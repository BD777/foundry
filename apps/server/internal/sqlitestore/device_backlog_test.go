package sqlitestore

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// A device sends an event again when its acknowledgement was late. Stored
// unchanged, it changes nothing: not its time, not the session's activity.
// The same id with new content (a growing response) is stored as before.
func TestRecordAgentSessionEventIgnoresAnEventSentAgain(t *testing.T) {
	db := newTestStore(t)
	ctx := context.Background()
	registerAgentSessionTestDaemon(t, db, "ws_dup", "agent_dup")
	session, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{WorkspaceID: "ws_dup", AgentID: "agent_dup", Provider: "codex", Prompt: "work"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.StartAgentSession(ctx, session.ID); err != nil {
		t.Fatal(err)
	}
	// After the input's own transcript event.
	first := time.Now().UTC().Add(time.Minute)
	event := store.AgentSessionEvent{
		ID: "evt_dup_1", SessionID: session.ID, Label: "Response stream", Detail: "hello", Level: "info",
		Metadata: &store.AgentSessionEventMetadata{TaskID: "task_1"},
		At:       first.Format(time.RFC3339Nano),
	}
	stored, err := db.RecordAgentSessionEvent(ctx, event)
	if err != nil || !stored {
		t.Fatalf("first delivery stored=%v err=%v", stored, err)
	}
	before, err := db.GetAgentSessionRecord(ctx, session.ID)
	if err != nil {
		t.Fatal(err)
	}

	event.At = first.Add(time.Hour).Format(time.RFC3339Nano)
	stored, err = db.RecordAgentSessionEvent(ctx, event)
	if err != nil || stored {
		t.Fatalf("the same event again stored=%v err=%v, want ignored", stored, err)
	}
	after, err := db.GetAgentSession(ctx, session.ID)
	if err != nil {
		t.Fatal(err)
	}
	if after.LastActivityAt != before.LastActivityAt {
		t.Fatalf("activity moved from %s to %s", before.LastActivityAt, after.LastActivityAt)
	}
	if len(after.Events) != 2 || after.Events[1].ID != event.ID || after.Events[1].At != first.Format(time.RFC3339Nano) {
		t.Fatalf("events after the repeat = %+v", after.Events)
	}

	event.Detail = "hello world"
	stored, err = db.RecordAgentSessionEvent(ctx, event)
	if err != nil || !stored {
		t.Fatalf("a changed event stored=%v err=%v", stored, err)
	}
	updated, err := db.GetAgentSession(ctx, session.ID)
	if err != nil {
		t.Fatal(err)
	}
	if last := updated.Events[len(updated.Events)-1]; last.Detail != "hello world" || updated.LastActivityAt == before.LastActivityAt {
		t.Fatalf("changed event = %+v, activity %s", last, updated.LastActivityAt)
	}
}

// The server's notices on a waiting session are written once and leave the
// session as it was; queued sessions are read through their own index.
func TestQueuedSessionsAndNotices(t *testing.T) {
	db := newTestStore(t)
	ctx := context.Background()
	registerAgentSessionTestDaemon(t, db, "ws_wait", "agent_wait")
	queued, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{WorkspaceID: "ws_wait", AgentID: "agent_wait", Provider: "codex", Prompt: "wait"})
	if err != nil {
		t.Fatal(err)
	}
	running, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{WorkspaceID: "ws_wait", AgentID: "agent_wait", Provider: "codex", Prompt: "run"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.StartAgentSession(ctx, running.ID); err != nil {
		t.Fatal(err)
	}
	sessions, err := db.QueuedAgentSessions(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(sessions) != 1 || sessions[0].ID != queued.ID || sessions[0].Input.At == "" {
		t.Fatalf("queued sessions = %+v", sessions)
	}
	before, err := db.GetAgentSessionRecord(ctx, queued.ID)
	if err != nil {
		t.Fatal(err)
	}
	notice := store.AgentSessionEvent{ID: "evt_notice", SessionID: queued.ID, Label: "Waiting for device", Detail: "Waiting…", Level: "warning", At: time.Now().UTC().Add(time.Minute).Format(time.RFC3339Nano)}
	if added, err := db.AddQueuedSessionNotice(ctx, notice, "input_earlier"); err != nil || added {
		t.Fatalf("notice for another input added=%v err=%v", added, err)
	}
	for attempt, want := range []bool{true, false} {
		added, err := db.AddQueuedSessionNotice(ctx, notice, queued.Input.ID)
		if err != nil || added != want {
			t.Fatalf("attempt %d: added=%v err=%v, want %v", attempt, added, err, want)
		}
	}
	if added, err := db.AddQueuedSessionNotice(ctx, store.AgentSessionEvent{ID: "evt_orphan", SessionID: "sess_missing", Label: "Waiting for device"}, ""); err != nil || added {
		t.Fatalf("notice on a missing session added=%v err=%v", added, err)
	}
	// A session that started meanwhile gets none.
	if added, err := db.AddQueuedSessionNotice(ctx, store.AgentSessionEvent{ID: "evt_started", SessionID: running.ID, Label: "Waiting for device"}, running.Input.ID); err != nil || added {
		t.Fatalf("notice on a running session added=%v err=%v", added, err)
	}
	after, err := db.GetAgentSession(ctx, queued.ID)
	if err != nil {
		t.Fatal(err)
	}
	if after.Status != "queued" || after.LastActivityAt != before.LastActivityAt || after.UpdatedLabel != before.UpdatedLabel {
		t.Fatalf("the notice changed the session: %s %s %s", after.Status, after.LastActivityAt, after.UpdatedLabel)
	}
	if last := after.Events[len(after.Events)-1]; last.ID != "evt_notice" || last.Label != "Waiting for device" {
		t.Fatalf("events = %+v", after.Events)
	}

	rows, err := db.conn().QueryContext(ctx, `EXPLAIN QUERY PLAN SELECT id FROM agent_sessions WHERE status = 'queued' AND `+visibleAgentSessionSQL+` ORDER BY created_at`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	plan := []string{}
	for rows.Next() {
		var id, parent, unused int
		var detail string
		if err := rows.Scan(&id, &parent, &unused, &detail); err != nil {
			t.Fatal(err)
		}
		plan = append(plan, detail)
	}
	if !strings.Contains(strings.Join(plan, "\n"), "idx_agent_sessions_queued") {
		t.Fatalf("queued sessions are read by scanning the table: %v", plan)
	}
}

// A steer the device did not confirm leaves its message failed and marked
// maybe sent; a retry or a new claim clears the mark. Once the transcript
// shows the message (a late steer), it is settled sent.
func TestChatQueueMaybeSentMessages(t *testing.T) {
	db := newTestStore(t)
	ctx := context.Background()
	queue := enqueueForTest(t, db, "ws_q", "chat_q", "steer me")
	enqueueForTest(t, db, "ws_q", "chat_q", "after it")
	item := queue.Items[0]
	claim := func() {
		t.Helper()
		if _, _, err := db.ClaimChatQueueItem(ctx, "ws_q", "chat_q", item.ID, false); err != nil {
			t.Fatal(err)
		}
	}
	claim()
	queue, err := db.SettleChatQueueItemUnconfirmed(ctx, item.ID, "Queue Device did not answer within 8 s.")
	if err != nil {
		t.Fatal(err)
	}
	if got := queue.Items[0]; got.State != store.ChatQueueStateFailed || !got.MaybeSent || got.Error != "Queue Device did not answer within 8 s." {
		t.Fatalf("unconfirmed = %+v", got)
	}
	queue, err = db.RetryChatQueueItem(ctx, "ws_q", "chat_q", item.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got := queue.Items[0]; got.State != store.ChatQueueStateQueued || got.MaybeSent || got.Error != "" {
		t.Fatalf("retried = %+v", got)
	}
	claim()
	if _, err := db.SettleChatQueueItemUnconfirmed(ctx, item.ID, "no answer"); err != nil {
		t.Fatal(err)
	}

	queue, settled, err := db.SettleRecordedChatQueueItem(ctx, item.ID, "sess_took_it")
	if err != nil || !settled {
		t.Fatalf("settled=%v err=%v", settled, err)
	}
	if !sameStrings(queueTexts(queue), []string{"after it"}) {
		t.Fatalf("queue after the late steer = %v", queueTexts(queue))
	}
	if _, settled, err := db.SettleRecordedChatQueueItem(ctx, item.ID, "sess_took_it"); err != nil || settled {
		t.Fatalf("settling a sent message again settled=%v err=%v", settled, err)
	}
}

// A database from before the maybe-sent mark gains it on start.
func TestChatQueueMigrationAddsTheMaybeSentMark(t *testing.T) {
	db := newTestStore(t)
	ctx := context.Background()
	if _, err := db.conn().ExecContext(ctx, `ALTER TABLE chat_queue_items DROP COLUMN maybe_sent`); err != nil {
		t.Fatal(err)
	}
	if err := db.migrateChatQueue(ctx); err != nil {
		t.Fatal(err)
	}
	if queue := enqueueForTest(t, db, "ws_m", "chat_m", "hello"); len(queue.Items) != 1 || queue.Items[0].MaybeSent {
		t.Fatalf("queue after the migration = %+v", queue.Items)
	}
}

// A device event never replaces a person's input, nor another session's
// event: a late steer named after a message the person then sent as an
// input of its own is dropped.
func TestDeviceEventNeverReplacesAPersonsInput(t *testing.T) {
	db := newTestStore(t)
	ctx := context.Background()
	registerAgentSessionTestDaemon(t, db, "ws_input", "agent_input")
	session, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{WorkspaceID: "ws_input", AgentID: "agent_input", Provider: "codex", Prompt: "check mobile"})
	if err != nil {
		t.Fatal(err)
	}
	other, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{WorkspaceID: "ws_input", AgentID: "agent_input", Provider: "codex", Prompt: "other"})
	if err != nil {
		t.Fatal(err)
	}
	inputEvent := "evt_" + session.Input.ID
	for _, event := range []store.AgentSessionEvent{
		{ID: inputEvent, SessionID: session.ID, Label: "Steered into active turn", Detail: "check mobile", Level: "info"},
		{ID: inputEvent, SessionID: other.ID, Label: "Ran", Detail: "x", Level: "info"},
	} {
		stored, err := db.RecordAgentSessionEvent(ctx, event)
		if err != nil || stored {
			t.Fatalf("%s on %s: stored=%v err=%v", event.Label, event.SessionID, stored, err)
		}
	}
	full, err := db.GetAgentSession(ctx, session.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(full.Events) != 1 || full.Events[0].Label != store.SessionInputEventLabel || full.Events[0].Message == nil || full.Events[0].Message.Text != "check mobile" {
		t.Fatalf("the input event = %+v", full.Events)
	}
}
