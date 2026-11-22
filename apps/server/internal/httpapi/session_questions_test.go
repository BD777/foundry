package httpapi

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/personalagent/assistant"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// A child's question reaches its parent's inbox as soon as it is recorded,
// with how to answer; the parent's plain answer becomes the reply envelope.
func TestChildQuestionIsRelayedAndAnsweredInPlainText(t *testing.T) {
	f := newChildReportFixture(t)
	ctx := context.Background()
	question := store.AgentSessionEvent{
		ID: "evt_question", SessionID: f.child.ID, At: time.Now().UTC().Format(time.RFC3339Nano), Label: "Response stream",
		Message: &store.TranscriptMessage{
			ID: "toolu_q", Kind: "assistant", Text: "Which greeting?", Delivery: questionDeliveryNextTurn,
			Questions: []store.AgentQuestion{{Title: "Which greeting?", Options: []string{"Hello", "Bonjour"}, Descriptions: []string{"English", "French"}}},
		},
	}
	if _, err := f.db.StartAgentSession(ctx, f.child.ID); err != nil {
		t.Fatalf("start child: %v", err)
	}
	if _, err := f.db.RecordAgentSessionEvent(ctx, question); err != nil {
		t.Fatalf("record question: %v", err)
	}
	childQuestionReactions{f.server}.SessionEventRecorded(ctx, question)
	childQuestionReactions{f.server}.SessionEventRecorded(ctx, question)

	items, err := f.db.SessionInboxItems(ctx, f.parent.ID, time.Now().Add(-time.Hour), 50)
	if err != nil {
		t.Fatalf("parent inbox: %v", err)
	}
	var relayed []store.SessionInboxItem
	for _, item := range items {
		if item.SenderSessionID == f.child.ID && strings.HasPrefix(item.Prompt, "Foundry question:") {
			relayed = append(relayed, item)
		}
	}
	if len(relayed) != 1 {
		t.Fatalf("relayed questions = %d, want 1: %+v", len(relayed), items)
	}
	for _, want := range []string{f.child.ID, "Which greeting?", "- Bonjour: French", "send_message to " + f.child.ID} {
		if !strings.Contains(relayed[0].Prompt, want) {
			t.Errorf("relayed question lacks %q:\n%s", want, relayed[0].Prompt)
		}
	}
	// Facts only: nothing tells the parent when to involve its person.
	if strings.Contains(relayed[0].Prompt, "decide whether") || strings.Contains(relayed[0].Prompt, "question tool") {
		t.Errorf("relayed question carries guidance:\n%s", relayed[0].Prompt)
	}
	if relayed[0].RequestedDelivery != store.DeliveryBoundary {
		t.Errorf("delivery = %q, want boundary", relayed[0].RequestedDelivery)
	}

	// An answer while the child's turn is still ending maps too.
	running, _ := f.db.GetAgentSessionSummary(ctx, f.child.ID)
	if got := f.server.answerWaitingQuestion(ctx, f.parent.ID, running, "Bonjour"); !strings.Contains(got, agentQuestionReplyOpen) {
		t.Errorf("answer to a child still ending its turn = %q", got)
	}
	child, err := f.db.CompleteAgentSession(ctx, f.child.ID, "Waiting for the answer.", "native-child")
	if err != nil {
		t.Fatalf("complete child: %v", err)
	}
	answer := f.server.answerWaitingQuestion(ctx, f.parent.ID, child, "Bonjour")
	if !strings.Contains(answer, agentQuestionReplyOpen) || !strings.Contains(answer, `\"toolu_q\"`) || !strings.Contains(answer, `"answer":"Bonjour"`) {
		t.Errorf("parent's answer = %q, want the reply envelope", answer)
	}
	// Only the parent's messages map; an envelope stays as it is.
	if got := f.server.answerWaitingQuestion(ctx, "sess_other", child, "Bonjour"); got != "Bonjour" {
		t.Errorf("another session's message = %q", got)
	}
	if got := f.server.answerWaitingQuestion(ctx, f.parent.ID, child, answer); got != answer {
		t.Errorf("an envelope was wrapped again: %q", got)
	}
}

// An approval tells the parent how to approve or deny, with the plan.
func TestRelayedApprovalCarriesThePlan(t *testing.T) {
	s := NewServer(newTestStore(t))
	text := s.relayedQuestionText(store.AgentSession{ID: "sess_child", Title: "Refactor"}, assistant.SignalTarget{}, store.TranscriptMessage{
		ID: "approval_toolu_p", Questions: []store.AgentQuestion{{Title: "Approve this plan?", Options: []string{"Approve", "Deny"}, Approval: true, Detail: "1. Split the module"}},
	})
	for _, want := range []string{"asks for approval", "1. Split the module", `"Approve" approves`} {
		if !strings.Contains(text, want) {
			t.Errorf("approval relay lacks %q:\n%s", want, text)
		}
	}
}

// A child's async question (its turn runs on) reaches its parent at once,
// saying the child keeps working; the parent's plain answer becomes the reply
// envelope until the child has taken an answer, then a plain message again.
func TestAsyncChildQuestionIsRelayedAndAnsweredByParent(t *testing.T) {
	f := newChildReportFixture(t)
	ctx := context.Background()
	if _, err := f.db.StartAgentSession(ctx, f.child.ID); err != nil {
		t.Fatalf("start child: %v", err)
	}
	question := store.AgentSessionEvent{
		ID: "evt_async", SessionID: f.child.ID, At: time.Now().UTC().Format(time.RFC3339Nano), Label: "Response stream",
		Message: &store.TranscriptMessage{
			ID: "item_async", Kind: "assistant", Text: "Which greeting?", Delivery: questionDeliveryAsync,
			Questions: []store.AgentQuestion{{Title: "Which greeting?", Options: []string{"Hello", "Bonjour"}}},
		},
	}
	if _, err := f.db.RecordAgentSessionEvent(ctx, question); err != nil {
		t.Fatalf("record question: %v", err)
	}
	childQuestionReactions{f.server}.SessionEventRecorded(ctx, question)

	var relayed []store.SessionInboxItem
	items, err := f.db.SessionInboxItems(ctx, f.parent.ID, time.Now().Add(-time.Hour), 50)
	if err != nil {
		t.Fatalf("parent inbox: %v", err)
	}
	for _, item := range items {
		if item.SenderSessionID == f.child.ID && strings.HasPrefix(item.Prompt, "Foundry question:") {
			relayed = append(relayed, item)
		}
	}
	if len(relayed) != 1 {
		t.Fatalf("relayed questions = %d, want 1: %+v", len(relayed), items)
	}
	for _, want := range []string{"keeps working", "reads the answer at its next step", "Which greeting?", "send_message to " + f.child.ID} {
		if !strings.Contains(relayed[0].Prompt, want) {
			t.Errorf("relayed async question lacks %q:\n%s", want, relayed[0].Prompt)
		}
	}
	if strings.Contains(relayed[0].Prompt, "turn ended") {
		t.Errorf("async question says its turn ended:\n%s", relayed[0].Prompt)
	}

	running, _ := f.db.GetAgentSessionSummary(ctx, f.child.ID)
	if got := f.server.answerWaitingQuestion(ctx, f.parent.ID, running, "Bonjour"); !strings.Contains(got, agentQuestionReplyOpen) || !strings.Contains(got, `\"item_async\"`) {
		t.Fatalf("parent's answer while the child runs = %q, want the reply envelope", got)
	}

	// The Worker records the envelope steered in: the question is answered.
	steered := store.AgentSessionEvent{
		ID: "evt_steer", SessionID: f.child.ID, At: time.Now().UTC().Add(time.Second).Format(time.RFC3339Nano),
		Label: store.EventLabelSteeredIntoTurn, Detail: agentQuestionReplyText("item_async", "Which greeting?", "Bonjour"),
	}
	if _, err := f.db.RecordAgentSessionEvent(ctx, steered); err != nil {
		t.Fatalf("record steer: %v", err)
	}
	if got := f.server.answerWaitingQuestion(ctx, f.parent.ID, running, "Also check the tests"); got != "Also check the tests" {
		t.Errorf("a message after the answer = %q, want a plain steer", got)
	}
}

// The person answers the child's question in its chat before the parent is
// told: nothing is relayed, and the parent's text is no answer.
func TestAsyncChildQuestionAnsweredByThePersonIsNotRelayed(t *testing.T) {
	f := newChildReportFixture(t)
	ctx := context.Background()
	if _, err := f.db.StartAgentSession(ctx, f.child.ID); err != nil {
		t.Fatalf("start child: %v", err)
	}
	question := store.AgentSessionEvent{
		ID: "evt_async_person", SessionID: f.child.ID, At: time.Now().UTC().Format(time.RFC3339Nano), Label: "Response stream",
		Message: &store.TranscriptMessage{
			ID: "item_person", Kind: "assistant", Text: "Which greeting?", Delivery: questionDeliveryAsync,
			Questions: []store.AgentQuestion{{Title: "Which greeting?"}},
		},
	}
	answer := store.AgentSessionEvent{
		ID: "evt_person_answer", SessionID: f.child.ID, At: time.Now().UTC().Format(time.RFC3339Nano), Label: store.EventLabelSteeredIntoTurn,
		Detail: agentQuestionReplyText("item_person", "Which greeting?", "Hello"),
	}
	for _, event := range []store.AgentSessionEvent{question, answer} {
		if _, err := f.db.RecordAgentSessionEvent(ctx, event); err != nil {
			t.Fatalf("record %s: %v", event.ID, err)
		}
	}
	childQuestionReactions{f.server}.SessionEventRecorded(ctx, question)

	items, err := f.db.SessionInboxItems(ctx, f.parent.ID, time.Now().Add(-time.Hour), 50)
	if err != nil {
		t.Fatalf("parent inbox: %v", err)
	}
	for _, item := range items {
		if strings.HasPrefix(item.Prompt, "Foundry question:") {
			t.Errorf("an answered question was relayed: %+v", item)
		}
	}
	running, _ := f.db.GetAgentSessionSummary(ctx, f.child.ID)
	if got := f.server.answerWaitingQuestion(ctx, f.parent.ID, running, "Bonjour"); got != "Bonjour" {
		t.Errorf("parent's text after the person's answer = %q, want it unchanged", got)
	}
}

// A helper of the person's assistant asks asynchronously: a running assistant
// gets the question with the hand-over hint; a stopped one gets nothing (the
// person already has the item in their list).
func TestAsyncHelperQuestionFollowsTheAssistantState(t *testing.T) {
	f := newNeedsYouFixture(t)
	ctx := context.Background()
	agent := defaultAssistantOf(t, f.server, f.aliceID)
	question := store.AgentSessionEvent{
		ID: "evt_helper_async", SessionID: f.helper.ID, At: time.Now().UTC().Format(time.RFC3339Nano), Label: "Response stream",
		Message: &store.TranscriptMessage{
			ID: "item_helper_async", Kind: "assistant", Text: "Which export format?", Delivery: questionDeliveryAsync,
			Questions: []store.AgentQuestion{{Title: "Which export format?"}},
		},
	}
	relayedTo := func() []store.SessionInboxItem {
		t.Helper()
		items, err := f.db.SessionInboxItems(ctx, f.conversation.ID, time.Now().Add(-time.Hour), 50)
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

	if _, err := f.db.SetPersonalAgentState(ctx, agent.ID, store.PersonalAgentStopped); err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.RecordAgentSessionEvent(ctx, question); err != nil {
		t.Fatalf("record question: %v", err)
	}
	childQuestionReactions{f.server}.SessionEventRecorded(ctx, question)
	if got := relayedTo(); len(got) != 0 {
		t.Fatalf("stopped assistant got the question: %+v", got)
	}

	if _, err := f.db.SetPersonalAgentState(ctx, agent.ID, store.PersonalAgentActive); err != nil {
		t.Fatal(err)
	}
	active := question
	active.ID = "evt_helper_async_active"
	active.Message = &store.TranscriptMessage{
		ID: "item_helper_async_active", Kind: "assistant", Text: "Which export format?", Delivery: questionDeliveryAsync,
		Questions: []store.AgentQuestion{{Title: "Which export format?"}},
	}
	if _, err := f.db.RecordAgentSessionEvent(ctx, active); err != nil {
		t.Fatalf("record active question: %v", err)
	}
	childQuestionReactions{f.server}.SessionEventRecorded(ctx, active)
	got := relayedTo()
	if len(got) != 1 {
		t.Fatalf("running assistant got %d questions, want 1", len(got))
	}
	// Facts only: when to hand it to the person is the needs_you tool's contract.
	if strings.Contains(got[0].Prompt, "hand_over") || !strings.Contains(got[0].Prompt, "keeps working") {
		t.Errorf("running assistant's question carries the hand-over hint or lacks the keep-working line:\n%s", got[0].Prompt)
	}
}
