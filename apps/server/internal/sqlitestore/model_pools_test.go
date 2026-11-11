package sqlitestore

import (
	"context"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func TestModelPoolsKeepOwnerCursorAndProviderScopedUsage(t *testing.T) {
	ctx := context.Background()
	db, err := Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	pool, err := db.SaveModelPool(ctx, store.StoredModelPool{
		OwnerUserID: "user_a", ProviderKind: "api", ProviderID: "relay",
		Runtime: "codex", Label: "Flash",
		Members: []store.EquivalentModelMember{
			{Model: "flash-a", TokensPerMinute: 100},
			{Model: "flash-b", TokensPerMinute: 1_000},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if cursor, err := db.AdvanceModelPoolCursor(ctx, pool.ID, 2); err != nil || cursor != 0 {
		t.Fatalf("first cursor = %d, %v", cursor, err)
	}
	if cursor, err := db.AdvanceModelPoolCursor(ctx, pool.ID, 2); err != nil || cursor != 1 {
		t.Fatalf("second cursor = %d, %v", cursor, err)
	}
	if pools, err := db.ListModelPools(ctx, "user_a"); err != nil || len(pools) != 1 || pools[0].Label != "Flash" {
		t.Fatalf("pools = %+v, %v", pools, err)
	}
	if pools, err := db.ListModelPools(ctx, "user_b"); err != nil || len(pools) != 0 {
		t.Fatalf("other owner's pools = %+v, %v", pools, err)
	}

	now := time.Now().UTC()
	for _, turn := range []store.UsageTurn{
		{
			UsageReported: true, SessionID: "sess_a", InputID: "input_a", UserID: "user_a",
			ProfileID: "relay", Runtime: "codex", Model: "flash-a", Entry: store.UsageEntryChat,
			StartedAt: formatTime(now.Add(-10 * time.Second)), EndedAt: formatTime(now),
			InputTokens: 1_000, OutputTokens: 100, CostSource: store.UsageCostUnknown,
		},
		{
			UsageReported: true, SessionID: "sess_b", InputID: "input_b", UserID: "user_a",
			ProfileID: "relay", Runtime: "codex", Model: "flash-b", Entry: store.UsageEntryChat,
			StartedAt: formatTime(now.Add(-10 * time.Second)), EndedAt: formatTime(now),
			InputTokens: 500, OutputTokens: 50, CostSource: store.UsageCostUnknown,
		},
		{
			UsageReported: true, SessionID: "sess_c", InputID: "input_c", UserID: "user_b",
			ProfileID: "relay", Runtime: "codex", Model: "flash-a", Entry: store.UsageEntryChat,
			StartedAt: formatTime(now.Add(-10 * time.Second)), EndedAt: formatTime(now),
			InputTokens: 20_000, OutputTokens: 1_000, CostSource: store.UsageCostUnknown,
		},
	} {
		if err := db.RecordUsage(ctx, store.UsageRecord{Turn: &turn}); err != nil {
			t.Fatal(err)
		}
	}
	usage, err := db.RecentModelTokens(ctx, now.Add(-time.Minute),
		"user_a", "relay", "codex", []string{"flash-a", "flash-b"})
	if err != nil {
		t.Fatal(err)
	}
	if usage["flash-a"] != 1_100 || usage["flash-b"] != 550 {
		t.Fatalf("provider-scoped usage = %+v", usage)
	}
}
