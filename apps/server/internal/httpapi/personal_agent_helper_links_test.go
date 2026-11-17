package httpapi

import (
	"context"
	"strings"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// A helper's link to an item is its task: pa_tasks.item_id. The item's plan
// lists the helper as a session reference and keeps it when the plan changes;
// moving the helper moves the reference with it.
func TestHelperLinksFollowTheItemAndSurvivePlanUpdates(t *testing.T) {
	f := newAssistantFixture(t)
	ctx := context.Background()
	agent := defaultAssistantOf(t, f.server, f.aliceID)
	conversation := f.startSession(t, "ws_pa", "", plansMessage)
	token := f.mint(t, conversation.ID)
	first := addItem(t, f, agent, "Check the gateway deploy", store.PersonalAgentItemOwnerAssistant)
	second := addItem(t, f, agent, "Review the draft", store.PersonalAgentItemOwnerAssistant)
	dropped := addItem(t, f, agent, "Old plan", store.PersonalAgentItemOwnerAssistant)
	dropped.Status, dropped.Revision = store.PersonalAgentItemDropped, 0
	if _, err := f.server.store.SavePersonalAgentItem(ctx, store.PersonalAgentActorPerson, dropped); err != nil {
		t.Fatal(err)
	}
	for _, item := range []store.PersonalAgentListItem{first, second} {
		text, failed := f.tool(t, token, "update_list", map[string]any{"op": "update", "item": map[string]any{
			"id": item.ID, "quote": "我下午要去给大家捋一下现在Atlas的流程", "plan": map[string]any{"mode": "execute", "progress": "working", "workspaceId": "ws_alice"}}})
		if failed {
			t.Fatalf("plan for %s: %s", item.ID, text)
		}
	}
	itemNow := func(id string) store.PersonalAgentListItem {
		t.Helper()
		item, err := f.server.store.GetPersonalAgentItem(ctx, agent.ID, id)
		if err != nil {
			t.Fatal(err)
		}
		return item
	}
	helperRefs := func(id, sessionID string) int {
		t.Helper()
		count := 0
		if plan := itemNow(id).Plan; plan != nil {
			for _, ref := range plan.WorkRefs {
				if ref.Kind == "session" && ref.ID == sessionID {
					count++
				}
			}
		}
		return count
	}

	helper := f.startSession(t, "ws_alice", conversation.ID, "check the gateway deploy")
	f.server.assistant.RecordTask(ctx, agent, conversation.ID, helper, first.ID)
	if got := helperRefs(first.ID, helper.ID); got != 1 {
		t.Fatalf("the helper's item lists it %d times, want 1", got)
	}

	// A plan update that does not mention the helper keeps its link.
	if text, failed := f.tool(t, token, "update_list", map[string]any{"op": "update", "item": map[string]any{
		"id": first.ID, "quote": "我下午要去给大家捋一下现在Atlas的流程", "plan": map[string]any{"mode": "execute", "progress": "review", "workspaceId": "ws_alice", "nextAction": "read the deploy log"}}}); failed {
		t.Fatalf("plan update: %s", text)
	}
	if got := helperRefs(first.ID, helper.ID); got != 1 {
		t.Fatalf("a plan update dropped the helper's link (%d refs)", got)
	}

	// update_list taskId moves the helper: the item it left loses it.
	tasks, err := f.server.store.ListPersonalAgentTasks(ctx, agent.ID, nil)
	if err != nil {
		t.Fatal(err)
	}
	if text, failed := f.tool(t, token, "update_list", map[string]any{"op": "update", "item": map[string]any{"id": second.ID, "taskId": tasks[0].ID}}); failed {
		t.Fatalf("taskId move: %s", text)
	}
	if got := helperRefs(first.ID, helper.ID); got != 0 {
		t.Fatalf("the item the helper left still lists it (%d refs)", got)
	}
	if got := helperRefs(second.ID, helper.ID); got != 1 {
		t.Fatalf("the item the helper joined lists it %d times, want 1", got)
	}

	// The assistant's send_message itemId goes through the same move.
	session, err := f.server.store.GetAgentSessionRecord(ctx, conversation.ID)
	if err != nil {
		t.Fatal(err)
	}
	scope, err := f.server.assistant.ScopeFor(ctx, agent, session.ID, session.Input)
	if err != nil {
		t.Fatal(err)
	}
	if err := f.server.assistant.MoveHelper(ctx, scope, helper.ID, first.ID); err != nil {
		t.Fatalf("move the helper back: %v", err)
	}
	if got, want := helperRefs(first.ID, helper.ID), 1; got != want {
		t.Fatalf("the item the helper returned to lists it %d times, want %d", got, want)
	}
	if got := helperRefs(second.ID, helper.ID); got != 0 {
		t.Fatalf("the item the helper left still lists it (%d refs)", got)
	}
	if err := f.server.assistant.MoveHelper(ctx, scope, helper.ID, dropped.ID); err == nil || !strings.Contains(err.Error(), "is dropped") {
		t.Fatalf("moving a helper to a dropped item = %v, want a refusal", err)
	}
	if err := f.server.assistant.MoveHelper(ctx, scope, conversation.ID, second.ID); err == nil || !strings.Contains(err.Error(), "not one of your helpers") {
		t.Fatalf("moving the assistant's own conversation = %v, want a refusal", err)
	}
	if tasks, _ := f.server.store.ListPersonalAgentTasks(ctx, agent.ID, nil); len(tasks) == 0 || tasks[0].ItemID != first.ID {
		t.Fatalf("the task does not name the item it returned to: %+v", tasks)
	}
}
