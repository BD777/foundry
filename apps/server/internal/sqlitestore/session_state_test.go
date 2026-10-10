package sqlitestore

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// saveStateTestEvents stores events a second apart, in order, after the
// session's input.
func saveStateTestEvents(t *testing.T, db *Store, sessionID string, events []store.AgentSessionEvent) {
	t.Helper()
	base := time.Now().UTC().Add(time.Minute)
	for index, event := range events {
		event.SessionID = sessionID
		if event.Level == "" {
			event.Level = "info"
		}
		if err := db.saveAgentSessionEvent(context.Background(), event, base.Add(time.Duration(index)*time.Second)); err != nil {
			t.Fatal(err)
		}
	}
}

func timersEvent(id string, taskIDs ...string) store.AgentSessionEvent {
	tasks := []store.AgentScheduledTask{}
	for _, taskID := range taskIDs {
		tasks = append(tasks, store.AgentScheduledTask{ID: taskID, Kind: "cron", Schedule: "28,58 * * * *", Recurring: true, Prompt: "patrol"})
	}
	return store.AgentSessionEvent{ID: id, Label: "Scheduled tasks updated", Metadata: &store.AgentSessionEventMetadata{TimerSnapshot: &tasks}}
}

func taskEvent(id, label, taskID, taskType, detail string) store.AgentSessionEvent {
	return store.AgentSessionEvent{ID: id, Label: label, Detail: detail, Metadata: &store.AgentSessionEventMetadata{TaskID: taskID, TaskType: taskType}}
}

// The side panel's state older than a window comes back one event per
// state key: the newest snapshot and task progress, every recorded file,
// a subagent's start, and the first load of each workspace; a background
// command's progress and the transcript itself do not.
func TestAgentSessionStateEventsBeforeAWindow(t *testing.T) {
	ctx := context.Background()
	db := newTestStore(t)
	registerAgentSessionTestDaemon(t, db, "ws_state", "agent_state")
	session, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{WorkspaceID: "ws_state", AgentID: "agent_state", Provider: "codex", Prompt: "first"})
	if err != nil {
		t.Fatal(err)
	}
	background := func(id, status string) store.AgentSessionEvent {
		tasks := []store.AgentBackgroundTask{{ID: "bg1", Kind: "command", Status: status}}
		return store.AgentSessionEvent{ID: id, Label: "Background tasks updated", Metadata: &store.AgentSessionEventMetadata{BackgroundTaskSnapshot: &tasks}}
	}
	file := func(id, path string) store.AgentSessionEvent {
		return store.AgentSessionEvent{ID: id, Label: "Recorded file", Detail: path, Metadata: &store.AgentSessionEventMetadata{SessionFile: &store.SessionFileRecord{Path: path, Op: "created", Origin: "tool"}}}
	}
	workspace := func(id, path string) store.AgentSessionEvent {
		return store.AgentSessionEvent{ID: id, Label: "Loaded workspace", Detail: path}
	}
	events := []store.AgentSessionEvent{
		workspace("evt_ws_a", "/repo/a"),
		timersEvent("evt_timers_old", "t_old"),
		background("evt_bg_old", "running"),
		file("evt_file_1", "/repo/a/one.go"),
		taskEvent("evt_sub_start", "Starting subtask", "agent_1", "local_agent", "Review the change"),
		taskEvent("evt_sub_progress_1", "Subtask running", "agent_1", "", "reading"),
		taskEvent("evt_bash_start", "Starting subtask", "bash_1", "local_bash", "npm test"),
		taskEvent("evt_bash_end", "Subtask completed", "bash_1", "", "exit 0"),
		{ID: "evt_answer", Label: "Response stream", Detail: "an answer"},
		timersEvent("evt_timers_new", "t_new"),
		background("evt_bg_new", "completed"),
		file("evt_file_2", "/repo/a/two.go"),
		taskEvent("evt_sub_progress_2", "Subtask running", "agent_1", "", "writing"),
		workspace("evt_ws_b", "/repo/b"),
		workspace("evt_ws_a_again", "/repo/a"),
	}
	for index := range 4 {
		events = append(events, store.AgentSessionEvent{ID: fmt.Sprintf("evt_recent_%d", index), Label: "Response stream", Detail: "recent"})
	}
	saveStateTestEvents(t, db, session.ID, events)

	window, before, err := db.AgentSessionEventWindow(ctx, session.ID, "", 4)
	if err != nil || before == "" || len(window) != 4 {
		t.Fatalf("window = %d events, cursor %q, %v", len(window), before, err)
	}
	state, err := db.AgentSessionStateEvents(ctx, session.ID, before)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"evt_ws_a", "evt_file_1", "evt_sub_start", "evt_timers_new", "evt_bg_new", "evt_file_2", "evt_sub_progress_2", "evt_ws_b"}
	if got := eventIDs(state); !slices.Equal(got, want) {
		t.Fatalf("state events = %v\nwant %v", got, want)
	}

	// The cursor bounds them: before the newest snapshot only the older one counts.
	older, cursor, err := db.AgentSessionEventWindow(ctx, session.ID, before, 7)
	if err != nil || len(older) == 0 || older[0].ID != "evt_answer" {
		t.Fatalf("page = %v, %v; the test expects it to start at evt_answer", eventIDs(older), err)
	}
	state, err = db.AgentSessionStateEvents(ctx, session.ID, cursor)
	if err != nil {
		t.Fatal(err)
	}
	want = []string{"evt_ws_a", "evt_timers_old", "evt_bg_old", "evt_file_1", "evt_sub_start", "evt_sub_progress_1"}
	if got := eventIDs(state); !slices.Equal(got, want) {
		t.Fatalf("state events before %s = %v\nwant %v", older[0].ID, got, want)
	}
	if _, err := db.AgentSessionStateEvents(ctx, session.ID, "not a cursor"); !errors.Is(err, store.ErrInvalidEventsCursor) {
		t.Fatalf("bad cursor: err = %v", err)
	}
}

// The state keys are read from the partial state index alone, with or
// without a cursor.
func TestAgentSessionStateKeysUseTheStateIndex(t *testing.T) {
	db := newTestStore(t)
	for _, paged := range []bool{false, true} {
		args := []any{"sess"}
		if paged {
			args = append(args, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z", 1)
		}
		rows, err := db.conn().QueryContext(context.Background(), "EXPLAIN QUERY PLAN "+sessionStateKeysQuery(paged), args...)
		if err != nil {
			t.Fatal(err)
		}
		var plan []string
		for rows.Next() {
			var id, parent, unused int
			var detail string
			if err := rows.Scan(&id, &parent, &unused, &detail); err != nil {
				t.Fatal(err)
			}
			plan = append(plan, detail)
		}
		rows.Close()
		joined := strings.Join(plan, "; ")
		if !strings.Contains(joined, "COVERING INDEX idx_agent_session_events_state") {
			t.Fatalf("paged=%v plan = %s; want the covering state index", paged, joined)
		}
	}
}

// A database from before the state column gets the keys of the events it
// holds when the column is added.
func TestSessionStateKeysAreBackfilled(t *testing.T) {
	ctx := context.Background()
	db := newTestStore(t)
	registerAgentSessionTestDaemon(t, db, "ws_backfill", "agent_backfill")
	session, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{WorkspaceID: "ws_backfill", AgentID: "agent_backfill", Provider: "codex", Prompt: "first"})
	if err != nil {
		t.Fatal(err)
	}
	saveStateTestEvents(t, db, session.ID, []store.AgentSessionEvent{
		timersEvent("evt_backfill_timers", "t1"),
		taskEvent("evt_backfill_sub", "Starting subtask", "agent_1", "local_agent", "Review"),
		{ID: "evt_backfill_answer", Label: "Response stream", Detail: "an answer"},
	})
	for _, statement := range []string{
		`DROP INDEX idx_agent_session_events_state`,
		`DROP INDEX idx_agent_session_events_unkeyed`,
		`ALTER TABLE agent_session_events DROP COLUMN state_key`,
	} {
		if _, err := db.conn().ExecContext(ctx, statement); err != nil {
			t.Fatal(err)
		}
	}
	if err := db.migrateSessionStateKeys(ctx); err != nil {
		t.Fatal(err)
	}
	keys := map[string]string{}
	if err := scanRows(ctx, db.conn(), `SELECT id, state_key FROM agent_session_events WHERE session_id = ?`, func(rows *sql.Rows) error {
		var id, key string
		if err := rows.Scan(&id, &key); err != nil {
			return err
		}
		keys[id] = key
		return nil
	}, session.ID); err != nil {
		t.Fatal(err)
	}
	if keys["evt_backfill_timers"] != "timers" || keys["evt_backfill_sub"] != "subagent:agent_1" || keys["evt_backfill_answer"] != "" {
		t.Fatalf("backfilled keys = %v", keys)
	}
}

// Events a binary unaware of the column wrote (after a downgrade) get their
// keys on the next start; one whose payload does not decode is logged and
// gets none, and the start goes on. A database whose column an earlier
// build made NOT NULL gets it again, computed.
func TestSessionStateKeysAreFilledOnEveryStart(t *testing.T) {
	ctx := context.Background()
	db := newTestStore(t)
	registerAgentSessionTestDaemon(t, db, "ws_downgrade", "agent_downgrade")
	session, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{WorkspaceID: "ws_downgrade", AgentID: "agent_downgrade", Provider: "codex", Prompt: "first"})
	if err != nil {
		t.Fatal(err)
	}
	saveStateTestEvents(t, db, session.ID, []store.AgentSessionEvent{timersEvent("evt_new_timers", "t1")})
	older := func(id, payload string) {
		t.Helper()
		if _, err := db.conn().ExecContext(ctx, `INSERT INTO agent_session_events (id, session_id, level, payload_json, created_at) VALUES (?, ?, 'info', ?, '2026-10-10T00:00:00Z')`, id, session.ID, payload); err != nil {
			t.Fatal(err)
		}
	}
	timers, err := json.Marshal(timersEvent("evt_old_timers", "t2"))
	if err != nil {
		t.Fatal(err)
	}
	older("evt_old_timers", string(timers))
	older("evt_unreadable", `{"id":`)
	keys := func() map[string]any {
		t.Helper()
		found := map[string]any{}
		if err := scanRows(ctx, db.conn(), `SELECT id, state_key FROM agent_session_events WHERE session_id = ?`, func(rows *sql.Rows) error {
			var id string
			var key sql.NullString
			if err := rows.Scan(&id, &key); err != nil {
				return err
			}
			if key.Valid {
				found[id] = key.String
			} else {
				found[id] = nil
			}
			return nil
		}, session.ID); err != nil {
			t.Fatal(err)
		}
		return found
	}
	if got := keys(); got["evt_old_timers"] != nil || got["evt_new_timers"] != "timers" {
		t.Fatalf("before the start: %v", got)
	}
	if err := db.migrateSessionStateKeys(ctx); err != nil {
		t.Fatalf("a start with an unreadable event: %v", err)
	}
	if got := keys(); got["evt_old_timers"] != "timers" || got["evt_unreadable"] != "" || got["evt_new_timers"] != "timers" {
		t.Fatalf("after the start: %v", got)
	}

	for _, statement := range []string{
		`DROP INDEX idx_agent_session_events_state`,
		`DROP INDEX idx_agent_session_events_unkeyed`,
		`ALTER TABLE agent_session_events DROP COLUMN state_key`,
		`ALTER TABLE agent_session_events ADD COLUMN state_key TEXT NOT NULL DEFAULT ''`,
	} {
		if _, err := db.conn().ExecContext(ctx, statement); err != nil {
			t.Fatal(err)
		}
	}
	if err := db.migrateSessionStateKeys(ctx); err != nil {
		t.Fatal(err)
	}
	var notNull int
	if err := db.conn().QueryRowContext(ctx, `SELECT "notnull" FROM pragma_table_info('agent_session_events') WHERE name = 'state_key'`).Scan(&notNull); err != nil || notNull != 0 {
		t.Fatalf("state_key not null = %d (%v), want a nullable column", notNull, err)
	}
	if got := keys(); got["evt_old_timers"] != "timers" || got["evt_new_timers"] != "timers" {
		t.Fatalf("after recreating the column: %v", got)
	}
}
