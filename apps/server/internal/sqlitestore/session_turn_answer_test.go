package sqlitestore

import (
	"context"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// A new input never carries the previous input's answer: published with the
// session, a stale answer reads as the current one.
func TestNewInputClearsThePreviousAnswer(t *testing.T) {
	ctx := context.Background()
	db := newTestStore(t)
	registerAgentSessionTestDaemon(t, db, "ws_turn", "agent_turn")
	session, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{WorkspaceID: "ws_turn", AgentID: "agent_turn", Provider: "codex", Prompt: "first"})
	if err != nil {
		t.Fatal(err)
	}
	completed, err := db.CompleteAgentSession(ctx, session.ID, "first answer", "native_turn")
	if err != nil || completed.AnswerRevision == "" {
		t.Fatalf("complete = %+v, %v", completed, err)
	}
	next, err := db.SendAgentSessionInput(ctx, session.ID, store.SendAgentSessionInput{Prompt: "second"})
	if err != nil {
		t.Fatal(err)
	}
	stored, err := db.GetAgentSessionRecord(ctx, session.ID)
	if err != nil {
		t.Fatal(err)
	}
	for _, value := range []store.AgentSession{next, stored} {
		if value.Response != "" || value.AnswerRevision != "" || value.Error != "" {
			t.Fatalf("queued input = response %q revision %q error %q; want the previous answer cleared", value.Response, value.AnswerRevision, value.Error)
		}
	}
	started, err := db.StartAgentSession(ctx, session.ID)
	if err != nil || started.Status != "running" || started.Response != "" || started.AnswerRevision != "" {
		t.Fatalf("started = %+v, %v", started, err)
	}
}

// Starting a queued input clears an answer the row still holds (a row
// written before inputs cleared it, or by any other path).
func TestStartingAnInputClearsAStaleAnswer(t *testing.T) {
	ctx := context.Background()
	db := newTestStore(t)
	registerAgentSessionTestDaemon(t, db, "ws_stale", "agent_stale")
	session, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{WorkspaceID: "ws_stale", AgentID: "agent_stale", Provider: "codex", Prompt: "first"})
	if err != nil {
		t.Fatal(err)
	}
	session.Response, session.Error, session.AnswerRevision = "old answer", "old error", "old revision"
	if err := db.saveAgentSession(ctx, session, time.Time{}, time.Now().UTC()); err != nil {
		t.Fatal(err)
	}
	started, err := db.StartAgentSession(ctx, session.ID)
	if err != nil {
		t.Fatal(err)
	}
	stored, err := db.GetAgentSessionRecord(ctx, session.ID)
	if err != nil {
		t.Fatal(err)
	}
	for _, value := range []store.AgentSession{started, stored} {
		if value.Status != "running" || value.Response != "" || value.Error != "" || value.AnswerRevision != "" {
			t.Fatalf("started = %+v; want running without the stale answer", value)
		}
	}
	// A repeated start of the running input keeps what it has.
	if again, err := db.StartAgentSession(ctx, session.ID); err != nil || again.Status != "running" {
		t.Fatalf("restart = %+v, %v", again, err)
	}
}

// Status changes load and return the session row only, never its
// transcript: a long chat has thousands of events.
func TestSessionTransitionsLeaveTheTranscriptOut(t *testing.T) {
	ctx := context.Background()
	db := newTestStore(t)
	registerAgentSessionTestDaemon(t, db, "ws_slim", "agent_slim")
	session, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{WorkspaceID: "ws_slim", AgentID: "agent_slim", Provider: "codex", Prompt: "first"})
	if err != nil {
		t.Fatal(err)
	}
	for index := 0; index < 3; index++ {
		if err := db.AppendAgentSessionEvent(ctx, store.AgentSessionEvent{ID: "evt_" + string(rune('a'+index)), SessionID: session.ID, Label: "Thinking", Level: "info"}); err != nil {
			t.Fatal(err)
		}
	}
	started, err := db.StartAgentSession(ctx, session.ID)
	if err != nil {
		t.Fatal(err)
	}
	native, err := db.SetAgentSessionNativeSessionID(ctx, session.ID, "native_slim")
	if err != nil {
		t.Fatal(err)
	}
	completed, err := db.CompleteAgentSession(ctx, session.ID, "answer", "native_slim")
	if err != nil {
		t.Fatal(err)
	}
	for _, value := range []store.AgentSession{started, native, completed} {
		if len(value.Events) != 0 {
			t.Fatalf("transition returned %d events", len(value.Events))
		}
	}
	full, err := db.GetAgentSession(ctx, session.ID)
	if err != nil || len(full.Events) < 3 || full.Response != "answer" {
		t.Fatalf("full read = %d events, %q, %v; want the transcript and answer", len(full.Events), full.Response, err)
	}
}
