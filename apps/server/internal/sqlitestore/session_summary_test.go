package sqlitestore

import (
	"context"
	"strings"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func TestRoutingSummaryDoesNotReadTranscriptEvents(t *testing.T) {
	db := newTestStore(t)
	ctx := context.Background()
	registerAgentSessionTestDaemon(t, db, "ws_summary", "agent_summary")
	session, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{WorkspaceID: "ws_summary", AgentID: "agent_summary", Provider: "codex", Prompt: "hello", ImportedContext: "large private history"})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AppendAgentSessionEvent(ctx, store.AgentSessionEvent{ID: "event_summary", SessionID: session.ID, Label: "tool", Detail: "detail"}); err != nil {
		t.Fatal(err)
	}
	// If the routing path accidentally attaches events, malformed historical
	// detail will fail decoding. Listing identity must remain independent.
	if _, err := db.conn().ExecContext(ctx, `UPDATE agent_session_events SET payload_json='invalid' WHERE session_id=?`, session.ID); err != nil {
		t.Fatal(err)
	}
	summary, err := db.GetAgentSessionSummary(ctx, session.ID)
	if err != nil {
		t.Fatal(err)
	}
	if summary.ID != session.ID || summary.DeviceID != session.DeviceID || summary.WorkspaceID != session.WorkspaceID || len(summary.Events) != 0 || summary.Input.ImportedContext != "" {
		t.Fatalf("incorrect routing summary: %#v", summary)
	}
	if _, err := db.GetAgentSession(ctx, session.ID); err == nil {
		t.Fatal("detail unexpectedly skipped events")
	}
}

// A parent's list of children leaves out what a child was handed, as every
// other session list does.
func TestChildSessionListLeavesOutImportedContext(t *testing.T) {
	db := newTestStore(t)
	ctx := context.Background()
	registerAgentSessionTestDaemon(t, db, "ws_children", "agent_children")
	parent, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{WorkspaceID: "ws_children", AgentID: "agent_children", Provider: "codex", Prompt: "parent"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{
		WorkspaceID: "ws_children", AgentID: "agent_children", Provider: "codex", Prompt: "child",
		ParentSessionID: parent.ID, ImportedContext: "large private history", ProfileTransitionNote: "switched profile",
	}); err != nil {
		t.Fatal(err)
	}
	children, err := db.ListAgentSessionChildren(ctx, "ws_children", parent.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(children) != 1 || children[0].Input.ImportedContext != "" || children[0].Input.ProfileTransitionNote != "" {
		t.Fatalf("children = %#v", children)
	}
}

// ActiveAgentSessions lists the running and blocked sessions of every
// workspace (what a silent device can leave stale), with their last activity,
// and reads them through the partial index rather than the whole table.
func TestActiveAgentSessionsListsRunningAndBlockedSessions(t *testing.T) {
	db := newTestStore(t)
	ctx := context.Background()
	registerAgentSessionTestDaemon(t, db, "ws_active_a", "agent_active_a")
	registerAgentSessionTestDaemon(t, db, "ws_active_b", "agent_active_b")
	create := func(workspaceID, agentID string) store.AgentSession {
		t.Helper()
		session, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{WorkspaceID: workspaceID, AgentID: agentID, Provider: "codex", Prompt: "work"})
		if err != nil {
			t.Fatal(err)
		}
		return session
	}
	queued := create("ws_active_a", "agent_active_a")
	running := create("ws_active_a", "agent_active_a")
	if _, err := db.StartAgentSession(ctx, running.ID); err != nil {
		t.Fatal(err)
	}
	blocked := create("ws_active_b", "agent_active_b")
	if _, err := db.StartAgentSession(ctx, blocked.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.BlockAgentSession(ctx, blocked.ID, "waiting"); err != nil {
		t.Fatal(err)
	}
	done := create("ws_active_b", "agent_active_b")
	if _, err := db.StartAgentSession(ctx, done.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.CompleteAgentSession(ctx, done.ID, "answer", ""); err != nil {
		t.Fatal(err)
	}
	sessions, err := db.ActiveAgentSessions(ctx)
	if err != nil {
		t.Fatal(err)
	}
	got := []string{}
	for _, session := range sessions {
		if session.LastActivityAt == "" || session.Events != nil {
			t.Fatalf("session %s: lastActivityAt %q, %d events; want the activity time and no events", session.ID, session.LastActivityAt, len(session.Events))
		}
		got = append(got, session.ID+" "+session.Status)
	}
	want := []string{running.ID + " running", blocked.ID + " blocked"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("active sessions = %v, want %v (not %s queued, not %s completed)", got, want, queued.ID, done.ID)
	}

	rows, err := db.conn().QueryContext(ctx, `EXPLAIN QUERY PLAN SELECT id FROM agent_sessions WHERE status IN ('running','blocked') AND `+visibleAgentSessionSQL+` ORDER BY created_at`)
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
	if !strings.Contains(strings.Join(plan, "\n"), "idx_agent_sessions_active") {
		t.Fatalf("the active sessions are read by scanning the table: %v", plan)
	}
}
