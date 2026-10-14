package sqlitestore

import (
	"context"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// Kind, archive time and purpose belong to the server: the device's next
// report keeps them, list and detail agree, and restoring clears the
// archive without touching anything else.
func TestWorkspaceLifecycleSurvivesDeviceReports(t *testing.T) {
	db := newTestStore(t)
	ctx := context.Background()
	workspace := store.WorkspaceProjection{ID: "ws_lifecycle", DeviceID: "dev_lifecycle", Name: "folder", LocalPath: "/home/me/Foundry/folder"}
	if err := db.saveWorkspace(ctx, workspace, time.Now()); err != nil {
		t.Fatal(err)
	}
	if got, err := db.GetWorkspace(ctx, workspace.ID); err != nil || got.Kind != "" || got.ArchivedAt != "" {
		t.Fatalf("a new workspace is a project, not archived: %+v %v", got, err)
	}
	if err := db.SetWorkspaceKind(ctx, workspace.ID, store.WorkspaceKindPersonalAgent); err != nil {
		t.Fatal(err)
	}
	if err := db.SetWorkspaceKind(ctx, workspace.ID, "team"); err == nil {
		t.Fatal("an unknown kind was stored")
	}
	if err := db.SetWorkspacePurpose(ctx, workspace.ID, "  Tracks the family budget. "); err != nil {
		t.Fatal(err)
	}
	first := time.Date(2026, 10, 15, 8, 0, 0, 0, time.UTC)
	archived, err := db.SetWorkspaceArchived(ctx, workspace.ID, first)
	if err != nil || archived.ArchivedAt == "" || archived.Kind != store.WorkspaceKindPersonalAgent {
		t.Fatalf("archive = %+v %v", archived, err)
	}
	again, err := db.SetWorkspaceArchived(ctx, workspace.ID, first.Add(time.Hour))
	if err != nil || again.ArchivedAt != archived.ArchivedAt {
		t.Fatalf("archiving again moved its time: %+v %v", again, err)
	}

	workspace.Name = "reported again"
	if err := db.saveWorkspace(ctx, workspace, time.Now()); err != nil {
		t.Fatal(err)
	}
	got, err := db.GetWorkspace(ctx, workspace.ID)
	if err != nil || got.Kind != store.WorkspaceKindPersonalAgent || got.ArchivedAt != archived.ArchivedAt || got.Name != "reported again" {
		t.Fatalf("the device's report overwrote the server's state: %+v %v", got, err)
	}
	list, err := db.ListWorkspaces(ctx)
	if err != nil {
		t.Fatal(err)
	}
	for _, item := range list {
		if item.ID == workspace.ID && (item.Kind != got.Kind || item.ArchivedAt != got.ArchivedAt) {
			t.Fatalf("list/detail mismatch: %+v", item)
		}
	}
	if purpose, err := db.WorkspacePurpose(ctx, workspace.ID); err != nil || purpose != "Tracks the family budget." {
		t.Fatalf("purpose = %q %v", purpose, err)
	}

	restored, err := db.SetWorkspaceArchived(ctx, workspace.ID, time.Time{})
	if err != nil || restored.ArchivedAt != "" || restored.Kind != store.WorkspaceKindPersonalAgent || restored.LocalPath != workspace.LocalPath {
		t.Fatalf("restore = %+v %v", restored, err)
	}
	if _, err := db.SetWorkspaceArchived(ctx, "ws_missing", first); err != store.ErrNotFound {
		t.Fatalf("archive missing = %v", err)
	}
}
