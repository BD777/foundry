package sqlitestore

import (
	"context"
	"errors"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func TestAssistantRunSnapshotCannotChangeAfterIntentIsPinned(t *testing.T) {
	db, ctx := newTestStore(t), context.Background()
	input := store.PersonalAgentRunSnapshot{ID: "run-1", UserID: "person", Role: "coordinator", WorkspaceID: "ws-own", DeviceID: "device-a", Runtime: "codex", ProfileID: "local", Model: "model-a", ConfigHash: "configuration-a"}
	saved, err := db.RecordPersonalAgentRunSnapshot(ctx, input)
	if err != nil {
		t.Fatal(err)
	}
	retry, err := db.RecordPersonalAgentRunSnapshot(ctx, input)
	if err != nil || retry.CreatedAt != saved.CreatedAt {
		t.Fatalf("retry changed snapshot: %+v %v", retry, err)
	}
	input.Model = "different-model"
	if _, err := db.RecordPersonalAgentRunSnapshot(ctx, input); !errors.Is(err, store.ErrIdempotencyConflict) {
		t.Fatalf("model changed under a pinned operation: %v", err)
	}
	if err := db.BindPersonalAgentRunSnapshot(ctx, "person", input.ID, "session-1"); err != nil {
		t.Fatal(err)
	}
	if err := db.BindPersonalAgentRunSnapshot(ctx, "person", input.ID, "session-2"); !errors.Is(err, store.ErrPersonalAgentRevision) {
		t.Fatalf("operation rebound: %v", err)
	}
	if _, err := db.GetPersonalAgentRunSnapshot(ctx, "someone-else", input.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("snapshot crossed users: %v", err)
	}
}

func TestAssistantNativeEndRequiresExactInputReceipt(t *testing.T) {
	for _, exact := range []bool{false, true} {
		t.Run(map[bool]string{false: "legacy", true: "exact"}[exact], func(t *testing.T) {
			db, ctx := newTestStore(t), context.Background()
			registerAgentSessionTestDaemon(t, db, "ws_receipt", "agent_receipt")
			session, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{WorkspaceID: "ws_receipt", AgentID: "agent_receipt", Provider: "codex", Prompt: "synthetic work"})
			if err != nil {
				t.Fatal(err)
			}
			control, err := db.EnsurePersonalAgentRunControl(ctx, store.PersonalAgentRunControl{ID: "receipt-control", UserID: "person", SessionID: session.ID, InputID: session.Input.ID, DispatchAttempted: true})
			if err != nil {
				t.Fatal(err)
			}
			inputID := ""
			if exact {
				inputID = session.Input.ID
			}
			_, applied, err := db.SettleAgentSessionInput(ctx, session.ID, inputID, "done", "native", "")
			if err != nil || !applied {
				t.Fatalf("settlement: %v %v", applied, err)
			}
			control, err = db.GetPersonalAgentRunControl(ctx, control.UserID, control.ID)
			if err != nil || (control.NativeEndedAt != "") != exact {
				t.Fatalf("exact native proof: %+v %v", control, err)
			}
		})
	}
}
