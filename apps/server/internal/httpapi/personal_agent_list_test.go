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
	f.server.recordAssistantTask(ctx, agent, conversation.ID, helper)
	tasks, _ := f.server.store.ListPersonalAgentTasks(ctx, f.aliceID, nil)
	if linked, text, failed := update("update", map[string]any{"id": talk.ID, "taskId": tasks[0].ID}); failed || linked.TaskID != tasks[0].ID {
		t.Fatalf("linking its own task needs no quote: %s", text)
	}

	audit := f.lastAction(t)
	if audit.Tool != "update_list" || audit.Outcome != store.PersonalAgentOutcomeApplied || strings.Contains(audit.ArgsSummary, "Atlas") {
		t.Fatalf("audit = %+v", audit)
	}

	input, err := f.server.assistantPromptInput(ctx, agent, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	turn := prompt.TurnContext(input)
	if !strings.Contains(turn, "回猎头的微信消息") || !strings.Contains(turn, "reminder at") || strings.Contains(turn, "小林") {
		t.Fatalf("the turn's context:\n%s", turn)
	}
	read, failed := f.tool(t, token, "read_list", map[string]any{})
	if failed || !strings.Contains(read, qa.ID) || strings.Count(read, `"id": "pai_`) != 4 {
		t.Fatalf("read_list = %s", read)
	}

	// Stopped, the assistant changes nothing.
	if _, err := f.server.store.SetPersonalAgentState(ctx, f.aliceID, store.PersonalAgentStopped); err != nil {
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
	later := time.Now().Add(time.Hour).UTC().Format(time.RFC3339)
	item, err := f.server.store.AddPersonalAgentItem(ctx, store.PersonalAgentListItem{UserID: f.aliceID, Text: "Reply on WeChat", When: "after work", At: later, Remind: true})
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
	if _, err := f.db.SavePersonalAgentSettings(ctx, f.aliceID, agent.Settings); err != nil {
		t.Fatal(err)
	}
	conversation, err := f.server.createAndDispatch(ctx, store.CreateAgentSessionInput{
		CreatedByUserID: f.aliceID, WorkspaceID: "ws_pa", AgentID: "agent_pa", Provider: "claude", Prompt: "remind me after work", Source: "chat",
	}, false)
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
	item, err := f.db.AddPersonalAgentItem(ctx, store.PersonalAgentListItem{UserID: f.aliceID, Text: "Reply on WeChat", When: "after work", At: due, Remind: true})
	if err != nil {
		t.Fatal(err)
	}
	if err := f.server.sendAssistantReminders(ctx, time.Now()); err != nil {
		t.Fatal(err)
	}
	if text := told(); !strings.Contains(text, `"Reply on WeChat"`) || !strings.Contains(text, "after work") || !strings.Contains(text, item.ID) {
		t.Fatalf("reminder = %q", text)
	}
	if err := f.server.sendAssistantReminders(ctx, time.Now()); err != nil {
		t.Fatal(err)
	}
	quiet()

	// The digest: on, in its window; once a day.
	agent, _ = f.db.GetPersonalAgent(ctx, f.aliceID)
	agent.Settings.DailyDigest, agent.Settings.DailyDigestTime = true, time.Now().UTC().Add(-time.Minute).Format("15:04")
	if _, err := f.db.SavePersonalAgentSettings(ctx, f.aliceID, agent.Settings); err != nil {
		t.Fatal(err)
	}
	if err := f.server.sendAssistantDigests(ctx, time.Now()); err != nil {
		t.Fatal(err)
	}
	if text := told(); !strings.Contains(text, "daily digest") || !strings.Contains(text, "Reply on WeChat (after work)") {
		t.Fatalf("digest = %q", text)
	}
	if err := f.server.sendAssistantDigests(ctx, time.Now()); err != nil {
		t.Fatal(err)
	}
	quiet()

	// Stopped: the reminder waits, unsent.
	if _, err := f.db.SetPersonalAgentState(ctx, f.aliceID, store.PersonalAgentStopped); err != nil {
		t.Fatal(err)
	}
	stoppedItem, _ := f.db.AddPersonalAgentItem(ctx, store.PersonalAgentListItem{UserID: f.aliceID, Text: "Check Maimai", At: due, Remind: true})
	if err := f.server.sendAssistantReminders(ctx, time.Now()); err != nil {
		t.Fatal(err)
	}
	quiet()
	if kept, _ := f.db.GetPersonalAgentItem(ctx, f.aliceID, stoppedItem.ID); kept.RemindedAt != "" {
		t.Fatalf("a stopped assistant's reminder went out: %+v", kept)
	}
}

// Nothing on record: no digest.
func TestNoDigestWithoutNews(t *testing.T) {
	f := newDigestFixture(t)
	ctx := context.Background()
	if facts, err := f.server.assistantDigestFacts(ctx, store.PersonalAgent{UserID: f.aliceID}, time.Now()); err != nil || facts != "" {
		t.Fatalf("facts = %q (%v)", facts, err)
	}
}
