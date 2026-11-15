package assistant

import (
	"context"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/sqlitestore"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// A channel hand-over's structured origin names its channel, conversation,
// thread and each message, without parsing the facts block (DEV-234).
func TestChannelOriginOfOneHandOver(t *testing.T) {
	db, err := sqlitestore.Open(t.TempDir() + "/foundry.db")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	ctx := context.Background()
	channel := store.MessageChannelRecord{UserID: "user_1", MessageChannel: store.MessageChannel{
		ID: "mch_1", AssistantID: "asst_1", Name: "Ops", Enabled: true,
		Source:    store.MessageChannelSource{Kind: "openlark", AccountID: "xacc_1"},
		Limits:    store.MessageChannelLimits{PerHour: 10, PerDay: 10, Concurrency: 1},
		CreatedAt: "2026-11-16T00:00:00Z", UpdatedAt: "2026-11-16T00:00:00Z",
	}}
	if err := db.SaveMessageChannel(ctx, channel); err != nil {
		t.Fatal(err)
	}
	item := store.MessageChannelDeliveryRecord{UserID: channel.UserID, AssistantID: channel.AssistantID}
	item.ID, item.ChannelID, item.Status, item.CreatedAt = "dlv_1", channel.ID, store.MessageDeliveryDone, "2026-11-16T06:00:00Z"
	item.InboxID, item.Segment, item.SessionNew, item.NewReason, item.Rule = "inbox_1", 0, true, "first", "group"
	item.Envelope = store.MessageEnvelope{
		ID: "env_1", Kind: "message", Op: "new", MessageID: "om_1", Text: "/ai check the build",
		OccurredAt:   "2026-11-16T05:59:00Z",
		Conversation: store.MessageEnvelopeConversation{ID: "oc_1", Kind: "group", Name: "Ops"},
		Thread:       store.MessageEnvelopeThread{ID: "omt_1", IsReply: true},
		Sender:       store.MessageEnvelopeSender{ID: "u_1", Name: "张三"},
	}
	pending := item
	pending.ID, pending.InboxID, pending.InboxChannel = "dlv_2", "", "mc:mch_1:c:oc_1:0"
	pending.CreatedAt = "2026-11-16T06:10:00Z"
	pending.Envelope.ID, pending.Envelope.MessageID, pending.Envelope.Text = "env_2", "om_2", "pending"
	if _, err := db.RecordMessageChannelBatch(ctx, channel.ID, []store.MessageChannelDeliveryRecord{item, pending}, "c1"); err != nil {
		t.Fatal(err)
	}
	service := &Service{messageChannels: db}
	origin := service.channelOriginOf(ctx, store.PersonalAgentInboxEntry{ID: "inbox_1", AssistantID: channel.AssistantID})
	if origin == nil {
		t.Fatal("no origin")
	}
	if origin.ChannelID != channel.ID || origin.ChannelName != "Ops" || origin.Source != "openlark" ||
		origin.Conversation.Name != "Ops" || origin.Thread.ID != "omt_1" || !origin.Thread.IsReply ||
		origin.Segment != 0 || !origin.SessionNew || origin.NewReason != "first" {
		t.Fatalf("origin = %+v", origin)
	}
	if len(origin.Messages) != 1 || origin.Messages[0].ID != "om_1" || origin.Messages[0].Sender.Name != "张三" ||
		origin.Messages[0].Text != "/ai check the build" || origin.Messages[0].Status != store.MessageDeliveryDone {
		t.Fatalf("origin messages = %+v", origin.Messages)
	}
	pendingOrigin := service.channelOriginOf(ctx, store.PersonalAgentInboxEntry{ID: "inbox_pending", AssistantID: channel.AssistantID, Channel: "mc:mch_1:c:oc_1:0"})
	if pendingOrigin == nil || len(pendingOrigin.Messages) != 1 || pendingOrigin.Messages[0].Text != "pending" {
		t.Fatalf("origin of a hand-over drained before its records were tagged = %+v", pendingOrigin)
	}
	if other := service.channelOriginOf(ctx, store.PersonalAgentInboxEntry{ID: "inbox_other", AssistantID: channel.AssistantID}); other != nil {
		t.Fatalf("origin of an unknown hand-over = %+v", other)
	}
}
