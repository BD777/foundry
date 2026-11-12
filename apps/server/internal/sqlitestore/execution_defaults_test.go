package sqlitestore

import (
	"context"
	"errors"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func TestExecutionDefaultsFallBackByScope(t *testing.T) {
	ctx := context.Background()
	db, err := Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	global := store.StoredExecutionModelDefault{
		OwnerUserID: "user_a", ProviderID: "relay", Runtime: "codex",
		Model: "worker", Effort: "high", UpdatedBy: "user_a",
	}
	if err := db.SetExecutionDefault(ctx, global); err != nil {
		t.Fatal(err)
	}
	workspace := global
	workspace.WorkspaceID = "ws_a"
	workspace.Model = "workspace-worker"
	if err := db.SetExecutionDefault(ctx, workspace); err != nil {
		t.Fatal(err)
	}
	gotGlobal, err := db.GetExecutionDefault(ctx, "user_a", "")
	if err != nil || gotGlobal.Scope != "global" || gotGlobal.Model != "worker" || gotGlobal.UpdatedAt == "" {
		t.Fatalf("global = %+v, err %v", gotGlobal, err)
	}
	gotWorkspace, err := db.GetExecutionDefault(ctx, "user_a", "ws_a")
	if err != nil || gotWorkspace.Scope != "workspace" || gotWorkspace.Model != "workspace-worker" {
		t.Fatalf("workspace = %+v, err %v", gotWorkspace, err)
	}
	if _, err := db.GetExecutionDefault(ctx, "user_b", ""); !errors.Is(err, store.ErrExecutionDefaultNotFound) {
		t.Fatalf("another owner = %v", err)
	}
	if err := db.SetExecutionDefault(ctx, store.StoredExecutionModelDefault{OwnerUserID: "user_a", WorkspaceID: "ws_a"}); err != nil {
		t.Fatal(err)
	}
	if _, err := db.GetExecutionDefault(ctx, "user_a", "ws_a"); !errors.Is(err, store.ErrExecutionDefaultNotFound) {
		t.Fatalf("cleared workspace = %v", err)
	}
	pool, err := db.SaveWorkerGroup(ctx, store.StoredWorkerGroup{
		OwnerUserID: "user_a", Label: "Workers",
		Members: []store.WorkerGroupMember{{ProviderKind: "api", ProviderID: "relay", Runtime: "codex", Model: "worker"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	poolDefault := store.StoredExecutionModelDefault{
		OwnerUserID: "user_a", WorkerGroupID: pool.ID, UpdatedBy: "user_a",
	}
	if err := db.SetExecutionDefault(ctx, poolDefault); err != nil {
		t.Fatal(err)
	}
	gotPool, err := db.GetExecutionDefault(ctx, "user_a", "")
	if err != nil || gotPool.WorkerGroupID != pool.ID || gotPool.Model != "" || gotPool.ProviderID != "" {
		t.Fatalf("pool default = %+v, %v", gotPool, err)
	}
}
