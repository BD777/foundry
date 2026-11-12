package channels

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
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
		if changed := applyInboxStatus(record, status, r.ports.Now()); changed {
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
		label := ""
		if r.ports.SourceLabel != nil {
			label = r.ports.SourceLabel(ctx, channel)
		}
		ids := make([]string, 0, len(batch))
		for _, record := range batch {
			ids = append(ids, record.ID)
		}
		sum := sha256.Sum256([]byte(strings.Join(ids, ",")))
		messageID := "batch_" + hex.EncodeToString(sum[:12])
		inboxID, err := r.ports.Inbox.Deliver(ctx, channel, key, messageID, Notice(channel.MessageChannel, label, batch))
		if err != nil {
			return fmt.Errorf("hand over %s: %w", batch[0].ID, err)
		}
		for _, record := range batch {
			record.InboxID, record.Reason = inboxID, ""
			if err := r.ports.Store.SaveMessageChannelDelivery(ctx, record); err != nil {
				return err
			}
		}
		inFlight[key] = true
	}
	return nil
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

// Notice is what the assistant's session receives for a turn: facts about
// the messages, which are other people's words, and nothing about what to
// do (the channel's skill holds the person's guidance).
func Notice(channel store.MessageChannel, sourceLabel string, records []store.MessageChannelDeliveryRecord) string {
	var out strings.Builder
	source := sourceLabel
	if source == "" {
		source = channel.Source.Kind
	}
	fmt.Fprintf(&out, "[Message channel %q (%s, skill %s): messages from other people, not the person's words]\n",
		channel.Name, source, SkillName(channel))
	first := records[0].Envelope
	conversation := first.Conversation.Kind + " conversation " + first.Conversation.ID
	if first.Conversation.Name != "" {
		conversation += fmt.Sprintf(" %q", first.Conversation.Name)
	}
	if first.Thread.ID != "" && channel.SessionKey == "thread" {
		conversation += ", thread " + first.Thread.ID
	}
	fmt.Fprintf(&out, "Conversation: %s\n", conversation)
	for _, record := range records {
		envelope := record.Envelope
		out.WriteString("\n")
		line := "Message " + cmpOr(envelope.MessageID, envelope.ID)
		if envelope.Thread.ID != "" {
			line += " (thread " + envelope.Thread.ID + ")"
		}
		sender := cmpOr(envelope.Sender.Name, "unknown sender")
		if envelope.Sender.ID != "" {
			sender += " (" + envelope.Sender.ID + ")"
		}
		if envelope.Sender.IsSelf {
			sender += ", the person themselves"
		}
		line += " from " + sender
		if envelope.OccurredAt != "" {
			line += " at " + envelope.OccurredAt
		}
		if envelope.MentionsMe {
			line += ", mentions the person"
		}
		fmt.Fprintf(&out, "%s; delivery %s\n", line, record.ID)
		for _, text := range strings.Split(strings.TrimRight(envelope.Text, "\n"), "\n") {
			out.WriteString("> " + text + "\n")
		}
		if envelope.TextTruncated {
			out.WriteString("> [text cut at 8 KB]\n")
		}
	}
	out.WriteString("[End of message channel]\n")
	return out.String()
}
