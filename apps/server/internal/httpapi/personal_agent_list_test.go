package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/personalagent"
	"github.com/foundry-dev/foundry/apps/server/internal/personalagent/prompt"
	"github.com/foundry-dev/foundry/apps/server/internal/sessions"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// The person's message from real use (dev, 2026-10-15): plans, a draft
// to finish and something already done.
const plansMessage = "几个事情啊，一个是我昨晚联系了很多猎头，然后他们的一些微信消息我还没有回复。下班再搞。另外是下班也回去看一下脉脉有没有新信息，要礼貌回复\n" +
	"然后是我下午要去给大家捋一下现在Atlas的流程，以及我想提出说把Atlas流程跟Tag流程给合并一下。正在写文档，还在修订中。得赶紧干完，在尽量在下午能够拉齐一个会议去说这个事情。\n\n" +
	"然后刚刚跟小林，也就是QA对了一下，他们有在维护一个提测这样的Workflow，然后我们后续看看可以直接调他的提测Workflow。"

// The assistant keeps the person's list only from their own words: each
// thing they plan or did, with their words for when; a reminder needs a
// time to come; its own task may be linked without a quote. The list
// reaches each turn's context and read_list, and the audit keeps no text.
func TestAssistantKeepsThePersonsList(t *testing.T) {
	f := newAssistantFixture(t)
	ctx := context.Background()
	conversation := f.startSession(t, "ws_pa", "", plansMessage)
	token := f.mint(t, conversation.ID)
	update := func(op string, item map[string]any) (store.PersonalAgentListItem, string, bool) {
		t.Helper()
		text, failed := f.tool(t, token, "update_list", map[string]any{"op": op, "item": item})
		var answer struct {
			Item store.PersonalAgentListItem
			Note string
		}
		_ = json.Unmarshal([]byte(text), &answer)
		if failed {
			return answer.Item, text, true
		}
		return answer.Item, answer.Note, false
	}
	add := func(item map[string]any) store.PersonalAgentListItem {
		t.Helper()
		added, text, failed := update("add", item)
		if failed {
			t.Fatalf("add %v: %s", item, text)
		}
		return added
	}
	wechat := add(map[string]any{"text": "回猎头的微信消息", "when": "下班后", "quote": "他们的一些微信消息我还没有回复。下班再搞"})
	add(map[string]any{"text": "看脉脉有没有新信息，礼貌回复", "when": "下班后", "quote": "下班也回去看一下脉脉有没有新信息，要礼貌回复"})
	talk := add(map[string]any{"text": "给大家捋 Atlas 流程，提议和 Tag 流程合并", "when": "下午", "quote": "我下午要去给大家捋一下现在Atlas的流程"})
	qa := add(map[string]any{"text": "和小林（QA）对了提测 Workflow", "status": "done", "quote": "刚刚跟小林，也就是QA对了一下"})
	if wechat.Status != store.PersonalAgentItemOpen || wechat.When != "下班后" || wechat.Quote == "" || wechat.SourceSessionID != conversation.ID {
		t.Fatalf("wechat = %+v", wechat)
	}
	if qa.Status != store.PersonalAgentItemDone || qa.ClosedAt == "" {
		t.Fatalf("something already done = %+v", qa)
	}

	for label, item := range map[string]map[string]any{
		"words not theirs": {"text": "约下午的会", "quote": "我去找大家都有空的时间，把会约上"},
		"no quote":         {"text": "回微信"},
	} {
		if _, text, failed := update("add", item); !failed || !(strings.Contains(text, "not added") || strings.Contains(text, "item.quote is required")) {
			t.Errorf("%s: %s", label, text)
		}
	}
	if _, text, failed := update("update", map[string]any{"id": wechat.ID, "remind": true, "quote": "下班再搞"}); !failed || !strings.Contains(text, "remind needs item.at") {
		t.Errorf("a reminder without a time: %s", text)
	}
	if _, text, failed := update("update", map[string]any{"id": wechat.ID, "at": time.Now().Add(-time.Hour).Format(time.RFC3339), "remind": true, "quote": "下班再搞"}); !failed || !strings.Contains(text, "already past") {
		t.Errorf("a reminder in the past: %s", text)
	}
	later := time.Now().Add(3 * time.Hour).UTC().Format(time.RFC3339)
	reminded, note, failed := update("update", map[string]any{"id": wechat.ID, "at": later, "remind": true, "quote": "下班再搞"})
	if failed || reminded.At != later || !reminded.Remind || !strings.Contains(note, "Foundry will remind you") {
		t.Fatalf("a reminder: %+v %s", reminded, note)
	}

	if _, text, failed := update("update", map[string]any{"id": talk.ID, "taskId": "pat_nope"}); !failed || !strings.Contains(text, "no task") {
		t.Errorf("someone else's task: %s", text)
	}
	agent, _ := f.server.store.GetPersonalAgent(ctx, f.aliceID)
	helper := f.startSession(t, "ws_alice", conversation.ID, "review the draft")
	f.server.assistant.RecordTask(ctx, agent, conversation.ID, helper, "")
	tasks, _ := f.server.store.ListPersonalAgentTasks(ctx, agent.ID, nil)
	if _, text, failed := update("update", map[string]any{"id": talk.ID, "taskId": tasks[0].ID}); failed {
		t.Fatalf("linking its own task needs no quote: %s", text)
	}
	if linkedTasks, _ := f.server.store.ListPersonalAgentTasks(ctx, agent.ID, nil); len(linkedTasks) == 0 || linkedTasks[0].ItemID != talk.ID {
		t.Fatalf("the task does not name its item: %+v", linkedTasks)
	}

	audit := f.lastAction(t)
	if audit.Tool != "update_list" || audit.Outcome != store.PersonalAgentOutcomeApplied || strings.Contains(audit.ArgsSummary, "Atlas") {
		t.Fatalf("audit = %+v", audit)
	}

	input, err := f.server.assistant.PromptInput(ctx, agent, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if turn := prompt.TurnContext(input) + prompt.AgentsFile(input); strings.Contains(turn, "回猎头的微信消息") {
		t.Fatalf("the list reached the turn or AGENTS.md instead of read_list:\n%s", turn)
	}
	read, failed := f.tool(t, token, "read_list", map[string]any{})
	if failed || !strings.Contains(read, qa.ID) || strings.Count(read, `"id": "pai_`) != 4 {
		t.Fatalf("read_list = %s", read)
	}

	// Stopped, the assistant changes nothing.
	if _, err := f.server.store.SetPersonalAgentState(ctx, agent.ID, store.PersonalAgentStopped); err != nil {
		t.Fatal(err)
	}
	if _, text, failed := update("update", map[string]any{"id": talk.ID, "status": "done", "quote": "下午要去给大家捋一下"}); !failed {
		t.Fatalf("a stopped assistant changed the list: %s", text)
	}
}

// The person ticks, edits and deletes items with their web login: a new
// "when" drops the time and reminder that no longer match it. A session
// token cannot.
func TestThePersonEditsTheirList(t *testing.T) {
	f := newAssistantFixture(t)
	ctx := context.Background()
	agent := defaultAssistantOf(t, f.server, f.aliceID)
	later := time.Now().Add(time.Hour).UTC().Format(time.RFC3339)
	item, err := f.server.store.AddPersonalAgentItem(ctx, store.PersonalAgentActorAssistant, store.PersonalAgentListItem{AssistantID: agent.ID, UserID: f.aliceID, Text: "Reply on WeChat", When: "after work", At: later, Remind: true})
	if err != nil {
		t.Fatal(err)
	}
	listed := doAuthCall(t, f.handler, f.as(f.alice, http.MethodGet, "/api/personal-agent/list", ""))
	expectStatus(t, listed, http.StatusOK, "list")
	if !strings.Contains(listed.Body.String(), item.ID) {
		t.Fatalf("listed %s", listed.Body.String())
	}
	edited := doAuthCall(t, f.handler, f.as(f.alice, http.MethodPut, "/api/personal-agent/list/"+item.ID, `{"text":"Reply to recruiters","when":"tomorrow"}`))
	expectStatus(t, edited, http.StatusOK, "edit")
	var saved store.PersonalAgentListItem
	_ = json.Unmarshal(edited.Body.Bytes(), &saved)
	if saved.Text != "Reply to recruiters" || saved.When != "tomorrow" || saved.At != "" || saved.Remind {
		t.Fatalf("edited = %+v", saved)
	}
	ticked := doAuthCall(t, f.handler, f.as(f.alice, http.MethodPut, "/api/personal-agent/list/"+item.ID, `{"status":"done"}`))
	expectStatus(t, ticked, http.StatusOK, "tick")
	_ = json.Unmarshal(ticked.Body.Bytes(), &saved)
	if saved.Status != store.PersonalAgentItemDone || saved.ClosedAt == "" {
		t.Fatalf("ticked = %+v", saved)
	}
	if open := doAuthCall(t, f.handler, f.as(f.alice, http.MethodGet, "/api/personal-agent/list", "")); strings.Contains(open.Body.String(), item.ID) {
		t.Fatalf("a done item is listed without closedSince: %s", open.Body.String())
	}
	since := time.Now().Add(-time.Hour).UTC().Format(time.RFC3339)
	if today := doAuthCall(t, f.handler, f.as(f.alice, http.MethodGet, "/api/personal-agent/list?closedSince="+since, "")); !strings.Contains(today.Body.String(), item.ID) {
		t.Fatalf("done today: %s", today.Body.String())
	}
	expectStatus(t, doAuthCall(t, f.handler, f.as(f.alice, http.MethodPut, "/api/personal-agent/list/"+item.ID, `{"status":"later"}`)), http.StatusBadRequest, "a bad status")
	expectStatus(t, doAuthCall(t, f.handler, authCall{method: http.MethodGet, path: "/api/personal-agent/list",
		headers: map[string]string{"Authorization": "Bearer " + f.token}}), http.StatusForbidden, "a session token reads the list")
	expectStatus(t, doAuthCall(t, f.handler, f.as(f.alice, http.MethodDelete, "/api/personal-agent/list/"+item.ID, "")), http.StatusNoContent, "delete")
	expectStatus(t, doAuthCall(t, f.handler, f.as(f.alice, http.MethodDelete, "/api/personal-agent/list/"+item.ID, "")), http.StatusNotFound, "delete again")
}

// A due reminder reaches the person's latest conversation with the
// assistant once, as Foundry's notice; nothing reaches a stopped assistant.
// The daily digest, when on, goes out once in its window with the list and
// the work in progress, and not without anything to say.
func TestRemindersAndTheDailyDigestReachTheLatestConversation(t *testing.T) {
	f := newDigestFixture(t)
	ctx := context.Background()
	agent, _ := f.db.GetPersonalAgent(ctx, f.aliceID)
	agent.Settings.Language = "en"
	if _, err := f.db.SavePersonalAgentSettings(ctx, agent.ID, agent.Settings); err != nil {
		t.Fatal(err)
	}
	conversation, err := f.server.sessionService.CreateAndDispatch(ctx, store.CreateAgentSessionInput{
		CreatedByUserID: f.aliceID, WorkspaceID: "ws_pa", AgentID: "agent_pa", Provider: "claude", Prompt: "remind me after work", Source: "chat",
	}, sessions.StartOptions{})
	if err != nil {
		t.Fatal(err)
	}
	f.daemon.complete(f.daemon.nextChatRun().Session, "Noted.")
	waitForStatus(t, f.db, conversation.ID, "completed")
	quiet := func() {
		t.Helper()
		select {
		case run := <-f.daemon.runs:
			if run.Session.ID == conversation.ID {
				t.Fatalf("the conversation was told: %q", run.Session.Input.Prompt)
			}
		case <-time.After(300 * time.Millisecond):
		}
	}
	told := func() string {
		t.Helper()
		run := f.daemon.nextChatRun()
		if run.Session.ID != conversation.ID {
			t.Fatalf("a run of %s, want the conversation", run.Session.ID)
		}
		stored, _ := f.db.GetAgentSession(ctx, conversation.ID)
		if !personalagent.IsNotice(stored.Input.Prompt) {
			t.Fatalf("the notice reads as the person's words: %q", stored.Input.Prompt)
		}
		f.daemon.complete(run.Session, "Done.")
		waitForStatus(t, f.db, conversation.ID, "completed")
		return stored.Input.Prompt
	}
	due := time.Now().Add(-time.Minute).UTC().Format(time.RFC3339)
	item, err := f.db.AddPersonalAgentItem(ctx, store.PersonalAgentActorAssistant, store.PersonalAgentListItem{AssistantID: agent.ID, UserID: f.aliceID, Text: "Reply on WeChat", When: "after work", At: due, Remind: true})
	if err != nil {
		t.Fatal(err)
	}
	if err := f.server.assistant.SendReminders(ctx, time.Now()); err != nil {
		t.Fatal(err)
	}
	if text := told(); !strings.Contains(text, `"Reply on WeChat"`) || !strings.Contains(text, "after work") || !strings.Contains(text, item.ID) {
		t.Fatalf("reminder = %q", text)
	}
	if err := f.server.assistant.SendReminders(ctx, time.Now()); err != nil {
		t.Fatal(err)
	}
	quiet()

	// The digest: on, in its window; once a day.
	agent, _ = f.db.GetPersonalAgent(ctx, f.aliceID)
	agent.Settings.DailyDigest, agent.Settings.DailyDigestTime = true, time.Now().UTC().Add(-time.Minute).Format("15:04")
	if _, err := f.db.SavePersonalAgentSettings(ctx, agent.ID, agent.Settings); err != nil {
		t.Fatal(err)
	}
	if err := f.server.assistant.SendDigests(ctx, time.Now()); err != nil {
		t.Fatal(err)
	}
	if text := told(); !strings.Contains(text, "daily digest") || !strings.Contains(text, "Reply on WeChat (after work)") {
		t.Fatalf("digest = %q", text)
	}
	if err := f.server.assistant.SendDigests(ctx, time.Now()); err != nil {
		t.Fatal(err)
	}
	quiet()

	// Stopped: the reminder waits, unsent.
	if _, err := f.db.SetPersonalAgentState(ctx, agent.ID, store.PersonalAgentStopped); err != nil {
		t.Fatal(err)
	}
	stoppedItem, _ := f.db.AddPersonalAgentItem(ctx, store.PersonalAgentActorAssistant, store.PersonalAgentListItem{AssistantID: agent.ID, UserID: f.aliceID, Text: "Check Maimai", At: due, Remind: true})
	if err := f.server.assistant.SendReminders(ctx, time.Now()); err != nil {
		t.Fatal(err)
	}
	quiet()
	if kept, _ := f.db.GetPersonalAgentItem(ctx, agent.ID, stoppedItem.ID); kept.RemindedAt != "" {
		t.Fatalf("a stopped assistant's reminder went out: %+v", kept)
	}
}

// Nothing on record: no digest.
func TestNoDigestWithoutNews(t *testing.T) {
	f := newDigestFixture(t)
	ctx := context.Background()
	if facts, err := f.server.assistant.DigestFacts(ctx, store.PersonalAgent{UserID: f.aliceID}, time.Now()); err != nil || facts != "" {
		t.Fatalf("facts = %q (%v)", facts, err)
	}
}

// The assistant keeps an item's owner and summary, and archives it only when it
// is closed with no helper running; restore and a reopen give back what the
// archive took, every change is on the timeline, and a summary over 1500
// characters is refused.
func TestAssistantKeepsItemOwnerSummaryAndArchive(t *testing.T) {
	f := newAssistantFixture(t)
	ctx := context.Background()
	agent := defaultAssistantOf(t, f.server, f.aliceID)
	conversation := f.startSession(t, "ws_pa", "", plansMessage)
	token := f.mint(t, conversation.ID)
	update := func(args map[string]any) (string, bool) {
		t.Helper()
		return f.tool(t, token, "update_list", args)
	}
	const quote = "他们的一些微信消息我还没有回复"
	text, failed := update(map[string]any{"op": "add", "item": map[string]any{"text": "回猎头的微信消息", "quote": quote, "owner": "assistant", "summary": "Reply to recruiters on WeChat."}})
	if failed {
		t.Fatalf("add: %s", text)
	}
	var added struct {
		Item store.PersonalAgentListItem `json:"item"`
	}
	if err := json.Unmarshal([]byte(text), &added); err != nil {
		t.Fatal(err)
	}
	id := added.Item.ID
	if added.Item.Owner != store.PersonalAgentItemOwnerAssistant || added.Item.Summary != "Reply to recruiters on WeChat." {
		t.Fatalf("added = %+v", added.Item)
	}
	if text, failed = update(map[string]any{"op": "update", "item": map[string]any{"id": id, "summary": strings.Repeat("概", 1501)}}); !failed || !strings.Contains(text, "1500") {
		t.Fatalf("a summary over 1500 characters: %s", text)
	}
	if text, failed = update(map[string]any{"op": "update", "item": map[string]any{"id": id, "summary": "Reply to recruiters on WeChat; two are waiting."}}); failed {
		t.Fatalf("update the summary: %s", text)
	}
	if text, failed = update(map[string]any{"op": "archive", "item": map[string]any{"id": id}}); !failed || !strings.Contains(text, "archived only when") {
		t.Fatalf("archive an open item: %s", text)
	}
	_, helper := itemHelper(t, f, agent, id, "send the recruiter reply", false)
	if text, failed = update(map[string]any{"op": "update", "item": map[string]any{"id": id, "status": "dropped", "quote": quote}}); failed {
		t.Fatalf("drop the item: %s", text)
	}
	if text, failed = update(map[string]any{"op": "archive", "item": map[string]any{"id": id}}); !failed || !strings.Contains(text, "no helper of it is running") {
		t.Fatalf("archive with a helper running: %s", text)
	}
	finishItemHelper(t, f, helper)
	if text, failed = update(map[string]any{"op": "archive", "item": map[string]any{"id": id}}); failed {
		t.Fatalf("archive once the helper ended: %s", text)
	}
	if text, failed = update(map[string]any{"op": "archive", "item": map[string]any{"id": id}}); failed || !strings.Contains(text, "already archived") {
		t.Fatalf("archive again: %s", text)
	}
	if text, failed = update(map[string]any{"op": "restore", "item": map[string]any{"id": id}}); failed {
		t.Fatalf("restore: %s", text)
	}
	if text, failed = update(map[string]any{"op": "update", "item": map[string]any{"id": id, "owner": "person"}}); failed {
		t.Fatalf("hand the item to the person: %s", text)
	}
	if text, failed = update(map[string]any{"op": "archive", "item": map[string]any{"id": id}}); failed {
		t.Fatalf("archive again: %s", text)
	}
	if text, failed = update(map[string]any{"op": "update", "item": map[string]any{"id": id, "status": "open", "quote": quote}}); failed {
		t.Fatalf("reopen an archived item: %s", text)
	}
	stored, err := f.server.store.GetPersonalAgentItem(ctx, agent.ID, id)
	if err != nil {
		t.Fatal(err)
	}
	if stored.ArchivedAt != "" || stored.Status != store.PersonalAgentItemOpen || stored.Owner != store.PersonalAgentItemOwnerPerson {
		t.Fatalf("reopened item = %+v", stored)
	}
	events, err := f.server.store.ListPersonalAgentItemEvents(ctx, agent.ID, id)
	if err != nil {
		t.Fatal(err)
	}
	kinds := map[string]bool{}
	for _, event := range events {
		kinds[event.Kind] = true
	}
	for _, kind := range []string{store.PersonalAgentItemEventSummaryUpdated, store.PersonalAgentItemEventOwnerChanged, store.PersonalAgentItemEventHelperEnded,
		store.PersonalAgentItemEventArchived, store.PersonalAgentItemEventRestored} {
		if !kinds[kind] {
			t.Fatalf("timeline has no %s event: %+v", kind, events)
		}
	}
}

// read_list answers one page at a time: its filters, archived items only with
// includeArchived, and each item concise, without events or its plan.
func TestReadListPagesFiltersAndStaysConcise(t *testing.T) {
	f := newAssistantFixture(t)
	ctx := context.Background()
	agent := defaultAssistantOf(t, f.server, f.aliceID)
	conversation := f.startSession(t, "ws_pa", "", plansMessage)
	token := f.mint(t, conversation.ID)
	addItem(t, f, agent, "Pay the rent", store.PersonalAgentItemOwnerPerson)
	addItem(t, f, agent, "Check the gateway deploy", store.PersonalAgentItemOwnerAssistant)
	old := addItem(t, f, agent, "Old plan", store.PersonalAgentItemOwnerPerson)
	old.Status, old.Revision = store.PersonalAgentItemDropped, 0
	if _, _, err := f.server.store.SavePersonalAgentItemArchive(ctx, store.PersonalAgentActorPerson, old, true); err != nil {
		t.Fatal(err)
	}
	type viewedItem struct {
		ID         string `json:"id"`
		Text       string `json:"text"`
		Owner      string `json:"owner"`
		Status     string `json:"status"`
		ArchivedAt string `json:"archivedAt"`
	}
	type viewedPage struct {
		Total      int          `json:"total"`
		NextOffset int          `json:"nextOffset"`
		Items      []viewedItem `json:"items"`
	}
	read := func(args map[string]any) (viewedPage, string) {
		t.Helper()
		text, failed := f.tool(t, token, "read_list", args)
		if failed {
			t.Fatalf("read_list %v: %s", args, text)
		}
		var page viewedPage
		if err := json.Unmarshal([]byte(text), &page); err != nil {
			t.Fatal(err)
		}
		return page, text
	}
	page, text := read(map[string]any{})
	if page.Total != 2 || len(page.Items) != 2 {
		t.Fatalf("default page = %s", text)
	}
	for _, key := range []string{`"events"`, `"plan"`, `"revision"`} {
		if strings.Contains(text, key) {
			t.Fatalf("read_list shows %s: %s", key, text)
		}
	}
	if page, _ = read(map[string]any{"status": "dropped", "includeArchived": true}); len(page.Items) != 1 || page.Items[0].ArchivedAt == "" {
		t.Fatalf("archived dropped items = %+v", page.Items)
	}
	if page, _ = read(map[string]any{"owner": "assistant"}); len(page.Items) != 1 || page.Items[0].Text != "Check the gateway deploy" {
		t.Fatalf("owned by the assistant = %+v", page.Items)
	}
	if page, _ = read(map[string]any{"from": "2000-01-01T00:00:00Z", "to": "2100-01-01T00:00:00Z"}); len(page.Items) != 2 {
		t.Fatalf("updated in range = %+v", page.Items)
	}
	if page, _ = read(map[string]any{"closedSince": "2000-01-01", "includeArchived": true}); len(page.Items) != 3 {
		t.Fatalf("closed since with archived = %+v", page.Items)
	}
	first, _ := read(map[string]any{"limit": 1})
	if len(first.Items) != 1 || first.NextOffset != 1 || first.Total != 2 {
		t.Fatalf("first page = %+v", first)
	}
	second, _ := read(map[string]any{"limit": 1, "offset": first.NextOffset})
	if len(second.Items) != 1 || second.Items[0].ID == first.Items[0].ID || second.NextOffset != 0 {
		t.Fatalf("second page = %+v", second)
	}
	for _, args := range []map[string]any{{"limit": 51}, {"status": "waiting"}, {"closedSince": "yesterday"}, {"from": "yesterday"}, {"offset": -1}} {
		if text, failed := f.tool(t, token, "read_list", args); !failed {
			t.Fatalf("read_list %v accepted: %s", args, text)
		}
	}
}

// create_session itemId ties the helper to an open item of the assistant's own
// and refuses an unknown, a closed or an archived one.
func TestCreateSessionItemIdTiesTheHelperToAnOpenItem(t *testing.T) {
	f := newAssistantFixture(t)
	ctx := context.Background()
	agent := defaultAssistantOf(t, f.server, f.aliceID)
	conversation := f.startSession(t, "ws_pa", "", plansMessage)
	token := f.mint(t, conversation.ID)
	open := addItem(t, f, agent, "Check the gateway deploy", store.PersonalAgentItemOwnerAssistant)
	dropped := addItem(t, f, agent, "Old plan", store.PersonalAgentItemOwnerPerson)
	dropped.Status, dropped.Revision = store.PersonalAgentItemDropped, 0
	if _, err := f.server.store.SavePersonalAgentItem(ctx, store.PersonalAgentActorPerson, dropped); err != nil {
		t.Fatal(err)
	}
	archived := addItem(t, f, agent, "Filed plan", store.PersonalAgentItemOwnerPerson)
	archived.Status, archived.Revision = store.PersonalAgentItemDropped, 0
	if _, _, err := f.server.store.SavePersonalAgentItemArchive(ctx, store.PersonalAgentActorPerson, archived, true); err != nil {
		t.Fatal(err)
	}
	create := func(itemID string) (string, bool) {
		t.Helper()
		args := map[string]any{"workspaceId": "ws_alice", "prompt": "check the gateway deploy time"}
		if itemID != "" {
			args["itemId"] = itemID
		}
		return f.tool(t, token, "create_session", args)
	}
	for itemID, want := range map[string]string{"item_missing": "no item", dropped.ID: "is dropped", archived.ID: "is archived"} {
		if text, failed := create(itemID); !failed || !strings.Contains(text, want) {
			t.Fatalf("create_session itemId %s: %s", itemID, text)
		}
	}
	if text, failed := create(open.ID); failed {
		t.Fatalf("create_session on an open item: %s", text)
	}
	tasks, err := f.server.store.ListPersonalAgentTasks(ctx, agent.ID, nil)
	if err != nil {
		t.Fatal(err)
	}
	var helpers []store.PersonalAgentTask
	for _, task := range tasks {
		if task.ItemID == open.ID {
			helpers = append(helpers, task)
		}
	}
	if len(helpers) != 1 {
		t.Fatalf("helpers on the item = %d, want 1", len(helpers))
	}
	events, err := f.server.store.ListPersonalAgentItemEvents(ctx, agent.ID, open.ID)
	if err != nil {
		t.Fatal(err)
	}
	for _, event := range events {
		if event.Kind == store.PersonalAgentItemEventHelperStarted && event.Detail != nil && event.Detail.SessionID == helpers[0].SessionID {
			return
		}
	}
	t.Fatalf("the item's timeline has no helper_started for %s: %+v", helpers[0].SessionID, events)
}

// An item records where it started: the channel conversation of the turn that
// named it, and the message that triggered the turn with its sender.
func TestItemOriginRecordsTheChannelMessageThatStartedTheTurn(t *testing.T) {
	f := newAssistantFixture(t)
	ctx := context.Background()
	const channelPrompt = "[Message channel: openlark]\nmessage 1:\n  sender is the person: yes\n  text: 把周报发给我\n"
	conversation, err := f.server.store.CreateAgentSession(ctx, store.CreateAgentSessionInput{
		CreatedByUserID: f.aliceID, WorkspaceID: "ws_pa", AgentID: "agent_ws_pa", Provider: "claude", Prompt: channelPrompt, Source: "chat",
		ChannelOrigin: &store.MessageChannelOrigin{ChannelName: "OpenLark", Source: "openlark",
			Conversation: store.MessageEnvelopeConversation{ID: "oc_team", Name: "产品群"},
			Messages:     []store.MessageChannelOriginMessage{{ID: "om_weekly", Sender: store.MessageEnvelopeSender{ID: "ou_zhang", Name: "张三"}, Text: "把周报发给我"}}},
	})
	if err != nil {
		t.Fatal(err)
	}
	token := f.mint(t, conversation.ID)
	text, failed := f.tool(t, token, "update_list", map[string]any{"op": "add", "item": map[string]any{"text": "把周报发给我", "quote": "把周报发给我"}})
	if failed {
		t.Fatalf("add from the channel: %s", text)
	}
	var added struct {
		Item store.PersonalAgentListItem `json:"item"`
	}
	if err := json.Unmarshal([]byte(text), &added); err != nil {
		t.Fatal(err)
	}
	origin := added.Item.Origin
	if origin == nil || origin.Kind != store.PersonalAgentItemOriginChannel || origin.Name != "产品群" || origin.Source != "openlark" ||
		origin.Requester != "张三" || origin.RequesterID != "ou_zhang" || origin.MessageID != "om_weekly" || origin.SessionID != conversation.ID {
		t.Fatalf("origin = %+v", origin)
	}
}
