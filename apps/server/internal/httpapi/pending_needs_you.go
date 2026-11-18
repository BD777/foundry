package httpapi

import (
	"context"
	"log"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// needsYouSweepInterval bounds notice latency after a restart.
const needsYouSweepInterval = 10 * time.Second

func (s *Server) runNeedsYouMaintenance(ctx context.Context) {
	everyFromNow(ctx, needsYouSweepInterval, nil, func(ctx context.Context) {
		s.maintainNeedsYou(ctx, time.Now().UTC())
	})
}

// resumedAssistant follows an assistant's resume: its helpers' questions that
// still wait are relayed to it, and the message-channel items it was told of
// are told again.
func (s *Server) resumedAssistant(ctx context.Context, agent store.PersonalAgent) {
	s.relayHelperQuestionsOnResume(ctx, agent)
	s.noticeChannelItemsOnResume(ctx, agent)
}

// noticeChannelItemsOnResume tells the resumed assistant once more about each
// message-channel item it was told of that is still open: the notice may have
// missed it while stopped. An item not yet told is left to the sweep. It
// reports how many notices it queued.
func (s *Server) noticeChannelItemsOnResume(ctx context.Context, agent store.PersonalAgent) int {
	current, err := s.store.GetAssistant(ctx, agent.ID)
	if err != nil {
		log.Printf("assistant %s: read on resume: %v", agent.ID, err)
		return 0
	}
	items, err := s.store.ListVisiblePendingItems(ctx, agent.UserID, []string{store.PendingOpen}, "", 500)
	if err != nil {
		log.Printf("assistant %s: list channel items on resume: %v", agent.ID, err)
		return 0
	}
	queued := 0
	for _, item := range items {
		if item.AssistantID != agent.ID || item.Source != store.PendingSourceMessageChannel || item.NotifiedAt == "" {
			continue
		}
		if s.assistant.NotifyPendingItem(ctx, current, item) {
			queued++
		}
	}
	return queued
}

// maintainNeedsYou sends each assistant-handled item's arrival notice to
// the assistant. Foundry makes no escalation decision of its own: the item
// stays the assistant's until the assistant hands it over or resolves it.
func (s *Server) maintainNeedsYou(ctx context.Context, now time.Time) {
	items, err := s.store.ListOpenAssistantPendingItems(ctx)
	if err != nil {
		if ctx.Err() == nil {
			log.Printf("pending needs-you sweep: %v", err)
		}
		return
	}
	at := formatPendingTime(now)
	for _, item := range items {
		if item.NotifiedAt != "" {
			continue
		}
		agent, err := s.store.GetAssistant(ctx, item.AssistantID)
		if err != nil || agent.UserID != item.UserID {
			continue
		}
		if s.assistant.NotifyPendingItem(ctx, agent, item) {
			if err := s.store.MarkPendingItemNotified(ctx, item.UserID, item.ID, at); err != nil {
				log.Printf("pending needs-you notice %s: %v", item.ID, err)
			}
		}
	}
}
