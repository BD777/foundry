package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"strings"
	"time"

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
	// for the next message (TranscriptMessage.delivery).
	questionDeliveryNextTurn = "next_turn"
	// questionChainLimit bounds the walk up nested orchestrators.
	questionChainLimit = 8
	// relayedQuestionDetailLimit is how much of a plan a relay carries.
	relayedQuestionDetailLimit = 4000
)

// relayedQuestionSpace names the inbox ids of relayed questions.
var relayedQuestionSpace = uuid.MustParse("3c0f7b8e-5d21-4f6a-9b3e-7a4c2d1e8f60")

// questionsTo is who answers the session's prompts ("person", "parent" or
// "": nobody) and, for "parent", the live parent that relays them ("" when
// the parent is gone: the question then waits in the child's own chat).
func (s *Server) questionsTo(ctx context.Context, session store.AgentSession) (string, string) {
	return questionsTo(ctx, s.store, session, 0)
}

// sessionSummaries reads the sessions a chain of parents walks.
type sessionSummaries interface {
	GetAgentSessionSummary(ctx context.Context, id string) (store.AgentSession, error)
}

func questionsTo(ctx context.Context, summaries sessionSummaries, session store.AgentSession, depth int) (string, string) {
	if session.IssueID != "" || session.Role != "" || depth > questionChainLimit {
		return "", ""
	}
	if session.ParentSessionID == "" {
		if session.Source == "" || session.Source == store.SessionSourceChat {
			return questionsToPerson, ""
		}
		return "", ""
	}
	// Only a session an agent created answers to it: a scheduled run
	// (source chat) and a verifier answer to their own owners.
	if session.Source != store.SessionSourceAgent {
		return "", ""
	}
	parent, err := summaries.GetAgentSessionSummary(ctx, session.ParentSessionID)
	if err != nil || parent.ArchivedAt != "" || parent.Status == "canceled" {
		// No live parent: the person answers in the child's own chat.
		return questionsToParent, ""
	}
	if to, _ := questionsTo(ctx, summaries, parent, depth+1); to == "" {
		return "", ""
	}
	return questionsToParent, parent.ID
}

// relayChildQuestion puts a child's question, recorded as waiting for its
// next message, in its parent's inbox at once.
func (s *Server) relayChildQuestion(ctx context.Context, event store.AgentSessionEvent) {
	message := event.Message
	if message == nil || len(message.Questions) == 0 || message.Delivery != questionDeliveryNextTurn {
		return
	}
	child, err := s.store.GetAgentSessionSummary(ctx, event.SessionID)
	if err != nil {
		return
	}
	to, parentID := s.questionsTo(ctx, child)
	if to != questionsToParent || parentID == "" {
		log.Printf("session question kept in its chat: session=%s message=%s reason=%q", child.ID, message.ID, "no live parent answers it")
		return
	}
	item := store.SessionInboxItem{
		SessionID: parentID, InputID: uuid.NewSHA1(relayedQuestionSpace, []byte(child.ID+"\x00"+message.ID)).String(),
		SenderSessionID: child.ID, Prompt: s.relayedQuestionText(child, *message), RequestedDelivery: store.DeliveryBoundary,
	}
	s.admitChildReport(ctx, child, item)
}

// relayedQuestionText is what the parent reads: who asks, what, and how
// to answer.
func (s *Server) relayedQuestionText(child store.AgentSession, message store.TranscriptMessage) string {
	var builder strings.Builder
	approval := len(message.Questions) == 1 && message.Questions[0].Approval
	if approval {
		fmt.Fprintf(&builder, "Foundry question: session %s (%q), which this session created, asks for approval and waits; its turn ended.\n", child.ID, child.Title)
	} else {
		fmt.Fprintf(&builder, "Foundry question: session %s (%q), which this session created, asks and waits for the answer; its turn ended.\n", child.ID, child.Title)
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
	builder.WriteString(" Answer it yourself when you know; otherwise ask your own person (your question tool) and pass on their answer.\n")
	return builder.String()
}

// waitingQuestion is the child's latest question still waiting for its
// next message, if any: one recorded since the child's latest input (its
// turn may still be ending when the parent answers).
func (s *Server) waitingQuestion(ctx context.Context, child store.AgentSession) (store.TranscriptMessage, bool) {
	events, _, err := s.store.AgentSessionEventWindow(ctx, child.ID, "", 200)
	if err != nil {
		return store.TranscriptMessage{}, false
	}
	started, _ := time.Parse(time.RFC3339Nano, child.Input.At)
	for index := len(events) - 1; index >= 0; index-- {
		event := events[index]
		if at, err := time.Parse(time.RFC3339Nano, event.At); err == nil && !started.IsZero() && at.Before(started) {
			break
		}
		// An answer steered in since: it waits no more.
		if event.Label == store.EventLabelSteeredIntoTurn && strings.Contains(event.Detail, agentQuestionReplyOpen) {
			break
		}
		if message := event.Message; message != nil && len(message.Questions) > 0 && message.Delivery == questionDeliveryNextTurn {
			return *message, true
		}
	}
	return store.TranscriptMessage{}, false
}

// answerWaitingQuestion turns a parent's plain message to a child waiting
// on a question into the answer to it (the envelope a person's answer
// card sends), so the child's runtime and chat read it as the answer. A
// message already in that envelope, or to a child that waits on nothing,
// stays as it is. With several questions the whole text answers the first.
func (s *Server) answerWaitingQuestion(ctx context.Context, sender string, child store.AgentSession, prompt string) string {
	text := strings.TrimSpace(prompt)
	if sender == "" || sender != child.ParentSessionID || text == "" || strings.Contains(text, agentQuestionReplyOpen) {
		return prompt
	}
	message, waiting := s.waitingQuestion(ctx, child)
	if !waiting {
		return prompt
	}
	return agentQuestionReplyText(message.ID, message.Questions[0].Title, text)
}

const (
	agentQuestionReplyOpen  = "<send_user_message_question_reply>"
	agentQuestionReplyClose = "</send_user_message_question_reply>"
)

// agentQuestionReplyText is the answer to the first question of item
// itemID, in the envelope of @bd777/foundry-protocol agentQuestionReplyText.
func agentQuestionReplyText(itemID, question, answer string) string {
	if at := strings.LastIndex(itemID, "/"); at >= 0 {
		itemID = itemID[at+1:]
	}
	target, _ := json.Marshal([]any{"request_user_input_async", itemID, 0})
	entries, _ := json.Marshal([]map[string]string{{"questionItemId": string(target), "question": question, "answer": answer}})
	return agentQuestionReplyOpen + "\n" + string(entries) + "\n" + agentQuestionReplyClose + "\n"
}

// childQuestionReactions relays a child's question to its parent as soon
// as it is recorded.
type childQuestionReactions struct{ s *Server }

func (r childQuestionReactions) SessionEventRecorded(ctx context.Context, event store.AgentSessionEvent) {
	r.s.relayChildQuestion(ctx, event)
}

var _ sessions.EventObserver = childQuestionReactions{}
