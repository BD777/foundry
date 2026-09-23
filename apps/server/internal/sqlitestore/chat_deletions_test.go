package sqlitestore

import (
	"context"
	"errors"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func TestDeleteGroupSoftDeletesAllTurnsAndNativeHistoryAcrossSyncAndRestart(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "delete.db")
	db := openTestStore(t, path)
	registerAgentSessionTestDaemon(t, db, "ws_delete", "agent_delete")
	first, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{WorkspaceID: "ws_delete", AgentID: "agent_delete", Provider: "codex", Prompt: "first"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.CompleteAgentSession(ctx, first.ID, "answer", "native_first"); err != nil {
		t.Fatal(err)
	}
	second, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{WorkspaceID: "ws_delete", AgentID: "agent_delete", Provider: "codex", ThreadID: first.ThreadID, Prompt: "second"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.CompleteAgentSession(ctx, second.ID, "answer", "native_second"); err != nil {
		t.Fatal(err)
	}
	history := store.ChatThread{ID: "history", WorkspaceID: "ws_delete", Provider: "claude", NativeSessionID: "history_native", Title: "history"}
	keep := store.ChatThread{ID: "keep", WorkspaceID: "ws_delete", Title: "keep"}
	if err := db.SyncChats(ctx, store.SyncChatsInput{WorkspaceID: "ws_delete", Chats: []store.ChatThread{history, keep}}); err != nil {
		t.Fatal(err)
	}
	layout, _ := db.GetChatLayout(ctx, "ws_delete")
	layout.Groups = []store.ChatLayoutGroup{{ID: "g", Name: "Delete"}, {ID: "keep", Name: "Keep"}}
	layout.Positions = []store.ChatPlacement{{ChatID: first.ThreadID, GroupID: "g"}, {ChatID: history.ID, GroupID: "g"}, {ChatID: "not-loaded", GroupID: "g"}, {ChatID: keep.ID, GroupID: "keep"}}
	layout = saveLayout(t, db, "ws_delete", layout)
	after, err := db.DeleteChatGroup(ctx, store.DeleteChatGroupInput{WorkspaceID: "ws_delete", GroupID: "g", ExpectedRevision: &layout.Revision})
	if err != nil {
		t.Fatal(err)
	}
	if after.Revision != layout.Revision+1 || len(after.Groups) != 1 || len(after.Positions) != 1 || after.Positions[0].ChatID != keep.ID {
		t.Fatal(after)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	db = newTestStoreAtPath(t, path)
	// A worker can import the same native session under a different projection ID.
	alias := history
	alias.ID = "history_alias"
	if err := db.SyncChats(ctx, store.SyncChatsInput{WorkspaceID: "ws_delete", Chats: []store.ChatThread{history, alias, keep, {ID: "not-loaded", WorkspaceID: "ws_delete"}}}); err != nil {
		t.Fatal(err)
	}
	late := store.ChatThread{ID: "not-loaded", WorkspaceID: "ws_delete", Provider: "claude", NativeSessionID: "late_native"}
	if err := db.SyncChats(ctx, store.SyncChatsInput{WorkspaceID: "ws_delete", Chats: []store.ChatThread{late}}); err != nil {
		t.Fatal(err)
	}
	late.ID = "late_alias"
	if err := db.SyncChats(ctx, store.SyncChatsInput{WorkspaceID: "ws_delete", Chats: []store.ChatThread{late}}); err != nil {
		t.Fatal(err)
	}
	chats, err := db.ListChats(ctx, "ws_delete")
	if err != nil || len(chats) != 1 || chats[0].ID != keep.ID {
		t.Fatalf("chats: %+v %v", chats, err)
	}
	for _, ws := range []string{"ws_delete", ""} {
		sessions, err := db.ListAgentSessionSummaries(ctx, ws)
		if err != nil || len(sessions) != 0 {
			t.Fatalf("sessions: %+v %v", sessions, err)
		}
	}
	if _, err := db.GetChat(ctx, alias.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatal("deleted history still readable", err)
	}
	if _, err := db.GetAgentSession(ctx, second.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatal("deleted turn still readable", err)
	}
	if sessions, err := db.ListAgentSessionThread(ctx, "ws_delete", first.ThreadID); err == nil || len(sessions) != 0 {
		t.Fatal("deleted transcript still readable")
	}
	if _, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{WorkspaceID: "ws_delete", AgentID: "agent_delete", Provider: "codex", ThreadID: first.ThreadID, Prompt: "stale browser"}); !errors.Is(err, store.ErrNotFound) {
		t.Fatal("deleted thread resumed", err)
	}
	var count int
	if err := db.conn().QueryRowContext(ctx, `SELECT COUNT(*) FROM agent_sessions WHERE workspace_id = 'ws_delete'`).Scan(&count); err != nil || count != 2 {
		t.Fatal("soft deletion removed source records", count, err)
	}
	registerAgentSessionTestDaemon(t, db, "ws_other", "agent_other")
	alias.ID, alias.WorkspaceID = "other_history", "ws_other"
	if err := db.SyncChats(ctx, store.SyncChatsInput{WorkspaceID: "ws_other", Chats: []store.ChatThread{alias}}); err != nil {
		t.Fatal(err)
	}
	chats, err = db.ListChats(ctx, "ws_other")
	if err != nil || len(chats) != 1 {
		t.Fatal("deletion leaked across workspaces", chats, err)
	}
}

func TestDeleteGroupConflictsAndBusySessionsRollBackEveryChange(t *testing.T) {
	ctx := context.Background()
	db := newTestStore(t)
	registerAgentSessionTestDaemon(t, db, "ws_delete", "agent_delete")
	busy, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{WorkspaceID: "ws_delete", AgentID: "agent_delete", Provider: "codex", Prompt: "busy"})
	if err != nil {
		t.Fatal(err)
	}
	layout, _ := db.GetChatLayout(ctx, "ws_delete")
	layout.Groups = []store.ChatLayoutGroup{{ID: "g", Name: "Delete"}}
	layout.Positions = []store.ChatPlacement{{ChatID: "history", GroupID: "g"}, {ChatID: busy.ThreadID, GroupID: "g"}}
	layout = saveLayout(t, db, "ws_delete", layout)
	stale := layout.Revision - 1
	for _, tc := range []struct {
		revision *int64
		group    string
		want     error
	}{
		{nil, "g", store.ErrInvalidChatLayout},
		{&stale, "g", store.ErrChatLayoutConflict},
		{&layout.Revision, "missing", store.ErrNotFound},
		{&layout.Revision, "g", store.ErrChatDeletionBusy},
	} {
		_, err := db.DeleteChatGroup(ctx, store.DeleteChatGroupInput{WorkspaceID: "ws_delete", GroupID: tc.group, ExpectedRevision: tc.revision})
		if !errors.Is(err, tc.want) {
			t.Fatalf("want %v got %v", tc.want, err)
		}
		var count int
		if err := db.conn().QueryRowContext(ctx, `SELECT COUNT(*) FROM chat_deletions`).Scan(&count); err != nil || count != 0 {
			t.Fatal("partial deletion committed", count, err)
		}
		after, _ := db.GetChatLayout(ctx, "ws_delete")
		if !reflect.DeepEqual(layout, after) {
			t.Fatal("failed deletion changed layout", after)
		}
	}
	if _, err := db.CancelAgentSession(ctx, busy.ID, "stop"); err != nil {
		t.Fatal(err)
	}
	if _, err := db.DeleteChatGroup(ctx, store.DeleteChatGroupInput{WorkspaceID: "ws_delete", GroupID: "g", ExpectedRevision: &layout.Revision}); err != nil {
		t.Fatal(err)
	}
}
