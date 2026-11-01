package sqlitestore

import (
	"context"
	"database/sql"
	"slices"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func contextEvent(id string, inputTokens int64) store.AgentSessionEvent {
	window := int64(1_000_000)
	return store.AgentSessionEvent{ID: id, Label: "Model request usage", Detail: "msg_" + id, Metadata: &store.AgentSessionEventMetadata{
		RequestUsage: &store.ModelRequestUsage{RequestID: "msg_" + id, InputTokens: inputTokens},
		ContextUsage: &store.AgentContextUsage{InputTokens: &inputTokens, ContextWindow: &window, Model: "claude-opus-5-5"},
	}}
}

func turnEvent(id string, inputTokens int64) store.AgentSessionEvent {
	return store.AgentSessionEvent{ID: id, Label: "Claude Agent SDK finished", Detail: "/tmp/result.md", Metadata: &store.AgentSessionEventMetadata{
		TurnUsage: &store.AgentTurnUsage{DurationMs: 1000, InputTokens: inputTokens, OutputTokens: 10},
	}}
}

// Before a window the panel gets the newest report of the context's size,
// every turn's usage and every compaction; an older worker's request
// usage counts as a report of the size.
func TestAgentSessionStateEventsCarryUsage(t *testing.T) {
	ctx := context.Background()
	db := newTestStore(t)
	registerAgentSessionTestDaemon(t, db, "ws_usage", "agent_usage")
	session, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{WorkspaceID: "ws_usage", AgentID: "agent_usage", Provider: "codex", Prompt: "first"})
	if err != nil {
		t.Fatal(err)
	}
	legacy := store.AgentSessionEvent{ID: "evt_legacy_request", Label: "Model request usage", Metadata: &store.AgentSessionEventMetadata{RequestUsage: &store.ModelRequestUsage{RequestID: "msg_old", InputTokens: 5}}}
	compacted := store.AgentSessionEvent{ID: "evt_compacted", Label: "Model request usage", Metadata: &store.AgentSessionEventMetadata{ContextUsage: &store.AgentContextUsage{Compaction: &store.AgentContextCompaction{Trigger: "auto"}}}}
	saveStateTestEvents(t, db, session.ID, []store.AgentSessionEvent{
		legacy,
		contextEvent("evt_context_1", 1000),
		turnEvent("evt_turn_1", 3000),
		compacted,
		contextEvent("evt_context_2", 2000),
		turnEvent("evt_turn_2", 4000),
		{ID: "evt_answer", Label: "Response stream", Detail: "recent"},
		{ID: "evt_answer_2", Label: "Response stream", Detail: "recent"},
	})
	window, before, err := db.AgentSessionEventWindow(ctx, session.ID, "", 2)
	if err != nil || before == "" || len(window) != 2 {
		t.Fatalf("window = %d events, cursor %q, %v", len(window), before, err)
	}
	state, err := db.AgentSessionStateEvents(ctx, session.ID, before)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"evt_turn_1", "evt_compacted", "evt_context_2", "evt_turn_2"}
	if got := eventIDs(state); !slices.Equal(got, want) {
		t.Fatalf("state events = %v\nwant %v", got, want)
	}
	for event, key := range map[string]string{
		"evt_legacy_request": store.SessionStateContext,
		"evt_context_1":      store.SessionStateContext,
		"evt_turn_1":         store.SessionStateTurn + "evt_turn_1",
		"evt_compacted":      store.SessionStateCompaction + "evt_compacted",
	} {
		if got := stateKeyForTest(t, db, event); got != key {
			t.Fatalf("%s key = %q, want %q", event, got, key)
		}
	}
}

// Turn usage read back from the agent's log makes the turn's event a
// state event.
func TestBackfilledTurnUsageIsKeyed(t *testing.T) {
	ctx := context.Background()
	db := newTestStore(t)
	registerAgentSessionTestDaemon(t, db, "ws_backfill_key", "agent_backfill_key")
	session, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{WorkspaceID: "ws_backfill_key", AgentID: "agent_backfill_key", Provider: "codex", Prompt: "first"})
	if err != nil {
		t.Fatal(err)
	}
	saveStateTestEvents(t, db, session.ID, []store.AgentSessionEvent{
		{ID: "evt_finished", Label: "Claude Agent SDK finished", Detail: "/tmp/result.md"},
	})
	if got := stateKeyForTest(t, db, "evt_finished"); got != "" {
		t.Fatalf("key before the backfill = %q", got)
	}
	if err := db.BackfillAgentSessionUsage(ctx, session.ID, map[string]store.AgentTurnUsage{"evt_finished": {DurationMs: 10, InputTokens: 100}}, nil); err != nil {
		t.Fatal(err)
	}
	if got := stateKeyForTest(t, db, "evt_finished"); got != store.SessionStateTurn+"evt_finished" {
		t.Fatalf("key after the backfill = %q", got)
	}
}

func stateKeyForTest(t *testing.T, db *Store, eventID string) string {
	t.Helper()
	var key sql.NullString
	if err := db.conn().QueryRowContext(context.Background(), `SELECT state_key FROM agent_session_events WHERE id = ?`, eventID).Scan(&key); err != nil {
		t.Fatal(err)
	}
	return key.String
}
