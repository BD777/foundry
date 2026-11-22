package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"strings"

	"github.com/foundry-dev/foundry/apps/server/internal/personalagent/assistant"
	"github.com/foundry-dev/foundry/apps/server/internal/sessions"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"github.com/foundry-dev/foundry/apps/server/internal/textcut"
	"github.com/google/uuid"
)

// Who answers a session's questions and permission prompts, for every
// runtime (Claude's questions and plan approvals; Codex's approvals,
// requestUserInput and MCP elicitations). A person's own chat asks the person, who sees the turn
// wait. A session another session created asks its parent through the
// parent's inbox: the question ends the child's turn, the parent answers or
// asks its own answerer, and its message to the child is the answer. A
// chain that reaches no person (a scheduled run, an Issue's session, a role,
// a utility session) answers nothing: prompts are denied at once.

const (
	questionsToPerson = "person"
	questionsToParent = "parent"
	// questionDeliveryNextTurn marks questions that ended the turn and wait
	// for the next message (TranscriptMessage.delivery); questionDeliveryAsync
	// marks questions the turn keeps working past (Codex
	// request_user_input_async), answered by a steer naming them.
	questionDeliveryNextTurn = "next_turn"
	questionDeliveryAsync    = "async"
	// relayedQuestionDetailLimit is how much of a plan a relay carries.
	relayedQuestionDetailLimit = 4000
)

// relayedQuestionSpace names the inbox ids of relayed questions.
var relayedQuestionSpace = uuid.MustParse("3c0f7b8e-5d21-4f6a-9b3e-7a4c2d1e8f60")

// questionRouting is the Worker's questionsTo value for a session (questionsToPerson,
// questionsToParent or "": nobody) and, for a parent, the live session that
// takes its questions ("" when it is gone: the question then waits in the
// child's own chat).
func questionRouting(responsible assistant.Responsibility) (string, string) {
	switch responsible.Party {
	case assistant.ResponsiblePerson:
		return questionsToPerson, ""
	case assistant.ResponsibleAssistant, assistant.ResponsibleSession:
		return questionsToParent, responsible.SessionID
	}
	return "", ""
}

// relayChildQuestion puts a question a child raised in its responsible
// party's inbox at once, whatever its delivery: a question the person holds
// in their own chat is not relayed. A child on an item asks whoever follows
// the item (assistant.SignalTarget), and its question waits on the item while
// no one does. A stopped assistant keeps the question until it resumes
// (relayHelperQuestionsOnResume).
func (s *Server) relayChildQuestion(ctx context.Context, event store.AgentSessionEvent) {
	message := event.Message
	if message == nil || len(message.Questions) == 0 {
		return
	}
	child, err := s.store.GetAgentSessionSummary(ctx, event.SessionID)
	if err != nil {
		return
	}
	responsible := s.assistant.ResponsibleFor(ctx, child)
	to, parentID := questionRouting(responsible)
	if to != questionsToParent {
		return
	}
	target := s.assistant.SignalTarget(ctx, child, parentID)
	if target.SessionID == "" && !target.Queued() {
		log.Printf("session question kept in its chat: session=%s message=%s reason=%q", child.ID, message.ID, "no live parent answers it")
		return
	}
	if responsible.Party == assistant.ResponsibleAssistant && responsible.Assistant.State != store.PersonalAgentActive && target.Via != assistant.SignalViaHolder {
		log.Printf("session question kept for the stopped assistant: session=%s message=%s", child.ID, message.ID)
		return
	}
	if s.questionAnswered(ctx, child, *message) {
		log.Printf("session question not relayed: session=%s message=%s reason=%q", child.ID, message.ID, "already answered")
		return
	}
	// What the parent reads is facts only: who asks, what, and how an answer
	// reaches it. When to hand it to the person is the needs_you tool's
	// contract, not this message's.
	prompt := s.relayedQuestionText(child, target, *message)
	item := store.SessionInboxItem{
		SessionID: target.SessionID, InputID: uuid.NewSHA1(relayedQuestionSpace, []byte(child.ID+"\x00"+message.ID)).String(),
		SenderSessionID: child.ID, Prompt: prompt, RequestedDelivery: store.DeliveryBoundary,
	}
	if target.Queued() {
		s.queueItemSignal(ctx, target, item, "")
		return
	}
	s.admitChildSignal(ctx, child, target, item)
}

// relayHelperQuestionsOnResume relays to a resumed assistant the questions
// its helpers raised while it was stopped and that still wait for an answer.
// Each is one inbox item keyed by its question, so a question relayed before
// is not relayed twice, and an answered or superseded one is not relayed.
func (s *Server) relayHelperQuestionsOnResume(ctx context.Context, agent store.PersonalAgent) {
	items, err := s.store.ListVisiblePendingItems(ctx, agent.UserID, []string{store.PendingOpen}, "", 500)
	if err != nil {
		log.Printf("assistant %s: list helper questions on resume: %v", agent.ID, err)
		return
	}
	for _, item := range items {
		if item.AssistantID != agent.ID || item.Source != store.PendingSourceQuestion || item.MessageID == "" || item.SessionID == "" {
			continue
		}
		child, err := s.store.GetAgentSessionSummary(ctx, item.SessionID)
		if err != nil {
			continue
		}
		if event, found := s.questionEvent(ctx, child, item.MessageID); found {
			s.relayChildQuestion(ctx, event)
		}
	}
}

// questionEvent is the recorded event that carries a child's question, if it
// is among the child's latest events.
func (s *Server) questionEvent(ctx context.Context, child store.AgentSession, messageID string) (store.AgentSessionEvent, bool) {
	events, _, err := s.store.AgentSessionEventWindow(ctx, child.ID, "", 200)
	if err != nil {
		return store.AgentSessionEvent{}, false
	}
	for _, event := range events {
		if event.Message != nil && event.Message.ID == messageID && len(event.Message.Questions) > 0 {
			return event, true
		}
	}
	return store.AgentSessionEvent{}, false
}

// relayedQuestionText is what the parent reads: who asks, what, and how
// to answer.
func (s *Server) relayedQuestionText(child store.AgentSession, target assistant.SignalTarget, message store.TranscriptMessage) string {
	var builder strings.Builder
	approval := len(message.Questions) == 1 && message.Questions[0].Approval
	relation := signalRelation(child, target)
	switch {
	case approval:
		fmt.Fprintf(&builder, "%s session %s (%q), %s, asks for approval and waits; its turn ended.\n", sessions.QuestionRelayPrefix, child.ID, child.Title, relation)
	case message.Delivery == questionDeliveryAsync:
		fmt.Fprintf(&builder, "%s session %s (%q), %s, asks and keeps working; it reads the answer at its next step.\n", sessions.QuestionRelayPrefix, child.ID, child.Title, relation)
	default:
		fmt.Fprintf(&builder, "%s session %s (%q), %s, asks and waits for the answer; its turn ended.\n", sessions.QuestionRelayPrefix, child.ID, child.Title, relation)
	}
	if link := s.assistant.SessionURL(child); link != "" {
		fmt.Fprintf(&builder, "Link: %s\n", link)
	}
	for index, question := range message.Questions {
		builder.WriteString("\n")
		if len(message.Questions) > 1 {
			fmt.Fprintf(&builder, "%d. ", index+1)
		}
		if question.Header != "" {
			fmt.Fprintf(&builder, "[%s] ", question.Header)
		}
		builder.WriteString(strings.TrimSpace(question.Title))
		builder.WriteString("\n")
		if detail := strings.TrimSpace(question.Detail); detail != "" {
			fmt.Fprintf(&builder, "\n%s\n\n", textcut.Excerpt(detail, relayedQuestionDetailLimit))
		}
		for at, option := range question.Options {
			fmt.Fprintf(&builder, "   - %s", option)
			if at < len(question.Descriptions) && strings.TrimSpace(question.Descriptions[at]) != "" {
				fmt.Fprintf(&builder, ": %s", strings.TrimSpace(question.Descriptions[at]))
			}
			builder.WriteString("\n")
		}
	}
	builder.WriteString("\n")
	if approval {
		fmt.Fprintf(&builder, "Answer with send_message to %s: \"Approve\" approves; any other text denies, with that text as the reason.", child.ID)
	} else {
		fmt.Fprintf(&builder, "Answer with send_message to %s: your plain text is the answer", child.ID)
		if len(message.Questions) > 1 {
			builder.WriteString(" (answer each numbered question in it)")
		}
		builder.WriteString(".")
	}
	builder.WriteString("\n")
	return builder.String()
}

// waitingQuestion is the child's latest question still waiting for an
// answer, if any: one recorded since the child's latest input (its turn may
// still be ending when the parent answers).
func (s *Server) waitingQuestion(ctx context.Context, child store.AgentSession) (store.TranscriptMessage, bool) {
	events, _, err := s.store.AgentSessionEventWindow(ctx, child.ID, "", sessions.QuestionEventWindow)
	if err != nil {
		return store.TranscriptMessage{}, false
	}
	return sessions.WaitingQuestion(events, child.Input)
}

// questionAnswered reports whether an answer naming the question reached the
// child: the person's in its chat, or its creator's.
func (s *Server) questionAnswered(ctx context.Context, child store.AgentSession, message store.TranscriptMessage) bool {
	events, _, err := s.store.AgentSessionEventWindow(ctx, child.ID, "", 200)
	if err != nil {
		return false
	}
	itemID := nativeQuestionID(message.ID)
	for _, event := range events {
		if event.Label == store.EventLabelSteeredIntoTurn && strings.Contains(event.Detail, agentQuestionReplyOpen) && strings.Contains(event.Detail, itemID) {
			return true
		}
	}
	return false
}

// nativeQuestionID is the runtime's id of a question item (its message id
// without the path a Foundry id carries).
func nativeQuestionID(messageID string) string {
	if at := strings.LastIndex(messageID, "/"); at >= 0 {
		return messageID[at+1:]
	}
	return messageID
}

// answerWaitingQuestion turns a parent's (or follower's) plain message to a child waiting
// on a question into the answer to it (the envelope a person's answer
// card sends), so the child's runtime and chat read it as the answer. A
// message already in that envelope, or to a child that waits on nothing,
// stays as it is. With several questions the whole text answers the first.
func (s *Server) answerWaitingQuestion(ctx context.Context, sender string, child store.AgentSession, prompt string) string {
	text := strings.TrimSpace(prompt)
	if sender == "" || text == "" || strings.Contains(text, agentQuestionReplyOpen) {
		return prompt
	}
	// Its creator answers, or the session its questions reach (a holder of
	// its item, the assistant's conversation).
	if sender != child.ParentSessionID && sender != s.assistant.SignalTarget(ctx, child, child.ParentSessionID).SessionID {
		return prompt
	}
	message, waiting := s.waitingQuestion(ctx, child)
	if !waiting {
		return prompt
	}
	return agentQuestionReplyText(message.ID, message.Questions[0].Title, text)
}

const (
	agentQuestionReplyOpen  = sessions.QuestionReplyOpen
	agentQuestionReplyClose = "</send_user_message_question_reply>"
)

// agentQuestionReplyText is the answer to the first question of item
// itemID, in the envelope of @bd777/foundry-protocol agentQuestionReplyText.
func agentQuestionReplyText(itemID, question, answer string) string {
	target, _ := json.Marshal([]any{"request_user_input_async", nativeQuestionID(itemID), 0})
	entries, _ := json.Marshal([]map[string]string{{"questionItemId": string(target), "question": question, "answer": answer}})
	return agentQuestionReplyOpen + "\n" + string(entries) + "\n" + agentQuestionReplyClose + "\n"
}

// questionRef is one question of a helper's item: the item of its message and
// the question's title.
type questionRef struct {
	itemID   string
	question string
}

// agentQuestionNoAnswerText gives each question no answer, and says why: the
// reply envelope of agentQuestionReplyText, one entry per question, each marked
// noAnswer with the reason. The Worker applies it at once, as it does an
// answer, and the helper reads that its question will not be answered.
func agentQuestionNoAnswerText(reason string, questions []questionRef) (string, error) {
	entries := make([]map[string]any, 0, len(questions))
	for _, question := range questions {
		target, err := json.Marshal([]any{"request_user_input_async", nativeQuestionID(question.itemID), 0})
		if err != nil {
			return "", fmt.Errorf("encode question %s: %w", question.itemID, err)
		}
		entries = append(entries, map[string]any{"questionItemId": string(target), "question": question.question, "noAnswer": true, "reason": reason})
	}
	raw, err := json.Marshal(entries)
	if err != nil {
		return "", fmt.Errorf("encode the no-answer reply: %w", err)
	}
	return agentQuestionReplyOpen + "\n" + string(raw) + "\n" + agentQuestionReplyClose + "\n", nil
}

// childQuestionReactions relays a child's question to its parent as soon
// as it is recorded.
type childQuestionReactions struct{ s *Server }

func (r childQuestionReactions) SessionEventRecorded(ctx context.Context, event store.AgentSessionEvent) {
	r.s.relayChildQuestion(ctx, event)
}

var _ sessions.EventObserver = childQuestionReactions{}
