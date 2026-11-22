package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// A Needs you entry names the open item its session works on, found from
// what Foundry recorded: a helper's item, or the one item its session holds.
// The items list and an item's detail show what waits on the person there.
func TestNeedsYouEntriesNameTheirItem(t *testing.T) {
	f := newAssistantFixture(t)
	ctx := context.Background()
	agent := mustAgent(t, f)
	helped := addItem(t, f, agent, "Renew the passport", store.PersonalAgentItemOwnerPerson)
	held := addItem(t, f, agent, "Ship the release", store.PersonalAgentItemOwnerAssistant)
	sharedOne := addItem(t, f, agent, "Book the hotel", store.PersonalAgentItemOwnerAssistant)
	sharedTwo := addItem(t, f, agent, "Book the train", store.PersonalAgentItemOwnerAssistant)
	helper, _ := itemHelper(t, f, agent, helped.ID, "passport helper", false)
	holder := f.startSession(t, "ws_alice", "", "release chat")
	if _, _, err := f.server.store.ClaimPersonalAgentItem(ctx, store.PersonalAgentActorSession, agent.ID, held.ID, holder.ID); err != nil {
		t.Fatal(err)
	}
	both := f.startSession(t, "ws_alice", "", "travel chat")
	for _, item := range []store.PersonalAgentListItem{sharedOne, sharedTwo} {
		if _, _, err := f.server.store.ClaimPersonalAgentItem(ctx, store.PersonalAgentActorSession, agent.ID, item.ID, both.ID); err != nil {
			t.Fatal(err)
		}
	}
	record := func(sessionID, key, handler string) {
		t.Helper()
		if _, _, err := f.server.store.RecordPendingItem(ctx, store.PendingItem{
			UserID: f.aliceID, WorkspaceID: "ws_alice", SessionID: sessionID, Source: store.PendingSourceQuestion,
			Key: key, Title: key, Excerpt: key, Handler: handler, AssistantID: agent.ID,
		}); err != nil {
			t.Fatal(err)
		}
	}
	record(helper.ID, "question:helper", store.PendingHandlerPerson)
	record(helper.ID, "question:helper:assistant", store.PendingHandlerAssistant)
	record(holder.ID, "question:holder", store.PendingHandlerPerson)
	record(both.ID, "question:both", store.PendingHandlerPerson)

	recorder := doAuthCall(t, f.handler, f.as(f.alice, http.MethodGet, "/api/pending-items", ""))
	expectStatus(t, recorder, http.StatusOK, "pending items")
	var list pendingItemList
	if err := json.Unmarshal(recorder.Body.Bytes(), &list); err != nil {
		t.Fatal(err)
	}
	want := map[string]string{"question:helper": helped.ID, "question:helper:assistant": helped.ID, "question:holder": held.ID, "question:both": ""}
	for _, item := range list.Items {
		if item.ItemID != want[item.Title] {
			t.Errorf("%s: item = %q, want %q", item.Title, item.ItemID, want[item.Title])
		}
		if item.ItemID == helped.ID && (item.ItemText != "Renew the passport" || item.ItemAssistantID != agent.ID) {
			t.Errorf("%s: names %q of %q", item.Title, item.ItemText, item.ItemAssistantID)
		}
	}
	if len(list.Items) != 4 {
		t.Fatalf("pending items = %+v", list.Items)
	}

	recorder = doAuthCall(t, f.handler, f.as(f.alice, http.MethodGet, "/api/personal-agent/items", ""))
	expectStatus(t, recorder, http.StatusOK, "items")
	var page store.PersonalAgentItemList
	if err := json.Unmarshal(recorder.Body.Bytes(), &page); err != nil {
		t.Fatal(err)
	}
	counts := map[string]int{}
	for _, item := range page.Items {
		counts[item.ID] = len(item.NeedsYou)
	}
	// The assistant's own entry waits on the assistant, not the person.
	if counts[helped.ID] != 1 || counts[held.ID] != 1 || counts[sharedOne.ID] != 0 || counts[sharedTwo.ID] != 0 {
		t.Fatalf("waiting by item = %+v", counts)
	}

	recorder = doAuthCall(t, f.handler, f.as(f.alice, http.MethodGet, "/api/personal-agent/items/"+helped.ID, ""))
	expectStatus(t, recorder, http.StatusOK, "item detail")
	var detail store.PersonalAgentItemDetail
	if err := json.Unmarshal(recorder.Body.Bytes(), &detail); err != nil {
		t.Fatal(err)
	}
	if len(detail.Item.NeedsYou) != 1 || detail.Item.NeedsYou[0].Title != "question:helper" || detail.Item.NeedsYou[0].SessionID != helper.ID {
		t.Fatalf("detail needsYou = %+v", detail.Item.NeedsYou)
	}
}
