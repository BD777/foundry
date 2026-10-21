package sqlitestore

import (
	"context"
	"errors"
	"sync"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func TestItemCaptureReturnsUpdatedItemAndRefusesChangedOriginal(t *testing.T) {
	db, ctx := newTestStore(t), context.Background()
	input := store.PersonalAgentListItem{UserID: "person", Text: "Compare export formats", CaptureKey: "input-1:part-1", CaptureHash: "original", SourceInputID: "input-1"}
	item, err := db.AddPersonalAgentItem(ctx, input)
	if err != nil {
		t.Fatal(err)
	}
	item.Text = "Compare CSV and JSON"
	changed, err := db.SavePersonalAgentItem(ctx, item)
	if err != nil {
		t.Fatal(err)
	}
	replayed, err := db.AddPersonalAgentItem(ctx, input)
	if err != nil || replayed.ID != changed.ID || replayed.Text != changed.Text || replayed.Revision != 2 {
		t.Fatalf("capture retry lost updates: %+v %v", replayed, err)
	}
	if _, err = db.SavePersonalAgentItem(ctx, item); !errors.Is(err, store.ErrPersonalAgentRevision) {
		t.Fatalf("stale edit accepted: %v", err)
	}
	input.CaptureHash = "different-original"
	if _, err = db.AddPersonalAgentItem(ctx, input); !errors.Is(err, store.ErrIdempotencyConflict) {
		t.Fatalf("key reused with changed intent: %v", err)
	}
	input.CaptureHash = "original"
	if err := db.DeletePersonalAgentItem(ctx, "person", item.ID); err != nil {
		t.Fatal(err)
	}
	removed, err := db.AddPersonalAgentItem(ctx, input)
	if err != nil || removed.ID != item.ID || removed.Text != "" || removed.Status != "dropped" {
		t.Fatalf("deleted item resurrected on retry: %+v %v", removed, err)
	}
	if items, _ := db.ListPersonalAgentItems(ctx, "person", "0001-01-01"); len(items) != 0 {
		t.Fatal("deleted words remain visible")
	}
}

func TestConcurrentItemEdgesCannotCreateCycle(t *testing.T) {
	db, ctx := newTestStore(t), context.Background()
	a, err := db.AddPersonalAgentItem(ctx, store.PersonalAgentListItem{UserID: "person", Text: "Research"})
	if err != nil {
		t.Fatal(err)
	}
	b, err := db.AddPersonalAgentItem(ctx, store.PersonalAgentListItem{UserID: "person", Text: "Design"})
	if err != nil {
		t.Fatal(err)
	}
	a.Plan = &store.PersonalAgentItemPlan{Mode: "record", Progress: "waiting", Dependencies: []string{b.ID}}
	b.Plan = &store.PersonalAgentItemPlan{Mode: "record", Progress: "waiting", Dependencies: []string{a.ID}}
	var wg sync.WaitGroup
	results := make(chan error, 2)
	for _, item := range []store.PersonalAgentListItem{a, b} {
		wg.Add(1)
		go func(item store.PersonalAgentListItem) {
			defer wg.Done()
			_, err := db.SavePersonalAgentItem(ctx, item)
			results <- err
		}(item)
	}
	wg.Wait()
	close(results)
	succeeded := 0
	for err := range results {
		if err == nil {
			succeeded++
		}
	}
	if succeeded != 1 {
		t.Fatalf("%d edge edits succeeded; expected one to roll back", succeeded)
	}
}
