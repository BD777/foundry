package httpapi

import (
	"context"
	"log"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/sessions"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func (s *Server) reconcileAgentSession(ctx context.Context, session store.AgentSession) (store.AgentSession, bool, error) {
	result, recovered, err := sessions.Reconcile(ctx, s.store, s.sessions, session, s.options.AgentSessionStaleAfter, s.hub.HasActiveSession)
	if recovered && err == nil {
		s.hub.settleIssueSession(ctx, result, nil, nil)
	}
	return result, recovered, err
}

// staleSessionSweepInterval is how often the server looks for sessions whose
// device stopped reporting, so they fail without anyone reading them.
var staleSessionSweepInterval = 30 * time.Second

// ReconcileStaleSessions fails, every staleSessionSweepInterval until ctx
// ends, the running and blocked sessions whose device stopped reporting
// (see reconcileAgentSession); each failure is published like any other.
// Queued sessions a connected device has not started for a while are told
// so (see sessions.Service.NoticeUnstarted); those that waited for an
// offline device past sessions.OfflineWaitLimit fail (ExpireDeviceWaits).
func (s *Server) ReconcileStaleSessions(ctx context.Context) {
	everyAfter(ctx, staleSessionSweepInterval, nil, func(ctx context.Context) {
		if err := s.reconcileStaleSessions(ctx); err != nil && ctx.Err() == nil {
			log.Printf("stale session sweep: %v", err)
		}
		if err := s.sessionService.NoticeUnstarted(ctx); err != nil && ctx.Err() == nil {
			log.Printf("unstarted session sweep: %v", err)
		}
		if err := s.sessionService.ExpireDeviceWaits(ctx, time.Now()); err != nil && ctx.Err() == nil {
			log.Printf("offline device wait sweep: %v", err)
		}
	})
}

func (s *Server) reconcileStaleSessions(ctx context.Context) error {
	active, err := s.store.ActiveAgentSessions(ctx)
	if err != nil {
		return err
	}
	s.sessionService.ReconcileAll(ctx, active)
	return nil
}

func (h *DaemonHub) reconcileAgentSession(ctx context.Context, session store.AgentSession) (store.AgentSession, bool, error) {
	result, recovered, err := sessions.Reconcile(ctx, h.store, h.sessions, session, defaultAgentSessionStaleAfter, h.HasActiveSession)
	if recovered && err == nil {
		h.settleIssueSession(ctx, result, nil, nil)
	}
	return result, recovered, err
}
