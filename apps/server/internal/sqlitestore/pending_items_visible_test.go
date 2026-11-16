package sqlitestore

import (
	"context"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// ListVisiblePendingItems is the one rule both the assistant's card and the
// Needs-you page read: an item whose session was archived is in neither,
// while ListPendingItems still has the row.
func TestVisiblePendingItemsHidesArchivedSessions(t *testing.T) {
	db, ctx := newTestStore(t), context.Background()
	const ws, sessionID, user = "ws_visible", "sess_archived", "user_visible"
	now := "2026-11-16T00:00:00Z"
	if _, err := db.conn().ExecContext(ctx, `INSERT INTO agent_sessions
		(id, workspace_id, agent_id, device_id, provider, status, payload_json, created_at, updated_at)
		VALUES (?,?,?,?,?,?,?,?,?)`,
		sessionID, ws, "agent_visible", "dev_visible", "codex", "completed",
		`{"id":"`+sessionID+`","nativeSessionId":"native-visible"}`, now, now); err != nil {
		t.Fatal(err)
	}
	if _, err := db.conn().ExecContext(ctx, `INSERT INTO chat_archives
		(workspace_id, archive_key, archived_at, batch_id) VALUES (?,?,?,?)`,
		ws, "id:"+sessionID, now, "batch_visible"); err != nil {
		t.Fatal(err)
	}
	record := func(item store.PendingItem) {
		t.Helper()
		item.UserID = user
		item.Handler = store.PendingHandlerPerson
		if _, _, err := db.RecordPendingItem(ctx, item); err != nil {
			t.Fatal(err)
		}
	}
	record(store.PendingItem{WorkspaceID: ws, SessionID: sessionID,
		Source: store.PendingSourceQuestion, Key: "question:archived:0",
		Title: "archived question", Excerpt: "archived question"})
	record(store.PendingItem{Source: store.PendingSourceAccount, Key: "account:a",
		Title: "account", Excerpt: "account"})

	raw, err := db.ListPendingItems(ctx, user, []string{store.PendingOpen}, "", 10)
	if err != nil || len(raw) != 2 {
		t.Fatalf("raw list = %+v (%v), want both rows", raw, err)
	}
	visible, err := db.ListVisiblePendingItems(ctx, user, []string{store.PendingOpen}, "", 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(visible) != 1 || visible[0].Title != "account" {
		t.Fatalf("visible list = %+v, want only the item without a session", visible)
	}
}
