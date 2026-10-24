package sqlitestore

import (
	"context"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"testing"
)

func TestWorkerFailureMetadataSurvivesSessionHistory(t *testing.T) {
	ctx := context.Background()
	db := newTestStore(t)
	registerAgentSessionTestDaemon(t, db, "ws_failure", "agent_failure")
	session, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{WorkspaceID: "ws_failure", AgentID: "agent_failure", Provider: "codex", Prompt: "test"})
	if err != nil {
		t.Fatal(err)
	}
	failure := &store.WorkerFailure{Version: 1, Code: "execution_host_stopped", InputID: "input_test"}
	err = db.AppendAgentSessionEvent(ctx, store.AgentSessionEvent{ID: "evt_failure", SessionID: session.ID, Label: "Session failed", Level: "error", Detail: "original failure", Metadata: &store.AgentSessionEventMetadata{WorkerFailure: failure}})
	if err != nil {
		t.Fatal(err)
	}
	loaded, err := db.GetAgentSession(ctx, session.ID)
	if err != nil {
		t.Fatal(err)
	}
	for _, event := range loaded.Events {
		if event.ID == "evt_failure" {
			if event.Metadata == nil || event.Metadata.WorkerFailure == nil || *event.Metadata.WorkerFailure != *failure {
				t.Fatalf("diagnosis lost: %+v", event)
			}
			return
		}
	}
	t.Fatal("failure event missing")
}
