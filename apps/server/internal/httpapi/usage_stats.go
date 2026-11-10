package httpapi

import (
	"context"
	"log"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"github.com/foundry-dev/foundry/apps/server/internal/usagestats"
)

type usageRecorder interface {
	Record(context.Context, store.AgentSession, store.AgentSessionEvent) error
	DeleteExpiredRequests(context.Context) (int64, error)
	Backfill(context.Context, usagestats.BackfillOptions) error
	Query(context.Context, usagestats.QueryOptions) (store.UsageStatsResult, error)
}

func newUsageRecorder(backend Backend, roleOf usagestats.RoleResolver) usageRecorder {
	usageStore, ok := backend.(usagestats.Store)
	if !ok {
		return nil
	}
	return usagestats.New(usageStore, roleOf)
}

// recordUsageEvent is the single event ingestion hook. The event path checks
// for usage metadata before asking here, so ordinary stream events do not load
// a session or touch the usage tables.
func (h *DaemonHub) recordUsageEvent(ctx context.Context, event store.AgentSessionEvent) {
	if h.usageStats == nil {
		return
	}
	session, err := h.store.GetAgentSessionSummary(ctx, event.SessionID)
	if err != nil {
		log.Printf("usage stats session=%s event=%s load: %v", event.SessionID, event.ID, err)
		return
	}
	h.recordUsage(ctx, session, event)
}

// recordUsage is a side path: failures are logged and never change the event
// acknowledgement or the session's completion result.
func (h *DaemonHub) recordUsage(ctx context.Context, session store.AgentSession, event store.AgentSessionEvent) {
	if h.usageStats == nil {
		return
	}
	if err := h.usageStats.Record(ctx, session, event); err != nil {
		log.Printf("usage stats session=%s input=%s record: %v", session.ID, session.Input.ID, err)
	}
}
