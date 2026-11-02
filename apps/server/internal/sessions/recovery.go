package sessions

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// Reconcile fails an input whose device stopped reporting
// activity. Whether an orphaned input finished is the device's to say
// (recover_session on reconnect); the server never reads a workspace's disk.
func Reconcile(ctx context.Context, st store.Store, events ChangeNotifier, session store.AgentSession, staleAfter time.Duration, hasActiveSession func(deviceID string, sessionID string) bool) (store.AgentSession, bool, error) {
	if !Unsettled(session.Status) {
		return session, false, nil
	}
	if message, stale := staleMessage(session, time.Now().UTC(), staleAfter, hasActiveSession); stale {
		updated, err := st.FailAgentSession(ctx, session.ID, message)
		if err != nil {
			return session, false, err
		}
		events.Changed(ctx, Completed, updated)
		return updated, true, nil
	}
	return session, false, nil
}

// ReconcileAll reconciles each of sessions (Policy.Reconcile), in place,
// and returns them.
func (s *Service) ReconcileAll(ctx context.Context, sessions []store.AgentSession) []store.AgentSession {
	for index := range sessions {
		session, recovered, err := s.policy.Reconcile(ctx, sessions[index])
		if err != nil {
			continue
		}
		if recovered {
			sessions[index] = session
		}
	}
	return sessions
}

func staleMessage(session store.AgentSession, now time.Time, staleAfter time.Duration, hasActiveSession func(deviceID string, sessionID string) bool) (string, bool) {
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

// Unsettled reports whether a session in status is still unsettled:
// queued, running or blocked. Those are the statuses on which steer and
// cancel are legal, and that a stale device recovers from.
func Unsettled(status string) bool {
	return status == "queued" || status == "running" || status == "blocked"
}
