package sqlitestore

import (
	"context"
	"strings"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// DEV-072: a message stopped before its turn started never reached the
// agent; the next turn must still tell it what the person sent.
func TestNextInputCarriesAMessageCanceledBeforeItStarted(t *testing.T) {
	ctx := context.Background()
	db := newTestStore(t)
	registerTwoRuntimes(t, db, "ws_cancel")
	session, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{WorkspaceID: "ws_cancel", AgentID: "agent_claude", Provider: "claude", Prompt: "first"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.StartAgentSession(ctx, session.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.CompleteAgentSession(ctx, session.ID, "answer", "native_a"); err != nil {
		t.Fatal(err)
	}
	held, err := db.SendAgentSessionInput(ctx, session.ID, store.SendAgentSessionInput{Prompt: "please look at the Services panel"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.CancelAgentSession(ctx, held.ID, "Session canceled before it started."); err != nil {
		t.Fatal(err)
	}
	next, err := db.SendAgentSessionInput(ctx, session.ID, store.SendAgentSessionInput{Prompt: "why did it wait so long?"})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(next.Input.ImportedContext, "please look at the Services panel") {
		t.Fatalf("imported context %q lacks the canceled message", next.Input.ImportedContext)
	}
}
