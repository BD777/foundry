package sqlitestore

import (
	"context"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"testing"
)

func TestInputCompletionReplayIsIdempotentAndFenced(t *testing.T) {
	db := newTestStore(t)
	ctx := context.Background()
	registerAgentSessionTestDaemon(t, db, "ws_completion", "agent_completion")
	s, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{WorkspaceID: "ws_completion", AgentID: "agent_completion", Provider: "codex", Prompt: "one"})
	if err != nil {
		t.Fatal(err)
	}
	done, applied, err := db.SettleAgentSessionInput(ctx, s.ID, s.Input.ID, "complete saved answer", "native_kept", "")
	if err != nil || !applied || done.Status != "completed" {
		t.Fatalf("first settlement: applied=%v status=%s err=%v", applied, done.Status, err)
	}
	if len(done.Events) != 1 || done.Events[0].Detail != done.Response {
		t.Fatal("completion's persisted answer must be available for streaming")
	}
	repeated, applied, err := db.SettleAgentSessionInput(ctx, s.ID, s.Input.ID, "different replay", "native_wrong", "")
	if err != nil || applied || len(repeated.Events) != 0 || repeated.Response != done.Response || repeated.NativeSessionID != done.NativeSessionID || repeated.CompletedAt != done.CompletedAt {
		t.Fatalf("replay changed completion: applied=%v err=%v", applied, err)
	}
	next, err := db.SendAgentSessionInput(ctx, s.ID, store.SendAgentSessionInput{Prompt: "two"})
	if err != nil {
		t.Fatal(err)
	}
	for _, failure := range []string{"", "old failure"} {
		current, applied, err := db.SettleAgentSessionInput(ctx, s.ID, s.Input.ID, "old answer", "native_wrong", failure)
		if err != nil || applied || current.Input.ID != next.Input.ID || current.Status != "queued" || current.Response != "" || current.Error != "" {
			t.Fatalf("stale result changed new input: applied=%v status=%s err=%v", applied, current.Status, err)
		}
	}
}
