package httpapi

import (
	"context"
	"fmt"
	"log"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func (s *Server) reconcileAgentSession(ctx context.Context, session store.AgentSession) (store.AgentSession, bool, error) {
	result, recovered, err := reconcileAgentSession(ctx, s.store, s.sessions, session, s.options.AgentSessionStaleAfter, s.hub.HasActiveSession)
	if recovered && err == nil {
		s.hub.settleIssueSession(ctx, result, nil, nil)
	}
	return result, recovered, err
}

func (s *Server) reconcileAgentSessions(ctx context.Context, sessions []store.AgentSession) []store.AgentSession {
	for index := range sessions {
		session, recovered, err := s.reconcileAgentSession(ctx, sessions[index])
		if err != nil {
			continue
		}
		if recovered {
			sessions[index] = session
		}
	}
	return sessions
}

// staleSessionSweepInterval is how often the server looks for sessions whose
// device stopped reporting, so they fail without anyone reading them.
var staleSessionSweepInterval = 30 * time.Second

// ReconcileStaleSessions fails, every staleSessionSweepInterval until ctx
// ends, the running and blocked sessions whose device stopped reporting
// (see reconcileAgentSession); each failure is published like any other.
// Queued sessions a connected device has not started for a while are told
// so (see noticeUnstartedSessions); those that waited for an offline
// device past offlineWaitLimit fail (expireDeviceWaits).
func (s *Server) ReconcileStaleSessions(ctx context.Context) {
	everyAfter(ctx, staleSessionSweepInterval, nil, func(ctx context.Context) {
		if err := s.reconcileStaleSessions(ctx); err != nil && ctx.Err() == nil {
			log.Printf("stale session sweep: %v", err)
		}
		if err := s.noticeUnstartedSessions(ctx); err != nil && ctx.Err() == nil {
			log.Printf("unstarted session sweep: %v", err)
		}
		if err := s.expireDeviceWaits(ctx, time.Now()); err != nil && ctx.Err() == nil {
			log.Printf("offline device wait sweep: %v", err)
		}
	})
}

func (s *Server) reconcileStaleSessions(ctx context.Context) error {
	sessions, err := s.store.ActiveAgentSessions(ctx)
	if err != nil {
		return err
	}
	s.reconcileAgentSessions(ctx, sessions)
	return nil
}

func (h *DaemonHub) reconcileAgentSession(ctx context.Context, session store.AgentSession) (store.AgentSession, bool, error) {
	result, recovered, err := reconcileAgentSession(ctx, h.store, h.sessions, session, defaultAgentSessionStaleAfter, h.HasActiveSession)
	if recovered && err == nil {
		h.settleIssueSession(ctx, result, nil, nil)
	}
	return result, recovered, err
}

// reconcileAgentSession fails an input whose device stopped reporting
// activity. Whether an orphaned input finished is the device's to say
// (recover_session on reconnect); the server never reads a workspace's disk.
func reconcileAgentSession(ctx context.Context, st store.Store, events sessionChangeNotifier, session store.AgentSession, staleAfter time.Duration, hasActiveSession func(deviceID string, sessionID string) bool) (store.AgentSession, bool, error) {
	if !isRecoverableAgentSessionStatus(session.Status) {
		return session, false, nil
	}
	if message, stale := staleAgentSessionMessage(session, time.Now().UTC(), staleAfter, hasActiveSession); stale {
		updated, err := st.FailAgentSession(ctx, session.ID, message)
		if err != nil {
			return session, false, err
		}
		events.changed(ctx, sessionCompleted, updated)
		return updated, true, nil
	}
	return session, false, nil
}

func staleAgentSessionMessage(session store.AgentSession, now time.Time, staleAfter time.Duration, hasActiveSession func(deviceID string, sessionID string) bool) (string, bool) {
	if session.Status != "running" && session.Status != "blocked" || staleAfter <= 0 {
		return "", false
	}
	// A reconnect of the same daemon process is authoritative even if a long
	// network outage made the persisted heartbeat stale. A replacement process
	// reuses the device ID but has an empty execution registry, so it cannot
	// accidentally keep the orphan alive.
	if hasActiveSession != nil && hasActiveSession(session.DeviceID, session.ID) {
		return "", false
	}
	activityAt := strings.TrimSpace(session.LastActivityAt)
	if activityAt == "" {
		activityAt = strings.TrimSpace(session.StartedAt)
	}
	lastActivity, err := time.Parse(time.RFC3339Nano, activityAt)
	if err != nil || now.Sub(lastActivity) < staleAfter {
		return "", false
	}
	return fmt.Sprintf(
		"Local daemon stopped reporting session activity for %s; marked failed to clear a stale running session.",
		staleDurationLabel(now.Sub(lastActivity)),
	), true
}

func staleDurationLabel(duration time.Duration) string {
	duration = duration.Round(time.Second)
	if duration < time.Minute {
		return duration.String()
	}
	return duration.Round(time.Minute).String()
}

func isRecoverableAgentSessionStatus(status string) bool {
	return status == "queued" || status == "running" || status == "blocked"
}
