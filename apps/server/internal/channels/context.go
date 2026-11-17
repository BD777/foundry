package channels

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"log"
	"strings"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// Other participants while a request is open (DEV-268): from the trigger
// until the turn, and every session it started, stops working, messages in
// the same conversation from someone else are handed to the open turn as
// facts. They are never triggers: they never start a turn or a session.

const (
	// maxContextMessages bounds one open window's context.
	maxContextMessages = 20
	// maxContextBytes bounds the text one open window's context carries.
	maxContextBytes = 8 * 1024
	// ReasonWindowClosed is why a context message was dropped: its request
	// ended before it could be handed over.
	ReasonWindowClosed = "window_closed"
	// ReasonContextDelivered marks a context message that reached the turn.
	ReasonContextDelivered = "context_delivered"
	// ReasonContextCapped is why a context message was dropped: the window's
	// cap had been reached.
	ReasonContextCapped = "context_capped"
)

// openWindow is a conversation whose turn is still working: the session it
// went to, the trigger's sender and segment.
type openWindow struct {
	SessionID       string
	TriggerSenderID string
	TriggerAt       string
	Segment         int
	Envelope        store.MessageEnvelope
	CreatedAt       string
}

// cappedKey names a window's capped flag.
func cappedKey(channelID, sessionKey string) string {
	return channelID + "\x00" + sessionKey
}

// working reports whether a session still works for its conversation,
// memoized for one pass.
func (r *Runner) working(ctx context.Context, cache map[string]bool, sessionID string) bool {
	if sessionID == "" {
		return false
	}
	if value, ok := cache[sessionID]; ok {
		return value
	}
	value := false
	if r.ports.Working != nil {
		if current, err := r.ports.Working(ctx, sessionID); err == nil {
			value = current
		} else {
			// An unreadable session is treated as still working: the
			// reaction and the window wait rather than lie.
			value = true
		}
	}
	cache[sessionID] = value
	return value
}

// openWindows finds the conversations whose turn still works.
func (r *Runner) openWindows(ctx context.Context, channel store.MessageChannelRecord, cache map[string]bool) map[string]openWindow {
	windows := map[string]openWindow{}
	records, err := r.ports.Store.ListMessageChannelDeliveries(ctx, channel.ID,
		[]string{store.MessageDeliveryQueued, store.MessageDeliveryDelivered, store.MessageDeliveryDone, store.MessageDeliveryFailed, store.MessageDeliveryContext}, 500)
	if err != nil {
		return windows
	}
	sortRecords(records) // oldest first
	for _, record := range records {
		if record.SessionKey == "" || record.SessionID == "" {
			continue
		}
		if !r.working(ctx, cache, record.SessionID) {
			continue
		}
		window, ok := windows[record.SessionKey]
		if !ok || window.CreatedAt == "" || record.CreatedAt >= window.CreatedAt {
			window.SessionID = record.SessionID
			window.Segment = record.Segment
			window.Envelope = record.Envelope
			window.CreatedAt = record.CreatedAt
		}
		// The trigger's sender comes from the newest record that is not one
		// of the context updates themselves: "someone else" is measured
		// against the message whose request is open, not the latest note.
		if record.Status != store.MessageDeliveryContext && record.Reason != ReasonContextDelivered {
			if window.TriggerSenderID == "" || record.CreatedAt >= window.TriggerAt {
				window.TriggerSenderID = record.Envelope.Sender.ID
				window.TriggerAt = record.CreatedAt
			}
		}
		windows[record.SessionKey] = window
	}
	return windows
}

// settleAcks takes the acknowledgement reaction off messages whose turn, and
// every session it started, have ended.
func (r *Runner) settleAcks(ctx context.Context, channel store.MessageChannelRecord) {
	if r.ports.Ack == nil || !AckEnabled(channel.MessageChannel) {
		return
	}
	records, err := r.ports.Store.ListMessageChannelDeliveries(ctx, channel.ID,
		[]string{store.MessageDeliveryDone, store.MessageDeliveryFailed}, 200)
	if err != nil {
		return
	}
	cache := map[string]bool{}
	var remove []string
	var settled []store.MessageChannelDeliveryRecord
	for _, record := range records {
		if !record.AckHeld || record.Envelope.MessageID == "" {
			continue
		}
		if r.working(ctx, cache, record.SessionID) {
			continue
		}
		remove = append(remove, record.Envelope.MessageID)
		record.AckHeld = false
		settled = append(settled, record)
	}
	if len(remove) == 0 {
		return
	}
	if err := r.ack(ctx, channel, false, remove); err != nil {
		return // the reaction stays marked; the next pass tries again
	}
	for _, record := range settled {
		if err := r.ports.Store.SaveMessageChannelDelivery(ctx, record); err != nil && ctx.Err() == nil {
			log.Printf("message channel %s: settle acknowledgement: %v", channel.ID, err)
		}
	}
}

// deliverContext hands waiting context messages to their conversation's
// running turn, and drops them once that request has ended.
func (r *Runner) deliverContext(ctx context.Context, channel store.MessageChannelRecord) {
	if r.ports.Context == nil {
		return
	}
	records, err := r.ports.Store.ListMessageChannelDeliveries(ctx, channel.ID,
		[]string{store.MessageDeliveryContext}, 500)
	if err != nil || len(records) == 0 {
		return
	}
	sortRecords(records) // oldest first
	groups := map[string][]store.MessageChannelDeliveryRecord{}
	var order []string
	for _, record := range records {
		if _, ok := groups[record.SessionKey]; !ok {
			order = append(order, record.SessionKey)
		}
		groups[record.SessionKey] = append(groups[record.SessionKey], record)
	}
	cache := map[string]bool{}
	windows := r.openWindows(ctx, channel, cache)
	for _, key := range order {
		group := groups[key]
		window, open := windows[key]
		if !open {
			// The turn and its helpers ended: these came too late to be
			// context for it.
			for _, record := range group {
				record.Status, record.Reason = store.MessageDeliveryDropped, ReasonWindowClosed
				record.Envelope.Text, record.Envelope.TextTruncated = "", false
				if err := r.ports.Store.SaveMessageChannelDelivery(ctx, record); err != nil {
					return
				}
			}
			r.capped.Delete(cappedKey(channel.ID, key))
			continue
		}
		batch, truncated := contextBatch(group)
		for i := range batch {
			batch[i].Envelope.Conversation = window.Envelope.Conversation
			if batch[i].Envelope.Thread.ID == "" {
				batch[i].Envelope.Thread = window.Envelope.Thread
			}
			batch[i].SessionID = window.SessionID
		}
		_, capped := r.capped.Load(cappedKey(channel.ID, key))
		label := ""
		if r.ports.SourceLabel != nil {
			label = r.ports.SourceLabel(ctx, channel)
		}
		turn := Turn{
			SessionKey: key, Segment: window.Segment, MessageID: contextMessageID(batch),
			Text:   ContextNotice(channel.MessageChannel, label, batch, Facts{}, capped || truncated),
			Origin: contextOrigin(channel, batch),
		}
		delivered, err := r.ports.Context(ctx, channel, window.SessionID, turn)
		if err != nil {
			if ctx.Err() == nil {
				log.Printf("message channel %s: context to %s: %v", channel.ID, window.SessionID, err)
			}
			continue
		}
		if !delivered {
			continue
		}
		for _, record := range batch {
			record.Status, record.Reason = store.MessageDeliveryDone, ReasonContextDelivered
			if err := r.ports.Store.SaveMessageChannelDelivery(ctx, record); err != nil {
				return
			}
		}
	}
}

// contextUsage is how much of a window's cap is used: messages already
// handed over or waiting, and their text bytes.
type contextUsage struct {
	Count int
	Bytes int
}

// contextUsage reads each conversation's context use, for the cap.
func (r *Runner) contextUsage(ctx context.Context, channel store.MessageChannelRecord) map[string]contextUsage {
	use := map[string]contextUsage{}
	records, err := r.ports.Store.ListMessageChannelDeliveries(ctx, channel.ID,
		[]string{store.MessageDeliveryContext, store.MessageDeliveryDone}, 500)
	if err != nil {
		return use
	}
	for _, record := range records {
		if record.Status == store.MessageDeliveryDone && record.Reason != ReasonContextDelivered {
			continue
		}
		current := use[record.SessionKey]
		current.Count++
		current.Bytes += len(record.Envelope.Text)
		use[record.SessionKey] = current
	}
	return use
}

// noteContextCap remembers that a window's cap left messages out.
func (r *Runner) noteContextCap(channelID, sessionKey string) {
	r.capped.Store(cappedKey(channelID, sessionKey), true)
}

// contextBatch takes up to the window's limits, oldest first; truncated says
// the cap was reached.
func contextBatch(group []store.MessageChannelDeliveryRecord) ([]store.MessageChannelDeliveryRecord, bool) {
	batch := make([]store.MessageChannelDeliveryRecord, 0, len(group))
	bytes := 0
	for _, record := range group {
		if len(batch) >= maxContextMessages || bytes+len(record.Envelope.Text) > maxContextBytes {
			return batch, true
		}
		bytes += len(record.Envelope.Text)
		batch = append(batch, record)
	}
	return batch, false
}

func contextMessageID(batch []store.MessageChannelDeliveryRecord) string {
	ids := make([]string, 0, len(batch))
	for _, record := range batch {
		ids = append(ids, record.ID)
	}
	sum := sha256.Sum256([]byte(strings.Join(ids, ",")))
	return "context_" + hex.EncodeToString(sum[:12])
}

// contextOrigin is a context batch as clients render it in the transcript.
func contextOrigin(channel store.MessageChannelRecord, batch []store.MessageChannelDeliveryRecord) *store.MessageChannelOrigin {
	if len(batch) == 0 {
		return nil
	}
	first := batch[0]
	origin := &store.MessageChannelOrigin{
		ChannelID: channel.ID, ChannelName: channel.Name, Source: channel.Source.Kind,
		Conversation: first.Envelope.Conversation, Thread: first.Envelope.Thread,
		Segment: first.Segment, At: first.CreatedAt,
	}
	for _, record := range batch {
		id := record.Envelope.MessageID
		if id == "" {
			id = record.Envelope.ID
		}
		origin.Messages = append(origin.Messages, store.MessageChannelOriginMessage{
			ID: id, At: record.Envelope.OccurredAt, Sender: record.Envelope.Sender,
			Text: record.Envelope.Text, TextTruncated: record.Envelope.TextTruncated,
			Status: record.Status, Rule: record.Rule,
		})
	}
	return origin
}
