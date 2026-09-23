package sqlitestore

import (
	"context"
	"errors"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func saveLayout(t *testing.T, db *Store, workspace string, layout store.ChatLayout) store.ChatLayout {
	t.Helper()
	result, err := db.SaveChatLayout(context.Background(), store.SaveChatLayoutInput{WorkspaceID: workspace, ExpectedRevision: &layout.Revision, Layout: layout})
	if err != nil {
		t.Fatal(err)
	}
	return result
}

func TestChatLayoutPersistsAcrossReopenAndProjectionSync(t *testing.T) {
	path := filepath.Join(t.TempDir(), "foundry.db")
	db := openTestStore(t, path)
	registerAgentSessionTestDaemon(t, db, "ws_layout", "agent_layout")
	ctx := context.Background()
	layout, err := db.GetChatLayout(ctx, "ws_layout")
	if err != nil || layout.Revision != 0 || layout.Groups == nil || layout.Positions == nil {
		t.Fatalf("empty: %+v %v", layout, err)
	}
	layout.Groups = []store.ChatLayoutGroup{{ID: "g", Name: " Work "}}
	layout.Positions = []store.ChatPlacement{{ChatID: "b", GroupID: "g"}, {ChatID: "a", GroupID: "g"}, {ChatID: "not-loaded"}}
	layout = saveLayout(t, db, "ws_layout", layout)
	if layout.Revision != 1 || layout.Groups[0].Name != "Work" {
		t.Fatal(layout)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	db = newTestStoreAtPath(t, path)
	restored, err := db.GetChatLayout(ctx, "ws_layout")
	if err != nil || !reflect.DeepEqual(restored, layout) {
		t.Fatalf("restore: %+v %v", restored, err)
	}
	registerAgentSessionTestDaemon(t, db, "ws_layout", "agent_layout")
	if err := db.SyncChats(ctx, store.SyncChatsInput{WorkspaceID: "ws_layout", Chats: []store.ChatThread{{ID: "a", WorkspaceID: "ws_layout", Title: "new title"}}}); err != nil {
		t.Fatal(err)
	}
	restored, err = db.GetChatLayout(ctx, "ws_layout")
	if err != nil || !reflect.DeepEqual(restored, layout) {
		t.Fatal("projection sync changed the layout", err)
	}
	registerAgentSessionTestDaemon(t, db, "ws_other", "agent_other")
	other, _ := db.GetChatLayout(ctx, "ws_other")
	if other.Revision != 0 || len(other.Groups) != 0 {
		t.Fatal("workspace leaked", other)
	}
	if _, err := db.DeleteWorkspace(ctx, "ws_layout"); err != nil {
		t.Fatal(err)
	}
	registerAgentSessionTestDaemon(t, db, "ws_layout", "agent_layout")
	reset, _ := db.GetChatLayout(ctx, "ws_layout")
	if reset.Revision != 0 {
		t.Fatal("deleted workspace retained layout")
	}
}

func TestChatLayoutConflictAndValidationAreAtomic(t *testing.T) {
	db := newTestStore(t)
	ctx := context.Background()
	registerAgentSessionTestDaemon(t, db, "ws_layout", "agent_layout")
	registerAgentSessionTestDaemon(t, db, "ws_foreign", "agent_foreign")
	foreign, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{WorkspaceID: "ws_foreign", AgentID: "agent_foreign", Provider: "codex", Prompt: "other"})
	if err != nil {
		t.Fatal(err)
	}
	initial, _ := db.GetChatLayout(ctx, "ws_layout")
	winner := saveLayout(t, db, "ws_layout", initial)
	_, err = db.SaveChatLayout(ctx, store.SaveChatLayoutInput{WorkspaceID: "ws_layout", ExpectedRevision: &initial.Revision, Layout: initial})
	if !errors.Is(err, store.ErrChatLayoutConflict) {
		t.Fatal("stale write accepted", err)
	}
	invalid := []store.ChatLayout{
		{Groups: []store.ChatLayoutGroup{{ID: "g", Name: "x"}, {ID: "g", Name: "y"}}, Positions: []store.ChatPlacement{}},
		{Groups: []store.ChatLayoutGroup{{ID: "g", Name: " "}}, Positions: []store.ChatPlacement{}},
		{Groups: []store.ChatLayoutGroup{}, Positions: []store.ChatPlacement{{ChatID: "a", GroupID: "missing"}}},
		{Groups: []store.ChatLayoutGroup{}, Positions: []store.ChatPlacement{{ChatID: "a"}, {ChatID: "a"}}},
		{Groups: []store.ChatLayoutGroup{}, Positions: []store.ChatPlacement{{ChatID: foreign.ID}}},
		{},
	}
	for _, bad := range invalid {
		_, err := db.SaveChatLayout(ctx, store.SaveChatLayoutInput{WorkspaceID: "ws_layout", ExpectedRevision: &winner.Revision, Layout: bad})
		if !errors.Is(err, store.ErrInvalidChatLayout) {
			t.Fatal("invalid write accepted", bad, err)
		}
	}
	after, _ := db.GetChatLayout(ctx, "ws_layout")
	if !reflect.DeepEqual(after, winner) {
		t.Fatal("rejected write partially committed", after)
	}
	_, err = db.GetChatLayout(ctx, "unknown")
	if !errors.Is(err, store.ErrNotFound) {
		t.Fatal("unknown workspace accepted", err)
	}
}

func TestExistingDatabaseAddsChatLayoutWithoutLosingWorkspace(t *testing.T) {
	path := filepath.Join(t.TempDir(), "old.db")
	db := openTestStore(t, path)
	registerAgentSessionTestDaemon(t, db, "ws_upgrade", "agent_upgrade")
	// Reproduce the schema from before the layout feature was installed.
	if _, err := db.db.Exec(`DROP TABLE chat_layouts`); err != nil {
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	db = newTestStoreAtPath(t, path)
	layout, err := db.GetChatLayout(context.Background(), "ws_upgrade")
	if err != nil || layout.Revision != 0 || layout.Groups == nil || layout.Positions == nil {
		t.Fatalf("migration did not preserve the workspace with an empty layout: %+v %v", layout, err)
	}
	layout.Groups = []store.ChatLayoutGroup{{ID: "after-upgrade", Name: "Upgraded"}}
	if saveLayout(t, db, "ws_upgrade", layout).Revision != 1 {
		t.Fatal("upgraded layout is not writable")
	}
}
