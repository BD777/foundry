package httpapi

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

type summaryMap map[string]store.AgentSession

func (m summaryMap) GetAgentSessionSummary(_ context.Context, id string) (store.AgentSession, error) {
	if session, ok := m[id]; ok {
		return session, nil
	}
	return store.AgentSession{}, store.ErrNotFound
}

// Who answers: the person's own chat, a child's parent up a chain that
// reaches a person, the child's own chat when its parent is gone, and
// nobody where no person is at the root.
func TestQuestionsToFollowsTheChainToAPerson(t *testing.T) {
	sessions := summaryMap{
		"chat":         {ID: "chat", Source: store.SessionSourceChat, CreatedByUserID: "u"},
		"child":        {ID: "child", Source: store.SessionSourceAgent, ParentSessionID: "chat", CreatedByUserID: "u"},
		"grandchild":   {ID: "grandchild", Source: store.SessionSourceAgent, ParentSessionID: "child", CreatedByUserID: "u"},
		"archived":     {ID: "archived", Source: store.SessionSourceChat, ArchivedAt: "2026-11-06T00:00:00Z"},
		"orphan":       {ID: "orphan", Source: store.SessionSourceAgent, ParentSessionID: "archived", CreatedByUserID: "u"},
		"lost":         {ID: "lost", Source: store.SessionSourceAgent, ParentSessionID: "deleted", CreatedByUserID: "u"},
		"scheduled":    {ID: "scheduled", Source: store.SessionSourceChat, ParentSessionID: "chat", CreatedByUserID: "u"},
		"timerChild":   {ID: "timerChild", Source: store.SessionSourceAgent, ParentSessionID: "scheduled", CreatedByUserID: "u"},
		"issueRun":     {ID: "issueRun", Source: store.SessionSourceIssue, IssueID: "iss_1", CreatedByUserID: "u"},
		"issueChild":   {ID: "issueChild", Source: store.SessionSourceAgent, ParentSessionID: "issueRun", CreatedByUserID: "u"},
		"assistant":    {ID: "assistant", Source: store.SessionSourceChat, Role: store.AgentSessionRolePersonalAgent, CreatedByUserID: "u"},
		"utility":      {ID: "utility", Source: store.SessionSourceNaming},
		"verifier":     {ID: "verifier", Source: store.SessionSourceVerification, ParentSessionID: "chat", CreatedByUserID: "u"},
		"stoppedChild": {ID: "stoppedChild", Source: store.SessionSourceAgent, ParentSessionID: "stopped", CreatedByUserID: "u"},
		"stopped":      {ID: "stopped", Source: store.SessionSourceChat, Status: "canceled", CreatedByUserID: "u"},
	}
	for _, check := range []struct{ id, to, parent string }{
		{"chat", questionsToPerson, ""},
		{"child", questionsToParent, "chat"},
		{"grandchild", questionsToParent, "child"},
		{"orphan", questionsToParent, ""},
		{"lost", questionsToParent, ""},
		{"stoppedChild", questionsToParent, ""},
		{"scheduled", "", ""},
		{"timerChild", "", ""},
		{"issueRun", "", ""},
		{"issueChild", "", ""},
		{"assistant", "", ""},
		{"utility", "", ""},
		{"verifier", "", ""},
	} {
		to, parent := questionsTo(context.Background(), sessions, sessions[check.id], 0)
		if to != check.to || parent != check.parent {
			t.Errorf("questionsTo(%s) = %q, %q; want %q, %q", check.id, to, parent, check.to, check.parent)
		}
	}
}

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
	for _, want := range []string{f.child.ID, "Which greeting?", "- Bonjour: French", "send_message to " + f.child.ID, "otherwise decide whether it needs your own person, and if so ask with your question tool"} {
		if !strings.Contains(relayed[0].Prompt, want) {
			t.Errorf("relayed question lacks %q:\n%s", want, relayed[0].Prompt)
		}
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
	text := s.relayedQuestionText(store.AgentSession{ID: "sess_child", Title: "Refactor"}, store.TranscriptMessage{
		ID: "approval_toolu_p", Questions: []store.AgentQuestion{{Title: "Approve this plan?", Options: []string{"Approve", "Deny"}, Approval: true, Detail: "1. Split the module"}},
	})
	for _, want := range []string{"asks for approval", "1. Split the module", `"Approve" approves`} {
		if !strings.Contains(text, want) {
			t.Errorf("approval relay lacks %q:\n%s", want, text)
		}
	}
}
