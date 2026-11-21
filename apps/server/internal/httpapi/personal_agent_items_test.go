package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// 「事项」 (DEV-258) on /api/personal-agent/items: the page's filters and
// shape, the report route, the detail, the archive that goes with the
// helper sessions, and the older /list route as an alias.

func addItem(t *testing.T, f assistantFixture, agent store.PersonalAgent, text, owner string) store.PersonalAgentListItem {
	t.Helper()
	item, err := f.server.store.AddPersonalAgentItem(context.Background(), store.PersonalAgentActorAssistant, store.PersonalAgentListItem{
		AssistantID: agent.ID, UserID: f.aliceID, Text: text, Owner: owner, Status: store.PersonalAgentItemOpen, Quote: text,
	})
	if err != nil {
		t.Fatal(err)
	}
	return item
}

// itemHelper starts a helper session in ws_alice and ties it to the item.
// Done ends it: its session completes and its task is done.
func itemHelper(t *testing.T, f assistantFixture, agent store.PersonalAgent, itemID, title string, done bool) (store.AgentSession, store.PersonalAgentTask) {
	t.Helper()
	ctx := context.Background()
	session := f.startSession(t, "ws_alice", f.conversation.ID, title)
	task, err := f.server.store.CreatePersonalAgentTask(ctx, store.PersonalAgentActorAssistant, store.PersonalAgentTask{
		UserID: f.aliceID, AssistantID: agent.ID, WorkspaceID: "ws_alice", SessionID: session.ID, Title: title, ItemID: itemID,
	})
	if err != nil {
		t.Fatal(err)
	}
	if done {
		finishItemHelper(t, f, task)
	}
	return session, task
}

func finishItemHelper(t *testing.T, f assistantFixture, task store.PersonalAgentTask) {
	t.Helper()
	ctx := context.Background()
	if _, err := f.server.store.CompleteAgentSession(ctx, task.SessionID, "done", "native_"+task.SessionID); err != nil {
		t.Fatal(err)
	}
	task.Status = store.PersonalAgentTaskDone
	if err := f.server.store.UpdatePersonalAgentTask(ctx, store.PersonalAgentActorFoundry, task); err != nil {
		t.Fatal(err)
	}
}

func decodeItemBody(t *testing.T, recorder *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var body map[string]any
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatalf("body %q: %v", recorder.Body.String(), err)
	}
	return body
}

// forbiddenItemKeys are the store's references and captures the items page never shows.
var forbiddenItemKeys = []string{"taskId", "sourceSessionId", "sourceInputId", "sourceInboxId", "captureKey", "captureHash", "userId", "assistantId"}

func expectNoForbiddenItemKeys(t *testing.T, raw string) {
	t.Helper()
	for _, key := range forbiddenItemKeys {
		if strings.Contains(raw, `"`+key+`"`) {
			t.Fatalf("the response shows %s: %s", key, raw)
		}
	}
}

// itemIDs are the ids of the items in a page body, in order.
func itemIDs(t *testing.T, body map[string]any) []string {
	t.Helper()
	items, ok := body["items"].([]any)
	if !ok {
		t.Fatalf("items = %v", body["items"])
	}
	ids := []string{}
	for _, raw := range items {
		item, _ := raw.(map[string]any)
		id, _ := item["id"].(string)
		ids = append(ids, id)
	}
	return ids
}

func expectItemIDs(t *testing.T, body map[string]any, want ...string) {
	t.Helper()
	got := itemIDs(t, body)
	if len(got) != len(want) {
		t.Fatalf("items = %v, want %v", got, want)
	}
	for _, id := range want {
		if !strings.Contains(strings.Join(got, ","), id) {
			t.Fatalf("items = %v, want %v", got, want)
		}
	}
}

func TestPersonalAgentItemsPageFiltersAndShape(t *testing.T) {
	f := newAssistantFixture(t)
	ctx := context.Background()
	agent := defaultAssistantOf(t, f.server, f.aliceID)
	recruiters := addItem(t, f, agent, "Reply to recruiters", store.PersonalAgentItemOwnerPerson)
	report := addItem(t, f, agent, "Ship the report", store.PersonalAgentItemOwnerAssistant)
	errand := addItem(t, f, agent, "Pick up the parcel", store.PersonalAgentItemOwnerPerson)
	dropped := addItem(t, f, agent, "Skip the gym", store.PersonalAgentItemOwnerPerson)
	helper, _ := itemHelper(t, f, agent, report.ID, "report draft", false)
	edit := func(id, body string) {
		t.Helper()
		expectStatus(t, doAuthCall(t, f.handler, f.as(f.alice, http.MethodPut, "/api/personal-agent/items/"+id, body)), http.StatusOK, "edit "+body)
	}
	edit(errand.ID, `{"status":"done"}`)
	edit(dropped.ID, `{"status":"dropped"}`)
	current, err := f.server.store.GetPersonalAgentItem(ctx, agent.ID, recruiters.ID)
	if err != nil {
		t.Fatal(err)
	}
	current.Summary = "Context: asked two recruiters for slots"
	if _, err := f.server.store.SavePersonalAgentItem(ctx, store.PersonalAgentActorAssistant, current); err != nil {
		t.Fatal(err)
	}
	list := func(query string) (*httptest.ResponseRecorder, map[string]any) {
		t.Helper()
		recorder := doAuthCall(t, f.handler, f.as(f.alice, http.MethodGet, "/api/personal-agent/items"+query, ""))
		expectStatus(t, recorder, http.StatusOK, "items"+query)
		expectNoForbiddenItemKeys(t, recorder.Body.String())
		return recorder, decodeItemBody(t, recorder)
	}

	_, open := list("")
	expectItemIDs(t, open, recruiters.ID, report.ID)
	if open["total"] != float64(2) {
		t.Fatalf("open total = %v", open["total"])
	}
	_, finished := list("?view=finished")
	expectItemIDs(t, finished, errand.ID, dropped.ID)
	_, archived := list("?view=archived")
	expectItemIDs(t, archived)
	_, assistantOwned := list("?owner=assistant")
	expectItemIDs(t, assistantOwned, report.ID)
	_, byText := list("?q=recruit")
	expectItemIDs(t, byText, recruiters.ID)
	_, bySummary := list("?q=CONTEXT")
	expectItemIDs(t, bySummary, recruiters.ID)
	_, literal := list("?q=%25")
	expectItemIDs(t, literal)

	_, first := list("?limit=1&offset=0")
	if len(itemIDs(t, first)) != 1 || first["total"] != float64(2) || first["nextOffset"] != float64(1) {
		t.Fatalf("first page = %v", first)
	}
	_, second := list("?limit=1&offset=1")
	if _, ok := second["nextOffset"]; ok || len(itemIDs(t, second)) != 1 {
		t.Fatalf("last page = %v", second)
	}

	reported := assistantOwned["items"].([]any)[0].(map[string]any)
	helpers, _ := reported["helpers"].([]any)
	if len(helpers) != 1 {
		t.Fatalf("helpers of the report item = %v", reported["helpers"])
	}
	row := helpers[0].(map[string]any)
	if row["sessionId"] != helper.ID || (row["status"] != store.PersonalAgentTaskQueued && row["status"] != store.PersonalAgentTaskRunning) || row["archived"] == true {
		t.Fatalf("helper row = %v", row)
	}
	for _, raw := range open["items"].([]any) {
		item := raw.(map[string]any)
		if item["id"] == recruiters.ID {
			if helpers, ok := item["helpers"].([]any); !ok || len(helpers) != 0 {
				t.Fatalf("a row without helpers shows %v", item["helpers"])
			}
		}
	}

	now := time.Now().UTC()
	_, future := list("?from=" + now.Add(time.Hour).Format(time.RFC3339))
	expectItemIDs(t, future)
	_, past := list("?to=" + now.Add(-time.Hour).Format(time.RFC3339))
	expectItemIDs(t, past)
	_, inRange := list("?from=" + now.Add(-time.Hour).Format(time.RFC3339) + "&to=" + now.Add(time.Hour).Format(time.RFC3339))
	expectItemIDs(t, inRange, recruiters.ID, report.ID)

	for _, query := range []string{"?limit=0", "?limit=201", "?limit=x", "?offset=-1", "?view=later", "?owner=robot", "?from=yesterday",
		"?from=" + now.Add(time.Hour).Format(time.RFC3339) + "&to=" + now.Format(time.RFC3339)} {
		expectStatus(t, doAuthCall(t, f.handler, f.as(f.alice, http.MethodGet, "/api/personal-agent/items"+query, "")), http.StatusBadRequest, "items"+query)
	}
}

func TestPersonalAgentItemReportRouteAndRange(t *testing.T) {
	f := newAssistantFixture(t)
	agent := defaultAssistantOf(t, f.server, f.aliceID)
	open := addItem(t, f, agent, "Plan the offsite", store.PersonalAgentItemOwnerPerson)
	done := addItem(t, f, agent, "Book the room", store.PersonalAgentItemOwnerPerson)
	dropped := addItem(t, f, agent, "Old idea", store.PersonalAgentItemOwnerPerson)
	for _, change := range []struct{ item, status string }{{done.ID, "done"}, {dropped.ID, "dropped"}} {
		expectStatus(t, doAuthCall(t, f.handler, f.as(f.alice, http.MethodPut, "/api/personal-agent/items/"+change.item, `{"status":"`+change.status+`"}`)), http.StatusOK, change.status)
	}

	// One fixed range around now: the three items were created and changed in it.
	now := time.Now().UTC()
	from, to := now.Add(-time.Hour).Format(time.RFC3339), now.Add(time.Hour).Format(time.RFC3339)
	recorder := doAuthCall(t, f.handler, f.as(f.alice, http.MethodGet, "/api/personal-agent/items/report?from="+from+"&to="+to, ""))
	expectStatus(t, recorder, http.StatusOK, "report")
	expectNoForbiddenItemKeys(t, recorder.Body.String())
	body := decodeItemBody(t, recorder)
	counts, _ := body["counts"].(map[string]any)
	if counts["created"] != float64(3) || counts["done"] != float64(1) || counts["dropped"] != float64(1) || counts["open"] != float64(1) {
		t.Fatalf("counts = %v", counts)
	}
	groups, _ := body["groups"].([]any)
	if len(groups) != 3 {
		t.Fatalf("groups = %v", body["groups"])
	}
	if first := groups[0].(map[string]any); first["status"] != store.PersonalAgentItemOpen || !strings.Contains(recorder.Body.String(), open.ID) {
		t.Fatalf("open group = %v", first)
	}

	// The literal route answers, not the item route: no range is 400 here, and
	// an item lookup would have answered 404 for "report".
	expectStatus(t, doAuthCall(t, f.handler, f.as(f.alice, http.MethodGet, "/api/personal-agent/items/report", "")), http.StatusBadRequest, "report without a range")
	expectStatus(t, doAuthCall(t, f.handler, f.as(f.alice, http.MethodGet, "/api/personal-agent/items/report?from="+to+"&to="+from, "")), http.StatusBadRequest, "report from after to")
}

func TestPersonalAgentItemDetailShowsHelpersAndTimeline(t *testing.T) {
	f := newAssistantFixture(t)
	agent := defaultAssistantOf(t, f.server, f.aliceID)
	item := addItem(t, f, agent, "Ship the report", store.PersonalAgentItemOwnerAssistant)
	helper, _ := itemHelper(t, f, agent, item.ID, "report draft", false)

	recorder := doAuthCall(t, f.handler, f.as(f.alice, http.MethodGet, "/api/personal-agent/items/"+item.ID, ""))
	expectStatus(t, recorder, http.StatusOK, "detail")
	expectNoForbiddenItemKeys(t, recorder.Body.String())
	body := decodeItemBody(t, recorder)
	shown, _ := body["item"].(map[string]any)
	if shown["id"] != item.ID || shown["owner"] != store.PersonalAgentItemOwnerAssistant {
		t.Fatalf("item = %v", shown)
	}
	if helpers, _ := shown["helpers"].([]any); len(helpers) != 1 || helpers[0].(map[string]any)["sessionId"] != helper.ID {
		t.Fatalf("helpers = %v", shown["helpers"])
	}
	events, _ := body["events"].([]any)
	kinds := map[string]bool{}
	for _, raw := range events {
		kind, _ := raw.(map[string]any)["kind"].(string)
		kinds[kind] = true
	}
	if !kinds[store.PersonalAgentItemEventCreated] || !kinds[store.PersonalAgentItemEventHelperStarted] {
		t.Fatalf("timeline kinds = %v", kinds)
	}
	expectStatus(t, doAuthCall(t, f.handler, f.as(f.alice, http.MethodGet, "/api/personal-agent/items/item_missing", "")), http.StatusNotFound, "unknown item")
}

// Archive is the person's: an open item or one with a running helper is
// refused (409), a closed one archives with its ended helper sessions through
// the session archive, and restoring brings back only the sessions that
// archive took (a session archived before the item stays archived).
func TestPersonalAgentItemArchiveCascadesToItsHelpers(t *testing.T) {
	f := newAssistantFixture(t)
	ctx := context.Background()
	agent := defaultAssistantOf(t, f.server, f.aliceID)
	item := addItem(t, f, agent, "Ship the report", store.PersonalAgentItemOwnerAssistant)
	ended, endedTask := itemHelper(t, f, agent, item.ID, "first draft", true)
	running, runningTask := itemHelper(t, f, agent, item.ID, "second draft", false)
	earlier, _ := itemHelper(t, f, agent, item.ID, "reviewed earlier", true)
	edit := func(body string) *httptest.ResponseRecorder {
		return doAuthCall(t, f.handler, f.as(f.alice, http.MethodPut, "/api/personal-agent/items/"+item.ID, body))
	}
	sessionArchived := func(id string) bool {
		t.Helper()
		session, err := f.server.store.GetAgentSessionSummary(ctx, id)
		if err != nil {
			t.Fatal(err)
		}
		return session.ArchivedAt != ""
	}

	expectStatus(t, edit(`{"archived":true}`), http.StatusConflict, "archive an open item")
	expectStatus(t, edit(`{"revision":999,"text":"Ship it"}`), http.StatusConflict, "a stale revision")
	expectStatus(t, edit(`{"status":"done"}`), http.StatusOK, "finish the item")
	expectStatus(t, edit(`{"archived":true}`), http.StatusConflict, "archive with a helper running")
	finishItemHelper(t, f, runningTask)

	// The person archives one helper session by hand before the item archive.
	expectStatus(t, doAuthCall(t, f.handler, f.as(f.alice, http.MethodPost, "/api/chats/archive", `{"workspaceId":"ws_alice","chatIds":["`+earlier.ID+`"]}`)), http.StatusOK, "archive a helper by hand")

	archived := edit(`{"archived":true}`)
	expectStatus(t, archived, http.StatusOK, "archive the finished item")
	if decodeItemBody(t, archived)["archivedAt"] == nil {
		t.Fatalf("archived item has no archivedAt: %s", archived.Body.String())
	}
	if !sessionArchived(ended.ID) || !sessionArchived(running.ID) {
		t.Fatal("the archive did not take the ended helper sessions")
	}
	if session, _ := f.server.store.GetAgentSessionSummary(ctx, ended.ID); session.ArchivedByUser != f.aliceID {
		t.Fatalf("helper archived by %q, want the person's session archive", session.ArchivedByUser)
	}
	expectStatus(t, doAuthCall(t, f.handler, f.as(f.alice, http.MethodGet, "/api/personal-agent/items?view=archived", "")), http.StatusOK, "archived view")

	expectStatus(t, edit(`{"archived":false}`), http.StatusOK, "restore the item")
	if sessionArchived(ended.ID) || sessionArchived(running.ID) {
		t.Fatal("the restore left a helper session the archive took archived")
	}
	if !sessionArchived(earlier.ID) {
		t.Fatal("the restore restored a session the person archived before the item")
	}
	_ = endedTask

	// The sweep's port archives as the person whose assistant it is.
	if err := f.server.archiveItemSessionsForAssistant(ctx, store.PersonalAgentActorFoundry, agent.ID, item.ID, []string{ended.ID}); err != nil {
		t.Fatal(err)
	}
	if !sessionArchived(ended.ID) {
		t.Fatal("the sweep's port did not archive the session")
	}
}

// itemSessionArchived reports whether a helper session is archived.
func itemSessionArchived(t *testing.T, f assistantFixture, id string) bool {
	t.Helper()
	session, err := f.server.store.GetAgentSessionSummary(context.Background(), id)
	if err != nil {
		t.Fatal(err)
	}
	return session.ArchivedAt != ""
}

// A restore gives back exactly the helper sessions its archive took. A helper
// the person archived by hand while the item was archived stays archived, and
// so does one the archive took, then the person restored and archived again.
func TestPersonalAgentItemRestoreGivesBackOnlyWhatTheArchiveTook(t *testing.T) {
	f := newAssistantFixture(t)
	agent := defaultAssistantOf(t, f.server, f.aliceID)
	item := addItem(t, f, agent, "Send the notes", store.PersonalAgentItemOwnerAssistant)
	taken, _ := itemHelper(t, f, agent, item.ID, "notes taken", true)
	handed, _ := itemHelper(t, f, agent, item.ID, "notes handed", true)
	edit := func(body string) *httptest.ResponseRecorder {
		return doAuthCall(t, f.handler, f.as(f.alice, http.MethodPut, "/api/personal-agent/items/"+item.ID, body))
	}
	chat := func(path, id string) *httptest.ResponseRecorder {
		return doAuthCall(t, f.handler, f.as(f.alice, http.MethodPost, path, `{"workspaceId":"ws_alice","chatIds":["`+id+`"]}`))
	}
	sessionEvents := func() string {
		t.Helper()
		recorder := doAuthCall(t, f.handler, f.as(f.alice, http.MethodGet, "/api/personal-agent/items/"+item.ID, ""))
		expectStatus(t, recorder, http.StatusOK, "detail")
		var lines []string
		events, _ := decodeItemBody(t, recorder)["events"].([]any)
		for _, raw := range events {
			event, _ := raw.(map[string]any)
			detail, _ := event["detail"].(map[string]any)
			kind, _ := event["kind"].(string)
			sessionID, _ := detail["sessionId"].(string)
			if sessionID != "" && (kind == store.PersonalAgentItemEventArchived || kind == store.PersonalAgentItemEventRestored) {
				lines = append(lines, kind+" "+sessionID)
			}
		}
		return strings.Join(lines, ", ")
	}

	expectStatus(t, edit(`{"status":"done"}`), http.StatusOK, "finish the item")
	expectStatus(t, edit(`{"archived":true}`), http.StatusOK, "archive the item")
	if !itemSessionArchived(t, f, taken.ID) || !itemSessionArchived(t, f, handed.ID) {
		t.Fatal("the archive did not take the helper sessions")
	}
	expectStatus(t, chat("/api/chats/unarchive", handed.ID), http.StatusOK, "restore a helper by hand")
	expectStatus(t, chat("/api/chats/archive", handed.ID), http.StatusOK, "archive it again by hand")
	added, _ := itemHelper(t, f, agent, item.ID, "added while archived", true)
	expectStatus(t, chat("/api/chats/archive", added.ID), http.StatusOK, "archive a later helper by hand")

	expectStatus(t, edit(`{"archived":false}`), http.StatusOK, "restore the item")
	if itemSessionArchived(t, f, taken.ID) {
		t.Fatal("the restore left the helper the archive took archived")
	}
	if !itemSessionArchived(t, f, handed.ID) || !itemSessionArchived(t, f, added.ID) {
		t.Fatal("the restore took back a helper the person archived by hand")
	}
	want := "archived " + taken.ID + ", archived " + handed.ID + ", restored " + taken.ID
	if got := sessionEvents(); got != want {
		t.Fatalf("session events = %q, want %q", got, want)
	}
}

// Each archive takes the item's helper sessions again, and each restore gives
// back exactly those, so a later archive and restore work the same way.
func TestPersonalAgentItemArchiveCyclesEachTakeAndGiveBack(t *testing.T) {
	f := newAssistantFixture(t)
	agent := defaultAssistantOf(t, f.server, f.aliceID)
	item := addItem(t, f, agent, "Review the draft", store.PersonalAgentItemOwnerPerson)
	helper, _ := itemHelper(t, f, agent, item.ID, "review pass", true)
	edit := func(body string) *httptest.ResponseRecorder {
		return doAuthCall(t, f.handler, f.as(f.alice, http.MethodPut, "/api/personal-agent/items/"+item.ID, body))
	}
	expectStatus(t, edit(`{"status":"done"}`), http.StatusOK, "finish the item")
	for cycle := 1; cycle <= 2; cycle++ {
		expectStatus(t, edit(`{"archived":true}`), http.StatusOK, "archive the item")
		if !itemSessionArchived(t, f, helper.ID) {
			t.Fatalf("cycle %d: the archive did not take the helper session", cycle)
		}
		expectStatus(t, edit(`{"archived":false}`), http.StatusOK, "restore the item")
		if itemSessionArchived(t, f, helper.ID) {
			t.Fatalf("cycle %d: the restore left the helper session archived", cycle)
		}
	}
}

// A request that changes fields and archives is all or nothing: an archive the
// item cannot take refuses the whole request, and a closed item takes both.
func TestPersonalAgentItemEditWithArchiveIsAllOrNothing(t *testing.T) {
	f := newAssistantFixture(t)
	agent := defaultAssistantOf(t, f.server, f.aliceID)
	item := addItem(t, f, agent, "Book the venue", store.PersonalAgentItemOwnerPerson)
	edit := func(body string) *httptest.ResponseRecorder {
		return doAuthCall(t, f.handler, f.as(f.alice, http.MethodPut, "/api/personal-agent/items/"+item.ID, body))
	}
	shown := func() map[string]any {
		t.Helper()
		recorder := doAuthCall(t, f.handler, f.as(f.alice, http.MethodGet, "/api/personal-agent/items/"+item.ID, ""))
		expectStatus(t, recorder, http.StatusOK, "detail")
		view, _ := decodeItemBody(t, recorder)["item"].(map[string]any)
		return view
	}
	isArchived := func(view map[string]any) bool {
		archivedAt, _ := view["archivedAt"].(string)
		return archivedAt != ""
	}

	expectStatus(t, edit(`{"text":"Book the hall","archived":true}`), http.StatusConflict, "archive an open item with a text change")
	if got := shown(); got["text"] != "Book the venue" || isArchived(got) {
		t.Fatalf("a refused archive saved the text or the archive: %v", got)
	}
	expectStatus(t, edit(`{"status":"done"}`), http.StatusOK, "finish the item")
	expectStatus(t, edit(`{"revision":999,"text":"Book the hall","archived":true}`), http.StatusConflict, "a stale revision with an archive")
	if got := shown(); got["text"] != "Book the venue" || isArchived(got) {
		t.Fatalf("a refused request saved its fields or its archive: %v", got)
	}
	expectStatus(t, edit(`{"text":"Book the hall","archived":true}`), http.StatusOK, "text and archive on a closed item")
	if got := shown(); got["text"] != "Book the hall" || !isArchived(got) {
		t.Fatalf("the closed item did not take both the text and the archive: %v", got)
	}
}

// The /list routes answer the same handlers: the page's shape, the
// closedSince query, and no store references.
func TestPersonalAgentListAliasAnswersTheItemsShape(t *testing.T) {
	f := newAssistantFixture(t)
	agent := defaultAssistantOf(t, f.server, f.aliceID)
	item := addItem(t, f, agent, "Reply on WeChat", store.PersonalAgentItemOwnerPerson)

	listed := doAuthCall(t, f.handler, f.as(f.alice, http.MethodGet, "/api/personal-agent/list", ""))
	expectStatus(t, listed, http.StatusOK, "list alias")
	expectNoForbiddenItemKeys(t, listed.Body.String())
	if body := decodeItemBody(t, listed); body["total"] != float64(1) || body["offset"] != float64(0) {
		t.Fatalf("alias page = %v", body)
	}
	expectStatus(t, doAuthCall(t, f.handler, f.as(f.alice, http.MethodPut, "/api/personal-agent/list/"+item.ID, `{"status":"done"}`)), http.StatusOK, "tick via alias")
	if open := doAuthCall(t, f.handler, f.as(f.alice, http.MethodGet, "/api/personal-agent/list", "")); strings.Contains(open.Body.String(), item.ID) {
		t.Fatalf("a done item is listed without closedSince: %s", open.Body.String())
	}
	since := time.Now().Add(-time.Hour).UTC().Format(time.RFC3339Nano)
	closed := doAuthCall(t, f.handler, f.as(f.alice, http.MethodGet, "/api/personal-agent/list?closedSince="+since, ""))
	expectStatus(t, closed, http.StatusOK, "closedSince")
	if !strings.Contains(closed.Body.String(), item.ID) {
		t.Fatalf("done since %s: %s", since, closed.Body.String())
	}
	expectStatus(t, doAuthCall(t, f.handler, f.as(f.alice, http.MethodGet, "/api/personal-agent/list?closedSince=yesterday", "")), http.StatusBadRequest, "bad closedSince")
	expectStatus(t, doAuthCall(t, f.handler, f.as(f.alice, http.MethodDelete, "/api/personal-agent/items/"+item.ID, "")), http.StatusNoContent, "delete on the items route")
}

// The person's plan choice (PUT plan) merges over the assistant's plan: the
// route, the project and the dependencies change, the rest stays. A cycle or
// an unknown route is 400, a project the person is not in is 404, and a
// closed item refuses the choice with 409.
func TestPersonalAgentItemPlanChoiceMergesAndRefuses(t *testing.T) {
	f := newAssistantFixture(t)
	ctx := context.Background()
	agent := defaultAssistantOf(t, f.server, f.aliceID)
	put := func(id, body string) *httptest.ResponseRecorder {
		return doAuthCall(t, f.handler, f.as(f.alice, http.MethodPut, "/api/personal-agent/items/"+id, body))
	}

	planned := addItem(t, f, agent, "Draft the proposal", store.PersonalAgentItemOwnerAssistant)
	current, err := f.server.store.GetPersonalAgentItem(ctx, agent.ID, planned.ID)
	if err != nil {
		t.Fatal(err)
	}
	current.Plan = &store.PersonalAgentItemPlan{Mode: "execute", Progress: "working", NextAction: "send the draft",
		Evidence: []store.PersonalAgentCompletionEvidence{{Kind: "test", Ref: "outline", Summary: "checked", ObservedAt: time.Now().UTC().Format(time.RFC3339Nano)}}}
	if _, err := f.server.store.SavePersonalAgentItem(ctx, store.PersonalAgentActorAssistant, current); err != nil {
		t.Fatal(err)
	}
	chosen := put(planned.ID, `{"plan":{"route":"existing","workspaceId":"ws_alice"}}`)
	expectStatus(t, chosen, http.StatusOK, "choose a route and a project")
	plan, _ := decodeItemBody(t, chosen)["plan"].(map[string]any)
	route, _ := plan["route"].(map[string]any)
	if plan["mode"] != "execute" || plan["progress"] != "working" || plan["nextAction"] != "send the draft" || plan["workspaceId"] != "ws_alice" ||
		route["kind"] != "existing" || route["needsClarification"] != false {
		t.Fatalf("merged plan = %v", plan)
	}
	if evidence, _ := plan["evidence"].([]any); len(evidence) != 1 {
		t.Fatalf("the evidence was lost: %v", plan["evidence"])
	}
	clarify := put(planned.ID, `{"plan":{"route":"clarify"}}`)
	expectStatus(t, clarify, http.StatusOK, "ask for clarification")
	plan, _ = decodeItemBody(t, clarify)["plan"].(map[string]any)
	route, _ = plan["route"].(map[string]any)
	if route["kind"] != "clarify" || route["needsClarification"] != true || plan["workspaceId"] != "ws_alice" || plan["progress"] != "working" {
		t.Fatalf("second merge = %v", plan)
	}

	inbox := put(planned.ID, `{"plan":{"workspaceId":""}}`)
	expectStatus(t, inbox, http.StatusOK, "move the item back to the inbox")
	moved := decodeItemBody(t, inbox)
	plan, _ = moved["plan"].(map[string]any)
	if _, ok := moved["homeWorkspaceId"]; ok || plan["workspaceId"] != nil || plan["progress"] != "working" {
		t.Fatalf("the inbox move = home %v, plan %v", moved["homeWorkspaceId"], plan)
	}

	fresh := addItem(t, f, agent, "Book the room", store.PersonalAgentItemOwnerPerson)
	record := put(fresh.ID, `{"plan":{"route":"record"}}`)
	expectStatus(t, record, http.StatusOK, "a plan for an item without one")
	plan, _ = decodeItemBody(t, record)["plan"].(map[string]any)
	if plan["mode"] != "record" || plan["progress"] != "inbox" {
		t.Fatalf("a new plan = %v", plan)
	}
	expectStatus(t, put(fresh.ID, `{"plan":{"route":"later"}}`), http.StatusBadRequest, "an unknown route")
	expectStatus(t, put(fresh.ID, `{"plan":{"workspaceId":"ws_not_yours"}}`), http.StatusNotFound, "a project the person is not in")

	first := addItem(t, f, agent, "Collect the receipts", store.PersonalAgentItemOwnerPerson)
	second := addItem(t, f, agent, "File the expenses", store.PersonalAgentItemOwnerPerson)
	expectStatus(t, put(first.ID, `{"plan":{"dependencies":["`+second.ID+`"]}}`), http.StatusOK, "first depends on second")
	expectStatus(t, put(second.ID, `{"plan":{"dependencies":["`+first.ID+`"]}}`), http.StatusBadRequest, "a dependency cycle")

	closed := addItem(t, f, agent, "Old errand", store.PersonalAgentItemOwnerPerson)
	expectStatus(t, put(closed.ID, `{"status":"done"}`), http.StatusOK, "finish the errand")
	expectStatus(t, put(closed.ID, `{"plan":{"route":"record"}}`), http.StatusConflict, "a plan on a closed item")
}

// Reopening an archived item is a restore: the helper sessions its archive took
// come back, as an archived=false restore gives them back, and the timeline
// records the restore of the item and of each session once.
func TestPersonalAgentItemReopenRestoresItsHelpers(t *testing.T) {
	f := newAssistantFixture(t)
	ctx := context.Background()
	agent := defaultAssistantOf(t, f.server, f.aliceID)
	item := addItem(t, f, agent, "Send the notes", store.PersonalAgentItemOwnerAssistant)
	taken, _ := itemHelper(t, f, agent, item.ID, "notes taken", true)
	edit := func(body string) *httptest.ResponseRecorder {
		return doAuthCall(t, f.handler, f.as(f.alice, http.MethodPut, "/api/personal-agent/items/"+item.ID, body))
	}

	expectStatus(t, edit(`{"status":"done"}`), http.StatusOK, "finish the item")
	expectStatus(t, edit(`{"archived":true}`), http.StatusOK, "archive the item")
	if !itemSessionArchived(t, f, taken.ID) {
		t.Fatal("the archive did not take the helper session")
	}
	expectStatus(t, edit(`{"status":"open"}`), http.StatusOK, "reopen the item")

	if itemSessionArchived(t, f, taken.ID) {
		t.Fatal("reopening left the helper the archive took archived")
	}
	stored, err := f.server.store.GetPersonalAgentItem(ctx, agent.ID, item.ID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.Status != store.PersonalAgentItemOpen || stored.ArchivedAt != "" {
		t.Fatalf("reopened item = status %q archived %q", stored.Status, stored.ArchivedAt)
	}
	events, err := f.server.store.ListPersonalAgentItemEvents(ctx, agent.ID, item.ID)
	if err != nil {
		t.Fatal(err)
	}
	restored := 0
	for _, event := range events {
		if event.Kind == store.PersonalAgentItemEventRestored {
			restored++
		}
	}
	if restored != 2 {
		t.Fatalf("restored events = %d, want 2 (the item and its one helper): %+v", restored, events)
	}
}
