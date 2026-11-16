package sqlitestore

import (
	"context"
	"errors"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// A poll still running when its channel is deleted must not bring back the
// channel's runtime row or records.
func record(channel store.MessageChannelRecord, id, at, sessionKey, sessionID, inboxID string, segment int, extra store.MessageEnvelope) store.MessageChannelDeliveryRecord {
	item := store.MessageChannelDeliveryRecord{UserID: channel.UserID, AssistantID: channel.AssistantID}
	item.ID, item.ChannelID, item.Status, item.CreatedAt = id, channel.ID, store.MessageDeliveryDelivered, at
	item.SessionKey, item.SessionID, item.InboxID, item.Segment = sessionKey, sessionID, inboxID, segment
	item.Envelope = store.MessageEnvelope{ID: "env_" + id, Kind: "message", Op: "new", MessageID: id, Text: id}
	item.Envelope.Conversation = extra.Conversation
	item.Envelope.Sender = extra.Sender
	return item
}

// A channel's conversations page by newest activity, its deliveries filter
// by conversation and session with a cursor, and a session's origin names
// its conversation, segment and latest sender (DEV-234).
func TestMessageChannelReadPagesAndOrigins(t *testing.T) {
	db := newTestStore(t)
	ctx := context.Background()
	channel := store.MessageChannelRecord{UserID: "user_1", MessageChannel: store.MessageChannel{
		ID: "mch_read", AssistantID: "asst_1", Name: "Ops", Enabled: true,
		Source: store.MessageChannelSource{Kind: "openlark", AccountID: "xacc_1"},
		Limits: store.MessageChannelLimits{PerHour: 10, PerDay: 10, Concurrency: 1}, CreatedAt: "2026-11-13T00:00:00Z", UpdatedAt: "2026-11-13T00:00:00Z",
	}}
	if err := db.SaveMessageChannel(ctx, channel); err != nil {
		t.Fatal(err)
	}
	ops := store.MessageEnvelope{Conversation: store.MessageEnvelopeConversation{ID: "oc_a", Kind: "group", Name: "Ops"}, Sender: store.MessageEnvelopeSender{ID: "u_1", Name: "张三"}}
	design := store.MessageEnvelope{Conversation: store.MessageEnvelopeConversation{ID: "oc_b", Kind: "direct", Name: "Design"}, Sender: store.MessageEnvelopeSender{ID: "u_2", Name: "李四"}}
	r1 := record(channel, "r1", "2026-11-16T06:00:01Z", "c:a", "s1", "i1", 0, ops)
	r1.SessionNew, r1.NewReason, r1.Rule = true, "first", "group"
	r2 := record(channel, "r2", "2026-11-16T06:00:02Z", "c:a", "s1", "i1", 0, ops)
	r2.Envelope.Sender = store.MessageEnvelopeSender{ID: "u_3", Name: "李四"}
	r3 := record(channel, "r3", "2026-11-16T07:00:01Z", "c:a", "s2", "i2", 1, ops)
	r3.SessionNew, r3.NewReason = true, "idle"
	r4 := record(channel, "r4", "2026-11-16T08:00:01Z", "c:b", "s3", "i3", 0, design)
	r5 := record(channel, "r5", "2026-11-16T08:30:00Z", "c:a", "", "", 0, ops)
	r5.Status = store.MessageDeliveryDropped
	stored, err := db.RecordMessageChannelBatch(ctx, channel.ID, []store.MessageChannelDeliveryRecord{r1, r2, r3, r4, r5}, "c1")
	if err != nil || len(stored) != 5 {
		t.Fatalf("stored %d, %v", len(stored), err)
	}

	first, next, err := db.MessageChannelConversations(ctx, channel.ID, "", 1)
	if err != nil || len(first) != 1 || first[0].SessionKey != "c:a" || next == "" {
		t.Fatalf("first conversation page = %+v, %q, %v", first, next, err)
	}
	second, next, err := db.MessageChannelConversations(ctx, channel.ID, next, 1)
	if err != nil || len(second) != 1 || second[0].SessionKey != "c:b" || next != "" {
		t.Fatalf("second conversation page = %+v, %q, %v", second, next, err)
	}
	if count, err := db.CountMessageChannelConversations(ctx, channel.ID, "2026-01-01T00:00:00Z"); err != nil || count != 2 {
		t.Fatalf("conversations = %d, %v", count, err)
	}

	page, next, err := db.ListMessageChannelDeliveriesPage(ctx, channel.ID, store.MessageChannelDeliveryFilter{SessionKey: "c:a"}, "", 2)
	if err != nil || len(page) != 2 || page[0].ID != "r5" || page[1].ID != "r3" || next == "" {
		t.Fatalf("first delivery page = %+v, %q, %v", page, next, err)
	}
	page, next, err = db.ListMessageChannelDeliveriesPage(ctx, channel.ID, store.MessageChannelDeliveryFilter{SessionKey: "c:a"}, next, 2)
	if err != nil || len(page) != 2 || page[0].ID != "r2" || page[1].ID != "r1" || next != "" {
		t.Fatalf("second delivery page = %+v, %q, %v", page, next, err)
	}
	page, _, err = db.ListMessageChannelDeliveriesPage(ctx, channel.ID, store.MessageChannelDeliveryFilter{SessionID: "s1"}, "", 10)
	if err != nil || len(page) != 2 || page[0].ID != "r2" || page[1].ID != "r1" {
		t.Fatalf("session deliveries = %+v, %v", page, err)
	}

	origin, err := db.MessageChannelSessionOrigin(ctx, "s1")
	if err != nil || origin.Conversation.Name != "Ops" || origin.Segment != 0 || !origin.SessionNew || origin.NewReason != "first" ||
		origin.LastSender.Name != "李四" || origin.LastAt != "2026-11-16T06:00:02Z" || origin.ChannelID != channel.ID {
		t.Fatalf("session origin = %+v, %v", origin, err)
	}
	inbox, err := db.MessageChannelInboxDeliveries(ctx, channel.AssistantID, "i1")
	if err != nil || len(inbox) != 2 || inbox[0].ID != "r1" || inbox[1].ID != "r2" {
		t.Fatalf("inbox deliveries = %+v, %v", inbox, err)
	}
}

// The channel's "N conversations" counts what its workspace lists: source
// conversations with a message that reached the assistant, within
// retention. Dropped-only conversations, a bare new-session command, and
// conversations whose messages expired are not conversations there.
func TestMessageChannelConversationCountKeepsDeliveredWithinRetention(t *testing.T) {
	db := newTestStore(t)
	ctx := context.Background()
	channel := store.MessageChannelRecord{UserID: "user_1", MessageChannel: store.MessageChannel{
		ID: "mch_count", AssistantID: "asst_1", Name: "Ops", Enabled: true,
		Source: store.MessageChannelSource{Kind: "openlark", AccountID: "xacc_1"},
		Limits: store.MessageChannelLimits{PerHour: 10, PerDay: 10, Concurrency: 1}, CreatedAt: "2026-11-13T00:00:00Z", UpdatedAt: "2026-11-13T00:00:00Z",
	}}
	if err := db.SaveMessageChannel(ctx, channel); err != nil {
		t.Fatal(err)
	}
	ops := store.MessageEnvelope{Conversation: store.MessageEnvelopeConversation{ID: "oc_a", Kind: "group"}, Sender: store.MessageEnvelopeSender{ID: "u_1"}}
	delivered := record(channel, "r1", "2026-11-16T06:00:01Z", "c:a", "s1", "i1", 0, ops)
	done := record(channel, "r2", "2026-11-16T06:00:02Z", "c:b", "s2", "i2", 0, ops)
	done.Status = store.MessageDeliveryDone
	dropped := record(channel, "r3", "2026-11-16T06:00:03Z", "c:c", "", "", 0, ops)
	dropped.Status = store.MessageDeliveryDropped
	expired := record(channel, "r4", "2025-12-01T00:00:00Z", "c:d", "s4", "i4", 0, ops)
	reset := record(channel, "r5", "2026-11-16T06:00:04Z", "c:e", "", "", 0, ops)
	reset.Status, reset.Reason = store.MessageDeliveryDone, "reset_command"
	if _, err := db.RecordMessageChannelBatch(ctx, channel.ID, []store.MessageChannelDeliveryRecord{delivered, done, dropped, expired, reset}, "c1"); err != nil {
		t.Fatal(err)
	}
	if count, err := db.CountMessageChannelConversations(ctx, channel.ID, "2026-01-01T00:00:00Z"); err != nil || count != 2 {
		t.Fatalf("conversations = %d, %v, want the two delivered within retention", count, err)
	}
	if count, err := db.CountMessageChannelConversations(ctx, channel.ID, ""); err != nil || count != 3 {
		t.Fatalf("conversations without a cutoff = %d, %v, want every delivered one", count, err)
	}
}

func TestDeletedMessageChannelKeepsNoPollState(t *testing.T) {
	db := newTestStore(t)
	ctx := context.Background()
	channel := store.MessageChannelRecord{UserID: "user_1", MessageChannel: store.MessageChannel{
		ID: "mch_gone", AssistantID: "asst_1", Name: "gone", Enabled: true,
		Source: store.MessageChannelSource{Kind: "openlark", AccountID: "xacc_1"},
		Limits: store.MessageChannelLimits{PerHour: 1, PerDay: 1, Concurrency: 1}, CreatedAt: "2026-11-13T00:00:00Z", UpdatedAt: "2026-11-13T00:00:00Z",
	}}
	if err := db.SaveMessageChannel(ctx, channel); err != nil {
		t.Fatal(err)
	}
	if err := db.SaveMessageChannelRuntime(ctx, store.MessageChannelRuntime{ChannelID: channel.ID, Cursor: "c1", State: "running"}); err != nil {
		t.Fatal(err)
	}
	if runtime, err := db.GetMessageChannelRuntime(ctx, channel.ID); err != nil || runtime.Cursor != "c1" {
		t.Fatalf("runtime of a live channel = %+v, %v", runtime, err)
	}
	if err := db.DeleteMessageChannel(ctx, channel.UserID, channel.ID); err != nil {
		t.Fatal(err)
	}

	if err := db.SaveMessageChannelRuntime(ctx, store.MessageChannelRuntime{ChannelID: channel.ID, Cursor: "c2", State: "running"}); err != nil {
		t.Fatal(err)
	}
	record := store.MessageChannelDeliveryRecord{UserID: channel.UserID, AssistantID: channel.AssistantID}
	record.ID, record.ChannelID, record.Status, record.CreatedAt = "dlv_late", channel.ID, store.MessageDeliveryQueued, "2026-11-13T00:00:01Z"
	record.Envelope = store.MessageEnvelope{ID: "new:1", Kind: "message", Op: "new", MessageID: "1"}
	stored, err := db.RecordMessageChannelBatch(ctx, channel.ID, []store.MessageChannelDeliveryRecord{record}, "c3")
	if err != nil || len(stored) != 0 {
		t.Fatalf("batch for a deleted channel stored %d, %v", len(stored), err)
	}
	if _, err := db.GetMessageChannelRuntime(ctx, channel.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("runtime of a deleted channel: %v", err)
	}
	var deliveries int
	if err := db.reader().QueryRowContext(ctx, `SELECT COUNT(*) FROM message_channel_deliveries WHERE channel_id = ?`, channel.ID).Scan(&deliveries); err != nil || deliveries != 0 {
		t.Fatalf("deliveries of a deleted channel = %d, %v", deliveries, err)
	}
}
