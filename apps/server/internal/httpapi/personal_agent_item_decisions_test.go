package httpapi

import (
	"encoding/json"
	"slices"
	"strings"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// A session in a workspace records the person's decisions on an item homed
// there with op decide: only from the person's own words in the
// conversation, with a later one superseding an earlier one. A plan written
// without acceptance keeps the criteria the item had; an empty list clears
// them.
func TestWorkspaceSessionRecordsDecisionsAndAcceptance(t *testing.T) {
	f := newAssistantFixture(t)
	agent := defaultAssistantOf(t, f.server, f.aliceID)
	session := f.startSession(t, "ws_alice", "", "reply in group chats with an emoji only, no text line")
	token := f.mint(t, session.ID)

	added, text, failed := f.updateItem(t, token, "add", map[string]any{"text": "Channel replies", "quote": "reply in group chats with an emoji only"})
	if failed {
		t.Fatalf("add: %s", text)
	}
	id := added.Item.ID

	if _, text, failed := f.updateItem(t, token, "decide", map[string]any{"id": id, "decision": "Ship on Friday", "quote": "ship it on Friday"}); !failed || !strings.Contains(text, "not recorded") {
		t.Fatalf("a decision from words the person did not write: %s", text)
	}
	if _, text, failed := f.updateItem(t, token, "update", map[string]any{"id": id, "decision": "x", "quote": "emoji only"}); !failed || !strings.Contains(text, "belong to op decide") {
		t.Fatalf("a decision through update: %s", text)
	}
	text, failed = f.tool(t, token, "update_list", map[string]any{"op": "decide", "item": map[string]any{"id": id, "decision": "Post a short text line", "quote": "reply in group chats"}})
	var first struct {
		DecisionID string `json:"decisionId"`
	}
	if err := json.Unmarshal([]byte(text), &first); failed || err != nil || first.DecisionID == "" {
		t.Fatalf("decide: %s", text)
	}
	if _, text, failed := f.updateItem(t, token, "decide", map[string]any{"id": id, "decision": "React with an emoji, no text", "quote": "an emoji only, no text line", "supersedes": first.DecisionID}); failed {
		t.Fatalf("a superseding decision: %s", text)
	}
	var decided []store.PersonalAgentItemEvent
	for _, event := range f.itemEvents(t, agent.ID, id) {
		if event.Kind == store.PersonalAgentItemEventDecided {
			decided = append(decided, event)
		}
	}
	if len(decided) != 2 || decided[0].Actor != store.PersonalAgentActorSession || decided[1].Detail == nil || decided[1].Detail.Supersedes != first.DecisionID {
		t.Fatalf("decided events = %+v", decided)
	}

	current, err := f.server.store.GetPersonalAgentItem(t.Context(), agent.ID, id)
	if err != nil {
		t.Fatal(err)
	}
	plan := map[string]any{"mode": "record", "progress": "working", "acceptance": []string{"No text line when blocked", "Details reach the person"}}
	planned, text, failed := f.updateItem(t, token, "update", map[string]any{"id": id, "revision": current.Revision, "plan": plan, "quote": "reply in group chats"})
	if failed || planned.Item.Plan == nil || len(planned.Item.Plan.Acceptance) != 2 {
		t.Fatalf("a plan with acceptance: %s", text)
	}
	moved, text, failed := f.updateItem(t, token, "update", map[string]any{"id": id, "revision": planned.Item.Revision,
		"plan": map[string]any{"mode": "record", "progress": "review", "nextAction": "check on dev"}, "quote": "reply in group chats"})
	if failed || moved.Item.Plan == nil || !slices.Equal(moved.Item.Plan.Acceptance, planned.Item.Plan.Acceptance) {
		t.Fatalf("a plan without acceptance kept %s", text)
	}
	cleared, text, failed := f.updateItem(t, token, "update", map[string]any{"id": id, "revision": moved.Item.Revision,
		"plan": map[string]any{"mode": "record", "progress": "review", "acceptance": []string{}}, "quote": "reply in group chats"})
	if failed || cleared.Item.Plan == nil || len(cleared.Item.Plan.Acceptance) != 0 {
		t.Fatalf("an empty acceptance list did not clear: %s", text)
	}
	long := strings.Repeat("x", store.PersonalAgentItemCriterionMaxLength+1)
	if _, text, failed := f.updateItem(t, token, "update", map[string]any{"id": id, "revision": cleared.Item.Revision,
		"plan": map[string]any{"mode": "record", "progress": "review", "acceptance": []string{long}}, "quote": "reply in group chats"}); !failed || !strings.Contains(text, "criterion") {
		t.Fatalf("an over-long criterion: %s", text)
	}
}
