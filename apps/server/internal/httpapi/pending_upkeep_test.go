package httpapi

import (
	"context"
	"strings"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// A suggested change is settled only once its file change is applying or
// applied; a conflict still waits for the person (DEV-256).
func TestUpkeepUndecidedCountsOnlyChangesNotYetSettled(t *testing.T) {
	job := store.PersonalAgentMaintenance{ID: "review", Status: "review", Result: &store.MaintenanceResult{
		Patches: []store.MaintenancePatch{{Path: "AGENTS.md", Reason: "first"}, {Path: "README.md", Reason: "second"}, {Path: "docs/x.md", Reason: "third"}},
	}}
	patches := []store.PersonalAgentContextPatch{
		{JobID: "review", Index: 0, Status: "applied"},
		{JobID: "review", Index: 1, Status: "conflict"},
		{JobID: "other-review", Index: 2, Status: "applied"},
	}
	if got := upkeepUndecided(job, patches); got != 2 {
		t.Fatalf("undecided = %d, want 2 (the conflict and the change nobody applied)", got)
	}
	if got := upkeepFirstReason(job, patches); got != "second" {
		t.Fatalf("first undecided reason = %q, want %q", got, "second")
	}
	job.Status = "dismissed"
	if got := upkeepUndecided(job, patches); got != 0 {
		t.Fatalf("a dismissed review still waits for %d changes", got)
	}
}

// A project's undecided suggestions are one Needs you item per person and
// episode: it opens once, does not change on a re-read, closes when every
// suggestion is decided, and a new review opens a new item (DEV-256).
func TestProjectUpkeepIsOneNeedsYouItemPerEpisode(t *testing.T) {
	f := newDigestFixture(t)
	ctx := context.Background()
	agent := defaultAssistantOf(t, f.server, f.aliceID)
	openItems := func() []store.PendingItem {
		t.Helper()
		items, err := f.db.ListPendingItems(ctx, f.aliceID, []string{store.PendingOpen}, "", 50)
		if err != nil {
			t.Fatal(err)
		}
		return items
	}
	review, err := f.server.store.EnqueuePersonalAgentMaintenance(ctx, store.PersonalAgentMaintenance{
		ID: "upkeep-review-1", AssistantID: agent.ID, UserID: f.aliceID, Role: "governance",
		WorkspaceID: "ws_budget", EventKey: "upkeep-event-1",
	})
	if err != nil {
		t.Fatal(err)
	}
	review.Status = "review"
	review.Result = &store.MaintenanceResult{Summary: "change", Patches: []store.MaintenancePatch{
		{Path: "AGENTS.md", Content: "# x", Reason: "Split the release notes"},
		{Path: "README.md", Content: "# y", Reason: "Fix the install steps"},
	}}
	if review, err = f.server.store.SavePersonalAgentMaintenance(ctx, review); err != nil {
		t.Fatal(err)
	}

	if !f.server.reconcileUpkeepPending(ctx, f.aliceID, map[string]bool{}) {
		t.Fatal("a review with two undecided suggestions opened no Needs you item")
	}
	items := openItems()
	if len(items) != 1 || items[0].Source != store.PendingSourceProjectUpkeep || items[0].Count != 2 {
		t.Fatalf("open items = %+v, want one project upkeep item counting 2", items)
	}
	if items[0].Key != upkeepPendingKey(f.aliceID, "ws_budget") || items[0].Title != "Budget" {
		t.Fatalf("item = key %q title %q, want the person's Budget item", items[0].Key, items[0].Title)
	}
	if !strings.Contains(items[0].EventID, "upkeep-review-1") || items[0].Excerpt != "Split the release notes" {
		t.Fatalf("item episode = %q excerpt %q", items[0].EventID, items[0].Excerpt)
	}
	if f.server.reconcileUpkeepPending(ctx, f.aliceID, upkeepOpenKeys(items)) {
		t.Fatal("re-reading an unchanged review rewrote its item")
	}

	// Dismissing the review decides every suggestion: the item closes.
	review.Status = "dismissed"
	if review, err = f.server.store.SavePersonalAgentMaintenance(ctx, review); err != nil {
		t.Fatal(err)
	}
	if !f.server.reconcileUpkeepPending(ctx, f.aliceID, upkeepOpenKeys(openItems())) {
		t.Fatal("decided suggestions left their item open")
	}
	if left := openItems(); len(left) != 0 {
		t.Fatalf("items still open after the review was decided: %+v", left)
	}

	// A later review that suggests changes is a new episode, a new item.
	next, err := f.server.store.EnqueuePersonalAgentMaintenance(ctx, store.PersonalAgentMaintenance{
		ID: "upkeep-review-2", AssistantID: agent.ID, UserID: f.aliceID, Role: "governance",
		WorkspaceID: "ws_budget", EventKey: "upkeep-event-2",
	})
	if err != nil {
		t.Fatal(err)
	}
	next.Status = "review"
	next.Result = &store.MaintenanceResult{Summary: "change", Patches: []store.MaintenancePatch{{Path: "AGENTS.md", Content: "# z", Reason: "Shorten"}}}
	if _, err := f.server.store.SavePersonalAgentMaintenance(ctx, next); err != nil {
		t.Fatal(err)
	}
	f.server.reconcileUpkeepPending(ctx, f.aliceID, map[string]bool{})
	items = openItems()
	if len(items) != 1 || items[0].Count != 1 || !strings.Contains(items[0].EventID, "upkeep-review-2") {
		t.Fatalf("a new review's item = %+v, want one new item counting 1", items)
	}
}
