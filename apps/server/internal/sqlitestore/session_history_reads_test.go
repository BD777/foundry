package sqlitestore

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// Writes that run on the writer read a session's events back only as far as
// they need: a long session holds tens of thousands. Each test compares the
// bounded read with the whole-history reading it replaces, then breaks an
// event the bounded read must not reach (malformed JSON fails any read of
// it, in SQL or in Go).

func saveTestEvent(t *testing.T, db *Store, event store.AgentSessionEvent, createdAt time.Time) {
	t.Helper()
	if err := db.saveAgentSessionEvent(context.Background(), event, createdAt); err != nil {
		t.Fatal(err)
	}
}

func breakTestEvent(t *testing.T, db *Store, id string) {
	t.Helper()
	if _, err := db.conn().ExecContext(context.Background(), `UPDATE agent_session_events SET payload_json = '{broken' WHERE id = ?`, id); err != nil {
		t.Fatal(err)
	}
}

// wholeHistoryAnswered is the reading inputAnswered replaces: every event of
// the session, newest first, up to the input.
func wholeHistoryAnswered(t *testing.T, db *Store, sessionID, inputID, answer string) bool {
	t.Helper()
	events, err := listJSON[store.AgentSessionEvent](context.Background(), db.conn(), `SELECT payload_json FROM agent_session_events
		WHERE session_id = ? ORDER BY created_at DESC, id DESC`, sessionID)
	if err != nil {
		t.Fatal(err)
	}
	for _, event := range events {
		if event.ID == "evt_"+inputID {
			return false
		}
		if event.Message != nil && event.Message.Kind == "assistant" && strings.TrimSpace(event.Message.Text) == answer {
			return true
		}
		if event.Label == "Response stream" && (event.Metadata == nil || event.Metadata.TaskID == "") && strings.TrimSpace(event.Detail) == answer {
			return true
		}
	}
	return false
}

// recordingExecutor runs a store's statements and keeps the queries that
// read event payloads, so a test can count the rows they returned.
type recordingExecutor struct {
	dbExecutor
	reads []recordedQuery
}

type recordedQuery struct {
	query string
	args  []any
}

func (r *recordingExecutor) QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error) {
	if strings.HasPrefix(strings.TrimSpace(query), "SELECT payload_json FROM agent_session_events") {
		r.reads = append(r.reads, recordedQuery{query, args})
	}
	return r.dbExecutor.QueryContext(ctx, query, args...)
}

// recording is db with its statements recorded.
func recording(db *Store) (*Store, *recordingExecutor) {
	recorder := &recordingExecutor{dbExecutor: db.conn()}
	return &Store{db: db.db, read: db.read, exec: recorder, kek: db.kek}, recorder
}

func (r *recordingExecutor) rowsRead(t *testing.T) int {
	t.Helper()
	total := 0
	for _, read := range r.reads {
		var rows int
		if err := r.dbExecutor.QueryRowContext(context.Background(), `SELECT COUNT(*) FROM (`+read.query+`)`, read.args...).Scan(&rows); err != nil {
			t.Fatal(err)
		}
		total += rows
	}
	return total
}

func TestInputAnswerReadsOnlyTheCurrentInputsEvents(t *testing.T) {
	ctx := context.Background()
	db := newTestStore(t)
	const session = "sess_answer"
	at := time.Date(2026, 10, 11, 1, 0, 0, 0, time.UTC)
	tick := func() time.Time { at = at.Add(time.Millisecond); return at }
	var inputAt time.Time
	if err := db.withTx(ctx, func(tx *Store) error {
		input := func(id string) {
			saveTestEvent(t, tx, store.AgentSessionEvent{ID: "evt_" + id, SessionID: session, Label: store.SessionInputEventLabel,
				Message: &store.TranscriptMessage{ID: id, Kind: "user", Text: id}}, tick())
		}
		assistant := func(id, text string, created time.Time) {
			saveTestEvent(t, tx, store.AgentSessionEvent{ID: id, SessionID: session, Label: "Assistant",
				Message: &store.TranscriptMessage{ID: id, Kind: "assistant", Text: text}}, created)
		}
		tools := func(prefix string, count int) {
			for index := range count {
				saveTestEvent(t, tx, store.AgentSessionEvent{ID: fmt.Sprintf("evt_%s_%04d", prefix, index), SessionID: session, Label: "Tool call", Detail: "ran"}, tick())
			}
		}
		input("in-old")
		tools("old", 3000)
		assistant("evt_old_answer", "earlier answer", tick())
		input("in-now")
		inputAt = at
		// Rows created with the input: the order puts "evt_in-now-z" ahead of
		// the input (it is read) and "evt_a" after it (it is not).
		assistant("evt_in-now-z", "tied after", inputAt)
		assistant("evt_a", "tied before", inputAt)
		saveTestEvent(t, tx, store.AgentSessionEvent{ID: "evt_stream_first", SessionID: session, Label: "Response stream", Detail: " first stream "}, tick())
		saveTestEvent(t, tx, store.AgentSessionEvent{ID: "evt_task_stream", SessionID: session, Label: "Response stream", Detail: "a task's stream",
			Metadata: &store.AgentSessionEventMetadata{TaskID: "task_1"}}, tick())
		// More events than the first chunk holds, so the walk crosses chunks.
		tools("now", 700)
		assistant("evt_last", "final answer", tick())
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	var sinceInput, total int
	if err := db.conn().QueryRowContext(ctx, `SELECT COUNT(*) FILTER (WHERE created_at >= ?), COUNT(*) FROM agent_session_events WHERE session_id = ?`,
		formatTime(inputAt), session).Scan(&sinceInput, &total); err != nil {
		t.Fatal(err)
	}

	answers := []string{"final answer", "first stream", "tied after", "tied before", "a task's stream", "earlier answer", "never said"}
	check := func(label string, bounded bool) {
		t.Helper()
		for _, answer := range answers {
			scoped, recorder := recording(db)
			got, err := scoped.inputAnswered(ctx, session, "in-now", answer)
			if err != nil {
				t.Fatalf("%s %q: %v", label, answer, err)
			}
			if want := wholeHistoryAnswered(t, db, session, "in-now", answer); got != want {
				t.Fatalf("%s %q: answered = %v, whole history says %v", label, answer, got, want)
			}
			if read := recorder.rowsRead(t); bounded && read > sinceInput {
				t.Fatalf("%s %q read %d events; %d are the input's and after, of %d", label, answer, read, sinceInput, total)
			}
		}
	}
	check("bounded", true)
	// Without its input's row the whole session is read, as before.
	if _, err := db.conn().ExecContext(ctx, `UPDATE agent_session_events SET id = 'evt_renamed' WHERE id = 'evt_in-now'`); err != nil {
		t.Fatal(err)
	}
	check("input row missing", false)
	if _, err := db.conn().ExecContext(ctx, `UPDATE agent_session_events SET id = 'evt_in-now' WHERE id = 'evt_renamed'`); err != nil {
		t.Fatal(err)
	}

	// Events before the input are never decoded: breaking them changes
	// nothing.
	breakTestEvent(t, db, "evt_old_answer")
	breakTestEvent(t, db, "evt_a")
	for answer, want := range map[string]bool{"final answer": true, "first stream": true, "tied after": true, "earlier answer": false, "never said": false} {
		if got, err := db.inputAnswered(ctx, session, "in-now", answer); err != nil || got != want {
			t.Fatalf("after breaking older events, %q: answered = %v, %v; want %v", answer, got, err, want)
		}
	}
}

// Completing records the answer the transcript lacks, and only that, while
// the session's earlier history stays unread.
func TestCompletingRecordsAMissingAnswerFromTheCurrentInputOn(t *testing.T) {
	ctx := context.Background()
	db := newTestStore(t)
	registerAgentSessionTestDaemon(t, db, "ws_answer", "agent_answer")
	session, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{WorkspaceID: "ws_answer", AgentID: "agent_answer", Provider: "codex", Prompt: "first"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.CompleteAgentSession(ctx, session.ID, "same words", ""); err != nil {
		t.Fatal(err)
	}
	next, err := db.SendAgentSessionInput(ctx, session.ID, store.SendAgentSessionInput{Prompt: "second"})
	if err != nil {
		t.Fatal(err)
	}
	breakTestEvent(t, db, "evt_"+session.Input.ID)
	breakTestEvent(t, db, "evt_"+session.Input.ID+"_answer")
	if _, err := db.CompleteAgentSession(ctx, session.ID, "same words", ""); err != nil {
		t.Fatalf("complete with broken history: %v", err)
	}
	var detail string
	if err := db.conn().QueryRowContext(ctx, `SELECT json_extract(payload_json, '$.detail') FROM agent_session_events WHERE id = ?`,
		"evt_"+next.Input.ID+"_answer").Scan(&detail); err != nil || detail != "same words" {
		t.Fatalf("answer = %q, %v; an earlier input's answer is not this one's", detail, err)
	}
}

func TestSessionConversationReadsOnlyTheTurnsItKeeps(t *testing.T) {
	ctx := context.Background()
	db := newTestStore(t)
	const session = "sess_conversation"
	at := time.Date(2026, 10, 11, 1, 0, 0, 0, time.UTC)
	tick := func() time.Time { at = at.Add(time.Millisecond); return at }
	sequence := 0
	event := func(label string, message *store.TranscriptMessage, detail string, metadata *store.AgentSessionEventMetadata) string {
		sequence++
		id := fmt.Sprintf("evt_%05d", sequence)
		saveTestEvent(t, db, store.AgentSessionEvent{ID: id, SessionID: session, Label: label, Message: message, Detail: detail, Metadata: metadata}, tick())
		return id
	}
	historyID := event("Native transcript", &store.TranscriptMessage{Kind: "user", Text: "history question"}, "", nil)
	event("Native transcript", &store.TranscriptMessage{Kind: "assistant", Text: "history answer"}, "", nil)
	var inputs []string
	for turn := 1; turn <= 40; turn++ {
		id := fmt.Sprintf("in%02d", turn)
		inputs = append(inputs, id)
		saveTestEvent(t, db, store.AgentSessionEvent{ID: "evt_" + id, SessionID: session, Label: store.SessionInputEventLabel,
			Message: &store.TranscriptMessage{ID: id, Kind: "user", Text: fmt.Sprintf("  question %d  ", turn)}}, tick())
		for range 25 {
			event("Tool call", nil, "ran", nil)
			event("Tool", &store.TranscriptMessage{Kind: "tool", Text: "output"}, "", nil)
		}
		switch turn % 5 {
		case 0: // unanswered
		case 1:
			event("Assistant", &store.TranscriptMessage{Kind: "assistant", Text: "draft"}, "", nil)
			event("Steer", &store.TranscriptMessage{Kind: "user", Text: "also this"}, "", nil)
			event("Assistant", &store.TranscriptMessage{Kind: "assistant", Text: strings.Repeat("答", 600) + fmt.Sprint(turn)}, "", nil)
		case 2:
			event("Response stream", nil, "partial", nil)
			event("Response stream", nil, strings.Repeat("streamed ", 150)+fmt.Sprint(turn), nil)
			event("Response stream", nil, "a task's", &store.AgentSessionEventMetadata{TaskID: "task"})
		case 3:
			event("Assistant", &store.TranscriptMessage{Kind: "assistant", Text: "  "}, "", nil)
			event("Assistant", &store.TranscriptMessage{Kind: "assistant", Text: strings.Repeat("words ", 250) + fmt.Sprint(turn)}, "", nil)
		case 4:
			event("Assistant", &store.TranscriptMessage{Kind: "assistant", Text: fmt.Sprint("short ", turn)}, "", nil)
			event("Steer", &store.TranscriptMessage{Kind: "user", Text: ""}, "", nil)
		}
	}

	whole := func() []store.AgentSessionEvent {
		events, err := listJSON[store.AgentSessionEvent](ctx, db.conn(), `SELECT payload_json FROM agent_session_events WHERE session_id = ? AND (`+
			transcriptEventsFilter+`) ORDER BY created_at ASC, id ASC`, session)
		if err != nil {
			t.Fatal(err)
		}
		return events
	}()
	type call struct {
		after, before string
		withHistory   bool
	}
	calls := []call{}
	for _, after := range []string{"", "in01", "in20", "in38", "in39", "in40", "unknown"} {
		for _, before := range []string{"", "in02", "in25", "in39", "in40", "fresh"} {
			calls = append(calls, call{after, before, true}, call{after, before, false})
		}
	}
	for _, c := range calls {
		got, err := db.sessionConversation(ctx, session, c.after, c.before, c.withHistory)
		if err != nil {
			t.Fatalf("%+v: %v", c, err)
		}
		if want := conversationContext(whole, c.after, c.before, c.withHistory); got != want {
			t.Fatalf("%+v:\n got %q\nwant %q", c, got, want)
		}
	}

	// The newest turns already fill the context: what a fresh native
	// session or a fork is told, and the turns since the last few inputs,
	// read nothing older.
	kept := map[call]string{}
	tail := []call{{"", "fresh", true}, {"", "", true}, {"", "in40", true}, {"in38", "fresh", false}, {"in39", "in40", false}}
	for _, c := range tail {
		kept[c] = conversationContext(whole, c.after, c.before, c.withHistory)
	}
	if !strings.HasPrefix(kept[call{"", "fresh", true}], "Earlier context truncated.") {
		t.Fatal("the transcript should run past the imported context limit")
	}
	breakTestEvent(t, db, historyID)
	breakTestEvent(t, db, "evt_in10")
	for _, c := range tail {
		if got, err := db.sessionConversation(ctx, session, c.after, c.before, c.withHistory); err != nil || got != kept[c] {
			t.Fatalf("%+v after breaking older events: %q, %v", c, got, err)
		}
	}
}

func TestStartupChecksOnlyChatsWrittenSinceTheirLastCheck(t *testing.T) {
	ctx := context.Background()
	db := newTestStore(t)
	registerTwoRuntimes(t, db, "ws_checked")
	kept := store.ChatThread{ID: "native_codex_kept", Provider: "codex", NativeSessionID: "kept", Title: "kept", UpdatedAt: "2026-10-11T01:00:00Z",
		RecentMessages: []store.ChatRecapMessage{{Role: "user", Text: "hi"}}}
	stub := store.ChatThread{ID: "native_codex_stub", Provider: "codex", NativeSessionID: "stub", Title: "stub", UpdatedAt: "2026-10-11T02:00:00Z"}
	if err := db.SyncChats(ctx, store.SyncChatsInput{WorkspaceID: "ws_checked", Chats: []store.ChatThread{kept, stub}}); err != nil {
		t.Fatal(err)
	}
	unchecked := func() []string {
		ids, err := listStrings(ctx, db.conn(), `SELECT id FROM chats WHERE `+uncheckedChatSQL+` ORDER BY id`)
		if err != nil {
			t.Fatal(err)
		}
		return ids
	}
	if got := unchecked(); strings.Join(got, ",") != "native_codex_stub" {
		t.Fatalf("unchecked = %v; a restart removes the stub, so only it waits for one", got)
	}
	var payload string
	if err := db.conn().QueryRowContext(ctx, `SELECT payload_json FROM chats WHERE id = ?`, kept.ID).Scan(&payload); err != nil {
		t.Fatal(err)
	}
	// A checked chat is not read at startup: breaking its payload in place
	// (no write moves its updated_at) changes nothing.
	if _, err := db.conn().ExecContext(ctx, `UPDATE chats SET payload_json = '{broken' WHERE id = ?`, kept.ID); err != nil {
		t.Fatal(err)
	}
	if err := db.migrateNativeSessions(ctx); err != nil {
		t.Fatalf("startup read a checked chat: %v", err)
	}
	if _, err := db.conn().ExecContext(ctx, `UPDATE chats SET payload_json = ? WHERE id = ?`, payload, kept.ID); err != nil {
		t.Fatal(err)
	}
	if got := listedChatIDs(t, db, "ws_checked"); strings.Join(got, ",") != "native_codex_kept" {
		t.Fatalf("listed = %v; the stub goes at startup", got)
	}
	// An older server rewrites the chat with its own column list and time:
	// the next start checks and repairs it, and the one after reads nothing.
	if _, err := db.conn().ExecContext(ctx, `UPDATE chats SET payload_json = json_set(payload_json, '$.workspaceId', 'ws_moved', '$.updatedAt', '2026-10-11T12:00:00+08:00'),
		updated_at = '2026-10-11T03:00:00Z' WHERE id = ?`, kept.ID); err != nil {
		t.Fatal(err)
	}
	if got := unchecked(); strings.Join(got, ",") != kept.ID {
		t.Fatalf("unchecked = %v", got)
	}
	if err := db.migrateNativeSessions(ctx); err != nil {
		t.Fatal(err)
	}
	var workspaceID, activity string
	if err := db.conn().QueryRowContext(ctx, `SELECT workspace_id, activity_at FROM chats WHERE id = ?`, kept.ID).Scan(&workspaceID, &activity); err != nil {
		t.Fatal(err)
	}
	if workspaceID != "ws_moved" || activity != "2026-10-11T04:00:00.000000000Z" || len(unchecked()) != 0 {
		t.Fatalf("repaired = %q %q, unchecked %v", workspaceID, activity, unchecked())
	}
	var before, after int64
	if err := db.conn().QueryRowContext(ctx, `SELECT total_changes()`).Scan(&before); err != nil {
		t.Fatal(err)
	}
	if err := db.migrateNativeSessions(ctx); err != nil {
		t.Fatal(err)
	}
	if err := db.conn().QueryRowContext(ctx, `SELECT total_changes()`).Scan(&after); err != nil {
		t.Fatal(err)
	}
	if after != before {
		t.Fatalf("a start on checked chats wrote %d rows", after-before)
	}
}
