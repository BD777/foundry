package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/personalagent"
	"github.com/foundry-dev/foundry/apps/server/internal/sessions"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// personPost sends a request as the person (alice) through the routes.
func (f needsYouFixture) personPost(t *testing.T, path string, body map[string]any, idempotencyKey string) (int, []byte) {
	t.Helper()
	raw, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, path, strings.NewReader(string(raw)))
	request.Header.Set("Content-Type", "application/json")
	if idempotencyKey != "" {
		request.Header.Set("Idempotency-Key", idempotencyKey)
	}
	recorder := httptest.NewRecorder()
	f.server.testActor = &Actor{Kind: ActorAccount, Account: &store.User{ID: f.aliceID}}
	defer func() { f.server.testActor = nil }()
	f.server.Routes().ServeHTTP(recorder, request)
	return recorder.Code, recorder.Body.Bytes()
}

// conversationInbox is what the assistant's conversation has waiting in its inbox.
func conversationInbox(t *testing.T, f needsYouFixture) []store.SessionInboxItem {
	t.Helper()
	items, err := f.db.SessionInboxItems(context.Background(), f.conversation.ID, time.Now().Add(-time.Hour), 50)
	if err != nil {
		t.Fatalf("conversation inbox: %v", err)
	}
	return items
}

func TestAssistantAskRecordsOneItemForThePerson(t *testing.T) {
	f := newNeedsYouFixture(t)
	const question = "Save the receipt to the Q3 folder, or to Travel?"
	options := []string{"Q3 folder", "Travel"}

	text, failed := f.needsYou(t, map[string]any{"op": "ask", "question": question, "options": options})
	if failed || !strings.Contains(text, `"asked"`) || !strings.Contains(text, question) {
		t.Fatalf("ask = %s (failed %v)", text, failed)
	}
	if _, failed := f.needsYou(t, map[string]any{"op": "ask", "question": question, "options": options}); failed {
		t.Fatal("repeating a question failed")
	}
	list, _ := f.open(t)
	if len(list.Items) != 1 {
		t.Fatalf("repeated question stacked: %+v", list.Items)
	}
	item := list.Items[0]
	if item.Source != store.PendingSourceAssistantQuestion || item.SessionID != f.conversation.ID ||
		item.AssistantID == "" || store.PendingHandledBy(item.PendingItem) != store.PendingHandlerPerson ||
		item.Title != question || strings.Join(item.Options, "|") != "Q3 folder|Travel" || item.Note != "" {
		t.Fatalf("ask item = %+v", item.PendingItem)
	}
	if list.Open != 1 || list.AssistantOpen != 0 {
		t.Fatalf("counts: open %d assistant %d", list.Open, list.AssistantOpen)
	}

	refused := []map[string]any{
		{"op": "ask", "question": ""},
		{"op": "ask", "question": question, "options": []string{"only one"}},
		{"op": "ask", "question": question, "options": []string{"a", "b", "c", "d", "e"}},
		{"op": "ask", "question": question, "options": []string{"a", " "}},
		{"op": "ask", "question": question, "itemId": item.ID},
		{"op": "ask", "question": question, "sessionId": f.helper.ID},
	}
	for _, args := range refused {
		if text, failed := f.needsYou(t, args); !failed {
			t.Fatalf("ask %v was accepted: %s", args, text)
		}
	}
	if list, _ := f.open(t); len(list.Items) != 1 {
		t.Fatalf("refused asks recorded items: %+v", list.Items)
	}
}

// An entry of the assistant's own conversation names that assistant, whatever
// its source: the conversation's title is only its first message. A helper's
// and an ordinary chat's entries name no conversation assistant.
func TestPendingEntriesOfAnAssistantConversationNameTheAssistant(t *testing.T) {
	f := newNeedsYouFixture(t)
	ctx := context.Background()
	if _, failed := f.needsYou(t, map[string]any{"op": "ask", "question": "Cancel tomorrow's meeting?"}); failed {
		t.Fatal("ask failed")
	}
	for _, session := range []store.AgentSession{f.conversation, f.helper, f.chat} {
		if _, _, err := f.server.recordPendingItem(ctx, store.PendingItem{
			UserID: f.aliceID, WorkspaceID: session.WorkspaceID, SessionID: session.ID, Source: store.PendingSourceTurnFailed,
			Key: "failed:" + session.ID, Title: "The turn failed", Excerpt: "The turn failed",
		}); err != nil {
			t.Fatal(err)
		}
	}
	agent := defaultAssistantOf(t, f.server, f.aliceID)
	list, _ := f.open(t)
	named := map[string]int{}
	for _, item := range list.Items {
		switch item.SessionID {
		case f.conversation.ID:
			if item.ConversationAssistant == nil || item.ConversationAssistant.ID != agent.ID || !item.ConversationAssistant.IsDefault {
				t.Fatalf("%s of the conversation names %+v", item.Source, item.ConversationAssistant)
			}
			named[item.Source]++
		default:
			if item.ConversationAssistant != nil {
				t.Fatalf("%s of %s names %+v", item.Source, item.SessionID, item.ConversationAssistant)
			}
		}
	}
	if named[store.PendingSourceAssistantQuestion] != 1 || named[store.PendingSourceTurnFailed] != 1 {
		t.Fatalf("conversation entries = %v of %+v", named, list.Items)
	}
}

func TestHelperCannotAskThePerson(t *testing.T) {
	f := newNeedsYouFixture(t)
	token, err := f.db.MintAgentSessionToken(context.Background(), f.helper.ID)
	if err != nil {
		t.Fatal(err)
	}
	asHelper := f
	asHelper.token = token
	if text, failed := asHelper.needsYou(t, map[string]any{"op": "ask", "question": "Which folder?"}); !failed {
		t.Fatalf("a helper asked the person: %s", text)
	}
	if list, _ := f.open(t); len(list.Items) != 0 {
		t.Fatalf("a helper's ask recorded items: %+v", list.Items)
	}
}

// The person answers an assistant's question through its item. The answer
// reaches the conversation that asked as the person's own words, framed as a
// Foundry message that names the question; the item records the answer and
// who gave it. The request key makes a repeated answer replay the first.
func TestAnswerToAnAssistantQuestionReachesItsConversationAndIsRecorded(t *testing.T) {
	f := newNeedsYouFixture(t)
	ctx := context.Background()
	const question = "Save the receipt to the Q3 folder, or to Travel?"
	const answer = "Q3 folder, please."
	if text, failed := f.needsYou(t, map[string]any{"op": "ask", "question": question, "options": []string{"Q3 folder", "Travel"}}); failed {
		t.Fatalf("ask = %s", text)
	}
	list, _ := f.open(t)
	item := list.Items[0]
	path := "/api/pending-items/" + item.ID + "/answer"

	if status, raw := f.personPost(t, path, map[string]any{"text": "  " + answer + "\n"}, "answer-1"); status != http.StatusOK {
		t.Fatalf("answer = %d %s", status, raw)
	}

	var delivered []store.SessionInboxItem
	for _, message := range conversationInbox(t, f) {
		if strings.Contains(message.Prompt, answer) {
			delivered = append(delivered, message)
		}
	}
	if len(delivered) != 1 {
		t.Fatalf("the answer reached the conversation %d times: %+v", len(delivered), conversationInbox(t, f))
	}
	message := delivered[0]
	if message.Prompt != personalagent.AnswerFrame(item.Title, answer) || !strings.HasPrefix(message.Prompt, personalagent.NoticePrefix) ||
		!strings.Contains(message.Prompt, question) || message.RequestedDelivery != store.DeliveryBoundary ||
		message.InputSource == nil || message.InputSource.NoticeKind != store.NoticeKindQuestionAnswer {
		t.Fatalf("answer message = %+v", message)
	}
	// Viewers read the question and the person's words from the source, never the frame.
	if source := message.InputSource; source.Question != question || source.PersonWords != answer {
		t.Fatalf("answer source = %+v", source)
	}

	stored, err := f.db.GetPendingItem(ctx, f.aliceID, item.ID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.State != store.PendingDone || stored.Outcome != store.PendingOutcomePersonAnswered ||
		stored.Answer != answer || stored.AnsweredBy != store.PendingAnsweredByPerson {
		t.Fatalf("answered item = %+v", stored)
	}
	if _, open := f.open(t); len(open) != 0 {
		t.Fatalf("answered question still open: %+v", open)
	}

	// The same request again replays the first answer: nothing more is delivered.
	if status, raw := f.personPost(t, path, map[string]any{"text": "  " + answer + "\n"}, "answer-1"); status != http.StatusOK {
		t.Fatalf("replayed answer = %d %s", status, raw)
	}
	// A new request about an answered item is refused.
	if status, raw := f.personPost(t, path, map[string]any{"text": "Travel"}, "answer-2"); status != http.StatusConflict {
		t.Fatalf("second answer = %d %s, want 409", status, raw)
	}
	count := 0
	for _, message := range conversationInbox(t, f) {
		if strings.Contains(message.Prompt, answer) {
			count++
		}
	}
	if count != 1 {
		t.Fatalf("the answer was delivered %d times", count)
	}
}

// Only an assistant's question is answered through the item. Any other item
// is answered in its own conversation, and a bad request is refused.
func TestAnswerRefusesOtherItemsAndBadRequests(t *testing.T) {
	f := newNeedsYouFixture(t)
	f.ask(t, f.chat, "q-chat", "Which branch should the fix go to?")
	list, _ := f.open(t)
	if len(list.Items) != 1 {
		t.Fatalf("items = %+v", list.Items)
	}
	chatItem := list.Items[0]
	if chatItem.Source == store.PendingSourceAssistantQuestion {
		t.Fatalf("a chat's question is an assistant question: %+v", chatItem)
	}

	if status, raw := f.personPost(t, "/api/pending-items/"+chatItem.ID+"/answer", map[string]any{"text": "main"}, "answer-chat"); status != http.StatusConflict || !strings.Contains(string(raw), "answer this item in its conversation") {
		t.Fatalf("answer to a chat item = %d %s, want 409", status, raw)
	}
	if status, raw := f.personPost(t, "/api/pending-items/pnd_missing/answer", map[string]any{"text": "main"}, "answer-missing"); status != http.StatusNotFound {
		t.Fatalf("answer to a missing item = %d %s, want 404", status, raw)
	}
	if status, raw := f.personPost(t, "/api/pending-items/"+chatItem.ID+"/answer", map[string]any{"text": "  "}, "answer-empty"); status != http.StatusBadRequest {
		t.Fatalf("empty answer = %d %s, want 400", status, raw)
	}
	if _, open := f.open(t); len(open) != 1 {
		t.Fatalf("refused answers closed the item: %+v", open)
	}
	if inbox := conversationInbox(t, f); len(inbox) != 0 {
		t.Fatalf("refused answers delivered messages: %+v", inbox)
	}
}

func TestAssistantWithdrawsItsQuestionWithResolve(t *testing.T) {
	f := newNeedsYouFixture(t)
	ctx := context.Background()
	if _, failed := f.needsYou(t, map[string]any{"op": "ask", "question": "Which computer?"}); failed {
		t.Fatal("ask failed")
	}
	list, _ := f.open(t)
	if len(list.Items) != 1 {
		t.Fatalf("items = %+v", list.Items)
	}
	item := list.Items[0].PendingItem

	if text, failed := f.needsYou(t, map[string]any{"op": "resolve", "itemId": item.ID, "answer": "The laptop"}); !failed {
		t.Fatalf("resolve with an answer on a question of its own = %s", text)
	}
	if text, failed := f.needsYou(t, map[string]any{"op": "hand_over", "itemId": item.ID, "note": "please check"}); !failed {
		t.Fatalf("hand_over on a question of its own = %s", text)
	}

	if text, failed := f.needsYou(t, map[string]any{"op": "resolve", "itemId": item.ID}); failed || !strings.Contains(text, `"withdrawn"`) {
		t.Fatalf("resolve = %s (failed %v)", text, failed)
	}
	stored, err := f.db.GetPendingItem(ctx, f.aliceID, item.ID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.State != store.PendingDone || stored.Outcome != store.PendingOutcomeWithdrawn {
		t.Fatalf("withdrawn question = %+v", stored)
	}
	if _, open := f.open(t); len(open) != 0 {
		t.Fatalf("withdrawn question still open: %+v", open)
	}
	if inbox := conversationInbox(t, f); len(inbox) != 0 {
		t.Fatalf("withdrawing delivered a message: %+v", inbox)
	}
}

// In the assistant's conversation the person hands over one unrelated thing
// after another: their next message is not taken as the answer to a question
// the conversation's runtime asked on its card. The question closes when the
// person answers it on its card (the reply envelope names it) or when the
// assistant withdraws it with needs_you resolve. A chat the person holds
// themselves keeps its rule: the next message answers.
func TestAssistantConversationQuestionWaitsForItsOwnAnswer(t *testing.T) {
	f := newNeedsYouFixture(t)
	ctx := context.Background()
	reactions := pendingReactions{f.server}
	ask := func(session store.AgentSession, messageID, title string) store.PendingItem {
		t.Helper()
		reactions.SessionEventRecorded(ctx, store.AgentSessionEvent{
			ID: "evt_" + messageID, SessionID: session.ID, Label: "Response stream", Level: "info", At: time.Now().UTC().Format(time.RFC3339Nano),
			Message: &store.TranscriptMessage{ID: "turn/" + messageID, Kind: "assistant", Delivery: "async", Text: title,
				Questions: []store.AgentQuestion{{Title: title}}},
		})
		items, err := f.db.ListPendingItems(ctx, f.aliceID, []string{store.PendingOpen}, "", 100)
		if err != nil {
			t.Fatal(err)
		}
		for _, item := range items {
			if item.Title == title {
				return item
			}
		}
		t.Fatalf("no open item %q", title)
		return store.PendingItem{}
	}
	stateOf := func(id string) store.PendingItem {
		t.Helper()
		item, err := f.db.GetPendingItem(ctx, f.aliceID, id)
		if err != nil {
			t.Fatal(err)
		}
		return item
	}
	queue := func(session store.AgentSession, inputID, prompt string, at time.Time) {
		session.Input = store.SessionInput{ID: inputID, Prompt: prompt, At: at.UTC().Format(time.RFC3339Nano)}
		reactions.SessionChanged(ctx, sessions.Queued, session)
	}

	nas := ask(f.conversation, "call_nas", "Which app manages your NAS?")
	queue(f.conversation, "in_delete", "Delete notes/old-draft-test.txt, I am sure", time.Now().Add(time.Second))
	reactions.SessionEventRecorded(ctx, store.AgentSessionEvent{
		ID: "evt_steer", SessionID: f.conversation.ID, Label: store.EventLabelSteeredIntoTurn, At: time.Now().Add(2 * time.Second).UTC().Format(time.RFC3339Nano),
		Detail: "What day is December 8?",
	})
	if got := stateOf(nas.ID); got.State != store.PendingOpen {
		t.Fatalf("assistant question after unrelated messages = %s %+v, want open", got.State, got.Answer)
	}

	// Answered on its card: the envelope names it.
	queue(f.conversation, "in_card", agentQuestionReplyText(nas.MessageID, nas.Title, "Synology DSM"), time.Now().Add(3*time.Second))
	if got := stateOf(nas.ID); got.State != store.PendingReplied || got.Outcome != store.PendingOutcomePersonAnswered || got.Answer != "Synology DSM" {
		t.Fatalf("after the card answer = %s %s %+v", got.State, got.Outcome, got.Answer)
	}

	// The assistant sees a question of its own conversation and withdraws it.
	stale := ask(f.conversation, "call_photos", "Where is the new NAS?")
	if text, failed := f.needsYou(t, map[string]any{"op": "list"}); failed || !strings.Contains(text, stale.ID) {
		t.Fatalf("list = %s (failed %v), want the conversation's question", text, failed)
	}
	if text, failed := f.needsYou(t, map[string]any{"op": "resolve", "itemId": stale.ID, "answer": "10.0.0.2"}); !failed {
		t.Fatalf("resolve with an answer on its own question = %s", text)
	}
	if text, failed := f.needsYou(t, map[string]any{"op": "resolve", "itemId": stale.ID}); failed || !strings.Contains(text, `"withdrawn"`) {
		t.Fatalf("resolve = %s (failed %v)", text, failed)
	}
	if got := stateOf(stale.ID); got.State != store.PendingDone || got.Outcome != store.PendingOutcomeWithdrawn {
		t.Fatalf("withdrawn question = %s %s", got.State, got.Outcome)
	}
	if inbox := conversationInbox(t, f); len(inbox) != 0 {
		t.Fatalf("withdrawing delivered a message: %+v", inbox)
	}

	// A question in a chat the person holds themselves: their next message answers it.
	header := ask(f.chat, "call_header", "Keep the old header?")
	if text, failed := f.needsYou(t, map[string]any{"op": "resolve", "itemId": header.ID}); !failed {
		t.Fatalf("the assistant withdrew a question of the person's own chat: %s", text)
	}
	queue(f.chat, "in_chat", "Yes, keep it", time.Now().Add(4*time.Second))
	if got := stateOf(header.ID); got.State != store.PendingReplied || got.Answer != "Yes, keep it" {
		t.Fatalf("person's chat question after their message = %s %+v", got.State, got.Answer)
	}
}
