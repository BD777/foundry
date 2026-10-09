package sqlitestore

import (
	"context"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// Backfilled usage lands on the events that lacked it, keeps what they had,
// and marks the session so its log is read once.
func TestBackfillAgentSessionUsageStoresOnce(t *testing.T) {
	ctx := context.Background()
	db := newTestStore(t)
	registerAgentSessionTestDaemon(t, db, "ws_usage", "agent_usage")
	session, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{WorkspaceID: "ws_usage", AgentID: "agent_usage", Provider: "codex", Prompt: "first"})
	if err != nil {
		t.Fatal(err)
	}
	live := &store.AgentTurnUsage{InputTokens: 1}
	for _, event := range []store.AgentSessionEvent{
		{ID: "evt_tool", SessionID: session.ID, Label: "Used tool", Message: &store.TranscriptMessage{ID: "m", Kind: "tool", CallID: "call_1"}},
		{ID: "evt_old", SessionID: session.ID, Label: "Codex SDK finished"},
		{ID: "evt_live", SessionID: session.ID, Label: "Codex SDK finished", Metadata: &store.AgentSessionEventMetadata{TurnUsage: live}},
	} {
		if err := db.AppendAgentSessionEvent(ctx, event); err != nil {
			t.Fatal(err)
		}
	}
	if done, _ := db.SessionUsageBackfilled(ctx, session.ID); done {
		t.Fatal("not backfilled yet")
	}
	err = db.BackfillAgentSessionUsage(ctx, session.ID,
		map[string]store.AgentTurnUsage{"evt_old": {InputTokens: 500}, "evt_live": {InputTokens: 900}},
		map[string]store.ModelRequestUsage{"evt_tool": {RequestID: "codex:1", InputTokens: 40}})
	if err != nil {
		t.Fatal(err)
	}
	loaded, err := db.GetAgentSession(ctx, session.ID)
	if err != nil {
		t.Fatal(err)
	}
	byID := map[string]store.AgentSessionEvent{}
	for _, event := range loaded.Events {
		byID[event.ID] = event
	}
	if byID["evt_old"].Metadata == nil || byID["evt_old"].Metadata.TurnUsage.InputTokens != 500 {
		t.Fatalf("old turn = %+v", byID["evt_old"].Metadata)
	}
	if byID["evt_live"].Metadata.TurnUsage.InputTokens != 1 {
		t.Fatal("live usage was overwritten")
	}
	if byID["evt_tool"].Message.RequestUsage == nil || byID["evt_tool"].Message.RequestUsage.InputTokens != 40 {
		t.Fatalf("tool step = %+v", byID["evt_tool"].Message)
	}
	if byID["evt_tool"].Message.CallID != "call_1" {
		t.Fatal("the step's own fields changed")
	}
	if done, _ := db.SessionUsageBackfilled(ctx, session.ID); !done {
		t.Fatal("the session is not marked")
	}
}
