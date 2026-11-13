package channels

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// Debounce is how long the dispatcher waits for more messages of the same
// conversation before it hands them over together.
const Debounce = 5 * time.Second

// maxBatchMessages bounds the messages one notice carries.
const maxBatchMessages = 20

// DefaultIdleMinutes is how long a conversation may be quiet before its next
// message starts a new session, for a channel that does not say.
const DefaultIdleMinutes = 240

// Why a conversation's message started a new session.
const (
	NewFirst     = "first"
	NewIdle      = "idle"
	NewCommand   = "command"
	NewButton    = "button"
	NewRestarted = "restarted"
)

// SessionRule is the channel's session rule with its defaults.
func SessionRule(channel store.MessageChannel) store.MessageChannelSessionRule {
	if channel.Session == nil {
		return store.MessageChannelSessionRule{IdleMinutes: DefaultIdleMinutes, ResetCommands: []string{}}
	}
	return *channel.Session
}

// Dispatch hands each channel's queued messages to the assistant, one inbox
// entry per conversation turn, and follows the entries it made. It runs as
// a background job.
func (r *Runner) Dispatch(ctx context.Context) {
	channels, err := r.ports.Store.ListAllMessageChannels(ctx)
	if err != nil {
		return
	}
	for _, channel := range channels {
		if ctx.Err() != nil {
			return
		}
		if err := r.dispatchChannel(ctx, channel); err != nil && ctx.Err() == nil {
			log.Printf("message channel %s: dispatch: %v", channel.ID, err)
		}
	}
}

func (r *Runner) dispatchChannel(ctx context.Context, channel store.MessageChannelRecord) error {
	open, err := r.ports.Store.ListMessageChannelDeliveries(ctx, channel.ID,
		[]string{store.MessageDeliveryQueued, store.MessageDeliveryDelivered}, 500)
	if err != nil || len(open) == 0 {
		return err
	}
	sortRecords(open)
	handed, err := r.ports.Store.ListMessageChannelDeliveries(ctx, channel.ID,
		[]string{store.MessageDeliveryDelivered, store.MessageDeliveryDone, store.MessageDeliveryFailed}, 500)
	if err != nil {
		return err
	}
	latest := latestSessions(handed)
	// Follow what was handed over.
	inFlight := map[string]bool{}
	statuses := map[string]InboxStatus{}
	for i := range open {
		record := &open[i]
		if record.InboxID == "" {
			continue
		}
		status, ok := statuses[record.InboxID]
		if !ok {
			status, err = r.ports.Inbox.Status(ctx, channel.AssistantID, record.InboxID)
			if err != nil {
				if errors.Is(err, store.ErrNotFound) {
					status = InboxStatus{Status: "cancelled"}
				} else {
					inFlight[record.SessionKey] = true
					continue
				}
			}
			statuses[record.InboxID] = status
		}
		hadSession := record.SessionID != ""
		changed := applyInboxStatus(record, status, r.ports.Now())
		// The inbox started another session for the same segment (the last
		// one failed, or the model changed): say so on the record.
		if !hadSession && record.SessionID != "" && !record.SessionNew {
			if previous, ok := latest[segmentKey(record.SessionKey, record.Segment)]; ok && previous.SessionID != record.SessionID {
				record.SessionNew, record.NewReason, changed = true, NewRestarted, true
			}
		}
		if changed {
			if err := r.ports.Store.SaveMessageChannelDelivery(ctx, *record); err != nil {
				return err
			}
		}
		if record.Status == store.MessageDeliveryQueued || record.Status == store.MessageDeliveryDelivered {
			inFlight[record.SessionKey] = true
		}
	}
	if !channel.Enabled {
		return nil
	}
	// Hand over waiting conversations, oldest first, up to the concurrency.
	pending := map[string][]int{}
	var order []string
	for i, record := range open {
		if record.InboxID != "" || record.Status != store.MessageDeliveryQueued || inFlight[record.SessionKey] {
			continue
		}
		if _, ok := pending[record.SessionKey]; !ok {
			order = append(order, record.SessionKey)
		}
		pending[record.SessionKey] = append(pending[record.SessionKey], i)
	}
	concurrency := channel.Limits.Concurrency
	if concurrency <= 0 {
		concurrency = DefaultConcurrency
	}
	now := r.ports.Now()
	for _, key := range order {
		if len(inFlight) >= concurrency {
			break
		}
		indexes := pending[key]
		newest, _ := time.Parse(time.RFC3339Nano, open[indexes[len(indexes)-1]].CreatedAt)
		oldest, _ := time.Parse(time.RFC3339Nano, open[indexes[0]].CreatedAt)
		if now.Sub(newest) < Debounce && now.Sub(oldest) < 6*Debounce {
			continue
		}
		if len(indexes) > maxBatchMessages {
			indexes = indexes[:maxBatchMessages]
		}
		batch := make([]store.MessageChannelDeliveryRecord, 0, len(indexes))
		for _, i := range indexes {
			batch = append(batch, open[i])
		}
		delivered, err := r.handOver(ctx, channel, key, batch, latest)
		if err != nil {
			return err
		}
		if delivered {
			inFlight[key] = true
		}
	}
	return nil
}

// segmentKey names one segment (one session) of a conversation.
func segmentKey(sessionKey string, segment int) string {
	return fmt.Sprintf("%s#%d", sessionKey, segment)
}

// latestSessions is the newest handed record with a session of every
// segment, and of every conversation (keyed by its session key).
func latestSessions(handed []store.MessageChannelDeliveryRecord) map[string]store.MessageChannelDeliveryRecord {
	out := map[string]store.MessageChannelDeliveryRecord{}
	for _, record := range handed {
		if record.SessionID == "" {
			continue
		}
		for _, key := range []string{segmentKey(record.SessionKey, record.Segment), record.SessionKey} {
			if previous, ok := out[key]; !ok || previous.Segment < record.Segment ||
				previous.Segment == record.Segment && previous.CreatedAt < record.CreatedAt {
				out[key] = record
			}
		}
	}
	return out
}

// Rollover is the decision for a conversation's next batch: which segment
// (session) it goes to, and why a new one starts.
type Rollover struct {
	Segment int
	New     bool
	Reason  string
	// Previous is the conversation's earlier session, for the notice.
	Previous     string
	PreviousLast time.Time
	// Idle is how long the conversation was quiet (Reason idle).
	Idle time.Duration
}

// DecideRollover applies the session rule to a conversation: state is its
// stored segment and pending reset, previous the newest record that went to
// a session (ok false: none yet), at the arrival of the batch's first
// message, and command whether that message asked for a new session.
func DecideRollover(rule store.MessageChannelSessionRule, state store.MessageChannelKeyState, previous store.MessageChannelDeliveryRecord, hasPrevious bool, session SessionState, sessionKnown bool, at time.Time, command bool) Rollover {
	decision := Rollover{Segment: state.Segment}
	if !hasPrevious {
		decision.New, decision.Reason = true, NewFirst
		if state.Segment > 0 || state.ResetPending != "" {
			decision.Reason = state.ResetPending
			if decision.Reason == "" {
				decision.Reason = NewFirst
			}
		}
		return decision
	}
	decision.Previous = previous.SessionID
	if sessionKnown {
		decision.PreviousLast = session.LastActive
	}
	switch {
	case command:
		decision.Reason = NewCommand
	case state.ResetPending != "":
		decision.Reason = state.ResetPending
	case rule.IdleMinutes > 0 && sessionKnown && !session.Running && !session.OpenWork &&
		!session.LastActive.IsZero() && at.Sub(session.LastActive) >= time.Duration(rule.IdleMinutes)*time.Minute:
		decision.Reason, decision.Idle = NewIdle, at.Sub(session.LastActive)
	case sessionKnown && session.Replaced:
		// Same segment: the assistant starts the conversation's next
		// session in place of that one.
		decision.New, decision.Reason = true, NewRestarted
		return decision
	default:
		return decision
	}
	decision.Segment, decision.New = state.Segment+1, true
	return decision
}

// handOver gives one conversation's batch to the assistant; it reports
// whether a turn was handed over (a bare reset command hands nothing).
func (r *Runner) handOver(ctx context.Context, channel store.MessageChannelRecord, key string, batch []store.MessageChannelDeliveryRecord, latest map[string]store.MessageChannelDeliveryRecord) (bool, error) {
	rule := SessionRule(channel.MessageChannel)
	state, err := r.ports.Store.GetMessageChannelKey(ctx, channel.ID, key)
	if err != nil {
		return false, err
	}
	state.ChannelID, state.SessionKey = channel.ID, key
	command := false
	if len(rule.ResetCommands) > 0 {
		rest, ok := StripCommand(batch[0].Envelope.Text, ChannelTriggers(channel.MessageChannel), rule.ResetCommands)
		if ok {
			command = true
			if strings.TrimSpace(rest) == "" {
				// A bare command: the next message starts a new session.
				first := batch[0]
				first.Status, first.Reason = store.MessageDeliveryDone, "reset_command"
				if err := r.ports.Store.SaveMessageChannelDelivery(ctx, first); err != nil {
					return false, err
				}
				state.ResetPending = NewCommand
				if err := r.ports.Store.SaveMessageChannelKey(ctx, state); err != nil {
					return false, err
				}
				if batch = batch[1:]; len(batch) == 0 {
					return false, nil
				}
				command = false
			} else {
				batch[0].Envelope.Text = rest
			}
		}
	}
	previous, hasPrevious := latest[key]
	var session SessionState
	known := false
	if hasPrevious && r.ports.Session != nil {
		session, known = r.ports.Session(ctx, previous.SessionID)
	}
	at, _ := time.Parse(time.RFC3339Nano, batch[0].CreatedAt)
	decision := DecideRollover(rule, state, previous, hasPrevious, session, known, at, command)
	if decision.Segment != state.Segment || state.ResetPending != "" {
		state.Segment, state.ResetPending = decision.Segment, ""
		if err := r.ports.Store.SaveMessageChannelKey(ctx, state); err != nil {
			return false, err
		}
	}
	inboxChannel := InboxChannel(channel.ID, key)
	if decision.Segment > 0 {
		inboxChannel += fmt.Sprintf(":%d", decision.Segment)
	}
	label, hint := "", ""
	if r.ports.SourceLabel != nil {
		label = r.ports.SourceLabel(ctx, channel)
	}
	if r.ports.ContextHint != nil {
		hint = r.ports.ContextHint(ctx, channel)
	}
	ids := make([]string, 0, len(batch))
	raw := make([]json.RawMessage, 0, len(batch))
	for i := range batch {
		ids = append(ids, batch[i].ID)
		batch[i].Segment, batch[i].InboxChannel = decision.Segment, inboxChannel
		batch[i].SessionNew, batch[i].NewReason = i == 0 && decision.New, ""
		if batch[i].SessionNew {
			batch[i].NewReason = decision.Reason
		}
		if batch[i].RawJSON != "" && json.Valid([]byte(batch[i].RawJSON)) {
			raw = append(raw, json.RawMessage(batch[i].RawJSON))
		}
		// The segment goes on the records before the turn exists, so the
		// session it starts can be tied to them.
		if err := r.ports.Store.SaveMessageChannelDelivery(ctx, batch[i]); err != nil {
			return false, err
		}
	}
	sum := sha256.Sum256([]byte(strings.Join(ids, ",")))
	turn := Turn{InboxChannel: inboxChannel, SessionKey: key, Segment: decision.Segment,
		MessageID: "batch_" + hex.EncodeToString(sum[:12]), Text: Notice(channel.MessageChannel, label, hint, decision, batch)}
	if len(raw) > 0 {
		turn.Raw, _ = json.MarshalIndent(raw, "", "  ")
	}
	inboxID, err := r.ports.Inbox.Deliver(ctx, channel, turn)
	if err != nil {
		return false, fmt.Errorf("hand over %s: %w", batch[0].ID, err)
	}
	for _, record := range batch {
		record.InboxID, record.Reason = inboxID, ""
		if err := r.ports.Store.SaveMessageChannelDelivery(ctx, record); err != nil {
			return false, err
		}
	}
	return true, nil
}

// applyInboxStatus moves a record along with its inbox entry; it reports
// whether the record changed.
func applyInboxStatus(record *store.MessageChannelDeliveryRecord, status InboxStatus, now time.Time) bool {
	before := *record
	switch status.Status {
	case "delivered":
		record.Status, record.Reason = store.MessageDeliveryDelivered, ""
	case "resolved":
		record.Status, record.Reason = store.MessageDeliveryDone, ""
	case "cancelled":
		record.Status, record.Reason = store.MessageDeliveryFailed, "cancelled"
	default:
		record.Reason = status.WaitingReason
	}
	if status.Status == "delivered" && status.WaitingReason == "execution_failed" {
		record.Status, record.Reason = store.MessageDeliveryFailed, "execution_failed"
	}
	if status.ResultStatus != "" && status.ResultStatus != "completed" {
		record.Status, record.Reason = store.MessageDeliveryFailed, status.ResultStatus
	}
	if status.SessionID != "" && record.SessionID == "" {
		record.SessionID = status.SessionID
		record.DeliveredAt = now.UTC().Format(time.RFC3339Nano)
	}
	return record.Status != before.Status || record.Reason != before.Reason || record.SessionID != before.SessionID
}

// RequestNewSession makes the conversation's next message start a new
// session, as the person asked.
func (r *Runner) RequestNewSession(ctx context.Context, channelID, sessionKey string) error {
	state, err := r.ports.Store.GetMessageChannelKey(ctx, channelID, sessionKey)
	if err != nil {
		return err
	}
	state.ChannelID, state.SessionKey, state.ResetPending = channelID, sessionKey, NewButton
	return r.ports.Store.SaveMessageChannelKey(ctx, state)
}

// Release hands the channel's held messages over after all, past its
// limits, as the person asked.
func (r *Runner) Release(ctx context.Context, channelID string) (int, error) {
	held, err := r.ports.Store.ListMessageChannelDeliveries(ctx, channelID, []string{store.MessageDeliveryHeld}, 500)
	if err != nil {
		return 0, err
	}
	for _, record := range held {
		record.Status, record.Reason = store.MessageDeliveryQueued, ""
		if err := r.ports.Store.SaveMessageChannelDelivery(ctx, record); err != nil {
			return 0, err
		}
	}
	return len(held), nil
}
