package sqlitestore

import (
	"context"
	"errors"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func TestModelNotesKeepHistoryAndStayWithTheirOwner(t *testing.T) {
	ctx := context.Background()
	db, err := Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	first, err := db.AppendModelNote(ctx, store.StoredModelNote{
		OwnerUserID: "user_a", ProviderKind: "api", ProviderID: "provider_relay",
		Runtime: "codex", Model: "cheap-worker", Body: "Give exact files and commands.",
		AuthorUserID: "user_a", AuthorName: "Alice", AuthorSessionID: "sess_1",
	})
	if err != nil {
		t.Fatal(err)
	}
	second, err := db.AppendModelNote(ctx, store.StoredModelNote{
		OwnerUserID: "user_a", ProviderKind: "api", ProviderID: "provider_relay",
		Runtime: "codex", Model: "cheap-worker", Body: "Re-run tests after a failure.",
		AuthorUserID: "user_a", AuthorName: "Alice",
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.AppendModelNote(ctx, store.StoredModelNote{
		OwnerUserID: "user_b", ProviderKind: "api", ProviderID: "provider_relay",
		Runtime: "codex", Model: "cheap-worker", Body: "Bob's note",
		AuthorUserID: "user_b", AuthorName: "Bob",
	}); err != nil {
		t.Fatal(err)
	}

	filter := store.ModelNoteFilter{OwnerUserID: "user_a", ProviderKind: "api",
		ProviderID: "provider_relay", Runtime: "codex", Model: "cheap-worker", Limit: 1}
	page, total, err := db.ListModelNotes(ctx, filter)
	if err != nil || total != 2 || len(page) != 1 {
		t.Fatalf("first page = %+v, total %d, err %v", page, total, err)
	}
	filter.Offset = 1
	next, total, err := db.ListModelNotes(ctx, filter)
	if err != nil || total != 2 || len(next) != 1 || next[0].ID == page[0].ID {
		t.Fatalf("second page = %+v, total %d, err %v", next, total, err)
	}

	updated, err := db.UpdateModelNote(ctx, first.ID, "user_a", "  Ask for evidence.  ")
	if err != nil || updated.Body != "Ask for evidence." || updated.UpdatedAt == "" || updated.AuthorSessionID != "sess_1" {
		t.Fatalf("updated = %+v, err %v", updated, err)
	}
	if _, err := db.UpdateModelNote(ctx, second.ID, "user_b", "not yours"); !errors.Is(err, store.ErrModelNoteNotFound) {
		t.Fatalf("other owner update = %v", err)
	}
	if err := db.DeleteModelNote(ctx, second.ID, "user_a"); err != nil {
		t.Fatal(err)
	}
	if _, err := db.GetModelNote(ctx, second.ID); !errors.Is(err, store.ErrModelNoteNotFound) {
		t.Fatalf("deleted note = %v", err)
	}
}

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
}
