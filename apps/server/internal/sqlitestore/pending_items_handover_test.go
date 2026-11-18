package sqlitestore

import (
	"context"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// A hand-over belongs to the assistant turn that made it: only an open item
// handed over by that turn counts for it, and an item the person answers no
// longer counts (DEV-279).
func TestOpenHandOverIsScopedToItsTurn(t *testing.T) {
	db, ctx := newTestStore(t), context.Background()
	const user = "user_handover"
	open := func(key string) store.PendingItem {
		t.Helper()
		item, _, err := db.RecordPendingItem(ctx, store.PendingItem{
			UserID: user, WorkspaceID: "ws_handover", SessionID: "sess_helper",
			Source: store.PendingSourceQuestion, Key: key, Handler: store.PendingHandlerPerson,
			Title: key, Excerpt: key,
		})
		if err != nil {
			t.Fatal(err)
		}
		return item
	}
	handOver := func(item store.PendingItem, inputID string) {
		t.Helper()
		if _, err := db.HandPendingItem(ctx, user, item.ID, store.PendingHandlerPerson, "note",
			store.PendingHandedByAssistant, store.PendingOutcomeHandedOver, inputID); err != nil {
			t.Fatal(err)
		}
	}
	assertOpen := func(inputID string, want bool) {
		t.Helper()
		got, err := db.OpenHandOverForInput(ctx, inputID)
		if err != nil {
			t.Fatal(err)
		}
		if got != want {
			t.Fatalf("OpenHandOverForInput(%q) = %v, want %v", inputID, got, want)
		}
	}

	first := open("handover:helper_a:0")
	second := open("handover:helper_b:0")
	handOver(first, "input_turn_a")
	handOver(second, "input_turn_b")
	stored, err := db.GetPendingItem(ctx, user, first.ID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.HandedInputID != "input_turn_a" || stored.Outcome != store.PendingOutcomeHandedOver {
		t.Fatalf("the hand-over does not keep its turn: %+v", stored)
	}

	assertOpen("input_turn_a", true)
	assertOpen("input_turn_b", true)
	assertOpen("input_turn_c", false)
	assertOpen("", false)

	if _, err := db.ResolvePendingItem(ctx, user, first.ID, store.PendingDone, store.PendingOutcomePersonAnswered, store.PendingAnswer{}); err != nil {
		t.Fatal(err)
	}
	assertOpen("input_turn_a", false)
	assertOpen("input_turn_b", true)
}
