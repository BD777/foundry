package httpapi

import (
	"context"
	"strings"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// An assistant's memory reviews, of both layers, are one Needs you item that
// counts their findings; dismissing them closes it, and a new review opens a
// new item (DEV-256).
func TestMemoryUpkeepIsOneNeedsYouItemPerAssistant(t *testing.T) {
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
	review := func(id, workspace, vault, eventKey string, findings int) store.PersonalAgentMaintenance {
		t.Helper()
		job, err := f.server.store.EnqueuePersonalAgentMaintenance(ctx, store.PersonalAgentMaintenance{
			ID: id, AssistantID: agent.ID, UserID: f.aliceID, Role: "memory",
			WorkspaceID: workspace, VaultID: vault, EventKey: eventKey,
		})
		if err != nil {
			t.Fatal(err)
		}
		job.Status = "review"
		job.Result = &store.MaintenanceResult{Summary: "memory"}
		for range findings {
			job.Result.Findings = append(job.Result.Findings, store.MaintenanceFinding{Kind: "stale", Summary: "Merge " + id})
		}
		if job, err = f.server.store.SavePersonalAgentMaintenance(ctx, job); err != nil {
			t.Fatal(err)
		}
		return job
	}
	dismiss := func(job store.PersonalAgentMaintenance) {
		t.Helper()
		job.Status = "dismissed"
		if _, err := f.server.store.SavePersonalAgentMaintenance(ctx, job); err != nil {
			t.Fatal(err)
		}
	}

	// A new memory review supersedes the reviews of its own workspace (a changed
	// authority invalidates them), so the second layer sits in another one.
	person := review("memory-person", agent.WorkspaceID, "vault_person", "person-v1", 2)
	assistantLayer := review("memory-assistant", "ws_budget", "vault_assistant", "assistant-v1", 1)
	if !f.server.reconcileMemoryPending(ctx, f.aliceID, map[string]bool{}) {
		t.Fatal("two memory reviews with findings opened no Needs you item")
	}
	items := openItems()
	if len(items) != 1 || items[0].Source != store.PendingSourceMemoryUpkeep || items[0].Count != 3 {
		t.Fatalf("open items = %+v, want one memory upkeep item counting 3 findings", items)
	}
	wantTitle := agent.Name
	if wantTitle == "" {
		wantTitle = agent.ID
	}
	if items[0].Key != memoryUpkeepPendingKey(f.aliceID, agent.ID) || items[0].AssistantID != agent.ID || items[0].Title != wantTitle {
		t.Fatalf("item = key %q assistant %q title %q, want the assistant's item", items[0].Key, items[0].AssistantID, items[0].Title)
	}
	if !strings.Contains(items[0].EventID, assistantLayer.ID) {
		t.Fatalf("item episode = %q, want the newest review %q", items[0].EventID, assistantLayer.ID)
	}
	if f.server.reconcileMemoryPending(ctx, f.aliceID, upkeepOpenKeys(items)) {
		t.Fatal("re-reading unchanged memory reviews rewrote the item")
	}

	// Dismissing every review decides the findings: the item closes.
	dismiss(person)
	dismiss(assistantLayer)
	if !f.server.reconcileMemoryPending(ctx, f.aliceID, pendingOpenKeysOf(openItems(), store.PendingSourceMemoryUpkeep)) {
		t.Fatal("dismissed memory reviews left their item open")
	}
	if left := openItems(); len(left) != 0 {
		t.Fatalf("items still open after every memory review was dismissed: %+v", left)
	}

	// A later review that finds something is a new episode, a new item.
	next := review("memory-next", agent.WorkspaceID, "vault_person", "person-v2", 1)
	f.server.reconcileMemoryPending(ctx, f.aliceID, map[string]bool{})
	items = openItems()
	if len(items) != 1 || items[0].Count != 1 || !strings.Contains(items[0].EventID, next.ID) {
		t.Fatalf("a new review's item = %+v, want one new item counting 1", items)
	}
}
