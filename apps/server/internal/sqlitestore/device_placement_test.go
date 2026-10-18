package sqlitestore

import (
	"context"
	"slices"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func TestDeviceLabelsAndPresence(t *testing.T) {
	db := newTestStore(t)
	ctx := context.Background()
	labels := []store.DeviceLabel{{Key: "network", Value: "corp"}, {Key: "gpu"}}
	if err := db.SetDeviceLabels(ctx, "dev_a", labels, "user_a"); err != nil {
		t.Fatal(err)
	}
	sets, err := db.ListDeviceLabels(ctx, []string{"dev_a", "dev_b"})
	if err != nil || len(sets) != 1 || !slices.Equal(sets[0].Labels, labels) || sets[0].UpdatedBy != "user_a" {
		t.Fatalf("labels = %+v, %v", sets, err)
	}
	if err := db.SetDeviceLabels(ctx, "dev_a", nil, "user_a"); err != nil {
		t.Fatal(err)
	}
	if sets, _ := db.ListDeviceLabels(ctx, []string{"dev_a"}); len(sets) != 0 {
		t.Fatalf("cleared labels remain: %+v", sets)
	}

	now := time.Date(2026, 10, 15, 12, 0, 0, 0, time.UTC)
	old := now.Add(-20 * 24 * time.Hour)
	for _, interval := range []store.DevicePresenceInterval{
		{DeviceID: "dev_a", StartedAt: old, LastSeenAt: old.Add(time.Hour)},
		{DeviceID: "dev_a", StartedAt: now.Add(-3 * time.Hour), LastSeenAt: now.Add(-2 * time.Hour)},
		{DeviceID: "dev_b", StartedAt: now.Add(-time.Hour), LastSeenAt: now.Add(-time.Hour)},
	} {
		if err := db.RecordDevicePresence(ctx, interval.DeviceID, interval.StartedAt, interval.LastSeenAt); err != nil {
			t.Fatal(err)
		}
	}
	// A later save moves the connection on; an earlier one never moves it back.
	start := now.Add(-time.Hour)
	_ = db.RecordDevicePresence(ctx, "dev_b", start, now)
	_ = db.RecordDevicePresence(ctx, "dev_b", start, start)
	intervals, err := db.ListDevicePresence(ctx, []string{"dev_a", "dev_b"}, now.Add(-7*24*time.Hour))
	if err != nil || len(intervals) != 2 || !intervals[1].LastSeenAt.Equal(now) {
		t.Fatalf("presence = %+v, %v", intervals, err)
	}
	if err := db.PruneDevicePresence(ctx, now.Add(-14*24*time.Hour)); err != nil {
		t.Fatal(err)
	}
	if all, _ := db.ListDevicePresence(ctx, []string{"dev_a"}, time.Time{}); len(all) != 1 {
		t.Fatalf("pruned presence = %+v", all)
	}
}
