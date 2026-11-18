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
// The assistant owns its helpers' items (ResponsibleFor says which). They
// queue while it is stopped or its home computer is offline, and nothing
// hands them to the person on a timer.

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

// helperStuckExcerptChars bounds what a stuck helper's item quotes.
const helperStuckExcerptChars = 600

// recordHelperStuck keeps a helper that cannot reach its model service or
// runs past the stuck limit as its responsible party's item (its assistant
// for a helper). It queues even while the assistant is stopped or offline.
func (s *Service) recordHelperStuck(ctx context.Context, agent store.PersonalAgent, task store.PersonalAgentTask, session store.AgentSession, line string) {
	title := session.Title
	if title == "" {
		title = task.Title
	}
	handler, assistantID := s.ResponsibleFor(ctx, session).Handler()
	item := store.PendingItem{
		UserID: agent.UserID, AssistantID: assistantID, WorkspaceID: session.WorkspaceID, SessionID: session.ID,
		Source: store.PendingSourceHelperStuck, Key: "stuck:" + session.ID + ":" + session.Input.ID,
		Title: textcut.Excerpt(firstLineOf(title), 200), Excerpt: textcut.Excerpt(line, helperStuckExcerptChars),
		Handler: handler,
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
	if item.Source == store.PendingSourceMessageChannel {
		return s.notifyChannelItem(ctx, agent, item)
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
	s.notices.addLine(conversationID, language, noticeLine{key: item.ID, text: line, due: s.stillOpen(agent.UserID, item.ID)}, time.Now(), func(text string) {
		current, err := s.store.GetAssistant(context.Background(), agent.ID)
		if err != nil || current.State != store.PersonalAgentActive {
			return
		}
		if !s.tell(context.Background(), conversationID, store.NoticeKindHelperQuestion, text) {
			return
		}
		if err := s.store.MarkPendingItemNotified(context.Background(), agent.UserID, item.ID, formatPATime(time.Now())); err != nil {
			log.Printf("personal agent %s: mark item %s notified: %v", agent.UserID, item.ID, err)
		}
	})
	return true
}

// channelItemKeyPrefix starts the key of a message channel's item:
// "message-channel:<channel id>:<key>".
const channelItemKeyPrefix = "message-channel:"

// notifyChannelItem tells the assistant about an open item of a message
// channel, in the channel's conversation: the item has no session of its
// own. It reports whether a notice was queued; "" for a channel with no
// conversation yet.
func (s *Service) notifyChannelItem(ctx context.Context, agent store.PersonalAgent, item store.PendingItem) bool {
	conversationID := s.channelConversation(ctx, agent, item)
	if conversationID == "" {
		return false
	}
	language := personalagent.LanguageOf(agent.Settings, s.AccountLocale(ctx, agent.UserID))
	line := fmt.Sprintf(channelItemNoticeTexts[languageIndex(language)], textcut.Excerpt(strings.TrimSpace(item.Title), 240), item.ID)
	s.notices.addLine(conversationID, language, noticeLine{key: item.ID, text: line, due: s.stillOpen(agent.UserID, item.ID)}, time.Now(), func(text string) {
		current, err := s.store.GetAssistant(context.Background(), agent.ID)
		if err != nil || current.State != store.PersonalAgentActive {
			return
		}
		s.tell(context.Background(), conversationID, store.NoticeKindChannelItem, text)
	})
	return true
}

// stillOpen says whether a pending item is still open when its notice would
// go out: a notice queued while it waited is dropped once it was answered or
// closed.
func (s *Service) stillOpen(userID, itemID string) func() bool {
	return func() bool {
		item, err := s.store.GetPendingItem(context.Background(), userID, itemID)
		return err == nil && item.State == store.PendingOpen
	}
}

// channelConversation is the conversation a channel's item is told in: the
// channel's most recently active session of the assistant, not archived.
func (s *Service) channelConversation(ctx context.Context, agent store.PersonalAgent, item store.PendingItem) string {
	channelID, ok := channelOfItem(item)
	if !ok || s.messageChannels == nil {
		return ""
	}
	sessionIDs, err := s.messageChannels.MessageChannelSessions(ctx, agent.ID, channelID)
	if err != nil {
		log.Printf("personal agent %s: channel %s sessions: %v", agent.ID, channelID, err)
		return ""
	}
	latest, latestAt := "", ""
	for _, id := range sessionIDs {
		session, err := s.store.GetAgentSessionSummary(ctx, id)
		if err != nil || session.ArchivedAt != "" {
			continue
		}
		if latest == "" || session.ActivityAt > latestAt {
			latest, latestAt = session.ID, session.ActivityAt
		}
	}
	return latest
}

// channelOfItem is the message channel an item's key names.
func channelOfItem(item store.PendingItem) (string, bool) {
	rest, ok := strings.CutPrefix(item.Key, channelItemKeyPrefix)
	if !ok {
		return "", false
	}
	channelID, _, found := strings.Cut(rest, ":")
	return channelID, found && channelID != ""
}

var channelItemNoticeTexts = [2]string{
	"消息通道有一条事项需要你处理：%s。事项 %s。",
	"A message channel has an item for you: %s. Item %s.",
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
