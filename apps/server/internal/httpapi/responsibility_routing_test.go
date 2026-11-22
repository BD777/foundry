package httpapi

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// questionEventOf records a question a session asked, as its worker reports
// it, with the delivery the worker gave it.
func questionEventOf(t *testing.T, f needsYouFixture, session store.AgentSession, id, title, delivery string) store.AgentSessionEvent {
	t.Helper()
	ctx := context.Background()
	event := store.AgentSessionEvent{
		ID: "evt_" + id, SessionID: session.ID, At: formatPendingTime(time.Now()), Label: "Response stream",
		Message: &store.TranscriptMessage{ID: "item_" + id, Kind: "assistant", Text: title, Delivery: delivery, Questions: []store.AgentQuestion{{Title: title}}},
	}
	if _, err := f.db.RecordAgentSessionEvent(ctx, event); err != nil {
		t.Fatalf("record question %s: %v", id, err)
	}
	pendingReactions{f.server}.SessionEventRecorded(ctx, event)
	childQuestionReactions{f.server}.SessionEventRecorded(ctx, event)
	return event
}

// helperInboxQuestions are the relayed questions in the conversation's inbox.
func helperInboxQuestions(t *testing.T, f needsYouFixture) []store.SessionInboxItem {
	t.Helper()
	items, err := f.db.SessionInboxItems(context.Background(), f.conversation.ID, time.Now().Add(-time.Hour), 50)
	if err != nil {
		t.Fatalf("assistant inbox: %v", err)
	}
	var relayed []store.SessionInboxItem
	for _, item := range items {
		if item.SenderSessionID == f.helper.ID && strings.HasPrefix(item.Prompt, "Foundry question:") {
			relayed = append(relayed, item)
		}
	}
	return relayed
}

// openItemsOf are the person's open items for the user, by title.
func openItemsOf(t *testing.T, f needsYouFixture) map[string]store.PendingItem {
	t.Helper()
	items, err := f.db.ListVisiblePendingItems(context.Background(), f.aliceID, []string{store.PendingOpen}, "", 100)
	if err != nil {
		t.Fatalf("open items: %v", err)
	}
	byTitle := map[string]store.PendingItem{}
	for _, item := range items {
		byTitle[item.Title] = item
	}
	return byTitle
}

// closedItemsOf is the person's done items by title.
func closedItemsOf(t *testing.T, f needsYouFixture) map[string]store.PendingItem {
	t.Helper()
	items, err := f.db.ListVisiblePendingItems(context.Background(), f.aliceID, []string{store.PendingDone}, "", 100)
	if err != nil {
		t.Fatalf("done items: %v", err)
	}
	byTitle := map[string]store.PendingItem{}
	for _, item := range items {
		byTitle[item.Title] = item
	}
	return byTitle
}

// A helper's question raised while its assistant is stopped stays the
// assistant's, and is relayed to it once when it resumes: a question already
// answered is left out, and a relay before does not repeat.
func TestHelperQuestionOnStoppedAssistantIsRelayedOnceOnResume(t *testing.T) {
	f := newNeedsYouFixture(t)
	ctx := context.Background()
	agent := defaultAssistantOf(t, f.server, f.aliceID)
	if _, err := f.db.SetPersonalAgentState(ctx, agent.ID, store.PersonalAgentStopped); err != nil {
		t.Fatal(err)
	}
	// A steered answer settles what the session showed before it, so the
	// answered question comes first, and the open one after it.
	questionEventOf(t, f, f.helper, "qb", "Which size?", questionDeliveryAsync)
	answer := store.AgentSessionEvent{
		ID: "evt_answer_qb", SessionID: f.helper.ID, At: formatPendingTime(time.Now()), Label: store.EventLabelSteeredIntoTurn,
		Detail: agentQuestionReplyText("item_qb", "Which size?", "small"),
	}
	if _, err := f.db.RecordAgentSessionEvent(ctx, answer); err != nil {
		t.Fatal(err)
	}
	pendingReactions{f.server}.SessionEventRecorded(ctx, answer)
	questionEventOf(t, f, f.helper, "qa", "Which format?", questionDeliveryAsync)

	if got := helperInboxQuestions(t, f); len(got) != 0 {
		t.Fatalf("a stopped assistant got %d questions before it resumed", len(got))
	}
	open := openItemsOf(t, f)
	if item, ok := open["Which format?"]; !ok || item.Handler != store.PendingHandlerAssistant || item.AssistantID != agent.ID {
		t.Fatalf("the question of a stopped assistant's helper is not its assistant's: %+v", item)
	}
	if _, ok := open["Which size?"]; ok {
		t.Fatal("an answered question is still open")
	}

	if _, err := f.db.SetPersonalAgentState(ctx, agent.ID, store.PersonalAgentActive); err != nil {
		t.Fatal(err)
	}
	f.server.relayHelperQuestionsOnResume(ctx, agent)
	got := helperInboxQuestions(t, f)
	if len(got) != 1 || !strings.Contains(got[0].Prompt, "Which format?") {
		t.Fatalf("on resume the assistant got %d questions, want the one still open: %+v", len(got), got)
	}
	f.server.relayHelperQuestionsOnResume(ctx, agent)
	if again := helperInboxQuestions(t, f); len(again) != 1 {
		t.Fatalf("a second resume relayed again: %d questions", len(again))
	}
}

// A question a helper raised with no delivery label still goes to its
// assistant: the helper's question is never held by its turn, so it stays
// open until answered. The person's own chat keeps holding its turn.
func TestQuestionWithoutDeliveryGoesToItsResponsibleParty(t *testing.T) {
	f := newNeedsYouFixture(t)
	questionEventOf(t, f, f.helper, "qh", "Which path?", "")
	if got := helperInboxQuestions(t, f); len(got) != 1 {
		t.Fatalf("a helper's question with no delivery label reached its assistant %d times, want once", len(got))
	}
	item := openItemsOf(t, f)["Which path?"]
	if item.Handler != store.PendingHandlerAssistant || item.Rule != "" {
		t.Fatalf("helper question item = handler %q rule %q, want assistant and no held rule", item.Handler, item.Rule)
	}

	chatQuestion := store.AgentSessionEvent{
		ID: "evt_chat_q", SessionID: f.chat.ID, At: formatPendingTime(time.Now()), Label: "Response stream",
		Message: &store.TranscriptMessage{ID: "item_chat_q", Kind: "assistant", Text: "Which colour?", Questions: []store.AgentQuestion{{Title: "Which colour?"}}},
	}
	if _, err := f.db.RecordAgentSessionEvent(context.Background(), chatQuestion); err != nil {
		t.Fatal(err)
	}
	pendingReactions{f.server}.SessionEventRecorded(context.Background(), chatQuestion)
	childQuestionReactions{f.server}.SessionEventRecorded(context.Background(), chatQuestion)
	chat := openItemsOf(t, f)["Which colour?"]
	if chat.Handler != store.PendingHandlerPerson || chat.Rule != store.PendingRuleHeld {
		t.Fatalf("the person's chat question = handler %q rule %q, want person and held", chat.Handler, chat.Rule)
	}
}

// resolve follows what a waiting helper needs: its answer (sent as send_message
// sends one), or the reason it gets none (the no-answer reply). Bare, it is refused
// while the helper waits; an item nobody waits on closes bare.
func TestNeedsYouResolveAnswersOrGivesTheReasonToAWaitingHelper(t *testing.T) {
	f := newNeedsYouFixture(t)
	f.ask(t, f.helper, "q1", "Which format?")
	if text, failed := f.needsYou(t, map[string]any{"op": "resolve", "sessionId": f.helper.ID}); !failed || !strings.Contains(text, "waits for an answer") {
		t.Fatalf("bare resolve of a waiting question: failed %v, %s", failed, text)
	}
	if text, failed := f.needsYou(t, map[string]any{"op": "resolve", "sessionId": f.helper.ID, "answer": "csv", "reason": "no"}); !failed {
		t.Fatalf("answer and reason together: %s", text)
	}
	if text, failed := f.needsYou(t, map[string]any{"op": "resolve", "sessionId": f.helper.ID, "answer": "csv"}); failed {
		t.Fatalf("resolve with answer: %s", text)
	}
	if sent := helperInbox(t, f); len(sent) != 1 || !strings.Contains(sent[0].Prompt, "csv") {
		t.Fatalf("the helper's answer did not arrive: %+v", sent)
	}
	if open := openItemsOf(t, f); len(open) != 0 {
		t.Fatalf("answered item still open: %+v", open)
	}

	reasoned := newNeedsYouFixture(t)
	reasoned.ask(t, reasoned.helper, "q2", "Which path?")
	if text, failed := reasoned.needsYou(t, map[string]any{"op": "resolve", "sessionId": reasoned.helper.ID, "reason": "the path is out of scope"}); failed {
		t.Fatalf("resolve with reason: %s", text)
	}
	sent := helperInbox(t, reasoned)
	if len(sent) != 1 || !strings.Contains(sent[0].Prompt, agentQuestionReplyOpen) || !strings.Contains(sent[0].Prompt, `"noAnswer":true`) || !strings.Contains(sent[0].Prompt, "out of scope") {
		t.Fatalf("the helper did not get its question's no-answer reply with the reason: %+v", sent)
	}
	if open := openItemsOf(t, reasoned); len(open) != 0 {
		t.Fatalf("item closed with a reason still open: %+v", open)
	}
	closed := closedItemsOf(t, reasoned)["Which path?"]
	if closed.Outcome != store.PendingOutcomeAssistantClosed || closed.CloseReason != "the path is out of scope" || closed.Answer != "" {
		t.Fatalf("closed with a reason = outcome %q, reason %q, answer %q", closed.Outcome, closed.CloseReason, closed.Answer)
	}
	if answered := closedItemsOf(t, f)["Which format?"]; answered.Outcome != store.PendingOutcomeAssistantAnswered {
		t.Fatalf("answered item outcome = %q, want assistant_answered", answered.Outcome)
	}
}

// An item nobody waits on, closed bare, ends as assistant_closed: it was not
// answered, and nothing goes to the helper.
func TestNeedsYouBareResolveIsClosedNotAnswered(t *testing.T) {
	f := newNeedsYouFixture(t)
	ctx := context.Background()
	stuck, _, err := f.db.RecordPendingItem(ctx, store.PendingItem{
		UserID: f.aliceID, AssistantID: defaultAssistantOf(t, f.server, f.aliceID).ID, WorkspaceID: f.helper.WorkspaceID,
		SessionID: f.helper.ID, Source: store.PendingSourceHelperStuck, Key: "stuck:" + f.helper.ID,
		Title: "Stuck helper", Handler: store.PendingHandlerAssistant,
	})
	if err != nil {
		t.Fatal(err)
	}
	if text, failed := f.needsYou(t, map[string]any{"op": "resolve", "itemId": stuck.ID}); failed {
		t.Fatalf("bare resolve of an item nobody waits on: %s", text)
	}
	if sent := helperInbox(t, f); len(sent) != 0 {
		t.Fatalf("a bare resolve reached the helper: %+v", sent)
	}
	closed := closedItemsOf(t, f)["Stuck helper"]
	if closed.Outcome != store.PendingOutcomeAssistantClosed || closed.Answer != "" || closed.CloseReason != "" {
		t.Fatalf("bare close = outcome %q, answer %q, reason %q", closed.Outcome, closed.Answer, closed.CloseReason)
	}
}

// helperInbox is what was sent to the helper session.
func helperInbox(t *testing.T, f needsYouFixture) []store.SessionInboxItem {
	t.Helper()
	items, err := f.db.SessionInboxItems(context.Background(), f.helper.ID, time.Now().Add(-time.Hour), 50)
	if err != nil {
		t.Fatalf("helper inbox: %v", err)
	}
	return items
}

// A message channel's held or gap item stays with its assistant, stopped or
// not: the assistant decides it. Only the assistant's own failures go to the
// person.
func TestMessageChannelItemStaysWithItsAssistantWhileStopped(t *testing.T) {
	f := newNeedsYouFixture(t)
	ctx := context.Background()
	agent := defaultAssistantOf(t, f.server, f.aliceID)
	channel := store.MessageChannelRecord{UserID: f.aliceID, MessageChannel: store.MessageChannel{ID: "ch_held", AssistantID: agent.ID}}
	f.server.tellAboutMessageChannel(ctx, channel, "held-1", "A held message", "held text")
	if item := openItemsOf(t, f)["A held message"]; item.Handler != store.PendingHandlerAssistant || item.AssistantID != agent.ID {
		t.Fatalf("held channel item = handler %q assistant %q, want the assistant", item.Handler, item.AssistantID)
	}
	if _, err := f.db.SetPersonalAgentState(ctx, agent.ID, store.PersonalAgentStopped); err != nil {
		t.Fatal(err)
	}
	f.server.tellAboutMessageChannel(ctx, channel, "gap-1", "A gap in messages", "gap text")
	if item := openItemsOf(t, f)["A gap in messages"]; item.Handler != store.PendingHandlerAssistant || item.AssistantID != agent.ID {
		t.Fatalf("a stopped assistant's channel item = handler %q, want the assistant", item.Handler)
	}
}

// Only a question the person holds in their own chat holds its turn: the
// item says so, and a helper's does not.
func TestPendingItemsHeldByTurnOnlyInThePersonsChat(t *testing.T) {
	event := store.AgentSessionEvent{ID: "evt_q", SessionID: "sess", Message: &store.TranscriptMessage{ID: "m", Kind: "assistant", Text: "Which?", Questions: []store.AgentQuestion{{Title: "Which?"}}}}
	for _, check := range []struct {
		name      string
		holdsTurn bool
		rule      string
	}{
		{"the person's chat", true, store.PendingRuleHeld},
		{"a helper's question", false, ""},
	} {
		items := pendingItemsFromEvent(event, check.holdsTurn)
		if len(items) != 1 || items[0].Rule != check.rule {
			t.Errorf("%s: items %+v, want one item with rule %q", check.name, items, check.rule)
		}
	}
}

// itemsInStates are the user's items in those states, by title.
func itemsInStates(t *testing.T, f needsYouFixture, states ...string) map[string]store.PendingItem {
	t.Helper()
	items, err := f.db.ListVisiblePendingItems(context.Background(), f.aliceID, states, "", 100)
	if err != nil {
		t.Fatalf("items: %v", err)
	}
	byTitle := map[string]store.PendingItem{}
	for _, item := range items {
		byTitle[item.Title] = item
	}
	return byTitle
}

// An answered item keeps its answer and who gave it: the assistant's
// resolve with answer, and the person's answer in their own chat. The text is
// the answer itself, not the reply envelope, and is cut to PendingAnswerLimit
// characters.
func TestAnsweredItemKeepsItsAnswerAndWhoGaveIt(t *testing.T) {
	f := newNeedsYouFixture(t)
	ctx := context.Background()

	f.ask(t, f.helper, "qh", "Which format?")
	if text, failed := f.needsYou(t, map[string]any{"op": "resolve", "sessionId": f.helper.ID, "answer": "  csv  "}); failed {
		t.Fatalf("resolve with answer: %s", text)
	}
	if item := itemsInStates(t, f, store.PendingDone)["Which format?"]; item.Answer != "csv" || item.AnsweredBy != store.PendingAnsweredByAssistant {
		t.Fatalf("assistant's answer = %q by %q, want csv by assistant", item.Answer, item.AnsweredBy)
	}

	questionEventOf(t, f, f.chat, "qc", "Which colour?", "")
	long := strings.Repeat("ä", 1200)
	steer := store.AgentSessionEvent{
		ID: "evt_person_answer", SessionID: f.chat.ID, At: formatPendingTime(time.Now()), Label: store.EventLabelSteeredIntoTurn,
		Detail: agentQuestionReplyText("item_qc", "Which colour?", long),
	}
	if _, err := f.db.RecordAgentSessionEvent(ctx, steer); err != nil {
		t.Fatal(err)
	}
	pendingReactions{f.server}.SessionEventRecorded(ctx, steer)
	item := itemsInStates(t, f, store.PendingReplied)["Which colour?"]
	if item.AnsweredBy != store.PendingAnsweredByPerson || len([]rune(item.Answer)) != store.PendingAnswerLimit || item.Answer != strings.Repeat("ä", store.PendingAnswerLimit) {
		t.Fatalf("person's answer = %d runes by %q, want %d runes by person", len([]rune(item.Answer)), item.AnsweredBy, store.PendingAnswerLimit)
	}
}

// answerTextOf is the answer a message carries: the answers of a reply envelope,
// or the message itself.
func TestAnswerTextOfUnwrapsTheReplyEnvelope(t *testing.T) {
	for _, check := range []struct{ name, message, want string }{
		{"plain text", "  just this  ", "just this"},
		{"one envelope answer", agentQuestionReplyText("item_a", "Which?", "csv"), "csv"},
		{"two envelope answers", agentQuestionReplyOpen + "\n" + `[{"questionItemId":"x","answer":"one"},{"questionItemId":"y","answer":" two "}]` + "\n" + agentQuestionReplyClose + "\n", "one\ntwo"},
		{"malformed envelope", agentQuestionReplyOpen + "\nnot json\n" + agentQuestionReplyClose, agentQuestionReplyOpen + "\nnot json\n" + agentQuestionReplyClose},
	} {
		if got := answerTextOf(check.message); got != check.want {
			t.Errorf("%s: answerTextOf = %q, want %q", check.name, got, check.want)
		}
	}
}
