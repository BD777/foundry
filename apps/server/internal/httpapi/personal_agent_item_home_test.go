package httpapi

import (
	"context"
	"encoding/json"
	"slices"
	"strings"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// itemToolAnswer is update_list's answer.
type itemToolAnswer struct {
	Status   string                      `json:"status"`
	Item     store.PersonalAgentListItem `json:"item"`
	Replaced string                      `json:"replaced"`
	Note     string                      `json:"note"`
}

func (f assistantFixture) updateItem(t *testing.T, token, op string, item map[string]any) (itemToolAnswer, string, bool) {
	t.Helper()
	text, failed := f.tool(t, token, "update_list", map[string]any{"op": op, "item": item})
	var answer itemToolAnswer
	_ = json.Unmarshal([]byte(text), &answer)
	return answer, text, failed
}

func (f assistantFixture) itemEvents(t *testing.T, assistantID, itemID string) []store.PersonalAgentItemEvent {
	t.Helper()
	events, err := f.server.store.ListPersonalAgentItemEvents(context.Background(), assistantID, itemID)
	if err != nil {
		t.Fatal(err)
	}
	return events
}

// A session the person started in a workspace keeps the items homed there:
// it lists the item tools, adds items with that home, reads the items homed
// in or touching it, and changes, claims and releases only the ones homed
// there. A claim replaces the holder and records whom; a new home is recorded
// with its before and after.
func TestWorkspaceSessionKeepsItsWorkspaceItems(t *testing.T) {
	f := newAssistantFixture(t)
	ctx := context.Background()
	agent := defaultAssistantOf(t, f.server, f.aliceID)
	orchestrator := f.startSession(t, "ws_alice", "", "track the release checklist for the launch and the docs review")
	token := f.mint(t, orchestrator.ID)

	listed := f.listedTools(t, token)
	if !slices.Contains(listed, "read_list") || !slices.Contains(listed, "update_list") || slices.Contains(listed, "remember") {
		t.Fatalf("a workspace session lists %v", listed)
	}

	added, text, failed := f.updateItem(t, token, "add", map[string]any{"text": "Release checklist", "quote": "track the release checklist"})
	if failed || added.Item.HomeWorkspaceID != "ws_alice" || added.Item.SourceSessionID != orchestrator.ID {
		t.Fatalf("add from a workspace session: %s", text)
	}
	stored, err := f.server.store.GetPersonalAgentItem(ctx, agent.ID, added.Item.ID)
	if err != nil || stored.HomeWorkspaceID != "ws_alice" {
		t.Fatalf("the item is not on the default assistant's list with its home: %+v %v", stored, err)
	}
	if events := f.itemEvents(t, agent.ID, added.Item.ID); len(events) != 1 || events[0].Actor != store.PersonalAgentActorSession {
		t.Fatalf("created events = %+v", events)
	}
	if _, text, failed := f.updateItem(t, token, "add", map[string]any{"text": "Elsewhere", "quote": "the docs review", "home": "ws_bob"}); !failed || !strings.Contains(text, "leave item.home out") {
		t.Fatalf("a new item homed elsewhere: %s", text)
	}
	if _, text, failed := f.updateItem(t, token, "add", map[string]any{"text": "Not said", "quote": "ship it on Friday"}); !failed || !strings.Contains(text, "not added") {
		t.Fatalf("an item from words the person did not write: %s", text)
	}
	if _, text, failed := f.updateItem(t, token, "update", map[string]any{"id": added.Item.ID, "taskId": "pat_x"}); !failed || !strings.Contains(text, "only the person's assistant") {
		t.Fatalf("a workspace session set taskId: %s", text)
	}

	// The assistant keeps one item in its inbox and one homed in ws_bob that a
	// helper in ws_alice works on: it touches ws_alice.
	conversation := f.startSession(t, "ws_pa", "", "remember to renew the passport, and the docs review")
	assistantToken := f.mint(t, conversation.ID)
	inbox, text, failed := f.updateItem(t, assistantToken, "add", map[string]any{"text": "Renew the passport", "quote": "renew the passport"})
	if failed || inbox.Item.HomeWorkspaceID != "" {
		t.Fatalf("inbox item: %s", text)
	}
	touched, text, failed := f.updateItem(t, assistantToken, "add", map[string]any{"text": "Docs review", "quote": "the docs review", "home": "ws_bob"})
	if failed || touched.Item.HomeWorkspaceID != "ws_bob" {
		t.Fatalf("an item homed in ws_bob: %s", text)
	}
	helper := f.startSession(t, "ws_alice", conversation.ID, "review the docs")
	f.server.assistant.RecordTask(ctx, agent, conversation.ID, helper, touched.Item.ID)

	read, failed := f.tool(t, token, "read_list", map[string]any{})
	var page struct {
		Total int `json:"total"`
		Items []struct {
			ID       string   `json:"id"`
			Revision int64    `json:"revision"`
			Home     string   `json:"homeWorkspaceId"`
			Touches  []string `json:"touches"`
		} `json:"items"`
		Operations []json.RawMessage `json:"operations"`
	}
	if err := json.Unmarshal([]byte(read), &page); failed || err != nil || page.Total != 2 || len(page.Operations) != 0 {
		t.Fatalf("a workspace session read %s", read)
	}
	for _, item := range page.Items {
		if item.Revision < 1 {
			t.Fatalf("read_list gives no revision to update with: %+v", item)
		}
		switch item.ID {
		case added.Item.ID:
			if item.Home != "ws_alice" || len(item.Touches) != 0 {
				t.Fatalf("its own item reads %+v", item)
			}
		case touched.Item.ID:
			if item.Home != "ws_bob" || !slices.Equal(item.Touches, []string{"ws_alice"}) {
				t.Fatalf("the touched item reads %+v", item)
			}
		default:
			t.Fatalf("a workspace session read item %s outside its workspace: %s", item.ID, read)
		}
	}
	if text, failed := f.tool(t, token, "read_list", map[string]any{"workspaceId": "ws_bob"}); !failed || !strings.Contains(text, "only the items of its workspace") {
		t.Fatalf("a workspace session read another workspace: %s", text)
	}
	if text, failed := f.tool(t, assistantToken, "read_list", map[string]any{"workspaceId": "ws_alice"}); failed || strings.Count(text, `"id": "pai_`) != 2 || strings.Contains(text, inbox.Item.ID) {
		t.Fatalf("the assistant narrowed to ws_alice: %s", text)
	}
	for _, id := range []string{touched.Item.ID, inbox.Item.ID} {
		if _, text, failed := f.updateItem(t, token, "update", map[string]any{"id": id, "summary": "mine now"}); !failed || !strings.Contains(text, "not allowed") {
			t.Fatalf("a workspace session changed item %s homed elsewhere: %s", id, text)
		}
		if _, text, failed := f.updateItem(t, token, "claim", map[string]any{"id": id}); !failed || !strings.Contains(text, "not allowed") {
			t.Fatalf("a workspace session claimed item %s homed elsewhere: %s", id, text)
		}
	}

	claimed, text, failed := f.updateItem(t, token, "claim", map[string]any{"id": added.Item.ID})
	if failed || claimed.Status != "applied" || claimed.Item.HolderSessionID != orchestrator.ID || claimed.Replaced != "" {
		t.Fatalf("claim: %s", text)
	}
	if again, text, _ := f.updateItem(t, token, "claim", map[string]any{"id": added.Item.ID}); again.Status != "unchanged" {
		t.Fatalf("a second claim by the holder: %s", text)
	}
	taken, text, failed := f.updateItem(t, assistantToken, "claim", map[string]any{"id": added.Item.ID})
	if failed || taken.Item.HolderSessionID != conversation.ID || taken.Replaced != orchestrator.ID {
		t.Fatalf("the assistant's claim did not replace the holder: %s", text)
	}
	if released, text, _ := f.updateItem(t, token, "release", map[string]any{"id": added.Item.ID}); released.Status != "unchanged" || released.Item.HolderSessionID != conversation.ID {
		t.Fatalf("a release by a session that no longer holds it: %s", text)
	}
	if released, text, _ := f.updateItem(t, assistantToken, "release", map[string]any{"id": added.Item.ID}); released.Status != "applied" || released.Item.HolderSessionID != "" {
		t.Fatalf("the holder's release: %s", text)
	}
	var claims []store.PersonalAgentItemEvent
	for _, event := range f.itemEvents(t, agent.ID, added.Item.ID) {
		if event.Kind == store.PersonalAgentItemEventClaimed || event.Kind == store.PersonalAgentItemEventReleased {
			claims = append(claims, event)
		}
	}
	if len(claims) != 3 || claims[0].Actor != store.PersonalAgentActorSession || claims[0].Detail.SessionID != orchestrator.ID ||
		claims[1].Actor != store.PersonalAgentActorAssistant || claims[1].Detail.SessionID != conversation.ID || claims[1].Detail.From != orchestrator.ID ||
		claims[2].Kind != store.PersonalAgentItemEventReleased || claims[2].Detail.SessionID != conversation.ID {
		t.Fatalf("claim events = %+v", claims)
	}

	if _, text, failed := f.updateItem(t, token, "update", map[string]any{"id": added.Item.ID, "home": "ws_nowhere"}); !failed || !strings.Contains(text, "no workspace ws_nowhere") {
		t.Fatalf("a home the person cannot reach: %s", text)
	}
	moved, text, failed := f.updateItem(t, token, "update", map[string]any{"id": added.Item.ID, "home": "ws_bob"})
	if failed || moved.Item.HomeWorkspaceID != "ws_bob" {
		t.Fatalf("rehome from the workspace session: %s", text)
	}
	events := f.itemEvents(t, agent.ID, added.Item.ID)
	last := events[len(events)-1]
	if last.Kind != store.PersonalAgentItemEventRehomed || last.Detail.From != "ws_alice" || last.Detail.To != "ws_bob" || last.Actor != store.PersonalAgentActorSession {
		t.Fatalf("rehomed event = %+v", last)
	}
	if _, text, failed := f.updateItem(t, token, "update", map[string]any{"id": added.Item.ID, "summary": "still mine?"}); !failed || !strings.Contains(text, "not allowed") {
		t.Fatalf("the item moved away, yet the session changed it: %s", text)
	}

	// The plan's workspaceId is the home, not a second record of it.
	planned, text, failed := f.updateItem(t, assistantToken, "update", map[string]any{"id": inbox.Item.ID,
		"plan": map[string]any{"mode": "record", "progress": "ready", "workspaceId": "ws_alice"}, "quote": "renew the passport"})
	if failed || planned.Item.HomeWorkspaceID != "ws_alice" || planned.Item.Plan == nil || planned.Item.Plan.WorkspaceID != "ws_alice" {
		t.Fatalf("plan.workspaceId did not move the home: %s", text)
	}
	if kept, text, failed := f.updateItem(t, assistantToken, "update", map[string]any{"id": inbox.Item.ID,
		"plan": map[string]any{"mode": "record", "progress": "working"}, "quote": "renew the passport"}); failed || kept.Item.HomeWorkspaceID != "ws_alice" {
		t.Fatalf("a plan without workspaceId cleared the home: %s", text)
	}
	if _, text, failed := f.updateItem(t, assistantToken, "update", map[string]any{"id": inbox.Item.ID, "home": "ws_bob",
		"plan": map[string]any{"mode": "record", "progress": "working", "workspaceId": "ws_alice"}, "quote": "renew the passport"}); !failed || !strings.Contains(text, "different workspaces") {
		t.Fatalf("two different homes: %s", text)
	}
	if back, text, failed := f.updateItem(t, assistantToken, "update", map[string]any{"id": inbox.Item.ID, "home": ""}); failed || back.Item.HomeWorkspaceID != "" {
		t.Fatalf("back to the inbox: %s", text)
	}
}

// Who keeps items besides the assistant: a session another session of the
// person started reads them, but its brief is not the person's words; the
// assistant's helpers do not keep items at all.
func TestItemToolsReachOnlyThePersonsWorkspaceSessions(t *testing.T) {
	f := newAssistantFixture(t)
	orchestrator := f.startSession(t, "ws_alice", "", "track the release checklist")
	child := f.startSession(t, "ws_alice", orchestrator.ID, "track the release checklist")
	childToken := f.mint(t, child.ID)
	if text, failed := f.tool(t, childToken, "read_list", map[string]any{}); failed {
		t.Fatalf("a child of the person's session read_list: %s", text)
	}
	if _, text, failed := f.updateItem(t, childToken, "add", map[string]any{"text": "Release checklist", "quote": "track the release checklist"}); !failed || !strings.Contains(text, "not added") {
		t.Fatalf("a child quoted its brief as the person's words: %s", text)
	}
	helper := f.startSession(t, "ws_alice", f.conversation.ID, "review the docs")
	f.server.assistant.RecordTask(context.Background(), defaultAssistantOf(t, f.server, f.aliceID), f.conversation.ID, helper, "")
	if text, failed := f.tool(t, f.mint(t, helper.ID), "read_list", map[string]any{}); !failed || !strings.Contains(text, "assistant's helpers") {
		t.Fatalf("the assistant's helper read the person's items: %s", text)
	}
}

// create_workspace fromItemId moves the item's home to the new project and
// records it.
func TestCreateWorkspaceFromAnItemRehomesIt(t *testing.T) {
	f := newAssistantFixture(t)
	agent := defaultAssistantOf(t, f.server, f.aliceID)
	conversation := f.startSession(t, "ws_pa", "", "plan the family trip to Japan")
	token := f.mint(t, conversation.ID)
	trip, text, failed := f.updateItem(t, token, "add", map[string]any{"text": "Family trip to Japan", "quote": "plan the family trip to Japan"})
	if failed {
		t.Fatalf("add: %s", text)
	}
	if text, failed := f.tool(t, token, "create_workspace", map[string]any{"name": "Japan trip", "purpose": "Plan the trip.",
		"source": map[string]any{"kind": "empty"}, "fromItemId": "pai_missing"}); !failed || !strings.Contains(text, "no item") {
		t.Fatalf("create_workspace from a missing item: %s", text)
	}
	if len(f.lifecycle.creates) != 0 {
		t.Fatalf("a refused create still created: %v", f.lifecycle.calls)
	}
	text, failed = f.tool(t, token, "create_workspace", map[string]any{"name": "Japan trip", "purpose": "Plan the trip.",
		"source": map[string]any{"kind": "empty"}, "fromItemId": trip.Item.ID})
	if failed || !strings.Contains(text, `"homeOf": "`+trip.Item.ID+`"`) {
		t.Fatalf("create_workspace fromItemId: %s", text)
	}
	item, err := f.server.store.GetPersonalAgentItem(context.Background(), agent.ID, trip.Item.ID)
	if err != nil || item.HomeWorkspaceID != "ws_new" {
		t.Fatalf("the item's home = %q (%v)", item.HomeWorkspaceID, err)
	}
	events := f.itemEvents(t, agent.ID, trip.Item.ID)
	last := events[len(events)-1]
	if last.Kind != store.PersonalAgentItemEventRehomed || last.Detail.From != "" || last.Detail.To != "ws_new" || last.Actor != store.PersonalAgentActorAssistant {
		t.Fatalf("rehomed event = %+v", last)
	}
}
