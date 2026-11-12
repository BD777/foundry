package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

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
	if _, open = f.open(t); open[f.helper.ID].ID != "" {
		t.Fatalf("answered helper still waits: %+v", open[f.helper.ID])
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

// While the assistant's computer is offline its items go to the person and
// stay there once it is back, until either side settles them (§h).
func TestNeedsYouOfflineItemsStayWithThePerson(t *testing.T) {
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
	if shown.Handler != store.PendingHandlerPerson || shown.HandedReason != store.PendingHandedOffline || list.Open != 1 {
		t.Fatalf("offline: %+v (open %d)", shown, list.Open)
	}
	// A question asked meanwhile is the person's at once.
	f.ask(t, f.helper, "h2", "And the file name?")
	// The device reconnects with its credential (the package tests' actor).
	f.server.testActor = &Actor{Kind: ActorDaemon, DeviceID: "dev_home", Account: &store.User{ID: f.aliceID}}
	f.daemon = connectDigestDaemon(t, f.live)
	f.server.testActor = nil
	waitFor(t, "the home computer to return", func() bool { return f.server.hub.HasConnection("dev_home") })
	list, open = f.open(t)
	// Both questions, the one handed over while offline and the one asked
	// meanwhile, stay the person's.
	if open[f.helper.ID].Handler != store.PendingHandlerPerson || list.Open != 2 || list.AssistantOpen != 0 {
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

// The stop switch hands the assistant's items to the person for good, and a
// question asked while it is stopped is the person's from the start.
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
	if _, open := f.open(t); store.PendingHandledBy(open[helper2.ID].PendingItem) != store.PendingHandlerPerson {
		t.Fatalf("asked while stopped: %+v", open[helper2.ID])
	}
}
