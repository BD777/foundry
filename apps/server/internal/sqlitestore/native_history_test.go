package sqlitestore

import (
	"context"
	"slices"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func TestAContinuedNativeChatImportsItsEarlierHistoryOldestFirst(t *testing.T) {
	ctx := context.Background()
	db := newTestStore(t)
	registerTwoRuntimes(t, db, "ws_history")
	chat := store.ChatThread{ID: "native_codex_long", Provider: "codex", NativeSessionID: "long", Title: "Long work", UpdatedAt: "2026-10-23T06:00:00Z",
		TranscriptBefore: 5000,
		Transcript: []store.TranscriptMessage{
			{ID: "u3", Kind: "user", Text: "third", At: "2026-10-23T05:00:00Z"},
			{ID: "a3", Kind: "assistant", Text: "answer three", At: "2026-10-23T05:01:00Z"},
		}}
	if _, err := db.SyncChatsChanges(ctx, store.SyncChatsInput{WorkspaceID: "ws_history", Chats: []store.ChatThread{chat}}); err != nil {
		t.Fatal(err)
	}
	session, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{WorkspaceID: "ws_history", AgentID: "agent_codex", Provider: "codex", Prompt: "continue", ChatID: chat.ID})
	if err != nil {
		t.Fatal(err)
	}
	history, found, err := db.SessionNativeHistory(ctx, session.ID)
	if err != nil || !found || history.Before != 5000 || history.NativeSessionID != "long" || history.Provider != "codex" {
		t.Fatalf("history = %+v %v %v; the log before the chat's latest part is still on the device", history, found, err)
	}
	texts := func() []string {
		t.Helper()
		events, older, _, err := db.AgentSessionEventWindowSpan(ctx, session.ID, "", 50)
		if err != nil || older != "" {
			t.Fatal(older, err)
		}
		var got []string
		for _, event := range events {
			if event.Message != nil {
				got = append(got, event.Message.Text)
			}
		}
		return got
	}
	if got := texts(); !slices.Equal(got, []string{"third", "answer three", "continue"}) {
		t.Fatalf("transcript = %v", got)
	}

	// The page's last step is also the first adoption copied (Codex logs a
	// step twice on adjacent lines): it is not shown twice.
	second := []store.TranscriptMessage{{ID: "u2", Kind: "user", Text: "second"}, {ID: "a2", Kind: "assistant", Text: "answer two"}, {ID: "u3", Kind: "user", Text: "third"}}
	if err := db.ImportNativeHistory(ctx, session.ID, history, second, 2000); err != nil {
		t.Fatal(err)
	}
	// The same page again (a second reader): nothing changes.
	if err := db.ImportNativeHistory(ctx, session.ID, history, second, 2000); err != nil {
		t.Fatal(err)
	}
	history, _, _ = db.SessionNativeHistory(ctx, session.ID)
	if history.Before != 2000 {
		t.Fatalf("before = %d", history.Before)
	}
	first := []store.TranscriptMessage{{ID: "u1", Kind: "user", Text: "first", At: "2026-10-23T03:11:00Z"}}
	if err := db.ImportNativeHistory(ctx, session.ID, history, first, 0); err != nil {
		t.Fatal(err)
	}
	if got := texts(); !slices.Equal(got, []string{"first", "second", "answer two", "third", "answer three", "continue"}) {
		t.Fatalf("transcript = %v; imported pages come before what the session held, oldest first", got)
	}
	if _, found, err := db.SessionNativeHistory(ctx, session.ID); err != nil || found {
		t.Fatalf("history found = %v, %v; the whole log is imported", found, err)
	}
	cursor, err := db.AgentSessionOldestEventCursor(ctx, session.ID)
	if err != nil || cursor == "" {
		t.Fatal(cursor, err)
	}
	if older, _, _, err := db.AgentSessionEventWindowSpan(ctx, session.ID, cursor, 50); err != nil || len(older) != 0 {
		t.Fatalf("before the oldest = %v, %v", older, err)
	}
}
