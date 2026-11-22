package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// The items page reads the person's ledger (DEV-324: one per person): the
// list holds the items of every assistant of theirs, and an item is read,
// edited and deleted by its id whichever assistant's list holds it. The
// assistant routes stay scoped to their assistant.
func TestItemsPageReadsThePersonsLedger(t *testing.T) {
	f := newAssistantFixture(t)
	ctx := context.Background()
	home := mustAgent(t, f)
	work, err := f.server.store.CreatePersonalAgent(ctx, store.PersonalAgent{UserID: f.aliceID, Name: "Work", WorkspaceID: "ws_alice", HomeDeviceID: "dev_alice"})
	if err != nil || work.IsDefault {
		t.Fatalf("second assistant = %+v (%v)", work, err)
	}
	homeItem := addItem(t, f, home, "Renew the passport", store.PersonalAgentItemOwnerPerson)
	workItem := addItem(t, f, work, "Ship the release", store.PersonalAgentItemOwnerAssistant)

	recorder := doAuthCall(t, f.handler, f.as(f.alice, http.MethodGet, "/api/personal-agent/items", ""))
	expectStatus(t, recorder, http.StatusOK, "ledger")
	var page store.PersonalAgentItemList
	if err := json.Unmarshal(recorder.Body.Bytes(), &page); err != nil || page.Total != 2 {
		t.Fatalf("ledger = %s (%v)", recorder.Body.String(), err)
	}

	recorder = doAuthCall(t, f.handler, f.as(f.alice, http.MethodGet, "/api/personal-agent/items/"+workItem.ID, ""))
	expectStatus(t, recorder, http.StatusOK, "an item of the second assistant on the ledger")
	if !strings.Contains(recorder.Body.String(), "Ship the release") {
		t.Fatalf("detail = %s", recorder.Body.String())
	}
	body := `{"text":"Ship the release candidate","revision":` + jsonInt(workItem.Revision) + `}`
	expectStatus(t, doAuthCall(t, f.handler, f.as(f.alice, http.MethodPut, "/api/personal-agent/items/"+workItem.ID, body)), http.StatusOK, "edit on the ledger")
	if saved, err := f.server.store.GetPersonalAgentItem(ctx, work.ID, workItem.ID); err != nil || saved.Text != "Ship the release candidate" {
		t.Fatalf("edited item = %+v (%v)", saved, err)
	}

	// An assistant's own route reads only its list.
	expectStatus(t, doAuthCall(t, f.handler, f.as(f.alice, http.MethodGet, "/api/assistants/"+home.ID+"/items/"+workItem.ID, "")), http.StatusNotFound, "another assistant's item on an assistant route")
	recorder = doAuthCall(t, f.handler, f.as(f.alice, http.MethodGet, "/api/assistants/"+home.ID+"/items", ""))
	if err := json.Unmarshal(recorder.Body.Bytes(), &page); err != nil || page.Total != 1 || page.Items[0].ID != homeItem.ID {
		t.Fatalf("assistant page = %s (%v)", recorder.Body.String(), err)
	}

	// Another person's item is not on the ledger.
	expectStatus(t, doAuthCall(t, f.handler, f.as(f.bob, http.MethodGet, "/api/personal-agent/items/"+workItem.ID, "")), http.StatusNotFound, "someone else's item")
	expectStatus(t, doAuthCall(t, f.handler, f.as(f.alice, http.MethodDelete, "/api/personal-agent/items/"+workItem.ID, "")), http.StatusNoContent, "delete on the ledger")
}

func jsonInt(value int64) string {
	raw, _ := json.Marshal(value)
	return string(raw)
}

// The items page's workspace filter: a workspace keeps what is homed in or
// touches it, inbox what has no home workspace; both at once answer 400.
func TestItemsPageFiltersByWorkspaceOrInbox(t *testing.T) {
	f := newAssistantFixture(t)
	ctx := context.Background()
	agent := mustAgent(t, f)
	inboxItem := addItem(t, f, agent, "Renew the passport", store.PersonalAgentItemOwnerPerson)
	homed, err := f.server.store.AddPersonalAgentItem(ctx, store.PersonalAgentActorAssistant, store.PersonalAgentListItem{
		AssistantID: agent.ID, UserID: f.aliceID, Text: "Ship the release", Owner: store.PersonalAgentItemOwnerAssistant,
		Status: store.PersonalAgentItemOpen, Quote: "Ship the release", HomeWorkspaceID: "ws_alice"})
	if err != nil {
		t.Fatal(err)
	}
	read := func(query string) store.PersonalAgentItemList {
		t.Helper()
		recorder := doAuthCall(t, f.handler, f.as(f.alice, http.MethodGet, "/api/personal-agent/items?"+query, ""))
		expectStatus(t, recorder, http.StatusOK, query)
		var page store.PersonalAgentItemList
		if err := json.Unmarshal(recorder.Body.Bytes(), &page); err != nil {
			t.Fatal(err)
		}
		return page
	}
	if page := read("workspace=ws_alice"); page.Total != 1 || page.Items[0].ID != homed.ID {
		t.Fatalf("workspace page = %+v", page)
	}
	if page := read("inbox=true"); page.Total != 1 || page.Items[0].ID != inboxItem.ID {
		t.Fatalf("inbox page = %+v", page)
	}
	if page := read("inbox=false"); page.Total != 2 {
		t.Fatalf("inbox=false page = %+v", page)
	}
	expectStatus(t, doAuthCall(t, f.handler, f.as(f.alice, http.MethodGet, "/api/personal-agent/items?inbox=true&workspace=ws_alice", "")), http.StatusBadRequest, "workspace and inbox")
	expectStatus(t, doAuthCall(t, f.handler, f.as(f.alice, http.MethodGet, "/api/personal-agent/items?inbox=maybe", "")), http.StatusBadRequest, "inbox not a boolean")
}
