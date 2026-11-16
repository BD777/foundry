package assistant

import (
	"context"
	"fmt"
	"log"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/permission"
	"github.com/foundry-dev/foundry/apps/server/internal/personalagent"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"github.com/foundry-dev/foundry/apps/server/internal/textcut"
)

// "Needs you" (docs/assistant-orchestration.md §h): one list of what waits
// for the person, each open item handled by the person or their assistant.
// The assistant always owns its helpers' items. They queue while it is
// stopped or its home computer is offline; if it neither reads nor handles
// one before the persisted deadline, the server hands it to the person.

// PendingFor is the one visibility rule for an assistant's "needs you"
// view. It returns open items assigned to it, visible workspace items, and
// personal account items it may use. An item with neither a workspace nor
// an account belongs only to the default assistant. Items whose session was
// archived or deleted are not "needs you" anywhere: the same
// ListVisiblePendingItems the person's Needs-you page reads is what this
// card counts.
func (s *Service) PendingFor(ctx context.Context, agent store.PersonalAgent, limit int) ([]store.PendingItem, error) {
	items, err := s.store.ListVisiblePendingItems(ctx, agent.UserID, []string{store.PendingOpen}, "", limit)
	if err != nil {
		return nil, err
	}
	pkg, err := s.store.GetPermissionPackage(ctx, agent.UserID, agent.PermissionPackageID)
	if err != nil {
		return nil, err
	}
	access := permission.Access{Applicable: true, Agent: agent, Package: pkg}
	visible := make([]store.PendingItem, 0, len(items))
	for _, item := range items {
		switch {
		case item.AssistantID != "":
			if item.AssistantID == agent.ID {
				visible = append(visible, item)
			}
		case item.WorkspaceID != "":
			if access.WorkspaceAllowed(item.WorkspaceID) {
				visible = append(visible, item)
			}
		case pendingAccountID(item) != "":
			if access.AllowsConnector(pendingAccountID(item)) {
				visible = append(visible, item)
			}
		case agent.IsDefault:
			visible = append(visible, item)
		}
	}
	return visible, nil
}

// pendingAccountID names the connector account a personal item concerns.
// Account items use "account:" or "account-scopes:"; device connector items
// use the same "device:<device>:<kind>" id the permission package stores.
func pendingAccountID(item store.PendingItem) string {
	switch {
	case strings.HasPrefix(item.Key, "account:"):
		return strings.TrimPrefix(item.Key, "account:")
	case strings.HasPrefix(item.Key, "account-scopes:"):
		return "account:" + strings.TrimPrefix(item.Key, "account-scopes:")
	case strings.HasPrefix(item.Key, "connector:"):
		parts := strings.SplitN(strings.TrimPrefix(item.Key, "connector:"), ":", 2)
		if len(parts) == 2 {
			return "device:" + parts[0] + ":" + parts[1]
		}
	}
	return ""
}

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

// Handler is who handles a new item of session: always the assistant for
// its helper, regardless of whether it is stopped or its computer is
// offline; and the assistant the helper works for ("" for none).
func (s *Service) Handler(ctx context.Context, session store.AgentSession) (handler, assistantID string) {
	agent, ok := s.HelperOf(ctx, session)
	if !ok {
		return store.PendingHandlerPerson, ""
	}
	return store.PendingHandlerAssistant, agent.ID
}

// helperStuckExcerptChars bounds what a stuck helper's item quotes.
const helperStuckExcerptChars = 600

// recordHelperStuck keeps a helper that cannot reach its model service or
// runs past the stuck limit as the assistant's item. It queues even while
// the assistant is stopped or offline.
func (s *Service) recordHelperStuck(ctx context.Context, agent store.PersonalAgent, task store.PersonalAgentTask, session store.AgentSession, line string) {
	title := session.Title
	if title == "" {
		title = task.Title
	}
	item := store.PendingItem{
		UserID: agent.UserID, AssistantID: agent.ID, WorkspaceID: session.WorkspaceID, SessionID: session.ID,
		Source: store.PendingSourceHelperStuck, Key: "stuck:" + session.ID + ":" + session.Input.ID,
		Title: textcut.Excerpt(firstLineOf(title), 200), Excerpt: textcut.Excerpt(line, helperStuckExcerptChars),
		Handler: store.PendingHandlerAssistant,
	}
	if _, _, err := s.store.RecordPendingItem(ctx, item); err != nil {
		log.Printf("personal agent %s: record stuck helper %s: %v", agent.UserID, session.ID, err)
	}
}

// NotifyPendingItem tells an accessible assistant conversation about one
// item as a short server notice. It is the existing task-notice path and
// carries facts only: the helper, its question and the item id. It reports
// whether a notice was queued.
func (s *Service) NotifyPendingItem(ctx context.Context, agent store.PersonalAgent, item store.PendingItem) bool {
	if agent.State != store.PersonalAgentActive || item.State != store.PendingOpen {
		return false
	}
	session, err := s.store.GetAgentSessionSummary(ctx, item.SessionID)
	if err != nil {
		return false
	}
	conversationID := session.ParentSessionID
	if _, task, ok := s.TaskOf(ctx, session); ok && task.ConversationSessionID != "" {
		conversationID = task.ConversationSessionID
	}
	if conversationID == "" {
		return false
	}
	language := personalagent.LanguageOf(agent.Settings, s.AccountLocale(ctx, agent.UserID))
	helper := firstLineOf(session.Title)
	if helper == "" {
		helper = session.ID
	}
	question := textcut.Excerpt(strings.TrimSpace(item.Title), 240)
	line := fmt.Sprintf(pendingNoticeTexts[languageIndex(language)],
		helper, session.ID, question, item.ID)
	s.notices.add(conversationID, language, line, time.Now(), func(text string) {
		current, err := s.store.GetAssistant(context.Background(), agent.ID)
		if err != nil || current.State != store.PersonalAgentActive {
			return
		}
		if !s.tell(context.Background(), conversationID, text) {
			return
		}
		if err := s.store.MarkPendingItemNotified(context.Background(), agent.UserID, item.ID, formatPATime(time.Now())); err != nil {
			log.Printf("personal agent %s: mark item %s notified: %v", agent.UserID, item.ID, err)
		}
	})
	return true
}

var pendingNoticeTexts = [2]string{
	"帮手“%s”（%s）的问题：%s。事项 %s。",
	"Helper %q (%s) asks: %s. Item %s.",
}

func firstLineOf(text string) string {
	for index, r := range text {
		if r == '\n' {
			return text[:index]
		}
	}
	return text
}
