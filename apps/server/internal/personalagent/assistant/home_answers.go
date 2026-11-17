package assistant

import (
	"context"
	"log"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// The home conversation's unread marker (DEV-278): the server records when
// the assistant last answered there, and the web records the person's last
// view. The marker is state, not a judgement: any turn source counts, a
// helper's report included, and the person's own messages never do.

// RecordHomeAnswer notes a home-conversation turn that ended with an
// answer. A helper's session (a child), a message channel's session and a
// utility session are not the person's home conversation.
func (s *Service) RecordHomeAnswer(ctx context.Context, session store.AgentSession) {
	if session.ParentSessionID != "" || strings.TrimSpace(session.Response) == "" {
		return
	}
	if session.Role != "" && session.Role != store.AgentSessionRolePersonalAgent {
		return
	}
	if session.Source != "" && session.Source != store.SessionSourceChat {
		return
	}
	agent, err := s.store.AssistantForHomeConversation(ctx, session.WorkspaceID)
	if err != nil || agent.UserID != session.CreatedByUserID {
		return
	}
	at := session.CompletedAt
	if at == "" {
		at = time.Now().UTC().Format(time.RFC3339Nano)
	}
	if err := s.store.MarkAssistantHomeAnswer(ctx, agent.ID, at); err != nil {
		log.Printf("personal agent %s: mark home answer: %v", agent.ID, err)
	}
}

// MarkHomeSeen records that the person is looking at the home conversation:
// every answer it holds now is seen, and answers recorded later stay unseen.
func (s *Service) MarkHomeSeen(ctx context.Context, agent store.PersonalAgent) error {
	return s.store.MarkAssistantHomeSeen(ctx, agent.ID)
}

// HomeUnread reports whether the home conversation holds an answer the
// person has not seen.
func (s *Service) HomeUnread(ctx context.Context, agent store.PersonalAgent) (store.AssistantHomeUnread, error) {
	return s.store.AssistantHomeUnread(ctx, agent.ID)
}

// TellPerson posts one note from the assistant to the person's Feishu
// direct chat, when their settings pair one (DEV-278). It reports whether
// the note was posted; a missing pairing is not an error.
func (s *Service) TellPerson(ctx context.Context, agent store.PersonalAgent, session store.AgentSession, note string) (bool, error) {
	if !agent.Settings.FeishuDirectChat || strings.TrimSpace(note) == "" || s.channel == nil {
		return false, nil
	}
	return s.channel.TellPerson(ctx, agent, note, s.SessionURL(session))
}
