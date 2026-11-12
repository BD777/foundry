package assistant

import (
	"context"
	"log"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"github.com/foundry-dev/foundry/apps/server/internal/textcut"
)

// "Needs you" (docs/assistant-orchestration.md §h): one list of what waits
// for the person, each open item handled by the person or their assistant.
// The assistant handles its own helpers' items while it runs and its home
// computer is online; it answers or retries them, or hands them to the
// person with a note. Anything it cannot take goes to the person at once.

// HelperOf is the person's assistant when session is a helper it handed
// work to: a session its tasks follow, or one its conversation started.
// The assistant's own conversations are not helpers.
func (s *Service) HelperOf(ctx context.Context, session store.AgentSession) (store.PersonalAgent, bool) {
	if session.ParentSessionID == "" || session.CreatedByUserID == "" {
		return store.PersonalAgent{}, false
	}
	if agent, _, ok := s.TaskOf(ctx, session); ok {
		return agent, true
	}
	parent, err := s.store.GetAgentSessionSummary(ctx, session.ParentSessionID)
	if err != nil {
		return store.PersonalAgent{}, false
	}
	agent, ok := s.Conversation(ctx, parent)
	if !ok || agent.UserID != session.CreatedByUserID {
		return store.PersonalAgent{}, false
	}
	return agent, true
}

// Takes reports whether the assistant can handle items now: it runs and
// its home computer is online.
func (s *Service) Takes(agent store.PersonalAgent) bool {
	return agent.State == store.PersonalAgentActive && s.devices.Connected(agent.HomeDeviceID)
}

// Handler is who handles a new item of session: the assistant for a helper
// of a running, reachable assistant, else the person; and the assistant the
// helper works for ("" for none), which the item records either way.
func (s *Service) Handler(ctx context.Context, session store.AgentSession) (handler, assistantID string) {
	agent, ok := s.HelperOf(ctx, session)
	if !ok {
		return store.PendingHandlerPerson, ""
	}
	if s.Takes(agent) {
		return store.PendingHandlerAssistant, agent.ID
	}
	return store.PendingHandlerPerson, agent.ID
}

// HandOverAll hands every open item the assistant handles to the person,
// saying why (store.PendingHanded*). It answers how many.
func (s *Service) HandOverAll(ctx context.Context, agent store.PersonalAgent, reason string) int {
	userID := agent.UserID
	items, err := s.store.ListPendingItems(ctx, userID, []string{store.PendingOpen}, "", 500)
	if err != nil {
		log.Printf("personal agent %s: list items to hand over: %v", userID, err)
		return 0
	}
	handed := 0
	for _, item := range items {
		if store.PendingHandledBy(item) != store.PendingHandlerAssistant || item.AssistantID != agent.ID {
			continue
		}
		if _, err := s.store.HandPendingItem(ctx, userID, item.ID, store.PendingHandlerPerson, "", reason); err != nil {
			log.Printf("personal agent %s: hand over item %s: %v", userID, item.ID, err)
			continue
		}
		handed++
	}
	return handed
}

// helperStuckExcerptChars bounds what a stuck helper's item quotes.
const helperStuckExcerptChars = 600

// recordHelperStuck keeps a helper that cannot reach its model service or
// runs past the stuck limit as an item of the assistant's (of the person's
// when the assistant cannot take it); line is the notice the assistant
// reads.
func (s *Service) recordHelperStuck(ctx context.Context, agent store.PersonalAgent, task store.PersonalAgentTask, session store.AgentSession, line string) {
	handler := store.PendingHandlerPerson
	if s.Takes(agent) {
		handler = store.PendingHandlerAssistant
	}
	title := session.Title
	if title == "" {
		title = task.Title
	}
	item := store.PendingItem{
		UserID: agent.UserID, AssistantID: agent.ID, WorkspaceID: session.WorkspaceID, SessionID: session.ID,
		Source: store.PendingSourceHelperStuck, Key: "stuck:" + session.ID + ":" + session.Input.ID,
		Title: textcut.Excerpt(firstLineOf(title), 200), Excerpt: textcut.Excerpt(line, helperStuckExcerptChars),
		Handler: handler,
	}
	if _, _, err := s.store.RecordPendingItem(ctx, item); err != nil {
		log.Printf("personal agent %s: record stuck helper %s: %v", agent.UserID, session.ID, err)
	}
}

func firstLineOf(text string) string {
	for index, r := range text {
		if r == '\n' {
			return text[:index]
		}
	}
	return text
}
