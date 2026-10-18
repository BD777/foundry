package sqlitestore

import (
	"context"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// inputEventSender is the sender the transcript event of input names.
func inputEventSender(t *testing.T, db *Store, sessionID, inputID string) string {
	t.Helper()
	session, err := db.GetAgentSession(context.Background(), sessionID)
	if err != nil {
		t.Fatal(err)
	}
	for _, event := range session.Events {
		if event.ID == "evt_"+inputID {
			if event.Metadata == nil {
				return ""
			}
			return event.Metadata.SentBySessionID
		}
	}
	t.Fatalf("no event for input %s in %+v", inputID, session.Events)
	return ""
}

func TestMessagesAnotherSessionSentNameIt(t *testing.T) {
	ctx := context.Background()
	db := newTestStore(t)
	registerAgentSessionTestDaemon(t, db, "ws_sender", "agent_sender")
	parent, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{WorkspaceID: "ws_sender", AgentID: "agent_sender", Provider: "codex", Prompt: "plan"})
	if err != nil {
		t.Fatal(err)
	}
	child, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{WorkspaceID: "ws_sender", AgentID: "agent_sender", Provider: "codex",
		Prompt: "research", ParentSessionID: parent.ID, Source: "agent"})
	if err != nil {
		t.Fatal(err)
	}
	if got := inputEventSender(t, db, child.ID, child.Input.ID); got != parent.ID {
		t.Fatalf("first message of a started session names %q, want its parent %q", got, parent.ID)
	}
	if got := inputEventSender(t, db, parent.ID, parent.Input.ID); got != "" {
		t.Fatalf("the person's message names %q, want no sender", got)
	}

	if _, err := db.CompleteAgentSession(ctx, child.ID, "done", "native_child"); err != nil {
		t.Fatal(err)
	}
	next, err := db.SendAgentSessionInput(ctx, child.ID, store.SendAgentSessionInput{Prompt: "more", SentBySessionID: parent.ID})
	if err != nil {
		t.Fatal(err)
	}
	if next.Input.SentBySessionID != parent.ID {
		t.Fatalf("input = %+v, want it to name its sender", next.Input)
	}
	if got := inputEventSender(t, db, child.ID, next.Input.ID); got != parent.ID {
		t.Fatalf("sent message names %q, want %q", got, parent.ID)
	}
	if _, err := db.CompleteAgentSession(ctx, child.ID, "done again", "native_child"); err != nil {
		t.Fatal(err)
	}
	typed, err := db.SendAgentSessionInput(ctx, child.ID, store.SendAgentSessionInput{Prompt: "from the person"})
	if err != nil {
		t.Fatal(err)
	}
	if got := inputEventSender(t, db, child.ID, typed.Input.ID); got != "" {
		t.Fatalf("typed message names %q, want no sender", got)
	}
}

func TestSteeredMessageSendersAreKeptPerInput(t *testing.T) {
	ctx := context.Background()
	db := newTestStore(t)
	if got, err := db.SessionInputSender(ctx, "sess_target", "input_1"); err != nil || got != "" {
		t.Fatalf("unrecorded sender = %q, %v; want none", got, err)
	}
	if err := db.RecordSessionInputSender(ctx, "sess_target", "input_1", "sess_sender"); err != nil {
		t.Fatal(err)
	}
	// A retried steer keeps the sender that sent it first.
	if err := db.RecordSessionInputSender(ctx, "sess_target", "input_1", "sess_other"); err != nil {
		t.Fatal(err)
	}
	if got, err := db.SessionInputSender(ctx, "sess_target", "input_1"); err != nil || got != "sess_sender" {
		t.Fatalf("sender = %q, %v; want sess_sender", got, err)
	}
	if got, _ := db.SessionInputSender(ctx, "sess_elsewhere", "input_1"); got != "" {
		t.Fatalf("another session's input names %q, want none", got)
	}
	if err := db.RecordSessionInputSender(ctx, "sess_target", "", "sess_sender"); err == nil {
		t.Fatal("recording a sender without an input succeeded")
	}
}
