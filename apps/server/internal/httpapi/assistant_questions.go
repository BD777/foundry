package httpapi

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/foundry-dev/foundry/apps/server/internal/personalagent"
	"github.com/foundry-dev/foundry/apps/server/internal/personalagent/assistant"
	"github.com/foundry-dev/foundry/apps/server/internal/personalagent/flow"
	"github.com/foundry-dev/foundry/apps/server/internal/sessions"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"github.com/foundry-dev/foundry/apps/server/internal/textcut"
	"github.com/google/uuid"
)

// assistantQuestionSpace names the inbox ids of answers to assistant questions.
var assistantQuestionSpace = uuid.MustParse("9b1e4c2a-7f3d-4a58-8c6e-2d5f0a7b3e19")

// needs_you ask (docs/assistant-orchestration.md §h, DEV-293): the assistant
// asks the person a question only they can answer. It does not wait: the
// question is an item in the person's list, and their answer comes back to
// the conversation that asked as a Foundry message naming the question.

const (
	assistantQuestionOptionsMin = 2
	assistantQuestionOptionsMax = 4
	// assistantQuestionOptionLimit bounds one option's text, in characters.
	assistantQuestionOptionLimit = 80
)

// askNeedsYou records the question as an item for the person, from one of the
// assistant's own conversations (home or a message channel), the same scope as
// tell. The same open question from the same conversation stays one item.
func (s *Server) askNeedsYou(call mcpCall, scope assistant.Scope) (string, error) {
	ctx := call.r.Context()
	if mcpArgString(call.args, "itemId") != "" {
		return "", &statusError{http.StatusBadRequest, fmt.Errorf("ask takes a sessionId, not an itemId")}
	}
	question := strings.TrimSpace(mcpArgString(call.args, "question"))
	if question == "" || utf8.RuneCountInString(question) > needsYouNoteLimit {
		return "", &statusError{http.StatusBadRequest, fmt.Errorf("ask needs a question of 1 to %d characters", needsYouNoteLimit)}
	}
	options, err := assistantQuestionOptions(mcpArgList(call.args, "options"))
	if err != nil {
		return "", &statusError{http.StatusBadRequest, err}
	}
	target := strings.TrimSpace(mcpArgString(call.args, "sessionId"))
	if target == "" {
		target = scope.SessionID
	}
	if target == "" {
		return "", &statusError{http.StatusBadRequest, fmt.Errorf("ask needs the conversation that asks")}
	}
	session, err := s.store.GetAgentSessionSummary(ctx, target)
	if err != nil {
		return "", &statusError{http.StatusNotFound, fmt.Errorf("session %s not found", target)}
	}
	agent, ok := s.assistant.Conversation(ctx, session)
	if !ok || agent.ID != scope.Agent.ID {
		return "", &statusError{http.StatusForbidden, fmt.Errorf("only one of this assistant's own conversations can ask the person")}
	}
	item, _, err := s.recordPendingItem(ctx, store.PendingItem{
		UserID: scope.Agent.UserID, AssistantID: agent.ID, WorkspaceID: session.WorkspaceID, SessionID: session.ID,
		Source: store.PendingSourceAssistantQuestion,
		Key:    flow.Key("assistant_question", scope.Agent.UserID, session.ID, question),
		Title:  pendingTitle(question), Excerpt: textcut.Excerpt(question, pendingExcerptLimit),
		Options: options, Handler: store.PendingHandlerPerson,
	})
	if err != nil {
		return "", err
	}
	return encodeJSON(map[string]any{"asked": s.needsYouLineOf(ctx, item)})
}

// assistantQuestionOptions checks ask's options: none, or 2 to 4 short ones.
func assistantQuestionOptions(raw []string) ([]string, error) {
	if len(raw) == 0 {
		return nil, nil
	}
	if len(raw) < assistantQuestionOptionsMin || len(raw) > assistantQuestionOptionsMax {
		return nil, fmt.Errorf("ask takes %d to %d options", assistantQuestionOptionsMin, assistantQuestionOptionsMax)
	}
	options := make([]string, 0, len(raw))
	for _, option := range raw {
		option = strings.TrimSpace(option)
		if option == "" || utf8.RuneCountInString(option) > assistantQuestionOptionLimit {
			return nil, fmt.Errorf("each option is 1 to %d characters", assistantQuestionOptionLimit)
		}
		options = append(options, option)
	}
	return options, nil
}

// assistantQuestionOp is hand_over or resolve on an item the assistant asked
// itself. The person answers such an item, so hand_over has nothing to do;
// resolve withdraws the question while nobody has answered it.
func (s *Server) assistantQuestionOp(call mcpCall, scope assistant.Scope, op string, item store.PendingItem) (string, error) {
	ctx := call.r.Context()
	if item.AssistantID != scope.Agent.ID {
		return "", &statusError{http.StatusForbidden, fmt.Errorf("only the questions this assistant asked")}
	}
	if op != "resolve" {
		return "", &statusError{http.StatusBadRequest, fmt.Errorf("the person answers a question you asked: resolve it to withdraw it")}
	}
	if item.State != store.PendingOpen {
		return "", &statusError{http.StatusConflict, fmt.Errorf("item %s is %s, no longer open", item.ID, item.State)}
	}
	if mcpArgString(call.args, "answer") != "" || mcpArgString(call.args, "reason") != "" {
		return "", &statusError{http.StatusBadRequest, fmt.Errorf("a question you asked takes no answer or reason: resolve it alone to withdraw it")}
	}
	withdrawn, err := s.store.ResolvePendingItem(ctx, item.UserID, item.ID, store.PendingDone, store.PendingOutcomeWithdrawn, store.PendingAnswer{})
	if err != nil {
		return "", err
	}
	return encodeJSON(map[string]any{"withdrawn": s.needsYouLineOf(ctx, withdrawn)})
}

// answerAssistantQuestion gives the person's answer to the conversation that
// asked. The answer goes in as the person's own words, framed by Foundry as
// a message that names the question (personalagent.AnswerFrame). It starts a
// turn when the conversation is idle and is delivered at the next boundary when
// it runs, waiting for the device like any queued message. The inbox needs a
// sending session: the conversation itself sends it, and InputSource says it is
// the person's answer relayed by Foundry. The inbox id is fixed by the item, so
// a repeated answer delivers nothing twice. The item then closes as answered by
// the person.
func (s *Server) answerAssistantQuestion(ctx context.Context, item store.PendingItem, answer string) (store.PendingItem, error) {
	admission, err := s.store.AdmitSessionInboxItem(ctx, store.SessionInboxItem{
		SessionID:         item.SessionID,
		SenderSessionID:   item.SessionID,
		InputID:           uuid.NewSHA1(assistantQuestionSpace, []byte(item.ID)).String(),
		Prompt:            personalagent.AnswerFrame(item.Title, answer),
		RequestedDelivery: store.DeliveryBoundary,
		InputSource:       &store.AgentSessionInputSource{Kind: "foundry_notice", NoticeKind: store.NoticeKindQuestionAnswer},
	}, store.SessionInboxRules{Now: time.Now().UTC(), DedupWindow: sessions.InboxDedupWindow})
	if err != nil {
		return store.PendingItem{}, fmt.Errorf("deliver the answer to session %s: %w", item.SessionID, err)
	}
	if !admission.Duplicate {
		s.sessionService.WakeInbox()
	}
	return s.store.ResolvePendingItem(ctx, item.UserID, item.ID, store.PendingDone, store.PendingOutcomePersonAnswered,
		store.PendingAnswer{Text: answer, By: store.PendingAnsweredByPerson})
}

// handleAnswerPendingItem is the person's answer to one of their items, the
// one answer path (docs/assistant-orchestration.md §h). An assistant's question
// goes to its conversation; other kinds are answered in their conversation for
// now. The request key makes a repeated answer replay the first.
func (s *Server) handleAnswerPendingItem(w http.ResponseWriter, r *http.Request) {
	user := accountID(r)
	if user == "" {
		writeError(w, http.StatusForbidden, "pending items belong to a signed-in account")
		return
	}
	var input store.PendingItemAnswerInput
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	text := strings.TrimSpace(input.Text)
	if text == "" {
		writeError(w, http.StatusBadRequest, "an answer needs text")
		return
	}
	ctx := r.Context()
	id := r.PathValue("id")
	idempotent, handled := s.beginIdempotentRequest(w, r, "pending-items/answer:"+id, input, http.StatusOK)
	if handled {
		return
	}
	defer idempotent.release()
	item, err := s.store.GetPendingItem(ctx, user, id)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "pending item not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "read pending item")
		return
	}
	if item.State != store.PendingOpen {
		writeError(w, http.StatusConflict, "this item is already "+item.State)
		return
	}
	var answered store.PendingItem
	switch item.Source {
	case store.PendingSourceAssistantQuestion:
		answered, err = s.answerAssistantQuestion(ctx, item, text)
	case store.PendingSourceItemWait:
		answered, err = s.answerItemWait(ctx, item, text)
		if errors.Is(err, errItemWaitGone) {
			writeError(w, http.StatusConflict, err.Error())
			return
		}
	default:
		writeError(w, http.StatusConflict, "answer this item in its conversation")
		return
	}
	if err != nil {
		log.Printf("answer pending item %s: %v", id, err)
		writeError(w, http.StatusInternalServerError, "the answer could not be delivered; try again")
		return
	}
	idempotent.record(ctx, answered)
	writeJSON(w, http.StatusOK, answered)
}

// isAssistantQuestionAnswer reports whether an input is the answer to an
// assistant question. Its turn settles nothing else: the person's own
// questions in that conversation stay open.
func isAssistantQuestionAnswer(source *store.AgentSessionInputSource) bool {
	return source != nil && source.Kind == "foundry_notice" && source.NoticeKind == store.NoticeKindQuestionAnswer
}
