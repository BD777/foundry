package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/foundry-dev/foundry/apps/server/internal/personalagent/assistant"
	"github.com/foundry-dev/foundry/apps/server/internal/personalagent/flow"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"github.com/foundry-dev/foundry/apps/server/internal/textcut"
)

// needs_you (docs/assistant-orchestration.md §h): the assistant reads the
// person's one list of what waits for them, hands its own helpers' items to
// the person with a note, asks the person a question it cannot settle (ask),
// and closes those it handled another way. Only a personal_agent session lists
// the tool.

// needsYouNoteLimit bounds what the assistant writes for the person.
const needsYouNoteLimit = 600

// needsYouLine is one item as the assistant reads it.
type needsYouLine struct {
	ID        string   `json:"id"`
	Handler   string   `json:"handler"`
	Source    string   `json:"source"`
	Title     string   `json:"title"`
	Excerpt   string   `json:"excerpt,omitempty"`
	Options   []string `json:"options,omitempty"`
	Note      string   `json:"note,omitempty"`
	Project   string   `json:"project,omitempty"`
	SessionID string   `json:"sessionId,omitempty"`
	Link      string   `json:"link,omitempty"`
	Since     string   `json:"since"`
}

func (s *Server) needsYouForMCP(call mcpCall) (string, error) {
	ctx := call.r.Context()
	scope, err := s.paScope(ctx, call.actor)
	if err != nil {
		return "", err
	}
	user := scope.Agent.UserID
	op := mcpArgString(call.args, "op")
	itemID := strings.TrimSpace(mcpArgString(call.args, "itemId"))
	sessionID := strings.TrimSpace(mcpArgString(call.args, "sessionId"))
	note := strings.TrimSpace(mcpArgString(call.args, "note"))
	switch op {
	case "list":
		return s.needsYouList(ctx, scope.Agent)
	case "hand_over":
		if note == "" || utf8.RuneCountInString(note) > needsYouNoteLimit {
			return "", &statusError{http.StatusBadRequest, fmt.Errorf("hand_over needs a note for the person of 1 to %d characters", needsYouNoteLimit)}
		}
	case "tell":
		if note == "" || utf8.RuneCountInString(note) > needsYouNoteLimit {
			return "", &statusError{http.StatusBadRequest, fmt.Errorf("tell needs a note for the person of 1 to %d characters", needsYouNoteLimit)}
		}
		if itemID != "" {
			return "", &statusError{http.StatusBadRequest, fmt.Errorf("tell takes a sessionId, not an itemId")}
		}
		target := sessionID
		if target == "" {
			target = scope.SessionID
		}
		if target == "" {
			return "", &statusError{http.StatusBadRequest, fmt.Errorf("tell needs the session with the news")}
		}
		session, err := s.store.GetAgentSessionSummary(ctx, target)
		if err != nil {
			return "", &statusError{http.StatusNotFound, fmt.Errorf("session %s not found", target)}
		}
		agent, ok := s.assistant.Conversation(ctx, session)
		if !ok || agent.ID != scope.Agent.ID {
			return "", &statusError{http.StatusForbidden, fmt.Errorf("only one of this assistant's own conversations can tell the person")}
		}
		item, changed, err := s.store.RecordPendingItem(ctx, store.PendingItem{
			UserID: user, AssistantID: agent.ID, WorkspaceID: session.WorkspaceID, SessionID: session.ID,
			Source: store.PendingSourceNotice, Key: flow.Key("notice", user, session.ID, note),
			Title: pendingTitle(note), Excerpt: textcut.Excerpt(note, pendingExcerptLimit),
			Handler: store.PendingHandlerPerson, Note: note,
			HandedReason: store.PendingHandedByAssistant, HandedAt: formatPendingTime(time.Now()),
		})
		if err != nil {
			return "", err
		}
		// One Feishu post per new note; a repeat of the same note only
		// refreshes its open item.
		if changed {
			if _, err := s.assistant.TellPerson(ctx, agent, session, note); err != nil {
				log.Printf("personal agent %s: tell the person: %v", agent.ID, err)
			}
		}
		return encodeJSON(map[string]any{"told": s.needsYouLineOf(ctx, item)})
	case "ask":
		return s.askNeedsYou(call, scope)
	case "resolve":
	default:
		return "", &statusError{http.StatusBadRequest, fmt.Errorf("op is list, hand_over, tell, ask or resolve")}
	}
	if itemID != "" && (op == "hand_over" || op == "resolve") {
		if item, err := s.store.GetPendingItem(ctx, user, itemID); err == nil &&
			(item.Source == store.PendingSourceAssistantQuestion || s.askedInConversation(ctx, scope.Agent, item)) {
			return s.assistantQuestionOp(call, scope, op, item)
		}
	}
	if (itemID == "") == (sessionID == "") {
		return "", &statusError{http.StatusBadRequest, fmt.Errorf("name exactly one of itemId and sessionId")}
	}
	items, helper, err := s.needsYouTargets(ctx, scope.Agent, itemID, sessionID)
	if err != nil {
		return "", err
	}
	if op == "resolve" {
		return s.resolveNeedsYou(call, scope, helper, items)
	}
	var changed []needsYouLine
	if len(items) == 0 {
		// A helper that asked in its answer, without a question card.
		item, err := s.handOverWithoutCard(ctx, scope.Agent, helper, scope.Turn.ID, note, s.noticeBotReaches)
		if err != nil {
			return "", err
		}
		return encodeJSON(map[string]any{"handedOver": []needsYouLine{s.needsYouLineOf(ctx, item)}})
	}
	for _, item := range items {
		handed, err := s.handPendingItem(ctx, user, item.ID, store.PendingHandlerPerson, note, store.PendingHandedByAssistant, store.PendingOutcomeHandedOver, scope.Turn.ID)
		if err != nil {
			return "", err
		}
		changed = append(changed, s.needsYouLineOf(ctx, handed))
	}
	return encodeJSON(map[string]any{"handedOver": changed})
}

// handOverWithoutCard puts a helper's question, which it asked in its answer
// with no question card, in needs-you as handed to the person. It notifies the
// person as any hand-over does: the item is recorded through the notice queue,
// not around it, so a sink that takes hand-overs hears of it.
func (s *Server) handOverWithoutCard(ctx context.Context, agent store.PersonalAgent, helper store.AgentSession, turnID, note string, bot noticeBotLookup) (store.PendingItem, error) {
	now := formatPendingTime(time.Now())
	item, changed, err := s.store.RecordPendingItem(ctx, store.PendingItem{
		UserID: agent.UserID, AssistantID: agent.ID, WorkspaceID: helper.WorkspaceID, SessionID: helper.ID,
		Source: store.PendingSourceQuestion, Rule: store.PendingRuleHandedOver,
		Key:   "handover:" + helper.ID + ":" + helper.Input.ID,
		Title: pendingTitle(note), Excerpt: textcut.Excerpt(note, pendingExcerptLimit),
		Context: pendingAnswerContext(helper.Response),
		Handler: store.PendingHandlerPerson, Note: note, HandedReason: store.PendingHandedByAssistant, HandedAt: now,
		HandedInputID: turnID, Outcome: store.PendingOutcomeHandedOver,
	})
	if err == nil && changed {
		s.queueItemNotice(ctx, item, bot)
	}
	return item, err
}

// resolveNeedsYou closes the items of one of the assistant's helpers. A helper
// waiting on one of them gets what the item needs: its answer (answer, which
// goes exactly as send_message sends an answer) or the reason it gets none
// (reason, the same reply envelope marked noAnswer). An item closed without
// an answer is assistant_closed, with the reason it was closed for.
func (s *Server) resolveNeedsYou(call mcpCall, scope assistant.Scope, helper store.AgentSession, items []store.PendingItem) (string, error) {
	ctx := call.r.Context()
	answer := strings.TrimSpace(mcpArgString(call.args, "answer"))
	reason := strings.TrimSpace(mcpArgString(call.args, "reason"))
	if answer != "" && reason != "" {
		return "", &statusError{http.StatusBadRequest, fmt.Errorf("resolve takes an answer or a reason, not both")}
	}
	if utf8.RuneCountInString(reason) > needsYouNoteLimit {
		return "", &statusError{http.StatusBadRequest, fmt.Errorf("reason must be 1 to %d characters", needsYouNoteLimit)}
	}
	waiting := waitingItems(items)
	switch {
	case len(waiting) > 0 && answer == "" && reason == "":
		return "", &statusError{http.StatusBadRequest, fmt.Errorf("the helper waits for an answer to this item: resolve it with answer (sent to the helper) or with reason (why it gets none)")}
	case len(waiting) == 0 && (answer != "" || reason != ""):
		return "", &statusError{http.StatusBadRequest, fmt.Errorf("nothing waits for an answer to this item: resolve it without answer or reason")}
	}
	switch {
	case answer != "":
		prompt := answer
		if mcpArgString(call.args, "itemId") != "" {
			prompt = s.answerToItem(ctx, helper, waiting[0], answer)
		}
		args, err := mcpStringArgs(map[string]string{"sessionId": helper.ID, "prompt": prompt})
		if err != nil {
			return "", err
		}
		if _, err := s.sendMessageForMCP(mcpCall{r: call.r, actor: call.actor, args: args}); err != nil {
			return "", err
		}
	case reason != "":
		prompt, err := s.noAnswerPrompt(ctx, helper, waiting, reason)
		if err != nil {
			return "", err
		}
		args, err := mcpStringArgs(map[string]string{"sessionId": helper.ID, "prompt": prompt})
		if err != nil {
			return "", err
		}
		if _, err := s.sendMessageForMCP(mcpCall{r: call.r, actor: call.actor, args: args}); err != nil {
			return "", err
		}
	}
	var closedWith store.PendingAnswer
	if answer != "" {
		closedWith = store.PendingAnswer{Text: answer, By: store.PendingAnsweredByAssistant}
	}
	var resolved []needsYouLine
	for _, item := range items {
		var closed store.PendingItem
		var err error
		if answer != "" {
			closed, err = s.store.ResolvePendingItem(ctx, scope.Agent.UserID, item.ID, store.PendingDone, store.PendingOutcomeAssistantAnswered, closedWith)
		} else {
			// Closed without an answer: the reason (maybe empty) is what the
			// person sees, never "the assistant answered".
			closed, err = s.store.ClosePendingItem(ctx, scope.Agent.UserID, item.ID, reason)
		}
		if err != nil {
			return "", err
		}
		resolved = append(resolved, s.needsYouLineOf(ctx, closed))
	}
	return encodeJSON(map[string]any{"resolved": resolved})
}

// answerToItem is the reply envelope that answers an item's question, so the
// answer lands on that question and not on the helper's newest one.
func (s *Server) answerToItem(ctx context.Context, helper store.AgentSession, item store.PendingItem, answer string) string {
	return agentQuestionReplyText(item.MessageID, s.questionOf(ctx, helper, item), answer)
}

// questionOf is the question an item asks: its title in the helper's event,
// else the item's own title.
func (s *Server) questionOf(ctx context.Context, helper store.AgentSession, item store.PendingItem) string {
	if event, found := s.questionEvent(ctx, helper, item.MessageID); found && len(event.Message.Questions) > 0 {
		return event.Message.Questions[0].Title
	}
	return item.Title
}

// noAnswerPrompt is the reply that tells the helper its waiting questions
// get no answer, and why.
func (s *Server) noAnswerPrompt(ctx context.Context, helper store.AgentSession, waiting []store.PendingItem, reason string) (string, error) {
	questions := make([]questionRef, 0, len(waiting))
	for _, item := range waiting {
		questions = append(questions, questionRef{itemID: item.MessageID, question: s.questionOf(ctx, helper, item)})
	}
	return agentQuestionNoAnswerText(reason, questions)
}

// waitingItems are the items a helper waits on for an answer: its open
// questions and approvals (an open item is one it has had no answer to).
func waitingItems(items []store.PendingItem) []store.PendingItem {
	var out []store.PendingItem
	for _, item := range items {
		if item.Source == store.PendingSourceQuestion {
			out = append(out, item)
		}
	}
	return out
}

// mcpStringArgs encodes text arguments as the MCP call arguments carry them.
func mcpStringArgs(values map[string]string) (map[string]json.RawMessage, error) {
	args := make(map[string]json.RawMessage, len(values))
	for key, value := range values {
		raw, err := json.Marshal(value)
		if err != nil {
			return nil, err
		}
		args[key] = raw
	}
	return args, nil
}

// needsYouTargets are the open items an op names: the item, or the open
// items of the helper session; either must be a helper of the person's
// assistant. helper is that session.
func (s *Server) needsYouTargets(ctx context.Context, agent store.PersonalAgent, itemID, sessionID string) ([]store.PendingItem, store.AgentSession, error) {
	user := agent.UserID
	notYours := &statusError{http.StatusForbidden, fmt.Errorf("only items of your own helpers: the person handles the others in their list")}
	if itemID != "" {
		item, err := s.store.GetPendingItem(ctx, user, itemID)
		if err != nil {
			return nil, store.AgentSession{}, &statusError{http.StatusNotFound, fmt.Errorf("item %s not found", itemID)}
		}
		if item.State != store.PendingOpen {
			return nil, store.AgentSession{}, &statusError{http.StatusConflict, fmt.Errorf("item %s is %s, no longer open", itemID, item.State)}
		}
		sessionID = item.SessionID
		helper, ok := s.needsYouHelper(ctx, agent, sessionID)
		if !ok {
			return nil, store.AgentSession{}, notYours
		}
		return []store.PendingItem{item}, helper, nil
	}
	helper, ok := s.needsYouHelper(ctx, agent, sessionID)
	if !ok {
		return nil, store.AgentSession{}, notYours
	}
	open, err := s.assistant.PendingFor(ctx, agent, 500)
	if err != nil {
		return nil, store.AgentSession{}, err
	}
	var items []store.PendingItem
	for _, item := range open {
		if item.SessionID == helper.ID {
			items = append(items, item)
		}
	}
	return items, helper, nil
}

// needsYouHelper is sessionID when it is a helper of this assistant.
func (s *Server) needsYouHelper(ctx context.Context, assistant store.PersonalAgent, sessionID string) (store.AgentSession, bool) {
	if sessionID == "" {
		return store.AgentSession{}, false
	}
	session, err := s.store.GetAgentSessionSummary(ctx, sessionID)
	if err != nil {
		return store.AgentSession{}, false
	}
	// A message channel's session (DEV-203) is the assistant's own: what
	// it hands over goes straight to the person.
	if s.channelSessionOfAssistant(ctx, assistant, session.ID) {
		return session, true
	}
	agent, ok := s.assistant.HelperOf(ctx, session)
	return session, ok && agent.ID == assistant.ID
}

// needsYouList is op list: the open items this assistant may see, its own
// first.
func (s *Server) needsYouList(ctx context.Context, agent store.PersonalAgent) (string, error) {
	items, err := s.assistant.PendingFor(ctx, agent, 200)
	if err != nil {
		return "", err
	}
	yours, persons := []needsYouLine{}, []needsYouLine{}
	for _, item := range items {
		line := s.needsYouLineOf(ctx, item)
		if line.Handler == store.PendingHandlerAssistant {
			yours = append(yours, line)
		} else {
			persons = append(persons, line)
		}
	}
	return encodeJSON(map[string]any{"yours": yours, "theirs": persons})
}

func (s *Server) needsYouLineOf(ctx context.Context, item store.PendingItem) needsYouLine {
	line := needsYouLine{
		ID: item.ID, Handler: store.PendingHandledBy(item), Source: item.Source, Title: item.Title,
		Options: item.Options, Note: item.Note, SessionID: item.SessionID, Since: item.CreatedAt,
	}
	if excerpt := strings.TrimSpace(item.Excerpt); excerpt != item.Title {
		line.Excerpt = textcut.Excerpt(excerpt, 400)
	}
	if workspace, err := s.store.GetWorkspace(ctx, item.WorkspaceID); err == nil {
		line.Project = workspace.Name
	}
	if item.SessionID != "" {
		if session, err := s.store.GetAgentSessionSummary(ctx, item.SessionID); err == nil {
			line.Link = s.assistant.SessionURL(session)
		}
	}
	return line
}
