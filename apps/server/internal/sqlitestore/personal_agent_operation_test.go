package sqlitestore

import (
	"context"
	"errors"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"testing"
)

func TestPersonalAgentOperationFences(t *testing.T) {
	db, ctx := newTestStore(t), context.Background()
	item, err := db.AddPersonalAgentItem(ctx, store.PersonalAgentListItem{UserID: "p", Text: "Prepare a comparison", Plan: &store.PersonalAgentItemPlan{Mode: "record", WorkspaceID: "ws"}})
	if err != nil {
		t.Fatal(err)
	}
	op := store.PersonalAgentOperation{ID: "op", UserID: "p", ItemID: item.ID, IntentRevision: item.IntentRevision, StepKey: "compare", WorkspaceID: "ws", SourceSessionID: "parent", InputID: "input", Prompt: "Compare", RequestHash: "hash"}
	if _, err = db.CapturePersonalAgentOperation(ctx, op); err == nil {
		t.Fatal("record-only item dispatched")
	}
	item.Plan.Mode = "execute"
	item, err = db.SavePersonalAgentItem(ctx, item)
	if err != nil {
		t.Fatal(err)
	}
	op.IntentRevision = item.IntentRevision
	saved, err := db.CapturePersonalAgentOperation(ctx, op)
	if err != nil {
		t.Fatal(err)
	}
	replay, err := db.CapturePersonalAgentOperation(ctx, op)
	if err != nil || replay.ID != saved.ID {
		t.Fatalf("replay: %+v %v", replay, err)
	}
	changed := op
	changed.RequestHash = "other"
	if _, err = db.CapturePersonalAgentOperation(ctx, changed); !errors.Is(err, store.ErrIdempotencyConflict) {
		t.Fatalf("changed request accepted: %v", err)
	}
	changed = op
	changed.ID = "new"
	changed.StepKey = "other"
	changed.InputID = "new-input"
	if _, err = db.CapturePersonalAgentOperation(ctx, changed); err == nil {
		t.Fatal("competing step accepted")
	}
	item.Plan.Progress = "working"
	item, err = db.SavePersonalAgentItem(ctx, item)
	if err != nil || item.IntentRevision != op.IntentRevision {
		t.Fatalf("progress minted intent: %+v %v", item, err)
	}
	saved.Status = "dispatching"
	claimed, err := db.SavePersonalAgentOperation(ctx, saved)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.SavePersonalAgentOperation(ctx, saved); !errors.Is(err, store.ErrPersonalAgentRevision) {
		t.Fatalf("stale claim: %v", err)
	}
	claimed.Status = "unknown"
	unknown, err := db.SavePersonalAgentOperation(ctx, claimed)
	if err != nil {
		t.Fatal(err)
	}
	unknown.Status = "dispatching"
	if _, err = db.SavePersonalAgentOperation(ctx, unknown); err == nil {
		t.Fatal("unknown outcome redelivered")
	}
	unknown.Status = "delivered"
	unknown.SessionID = "child"
	delivered, err := db.SavePersonalAgentOperation(ctx, unknown)
	if err != nil {
		t.Fatal(err)
	}
	delivered.SessionID = "other"
	if _, err = db.SavePersonalAgentOperation(ctx, delivered); !errors.Is(err, store.ErrIdempotencyConflict) {
		t.Fatalf("receipt rebound: %v", err)
	}
	delivered.SessionID = "child"
	delivered.Status = "review"
	if _, err = db.SavePersonalAgentOperation(ctx, delivered); err != nil {
		t.Fatal(err)
	}
	actual, _ := db.GetPersonalAgentItem(ctx, "p", item.ID)
	if actual.Status != "open" {
		t.Fatal("session completion closed item")
	}
}
func TestPersonalAgentOperationRechecksIntentAndDependencies(t *testing.T) {
	db, ctx := newTestStore(t), context.Background()
	dependency, err := db.AddPersonalAgentItem(ctx, store.PersonalAgentListItem{UserID: "p", Text: "Approve inputs"})
	if err != nil {
		t.Fatal(err)
	}
	item, err := db.AddPersonalAgentItem(ctx, store.PersonalAgentListItem{UserID: "p", Text: "Use inputs", Plan: &store.PersonalAgentItemPlan{Mode: "execute", WorkspaceID: "ws", Dependencies: []string{dependency.ID}}})
	if err != nil {
		t.Fatal(err)
	}
	op, err := db.CapturePersonalAgentOperation(ctx, store.PersonalAgentOperation{ID: "op", UserID: "p", ItemID: item.ID, IntentRevision: item.IntentRevision, StepKey: "use", WorkspaceID: "ws", SourceSessionID: "parent", InputID: "input", Prompt: "Use", RequestHash: "hash"})
	if err != nil {
		t.Fatal(err)
	}
	op.Status = "dispatching"
	if _, err = db.SavePersonalAgentOperation(ctx, op); err == nil {
		t.Fatal("unfinished dependency dispatched")
	}
	dependency.Status = "done"
	if _, err = db.SavePersonalAgentItem(ctx, dependency); err != nil {
		t.Fatal(err)
	}
	item.Text = "Changed instruction"
	if _, err = db.SavePersonalAgentItem(ctx, item); err != nil {
		t.Fatal(err)
	}
	if _, err = db.SavePersonalAgentOperation(ctx, op); !errors.Is(err, store.ErrPersonalAgentRevision) {
		t.Fatalf("stale intent dispatched: %v", err)
	}
}

func TestPendingDispatchCancellationDoesNotClaimAnAcceptedInputStopped(t *testing.T) {
	db, ctx := newTestStore(t), context.Background()
	item, err := db.AddPersonalAgentItem(ctx, store.PersonalAgentListItem{UserID: "p", Text: "Synthetic comparison", Plan: &store.PersonalAgentItemPlan{Mode: "execute", WorkspaceID: "ws"}})
	if err != nil {
		t.Fatal(err)
	}
	op, err := db.CapturePersonalAgentOperation(ctx, store.PersonalAgentOperation{ID: "pending-op", UserID: "p", ItemID: item.ID, IntentRevision: item.IntentRevision, StepKey: "compare", WorkspaceID: "ws", SourceSessionID: "parent", InputID: "unique-input", Prompt: "Compare", RequestHash: "hash"})
	if err != nil {
		t.Fatal(err)
	}
	snapshot, err := db.RecordPersonalAgentRunSnapshot(ctx, store.PersonalAgentRunSnapshot{ID: "accepted-snapshot", UserID: "p", InputID: op.InputID, Role: "executor", WorkspaceID: "ws", ConfigHash: "config"})
	if err != nil {
		t.Fatal(err)
	}
	if err = db.BindPersonalAgentRunSnapshot(ctx, "p", snapshot.ID, "a-deleted-session"); err != nil {
		t.Fatal(err)
	}
	if _, err = db.CancelPendingPersonalAgentOperation(ctx, "p", op.ID, op.Revision); err == nil {
		t.Fatal("absence of session event erased the immutable acceptance")
	}
	op.InputID = "unsent-input"
	op.ID = "other-pending-op"
	op.StepKey = "later"
	op.ItemID = ""
	other, err := db.AddPersonalAgentItem(ctx, store.PersonalAgentListItem{UserID: "p", Text: "Other synthetic comparison", Plan: &store.PersonalAgentItemPlan{Mode: "execute", WorkspaceID: "ws"}})
	if err != nil {
		t.Fatal(err)
	}
	op.ItemID = other.ID
	op.IntentRevision = other.IntentRevision
	op, err = db.CapturePersonalAgentOperation(ctx, op)
	if err != nil {
		t.Fatal(err)
	}
	cancelled, err := db.CancelPendingPersonalAgentOperation(ctx, "p", op.ID, op.Revision)
	if err != nil || cancelled.Status != "cancelled" || cancelled.SessionID != "" {
		t.Fatalf("unaccepted intent not safely cancelled %+v %v", cancelled, err)
	}
}
