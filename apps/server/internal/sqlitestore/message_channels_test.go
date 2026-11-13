package sqlitestore

import (
	"context"
	"errors"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// A poll still running when its channel is deleted must not bring back the
// channel's runtime row or records.
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
