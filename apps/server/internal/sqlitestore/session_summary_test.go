package sqlitestore

import (
	"context"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"testing"
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
	if summary.ID != session.ID || summary.DeviceID != session.DeviceID || summary.WorkspaceID != session.WorkspaceID || len(summary.Events) != 0 || summary.ImportedContext != "" {
		t.Fatalf("incorrect routing summary: %#v", summary)
	}
	if _, err := db.GetAgentSession(ctx, session.ID); err == nil {
		t.Fatal("detail unexpectedly skipped events")
	}
}
