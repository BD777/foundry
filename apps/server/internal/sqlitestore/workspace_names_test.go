package sqlitestore

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func TestWorkspaceDisplayNameSurvivesDaemonSnapshotAndDeletion(t *testing.T) {
	db := newTestStore(t)
	ctx := context.Background()
	workspace := store.WorkspaceProjection{ID: "ws_display_name", DeviceID: "dev_display_name", Name: "folder", LocalPath: "/unchanged/folder"}
	if err := db.saveWorkspace(ctx, workspace, time.Now()); err != nil {
		t.Fatal(err)
	}
	renamed, err := db.RenameWorkspace(ctx, workspace.ID, "My display name")
	if err != nil || renamed.Name != "My display name" || renamed.LocalPath != workspace.LocalPath {
		t.Fatalf("rename: %+v %v", renamed, err)
	}
	workspace.Name = "daemon folder name"
	if err := db.saveWorkspace(ctx, workspace, time.Now()); err != nil {
		t.Fatal(err)
	}
	got, err := db.GetWorkspace(ctx, workspace.ID)
	if err != nil || got.Name != "My display name" || got.DeviceID != workspace.DeviceID || got.LocalPath != workspace.LocalPath {
		t.Fatalf("snapshot overwrote alias/identity: %+v %v", got, err)
	}
	list, err := db.ListWorkspaces(ctx)
	if err != nil {
		t.Fatal(err)
	}
	for _, item := range list {
		if item.ID == workspace.ID && item.Name != got.Name {
			t.Fatalf("list/detail mismatch: %+v", item)
		}
	}
	if _, err := db.DeleteWorkspace(ctx, workspace.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.RenameWorkspace(ctx, workspace.ID, "missing"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("rename deleted: %v", err)
	}
	if err := db.saveWorkspace(ctx, workspace, time.Now()); err != nil {
		t.Fatal(err)
	}
	got, _ = db.GetWorkspace(ctx, workspace.ID)
	if got.Name != workspace.Name {
		t.Fatalf("deleted alias resurrected: %+v", got)
	}
}
