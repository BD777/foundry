package sqlitestore

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func TestAgentSessionPayloadDoesNotPersistEventsInline(t *testing.T) {
	db := newTestStore(t)
	ctx := context.Background()
	registerAgentSessionTestDaemon(t, db, "ws_payload", "agent_payload")

	session, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{
		WorkspaceID: "ws_payload",
		AgentID:     "agent_payload",
		Provider:    "codex",
		Prompt:      "payload",
	})
	if err != nil {
		t.Fatalf("create agent session: %v", err)
	}
	if err := db.AppendAgentSessionEvent(ctx, store.AgentSessionEvent{
		ID:        "evt_payload",
		SessionID: session.ID,
		Label:     "Response stream",
		Detail:    strings.Repeat("large event ", 256),
		Level:     "info",
		Message:   &store.TranscriptMessage{ID: "item_payload", Kind: "assistant", Text: "Answer", Status: "completed"},
	}); err != nil {
		t.Fatalf("append event: %v", err)
	}

	listed, err := db.ListAgentSessions(ctx, "ws_payload")
	if err != nil {
		t.Fatalf("list sessions: %v", err)
	}
	if len(listed) != 1 || len(listed[0].Events) != 1 {
		t.Fatalf("expected attached event from event table, got %#v", listed)
	}
	message := listed[0].Events[0].Message
	if message == nil || message.ID != "item_payload" || message.Kind != "assistant" || message.Text != "Answer" {
		t.Fatalf("typed event message did not survive persistence: %#v", message)
	}
	if inlineEvents := rawAgentSessionPayloadValue(t, db, session.ID, "events"); inlineEvents != nil {
		t.Fatalf("expected agent session payload to omit inline events, got %#v", inlineEvents)
	}
}

func TestAgentSessionEventReplacementMovesToLatestPosition(t *testing.T) {
	db := newTestStore(t)
	ctx := context.Background()
	registerAgentSessionTestDaemon(t, db, "ws_event_order", "agent_event_order")

	session, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{
		WorkspaceID: "ws_event_order",
		AgentID:     "agent_event_order",
		Provider:    "codex",
		Prompt:      "event order",
	})
	if err != nil {
		t.Fatalf("create agent session: %v", err)
	}
	if _, err := db.StartAgentSession(ctx, session.ID); err != nil {
		t.Fatalf("start agent session: %v", err)
	}

	if err := db.AppendAgentSessionEvent(ctx, store.AgentSessionEvent{
		ID:        "evt_response",
		SessionID: session.ID,
		Label:     "Response stream",
		Detail:    "partial answer",
		Level:     "info",
	}); err != nil {
		t.Fatalf("append response event: %v", err)
	}
	if err := db.AppendAgentSessionEvent(ctx, store.AgentSessionEvent{
		ID:        "evt_tool",
		SessionID: session.ID,
		Label:     "正在使用工具",
		Detail:    "Bash",
		Level:     "info",
	}); err != nil {
		t.Fatalf("append tool event: %v", err)
	}
	if err := db.AppendAgentSessionEvent(ctx, store.AgentSessionEvent{
		ID:        "evt_response",
		SessionID: session.ID,
		Label:     "Response stream",
		Detail:    "final answer",
		Level:     "info",
	}); err != nil {
		t.Fatalf("replace response event: %v", err)
	}

	detail, err := db.GetAgentSession(ctx, session.ID)
	if err != nil {
		t.Fatalf("get agent session: %v", err)
	}
	if len(detail.Events) != 2 {
		t.Fatalf("expected 2 events, got %#v", detail.Events)
	}
	if detail.Events[0].ID != "evt_tool" || detail.Events[1].ID != "evt_response" {
		t.Fatalf("expected replaced response to sort at latest position, got %#v", detail.Events)
	}
	if detail.Events[1].Detail != "final answer" {
		t.Fatalf("expected final response detail, got %#v", detail.Events[1])
	}
}

func TestListAgentSessionThreadReturnsOneCompleteTranscript(t *testing.T) {
	db := newTestStore(t)
	ctx := context.Background()
	registerAgentSessionTestDaemon(t, db, "ws_thread", "agent_thread")

	first, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{
		WorkspaceID: "ws_thread",
		AgentID:     "agent_thread",
		Provider:    "codex",
		Prompt:      "first prompt",
	})
	if err != nil {
		t.Fatalf("create first session: %v", err)
	}
	if _, err := db.CompleteAgentSession(ctx, first.ID, "first response", "native_thread"); err != nil {
		t.Fatalf("complete first session: %v", err)
	}

	second, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{
		WorkspaceID:     "ws_thread",
		ThreadID:        first.ID,
		NativeSessionID: "native_thread",
		AgentID:         "agent_thread",
		Provider:        "codex",
		Prompt:          "second prompt",
	})
	if err != nil {
		t.Fatalf("create second session: %v", err)
	}
	if err := db.AppendAgentSessionEvent(ctx, store.AgentSessionEvent{
		ID:        "evt_second_response",
		SessionID: second.ID,
		Label:     "Response stream",
		Detail:    "second response",
		Level:     "info",
	}); err != nil {
		t.Fatalf("append second event: %v", err)
	}
	if _, err := db.CompleteAgentSession(ctx, second.ID, "second response", "native_thread"); err != nil {
		t.Fatalf("complete second session: %v", err)
	}

	other, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{
		WorkspaceID: "ws_thread",
		AgentID:     "agent_thread",
		Provider:    "codex",
		Prompt:      "unrelated prompt",
	})
	if err != nil {
		t.Fatalf("create unrelated session: %v", err)
	}
	if _, err := db.CompleteAgentSession(ctx, other.ID, "unrelated response", "native_other"); err != nil {
		t.Fatalf("complete unrelated session: %v", err)
	}

	thread, err := db.ListAgentSessionThread(ctx, "ws_thread", second.ID)
	if err != nil {
		t.Fatalf("list thread by continuation session: %v", err)
	}
	if len(thread) != 2 {
		t.Fatalf("expected two sessions in thread, got %#v", thread)
	}
	if thread[0].ID != first.ID || thread[0].Response != "first response" {
		t.Fatalf("expected first complete turn, got %#v", thread[0])
	}
	if thread[1].ID != second.ID || thread[1].Response != "second response" {
		t.Fatalf("expected second complete turn, got %#v", thread[1])
	}
	if len(thread[1].Events) != 1 || thread[1].Events[0].Detail != "second response" {
		t.Fatalf("expected attached second-turn events, got %#v", thread[1].Events)
	}
}

func TestMigratePrunesLegacyAgentSessionInlineEvents(t *testing.T) {
	path := t.TempDir() + "/foundry.db"
	db := openTestStore(t, path)
	ctx := context.Background()
	registerAgentSessionTestDaemon(t, db, "ws_legacy_payload", "agent_legacy_payload")

	session, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{
		WorkspaceID: "ws_legacy_payload",
		AgentID:     "agent_legacy_payload",
		Provider:    "codex",
		Prompt:      "payload",
	})
	if err != nil {
		t.Fatalf("create agent session: %v", err)
	}
	if err := db.AppendAgentSessionEvent(ctx, store.AgentSessionEvent{
		ID:        "evt_legacy_payload",
		SessionID: session.ID,
		Label:     "Response stream",
		Detail:    "legacy event",
		Level:     "info",
	}); err != nil {
		t.Fatalf("append event: %v", err)
	}
	if _, err := db.db.ExecContext(ctx, `UPDATE agent_sessions
		SET payload_json = json_set(payload_json, '$.events', json('[{"id":"inline"}]')),
			thread_id = ''
		WHERE id = ?`, session.ID); err != nil {
		t.Fatalf("seed legacy inline events: %v", err)
	}
	if inlineEvents := rawAgentSessionPayloadValue(t, db, session.ID, "events"); inlineEvents == nil {
		t.Fatal("expected inline events before reopening legacy database")
	}
	if err := db.Close(); err != nil {
		t.Fatalf("close legacy database: %v", err)
	}

	reopened := newTestStoreAtPath(t, path)
	if inlineEvents := rawAgentSessionPayloadValue(t, reopened, session.ID, "events"); inlineEvents != nil {
		t.Fatalf("expected migration to prune inline events, got %#v", inlineEvents)
	}
	var threadID string
	if err := reopened.db.QueryRowContext(ctx, `SELECT thread_id FROM agent_sessions WHERE id = ?`, session.ID).Scan(&threadID); err != nil {
		t.Fatalf("read backfilled thread id: %v", err)
	}
	if threadID != session.ID {
		t.Fatalf("expected migration to backfill thread id %q, got %q", session.ID, threadID)
	}
	listed, err := reopened.ListAgentSessions(ctx, "ws_legacy_payload")
	if err != nil {
		t.Fatalf("list reopened sessions: %v", err)
	}
	if len(listed) != 1 || len(listed[0].Events) != 1 {
		t.Fatalf("expected event table data to remain attached, got %#v", listed)
	}
}

func TestListChatsOmitsHandoffContext(t *testing.T) {
	db := newTestStore(t)
	ctx := context.Background()
	if err := db.SyncChats(ctx, store.SyncChatsInput{
		WorkspaceID: "ws_chat_summary",
		Chats: []store.ChatThread{{
			ID:             "chat_with_context",
			WorkspaceID:    "ws_chat_summary",
			Provider:       "codex",
			Title:          "Chat with context",
			Preview:        "preview",
			HandoffContext: strings.Repeat("User: hello\nCodex: world\n", 128),
			Transcript:     []store.TranscriptMessage{{ID: "thinking", Kind: "reasoning", Text: "Saved summary", Title: "思考摘要", At: "2026-09-08T06:00:00Z"}},
			UpdatedAt:      "2026-09-08T07:00:00Z",
			UpdatedLabel:   "just now",
		}},
	}); err != nil {
		t.Fatalf("sync chat: %v", err)
	}

	chats, err := db.ListChats(ctx, "ws_chat_summary")
	if err != nil {
		t.Fatalf("list chats: %v", err)
	}
	if len(chats) != 1 || chats[0].HandoffContext != "" || len(chats[0].Transcript) != 0 {
		t.Fatalf("expected chat summary without handoff context, got %#v", chats)
	}
	if chats[0].UpdatedAt != "2026-09-08T07:00:00Z" {
		t.Fatalf("chat list lost update time: %#v", chats[0])
	}
	detail, err := db.GetChat(ctx, "chat_with_context")
	if err != nil {
		t.Fatalf("get chat detail: %v", err)
	}
	if detail.HandoffContext == "" {
		t.Fatalf("expected chat detail to include handoff context, got %#v", detail)
	}
	if len(detail.Transcript) != 1 || detail.Transcript[0].Kind != "reasoning" || detail.Transcript[0].Text != "Saved summary" {
		t.Fatalf("expected structured transcript in detail, got %#v", detail.Transcript)
	}
	if detail.Transcript[0].At != "2026-09-08T06:00:00Z" {
		t.Fatalf("chat detail lost message time: %#v", detail.Transcript[0])
	}
}

func TestLegacyChatSyncPreservesOnlyUnchangedStructuredHistory(t *testing.T) {
	db := newTestStore(t)
	ctx := context.Background()
	chat := store.ChatThread{ID: "rolling-upgrade", HandoffContext: "User: question", AnswerRevision: "v1", Transcript: []store.TranscriptMessage{{ID: "r", Kind: "reasoning", Text: "Summary"}}}
	sync := func() {
		t.Helper()
		if err := db.SyncChats(ctx, store.SyncChatsInput{Chats: []store.ChatThread{chat}}); err != nil {
			t.Fatal(err)
		}
	}
	sync()
	chat.Transcript = nil
	chat.UpdatedLabel = "later"
	sync()
	detail, err := db.GetChat(ctx, chat.ID)
	if err != nil || len(detail.Transcript) != 1 {
		t.Fatalf("legacy sync lost detail: %#v, %v", detail, err)
	}
	chat.AnswerRevision = "v2"
	sync()
	detail, err = db.GetChat(ctx, chat.ID)
	if err != nil || len(detail.Transcript) != 0 {
		t.Fatalf("changed history retained stale detail: %#v, %v", detail, err)
	}
}

func registerAgentSessionTestDaemon(t *testing.T, db *Store, workspaceID string, agentID string) {
	t.Helper()
	if err := db.RegisterDaemon(context.Background(), store.DaemonRegistration{
		Device: store.DeviceProjection{
			ID:            "dev_" + workspaceID,
			Label:         "Payload Device",
			Status:        "connected",
			LastSeenLabel: "online",
		},
		Workspace: store.WorkspaceProjection{
			ID:        workspaceID,
			Name:      "Payload Workspace",
			LocalPath: t.TempDir(),
		},
		Agents: []store.AgentProjection{{
			ID:            agentID,
			WorkspaceID:   workspaceID,
			DeviceID:      "dev_" + workspaceID,
			DeviceLabel:   "Payload Device",
			Provider:      "codex",
			Status:        "healthy",
			AuthMode:      "local_config",
			SecretStored:  "local",
			ConfigScope:   "workspace",
			ConfigLabel:   "local",
			LastSeenLabel: "online",
		}},
	}); err != nil {
		t.Fatalf("register daemon: %v", err)
	}
}

func rawAgentSessionPayloadValue(t *testing.T, db *Store, sessionID string, key string) any {
	t.Helper()
	var payload string
	if err := db.db.QueryRow(`SELECT payload_json FROM agent_sessions WHERE id = ?`, sessionID).Scan(&payload); err != nil {
		t.Fatalf("read raw agent session payload: %v", err)
	}
	var values map[string]any
	if err := json.Unmarshal([]byte(payload), &values); err != nil {
		t.Fatalf("decode raw agent session payload: %v", err)
	}
	return values[key]
}

func newTestStore(t *testing.T) *Store {
	t.Helper()
	return newTestStoreAtPath(t, t.TempDir()+"/foundry.db")
}

func newTestStoreAtPath(t *testing.T, path string) *Store {
	t.Helper()
	db := openTestStore(t, path)
	t.Cleanup(func() {
		_ = db.Close()
	})
	return db
}

func openTestStore(t *testing.T, path string) *Store {
	t.Helper()
	db, err := Open(path)
	if err != nil {
		t.Fatalf("open sqlite store: %v", err)
	}
	return db
}
