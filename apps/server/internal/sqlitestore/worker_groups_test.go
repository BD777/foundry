package sqlitestore

import (
	"context"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func TestWorkerGroupsKeepOwnerCursorAndProviderScopedUsage(t *testing.T) {
	ctx := context.Background()
	db, err := Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	pool, err := db.SaveWorkerGroup(ctx, store.StoredWorkerGroup{
		OwnerUserID: "user_a", Label: "Flash",
		Members: []store.WorkerGroupMember{
			{ProviderKind: "api", ProviderID: "relay", Runtime: "codex", Model: "flash-a", TokensPerMinute: 100},
			{ProviderKind: "api", ProviderID: "relay", Runtime: "codex", Model: "flash-b", TokensPerMinute: 1_000},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if cursor, err := db.AdvanceWorkerGroupCursor(ctx, pool.ID, 2); err != nil || cursor != 0 {
		t.Fatalf("first cursor = %d, %v", cursor, err)
	}
	if cursor, err := db.AdvanceWorkerGroupCursor(ctx, pool.ID, 2); err != nil || cursor != 1 {
		t.Fatalf("second cursor = %d, %v", cursor, err)
	}
	if groups, err := db.ListWorkerGroups(ctx, "user_a"); err != nil || len(groups) != 1 || groups[0].Label != "Flash" {
		t.Fatalf("groups = %+v, %v", groups, err)
	}
	if groups, err := db.ListWorkerGroups(ctx, "user_b"); err != nil || len(groups) != 0 {
		t.Fatalf("other owner's groups = %+v, %v", groups, err)
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

func TestOpenMigratesModelPoolsToCrossProviderWorkerGroups(t *testing.T) {
	ctx := context.Background()
	path := t.TempDir() + "/legacy.db"
	db, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	execAll(t, db,
		`CREATE TABLE model_pools (id TEXT PRIMARY KEY, owner_user_id TEXT NOT NULL, provider_kind TEXT NOT NULL,
			provider_id TEXT NOT NULL, runtime TEXT NOT NULL, label TEXT NOT NULL, members_json TEXT NOT NULL,
			cursor INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
		`INSERT INTO model_pools VALUES ('mpool_1', 'user_a', 'api', 'relay', 'codex', 'Flash',
			'[{"model":"flash-a","tokensPerMinute":100},{"model":"flash-b","weight":2}]', 3, 'then', 'then')`,
		`DROP TABLE execution_defaults`,
		`CREATE TABLE execution_defaults (owner_user_id TEXT NOT NULL, workspace_id TEXT NOT NULL DEFAULT '',
			provider_id TEXT NOT NULL, runtime TEXT NOT NULL, model TEXT NOT NULL, model_pool_id TEXT NOT NULL DEFAULT '',
			effort TEXT NOT NULL DEFAULT '', updated_by TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL,
			PRIMARY KEY (owner_user_id, workspace_id))`,
		`INSERT INTO execution_defaults VALUES ('user_a', '', 'relay', 'codex', '', 'mpool_1', 'high', '', 'then')`,
	)
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	db, err = Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	group, err := db.GetWorkerGroup(ctx, "mpool_1")
	if err != nil || group.Label != "Flash" || group.CreatedAt != "then" || len(group.Members) != 2 {
		t.Fatalf("migrated group = %+v, %v", group, err)
	}
	for _, member := range group.Members {
		if member.ProviderKind != "api" || member.ProviderID != "relay" || member.Runtime != "codex" {
			t.Fatalf("member %+v did not take the pool's provider and runtime", member)
		}
	}
	if group.Members[0].TokensPerMinute != 100 || group.Members[1].Weight != 2 {
		t.Fatalf("members lost their limits: %+v", group.Members)
	}
	if countRows(t, db, `SELECT count(*) FROM sqlite_master WHERE name = 'model_pools'`) != 0 {
		t.Fatal("model_pools was not dropped")
	}
	value, err := db.GetExecutionDefault(ctx, "user_a", "")
	if err != nil || value.WorkerGroupID != "mpool_1" {
		t.Fatalf("execution default = %+v, %v", value, err)
	}
}
