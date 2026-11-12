package httpapi

import (
	"context"
	"log"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// needsYouSweepInterval bounds notice latency and escalation after a
// restart. Deadlines themselves live on the item, not in a timer.
const needsYouSweepInterval = 10 * time.Second

func (s *Server) runNeedsYouMaintenance(ctx context.Context) {
	everyFromNow(ctx, needsYouSweepInterval, nil, func(ctx context.Context) {
		s.maintainNeedsYou(ctx, time.Now().UTC())
	})
}

// maintainNeedsYou sends each assistant-handled item's one arrival notice,
// then hands to the person any item the assistant has neither read nor
// handled by its persisted deadline.
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
		deadline := parseStoredPendingTime(item.DeadlineAt)
		overdue := !deadline.IsZero() && !now.Before(deadline) && item.AcknowledgedAt == ""
		if item.NotifiedAt == "" && !overdue {
			agent, err := s.store.GetAssistant(ctx, item.AssistantID)
			if err == nil && agent.UserID == item.UserID && s.assistant.NotifyPendingItem(ctx, agent, item) {
				if err := s.store.MarkPendingItemNotified(ctx, item.UserID, item.ID, at); err != nil {
					log.Printf("pending needs-you notice %s: %v", item.ID, err)
				}
			}
		}
		if !overdue {
			continue
		}
		if _, err := s.store.HandPendingItem(ctx, item.UserID, item.ID, store.PendingHandlerPerson, "",
			store.PendingHandedTimeout, store.PendingOutcomeEscalatedTimeout); err != nil {
			if ctx.Err() == nil {
				log.Printf("pending needs-you escalation %s: %v", item.ID, err)
			}
		}
	}
}
