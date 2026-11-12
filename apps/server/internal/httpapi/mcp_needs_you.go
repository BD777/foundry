package httpapi

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"github.com/foundry-dev/foundry/apps/server/internal/textcut"
)

// needs_you (docs/assistant-orchestration.md §h): the assistant reads the
// person's one list of what waits for them, hands its own helpers' items to
// the person with a note, and closes those it handled another way. Only a
// personal_agent session lists the tool.

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
	case "resolve":
	default:
		return "", &statusError{http.StatusBadRequest, fmt.Errorf("op is list, hand_over or resolve")}
	}
	if (itemID == "") == (sessionID == "") {
		return "", &statusError{http.StatusBadRequest, fmt.Errorf("name exactly one of itemId and sessionId")}
	}
	items, helper, err := s.needsYouTargets(ctx, scope.Agent, itemID, sessionID)
	if err != nil {
		return "", err
	}
	var changed []needsYouLine
	if op == "resolve" {
		for _, item := range items {
			resolved, err := s.store.SetPendingItemState(ctx, user, item.ID, store.PendingDone)
			if err != nil {
				return "", err
			}
			changed = append(changed, s.needsYouLineOf(ctx, resolved))
		}
		return encodeJSON(map[string]any{"resolved": changed})
	}
	if len(items) == 0 {
		// A helper that asked in its answer, without a question card.
		now := formatPendingTime(time.Now())
		item, _, err := s.store.RecordPendingItem(ctx, store.PendingItem{
			UserID: user, AssistantID: scope.Agent.ID, WorkspaceID: helper.WorkspaceID, SessionID: helper.ID,
			Source: store.PendingSourceQuestion, Rule: store.PendingRuleHandedOver,
			Key:   "handover:" + helper.ID + ":" + helper.Input.ID,
			Title: pendingTitle(note), Excerpt: textcut.Excerpt(note, pendingExcerptLimit),
			Context: pendingAnswerContext(helper.Response),
			Handler: store.PendingHandlerPerson, Note: note, HandedReason: store.PendingHandedByAssistant, HandedAt: now,
		})
		if err != nil {
			return "", err
		}
		return encodeJSON(map[string]any{"handedOver": []needsYouLine{s.needsYouLineOf(ctx, item)}})
	}
	for _, item := range items {
		handed, err := s.store.HandPendingItem(ctx, user, item.ID, store.PendingHandlerPerson, note, store.PendingHandedByAssistant)
		if err != nil {
			return "", err
		}
		changed = append(changed, s.needsYouLineOf(ctx, handed))
	}
	return encodeJSON(map[string]any{"handedOver": changed})
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
	open, err := s.store.ListPendingItems(ctx, user, []string{store.PendingOpen}, "", 500)
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
	agent, ok := s.assistant.HelperOf(ctx, session)
	return session, ok && agent.ID == assistant.ID
}

// needsYouList is op list: the open items, the assistant's first; another
// assistant's items are not listed.
func (s *Server) needsYouList(ctx context.Context, agent store.PersonalAgent) (string, error) {
	items, err := s.store.ListPendingItems(ctx, agent.UserID, []string{store.PendingOpen}, "", 200)
	if err != nil {
		return "", err
	}
	yours, persons := []needsYouLine{}, []needsYouLine{}
	for _, item := range items {
		if item.AssistantID != "" && item.AssistantID != agent.ID {
			continue
		}
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
