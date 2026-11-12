package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/personalagent/prompt"
	"github.com/foundry-dev/foundry/apps/server/internal/sessions"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// needsYouFixture: alice's assistant conversation in ws_pa, a helper it
// started in ws_budget, and a chat alice started there herself.
type needsYouFixture struct {
	digestFixture
	conversation, helper, chat store.AgentSession
	token                      string
}

func newNeedsYouFixture(t *testing.T) needsYouFixture {
	t.Helper()
	f := needsYouFixture{digestFixture: newDigestFixture(t)}
	ctx := context.Background()
	create := func(input store.CreateAgentSessionInput) store.AgentSession {
		session, err := f.db.CreateAgentSession(ctx, input)
		if err != nil {
			t.Fatal(err)
		}
		return session
	}
	f.conversation = create(store.CreateAgentSessionInput{CreatedByUserID: f.aliceID, WorkspaceID: "ws_pa", AgentID: "agent_pa", Prompt: "plan my week", Source: "chat"})
	f.helper = create(store.CreateAgentSessionInput{CreatedByUserID: f.aliceID, WorkspaceID: "ws_budget", AgentID: "agent_budget", Prompt: "build the export", Source: "agent", ParentSessionID: f.conversation.ID})
	f.chat = create(store.CreateAgentSessionInput{CreatedByUserID: f.aliceID, WorkspaceID: "ws_budget", AgentID: "agent_budget", Prompt: "fix the header", Source: "chat"})
	token, err := f.db.MintAgentSessionToken(ctx, f.conversation.ID)
	if err != nil {
		t.Fatal(err)
	}
	f.token = token
	return f
}

// An assistant sees its own items, unassigned items in workspaces its
// package allows, and personal account items it may use. Personal items
// with neither workspace nor account stay with the default assistant.
func TestNeedsYouVisibilityFollowsAssistantScope(t *testing.T) {
	f := newNeedsYouFixture(t)
	ctx := context.Background()
	defaultAgent := defaultAssistantOf(t, f.server, f.aliceID)
	work, err := f.db.CreatePersonalAgent(ctx, store.PersonalAgent{
		UserID: f.aliceID, Name: "Work", WorkspaceID: "ws_budget", HomeDeviceID: "dev_home",
	})
	if err != nil || work.IsDefault {
		t.Fatalf("work assistant = %+v (%v)", work, err)
	}
	pkg, err := f.db.GetPermissionPackage(ctx, f.aliceID, work.PermissionPackageID)
	if err != nil {
		t.Fatal(err)
	}
	pkg.Workspaces = store.PermissionListRule{
		Scope: store.PermissionListScopeListed, Include: []string{"ws_budget"},
	}
	pkg.ConnectorAccounts = []store.ConnectorAccountPermission{
		{AccountID: "acct_allowed", Level: store.ConnectorAccessLevelRead},
		{AccountID: "device:dev_home:github", Level: store.ConnectorAccessLevelOff},
	}
	if _, err := f.db.SavePermissionPackage(ctx, pkg); err != nil {
		t.Fatal(err)
	}

	record := func(title, assistantID, workspaceID, source, key string) {
		t.Helper()
		if _, _, err := f.db.RecordPendingItem(ctx, store.PendingItem{
			UserID: f.aliceID, AssistantID: assistantID, WorkspaceID: workspaceID,
			Source: source, Key: key, Title: title, Excerpt: title, Handler: store.PendingHandlerPerson,
		}); err != nil {
			t.Fatal(err)
		}
	}
	record("default's own", defaultAgent.ID, "ws_pa", store.PendingSourceQuestion, "own:default")
	record("work's own", work.ID, "ws_budget", store.PendingSourceQuestion, "own:work")
	record("budget question", "", "ws_budget", store.PendingSourceQuestion, "workspace:budget")
	record("assistant home question", "", "ws_pa", store.PendingSourceQuestion, "workspace:pa")
	record("allowed account", "", "", store.PendingSourceAccount, "account:acct_allowed")
	record("blocked connector", "", "", store.PendingSourceConnector, "connector:dev_home:github")
	record("bundle rollout", "", "", store.PendingSourceBundleUpdate, "bundle:repo")
	if _, _, err := f.db.RecordPendingItem(ctx, store.PendingItem{
		UserID: f.aliceID, AssistantID: work.ID, WorkspaceID: "ws_budget",
		Source: store.PendingSourceQuestion, Key: "own:work-handling",
		Title: "work is handling", Excerpt: "work is handling", Handler: store.PendingHandlerAssistant,
	}); err != nil {
		t.Fatal(err)
	}

	titles := func(items []store.PendingItem) []string {
		got := make([]string, len(items))
		for index, item := range items {
			got[index] = item.Title
		}
		slices.Sort(got)
		return got
	}
	defaultItems, err := f.server.assistant.PendingFor(ctx, defaultAgent, 200)
	if err != nil {
		t.Fatal(err)
	}
	if got := titles(defaultItems); !slices.Equal(got, []string{
		"allowed account", "assistant home question", "blocked connector",
		"budget question", "bundle rollout", "default's own",
	}) {
		t.Fatalf("default assistant sees %v", got)
	}
	workItems, err := f.server.assistant.PendingFor(ctx, work, 200)
	if err != nil {
		t.Fatal(err)
	}
	if got := titles(workItems); !slices.Equal(got, []string{
		"allowed account", "budget question", "work is handling", "work's own",
	}) {
		t.Fatalf("work assistant sees %v", got)
	}
	list, _ := f.open(t)
	if len(list.Assistants) != 2 || !slices.ContainsFunc(list.Assistants, func(agent pendingAssistantView) bool {
		return agent.ID == work.ID && agent.Name == "Work"
	}) {
		t.Fatalf("assistant filter choices = %+v", list.Assistants)
	}
	if !slices.ContainsFunc(list.Items, func(item pendingItemView) bool {
		return item.Title == "work's own" && item.AssistantName == "Work"
	}) {
		t.Fatalf("work item source = %+v", list.Items)
	}
	input, err := f.server.assistant.PromptInput(ctx, work, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	// The needs-you list reaches the assistant through the needs_you tool
	// (PendingFor), never with the turn (DEV-200).
	if turn := prompt.TurnContext(input) + prompt.AgentsFile(input); strings.Contains(turn, "work's own") {
		t.Fatalf("the needs-you list reached the turn or AGENTS.md:\n%s", turn)
	}
	overview, err := f.server.assistant.OverviewOf(ctx, work)
	if err != nil {
		t.Fatal(err)
	}
	if overview.NeedsYou == nil || overview.NeedsYou.Open != len(workItems)-1 {
		t.Fatalf("assistant card count = %+v, scope = %v", overview.NeedsYou, titles(workItems))
	}
	for _, item := range overview.NeedsYou.Items {
		if item.Title == "work is handling" {
			t.Fatalf("assistant card includes work already handled: %+v", overview.NeedsYou.Items)
		}
		if !slices.Contains(titles(workItems), item.Title) {
			t.Fatalf("assistant card sees %+v, scope sees %v", overview.NeedsYou.Items, titles(workItems))
		}
	}
}

func TestNeedsYouAssistantFirstWhenAssistantIsStopped(t *testing.T) {
	f := newNeedsYouFixture(t)
	ctx := context.Background()
	agent := defaultAssistantOf(t, f.server, f.aliceID)
	if _, err := f.db.SetPersonalAgentState(ctx, agent.ID, store.PersonalAgentStopped); err != nil {
		t.Fatal(err)
	}
	f.ask(t, f.helper, "offline", "Which export format?")
	_, open := f.open(t)
	item := open[f.helper.ID]
	if item.Handler != store.PendingHandlerAssistant || item.AssistantID != agent.ID || item.DeadlineAt == "" {
		t.Fatalf("assistant stopped at creation: %+v", item)
	}
}

func TestNeedsYouEscalatesAnUnacknowledgedItemAfterTenMinutes(t *testing.T) {
	f := newNeedsYouFixture(t)
	ctx := context.Background()
	agent := defaultAssistantOf(t, f.server, f.aliceID)
	now := time.Now().UTC()
	item, _, err := f.db.RecordPendingItem(ctx, store.PendingItem{
		UserID: f.aliceID, AssistantID: agent.ID, WorkspaceID: f.helper.WorkspaceID, SessionID: f.helper.ID,
		Source: store.PendingSourceQuestion, Key: "escalate:test", Title: "Choose a format", Excerpt: "Choose a format",
		Handler: store.PendingHandlerAssistant, DeadlineAt: formatPendingTime(now.Add(-time.Minute)),
	})
	if err != nil {
		t.Fatal(err)
	}
	f.server.maintainNeedsYou(ctx, now)
	got, err := f.db.GetPendingItem(ctx, f.aliceID, item.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Handler != store.PendingHandlerPerson || got.HandedReason != store.PendingHandedTimeout ||
		got.Outcome != store.PendingOutcomeEscalatedTimeout || got.HandedAt == "" {
		t.Fatalf("escalated item = %+v", got)
	}
}

func TestNeedsYouAcknowledgementPreventsEscalation(t *testing.T) {
	f := newNeedsYouFixture(t)
	ctx := context.Background()
	agent := defaultAssistantOf(t, f.server, f.aliceID)
	now := time.Now().UTC()
	item, _, err := f.db.RecordPendingItem(ctx, store.PendingItem{
		UserID: f.aliceID, AssistantID: agent.ID, WorkspaceID: f.helper.WorkspaceID, SessionID: f.helper.ID,
		Source: store.PendingSourceQuestion, Key: "ack:test", Title: "Choose a format", Excerpt: "Choose a format",
		Handler: store.PendingHandlerAssistant, DeadlineAt: formatPendingTime(now.Add(-time.Minute)),
	})
	if err != nil {
		t.Fatal(err)
	}
	text, failed := f.needsYou(t, map[string]any{"op": "list"})
	if failed || !strings.Contains(text, "Choose a format") {
		t.Fatalf("needs_you list: %s", text)
	}
	f.server.maintainNeedsYou(ctx, now)
	got, err := f.db.GetPendingItem(ctx, f.aliceID, item.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Handler != store.PendingHandlerAssistant || got.AcknowledgedAt == "" || got.Outcome != "" {
		t.Fatalf("acknowledged item = %+v", got)
	}
}

// ask records a question the session asked, as its worker reports it.
func (f needsYouFixture) ask(t *testing.T, session store.AgentSession, id, title string) {
	t.Helper()
	pendingReactions{f.server}.SessionEventRecorded(context.Background(), store.AgentSessionEvent{
		ID: "evt_" + id, SessionID: session.ID, At: formatPendingTime(time.Now()),
		Message: &store.TranscriptMessage{ID: "msg_" + id, Kind: "assistant", Text: title, Delivery: questionDeliveryNextTurn, Questions: []store.AgentQuestion{{Title: title}}},
	})
}

// open is alice's open items by session, as the list endpoint answers them.
func (f needsYouFixture) open(t *testing.T) (pendingItemList, map[string]pendingItemView) {
	t.Helper()
	request := httptest.NewRequest(http.MethodGet, "/api/pending-items", nil)
	recorder := httptest.NewRecorder()
	f.server.testActor = &Actor{Kind: ActorAccount, Account: &store.User{ID: f.aliceID}}
	defer func() { f.server.testActor = nil }()
	f.server.Routes().ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("list: %d %s", recorder.Code, recorder.Body)
	}
	var list pendingItemList
	if err := json.Unmarshal(recorder.Body.Bytes(), &list); err != nil {
		t.Fatal(err)
	}
	bySession := map[string]pendingItemView{}
	for _, item := range list.Items {
		if item.State == store.PendingOpen {
			bySession[item.SessionID] = item
		}
	}
	return list, bySession
}

// needsYou calls the assistant's tool from its conversation.
func (f needsYouFixture) needsYou(t *testing.T, args map[string]any) (string, bool) {
	t.Helper()
	raw, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 1, "method": "tools/call",
		"params": map[string]any{"name": "needs_you", "arguments": args}})
	request := httptest.NewRequest(http.MethodPost, "/api/mcp", strings.NewReader(string(raw)))
	request.Header.Set("Authorization", "Bearer "+f.token)
	request.Header.Set("Content-Type", "application/json")
	recorder := httptest.NewRecorder()
	f.server.Routes().ServeHTTP(recorder, request)
	var response struct {
		Result struct {
			Content []struct{ Text string } `json:"content"`
			IsError bool                    `json:"isError"`
		} `json:"result"`
		Error *struct{ Message string } `json:"error"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatalf("needs_you: %s", recorder.Body)
	}
	if response.Error != nil {
		return response.Error.Message, true
	}
	return response.Result.Content[0].Text, response.Result.IsError
}

// One list (docs/assistant-orchestration.md §h): a helper's question is the
// assistant's, a chat's the person's; the assistant answering its helper
// settles it, hands over what only the person can decide, and cannot touch
// the person's own chat's items. The person's count leaves the assistant's
// items out.
func TestNeedsYouOneListWithTwoHandlers(t *testing.T) {
	f := newNeedsYouFixture(t)
	ctx := context.Background()
	f.ask(t, f.helper, "h1", "Which export format?")
	f.ask(t, f.chat, "c1", "Keep the old header?")
	list, open := f.open(t)
	if open[f.helper.ID].Handler != store.PendingHandlerAssistant || store.PendingHandledBy(open[f.chat.ID].PendingItem) != store.PendingHandlerPerson {
		t.Fatalf("handlers: %+v", open)
	}
	if list.Open != 1 || list.AssistantOpen != 1 || list.BySession[f.helper.ID] != 0 || list.BySession[f.chat.ID] != 1 {
		t.Fatalf("counts: open %d assistant %d by session %v", list.Open, list.AssistantOpen, list.BySession)
	}
	// The assistant reads both.
	text, failed := f.needsYou(t, map[string]any{"op": "list"})
	if failed || !strings.Contains(text, "Which export format?") || !strings.Contains(text, "Keep the old header?") {
		t.Fatalf("list: %s", text)
	}
	// It answers its helper: the question is settled.
	helper := f.helper
	helper.Input = store.SessionInput{ID: "in_answer", SentBySessionID: f.conversation.ID, At: formatPendingTime(time.Now().Add(time.Second))}
	pendingReactions{f.server}.SessionChanged(ctx, sessions.Queued, helper)
	answeredID := open[f.helper.ID].ID
	if _, open = f.open(t); open[f.helper.ID].ID != "" {
		t.Fatalf("answered helper still waits: %+v", open[f.helper.ID])
	}
	if answered, err := f.db.GetPendingItem(ctx, f.aliceID, answeredID); err != nil || answered.Outcome != store.PendingOutcomeAssistantAnswered {
		t.Fatalf("assistant answer outcome = %+v (%v)", answered, err)
	}
	// What only the person can decide, it hands over with a note.
	f.ask(t, f.helper, "h2", "Delete the old exports?")
	text, failed = f.needsYou(t, map[string]any{"op": "hand_over", "sessionId": f.helper.ID, "note": "The helper wants to delete last year's exports; is that fine?"})
	if failed {
		t.Fatalf("hand_over: %s", text)
	}
	list, open = f.open(t)
	handed := open[f.helper.ID]
	if handed.Handler != store.PendingHandlerPerson || handed.HandedReason != store.PendingHandedByAssistant || !strings.Contains(handed.Note, "last year's exports") || list.Open != 2 || list.AssistantOpen != 0 {
		t.Fatalf("handed over: %+v (open %d)", handed, list.Open)
	}
	if handed.Outcome != store.PendingOutcomeHandedOver {
		t.Fatalf("hand-over outcome = %q", handed.Outcome)
	}
	// A helper that asked in its answer gets an item from the note alone.
	helper.Input = store.SessionInput{ID: "in_more", SentBySessionID: f.conversation.ID, At: formatPendingTime(time.Now().Add(2 * time.Second))}
	pendingReactions{f.server}.SessionChanged(ctx, sessions.Queued, helper)
	if text, failed = f.needsYou(t, map[string]any{"op": "hand_over", "sessionId": f.helper.ID, "note": "Pick a colour for the chart: blue or green?"}); failed {
		t.Fatalf("hand_over without an item: %s", text)
	}
	if _, open = f.open(t); open[f.helper.ID].Rule != store.PendingRuleHandedOver || open[f.helper.ID].Title != "Pick a colour for the chart: blue or green?" {
		t.Fatalf("made item: %+v", open[f.helper.ID])
	}
	// The person's own chat is theirs alone.
	if text, failed = f.needsYou(t, map[string]any{"op": "resolve", "itemId": open[f.chat.ID].ID}); !failed || !strings.Contains(text, "only items of your own helpers") {
		t.Fatalf("resolved the person's chat item: %s", text)
	}
	if text, failed = f.needsYou(t, map[string]any{"op": "hand_over", "sessionId": f.helper.ID}); !failed {
		t.Fatalf("hand_over without a note: %s", text)
	}
}

// While the assistant's computer is offline its items queue for it; the
// person's list does not take them over (§h).
func TestNeedsYouOfflineItemsStayWithTheAssistant(t *testing.T) {
	f := newNeedsYouFixture(t)
	f.ask(t, f.helper, "h1", "Which export format?")
	if _, open := f.open(t); open[f.helper.ID].Handler != store.PendingHandlerAssistant {
		t.Fatalf("online: %+v", open[f.helper.ID])
	}
	f.daemon.closing.Store(true)
	_ = f.daemon.conn.Close()
	waitFor(t, "the home computer to drop", func() bool { return !f.server.hub.HasConnection("dev_home") })
	list, open := f.open(t)
	shown := open[f.helper.ID]
	if shown.Handler != store.PendingHandlerAssistant || list.Open != 0 || list.AssistantOpen != 1 {
		t.Fatalf("offline: %+v (open %d)", shown, list.Open)
	}
	// A question asked meanwhile queues for the assistant too.
	f.ask(t, f.helper, "h2", "And the file name?")
	// The device reconnects with its credential (the package tests' actor).
	f.server.testActor = &Actor{Kind: ActorDaemon, DeviceID: "dev_home", Account: &store.User{ID: f.aliceID}}
	f.daemon = connectDigestDaemon(t, f.live)
	f.server.testActor = nil
	waitFor(t, "the home computer to return", func() bool { return f.server.hub.HasConnection("dev_home") })
	list, open = f.open(t)
	// Both questions stay the assistant's.
	if open[f.helper.ID].Handler != store.PendingHandlerAssistant || list.Open != 0 || list.AssistantOpen != 2 {
		t.Fatalf("back online, the item left the person's list: %+v (open %d)", open[f.helper.ID], list.Open)
	}
	// The assistant may still settle it; then it is gone.
	if text, failed := f.needsYou(t, map[string]any{"op": "resolve", "sessionId": f.helper.ID}); failed {
		t.Fatalf("resolve: %s", text)
	}
	if list, open = f.open(t); open[f.helper.ID].ID != "" || list.Open != 0 {
		t.Fatalf("resolved item still listed: %+v", open[f.helper.ID])
	}
}

// The stop switch hands the assistant's existing items to the person; a
// question created while it is stopped still queues for the assistant.
func TestNeedsYouStoppedAssistantHandsOver(t *testing.T) {
	f := newNeedsYouFixture(t)
	ctx := context.Background()
	agent := defaultAssistantOf(t, f.server, f.aliceID)
	f.ask(t, f.helper, "h1", "Which export format?")
	if _, err := f.server.assistant.Stop(ctx, agent); err != nil {
		t.Fatal(err)
	}
	items, err := f.db.ListPendingItems(ctx, f.aliceID, []string{store.PendingOpen}, "", 10)
	if err != nil || len(items) != 1 || items[0].Handler != store.PendingHandlerPerson || items[0].HandedReason != store.PendingHandedStopped {
		t.Fatalf("stopped: %+v %v", items, err)
	}
	helper2, err := f.db.CreateAgentSession(ctx, store.CreateAgentSessionInput{CreatedByUserID: f.aliceID, WorkspaceID: "ws_budget", AgentID: "agent_budget", Prompt: "another", Source: "agent", ParentSessionID: f.conversation.ID})
	if err != nil {
		t.Fatal(err)
	}
	f.ask(t, helper2, "h2", "Proceed?")
	if _, open := f.open(t); store.PendingHandledBy(open[helper2.ID].PendingItem) != store.PendingHandlerAssistant {
		t.Fatalf("asked while stopped: %+v", open[helper2.ID])
	}
}
