package sqlitestore

import (
	"context"
	"slices"
	"sync"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// Every item change tells the observer the homes it concerns: a change at
// home names it, a plan change with no event too, a rehome both homes, a
// delete the home it had. Items of the inbox name none and are not told.
// ListPersonalAgentItemsAtHome lists the live items of a home with helpers.
func TestPersonalAgentItemChangesNameTheirHomes(t *testing.T) {
	db, ctx := newTestStore(t), context.Background()
	var mu sync.Mutex
	var changes []store.PersonalAgentItemChange
	db.ObservePersonalAgentItemChanges(func(change store.PersonalAgentItemChange) {
		mu.Lock()
		defer mu.Unlock()
		changes = append(changes, change)
	})
	take := func() []store.PersonalAgentItemChange {
		mu.Lock()
		defer mu.Unlock()
		taken := changes
		changes = nil
		return taken
	}
	homes := func(changes []store.PersonalAgentItemChange) []string {
		var all []string
		for _, change := range changes {
			for _, workspace := range change.Workspaces {
				if !slices.Contains(all, workspace) {
					all = append(all, workspace)
				}
			}
		}
		slices.Sort(all)
		return all
	}

	item, err := db.AddPersonalAgentItem(ctx, store.PersonalAgentActorAssistant, store.PersonalAgentListItem{UserID: "user_a", AssistantID: "asst_a", Text: "Ship the release", HomeWorkspaceID: "ws_a",
		Plan: &store.PersonalAgentItemPlan{Mode: "execute", Progress: "started"}})
	if err != nil {
		t.Fatal(err)
	}
	if got := take(); len(got) == 0 || got[0].ItemID != item.ID || got[0].AssistantID != "asst_a" || !slices.Equal(homes(got), []string{"ws_a"}) {
		t.Fatalf("created: %+v", got)
	}
	if _, err := db.AddPersonalAgentItem(ctx, store.PersonalAgentActorAssistant, store.PersonalAgentListItem{UserID: "user_a", AssistantID: "asst_a", Text: "Buy milk"}); err != nil {
		t.Fatal(err)
	}
	if got := take(); len(got) != 0 {
		t.Fatalf("an inbox item was told: %+v", got)
	}

	item.Plan.Progress = "half way"
	if item, err = db.SavePersonalAgentItem(ctx, store.PersonalAgentActorAssistant, item); err != nil {
		t.Fatal(err)
	}
	if got := homes(take()); !slices.Equal(got, []string{"ws_a"}) {
		t.Fatalf("plan change: %v", got)
	}

	item.HomeWorkspaceID = "ws_b"
	if item, err = db.SavePersonalAgentItem(ctx, store.PersonalAgentActorAssistant, item); err != nil {
		t.Fatal(err)
	}
	if got := homes(take()); !slices.Equal(got, []string{"ws_a", "ws_b"}) {
		t.Fatalf("rehome: %v", got)
	}

	if _, err := db.CreatePersonalAgentTask(ctx, store.PersonalAgentActorAssistant, store.PersonalAgentTask{UserID: "user_a", AssistantID: "asst_a", ItemID: item.ID, SessionID: "sess_h", WorkspaceID: "ws_c", Title: "Build", Status: store.PersonalAgentTaskRunning}); err != nil {
		t.Fatal(err)
	}
	if got := homes(take()); !slices.Equal(got, []string{"ws_b"}) {
		t.Fatalf("helper started: %v", got)
	}
	items, helpers, err := db.ListPersonalAgentItemsAtHome(ctx, "user_a", "ws_b")
	if err != nil || len(items) != 1 || items[0].ID != item.ID || len(helpers[item.ID]) != 1 || helpers[item.ID][0].SessionID != "sess_h" {
		t.Fatalf("at home ws_b: %+v %+v %v", items, helpers, err)
	}
	if items, _, _ := db.ListPersonalAgentItemsAtHome(ctx, "user_a", "ws_a"); len(items) != 0 {
		t.Fatalf("at the old home: %+v", items)
	}
	if items, _, _ := db.ListPersonalAgentItemsAtHome(ctx, "user_b", "ws_b"); len(items) != 0 {
		t.Fatalf("another person's items at home: %+v", items)
	}

	if err := db.DeletePersonalAgentItem(ctx, "asst_a", item.ID); err != nil {
		t.Fatal(err)
	}
	if got := take(); len(got) != 1 || got[0].ItemID != item.ID || !slices.Equal(got[0].Workspaces, []string{"ws_b"}) {
		t.Fatalf("delete: %+v", got)
	}
	if items, _, _ := db.ListPersonalAgentItemsAtHome(ctx, "user_a", "ws_b"); len(items) != 0 {
		t.Fatalf("a deleted item is still at home: %+v", items)
	}
}
