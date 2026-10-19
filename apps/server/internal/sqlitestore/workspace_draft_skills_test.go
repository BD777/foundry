package sqlitestore

import (
	"context"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"testing"
)

func TestWorkspaceDraftSnapshotsRetainOldVersionsAndRespectExecutionRoot(t *testing.T) {
	db := newTestStore(t)
	ctx := context.Background()
	registerAgentSessionTestDaemon(t, db, "ws_drafts", "agent_drafts")
	value, err := db.WorkspaceDrafts(ctx, "ws_drafts", "ws_drafts")
	if err != nil || !value.Enabled {
		t.Fatalf("default: %#v %v", value, err)
	}
	a := store.WorkspaceDraftSkill{ID: "draft", WorkspaceID: "ws_drafts", ExecutionRootID: "ws_drafts", Digest: "v1", Status: "ready", SnapshotPath: "/snap/v1/SKILL.md"}
	value.Skills = []store.WorkspaceDraftSkill{a}
	if err := db.SaveWorkspaceDrafts(ctx, "ws_drafts", "ws_drafts", value); err != nil {
		t.Fatal(err)
	}
	a.Digest = "v2"
	a.SnapshotPath = "/snap/v2/SKILL.md"
	value.Skills = []store.WorkspaceDraftSkill{a}
	if err := db.SaveWorkspaceDrafts(ctx, "ws_drafts", "ws_drafts", value); err != nil {
		t.Fatal(err)
	}
	old, err := db.WorkspaceDraftRevision(ctx, "ws_drafts", "ws_drafts", "draft", "v1")
	if err != nil || old.SnapshotPath != "/snap/v1/SKILL.md" {
		t.Fatalf("old snapshot lost: %#v %v", old, err)
	}
	for _, scope := range [][2]string{{"another", "ws_drafts"}, {"ws_drafts", "issue:other"}} {
		if _, err := db.WorkspaceDraftRevision(ctx, scope[0], scope[1], "draft", "v1"); err == nil {
			t.Fatal("cross-scope snapshot exposed")
		}
	}
	if err := db.SetWorkspaceDraftsEnabled(ctx, "ws_drafts", false); err != nil {
		t.Fatal(err)
	}
	value, err = db.WorkspaceDrafts(ctx, "ws_drafts", "ws_drafts")
	if err != nil || value.Enabled || len(value.Skills) != 1 {
		t.Fatalf("settings lost: %#v %v", value, err)
	}
}
