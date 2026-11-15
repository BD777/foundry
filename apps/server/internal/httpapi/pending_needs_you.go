package httpapi

import (
	"context"
	"log"
	"time"
)

// needsYouSweepInterval bounds notice latency after a restart.
const needsYouSweepInterval = 10 * time.Second

func (s *Server) runNeedsYouMaintenance(ctx context.Context) {
	everyFromNow(ctx, needsYouSweepInterval, nil, func(ctx context.Context) {
		s.maintainNeedsYou(ctx, time.Now().UTC())
	})
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
