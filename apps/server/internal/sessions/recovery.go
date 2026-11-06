package sessions

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// Claim is what a session's device says about running it.
type Claim struct {
	// Held: the device's current connection, from the daemon process that
	// runs the session, claims it now.
	Held bool
	// ConfirmedAt is when the device last claimed it (its heartbeat
	// carries the claims), or when this server began hearing from devices
	// if it has not heard a claim since; zero when unknown.
	ConfirmedAt time.Time
}

// ClaimLookup tells what a device says about running a session.
type ClaimLookup func(deviceID string, sessionID string) Claim

// Reconcile fails an input whose device stopped reporting it: no event and
// no claim for staleAfter. A tool call or background task can run silently
// for longer; the device's claim keeps such a session alive, so only a
// session no daemon process owns any more goes stale. Whether an orphaned
// input finished is the device's to say (recover_session on reconnect); the
// server never reads a workspace's disk.
func Reconcile(ctx context.Context, st store.Store, events ChangeNotifier, session store.AgentSession, staleAfter time.Duration, claims ClaimLookup) (store.AgentSession, bool, error) {
	if !store.IsActiveSessionStatus(session.Status) {
		return session, false, nil
	}
	if message, stale := staleMessage(session, time.Now().UTC(), staleAfter, claims); stale {
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

func staleMessage(session store.AgentSession, now time.Time, staleAfter time.Duration, claims ClaimLookup) (string, bool) {
	if session.Status != "running" && session.Status != "blocked" || staleAfter <= 0 {
		return "", false
	}
	var claim Claim
	if claims != nil {
		claim = claims(session.DeviceID, session.ID)
	}
	// A claim from the daemon process that runs the session is
	// authoritative however long the session has been silent. A
	// replacement process reuses the device ID but has an empty execution
	// registry, so it cannot keep the orphan alive.
	if claim.Held {
		return "", false
	}
	activityAt := strings.TrimSpace(session.LastActivityAt)
	if activityAt == "" {
		activityAt = strings.TrimSpace(session.StartedAt)
	}
	lastActivity, err := time.Parse(time.RFC3339Nano, activityAt)
	if err != nil {
		return "", false
	}
	// A device between connections (a server restart, a dropped socket)
	// holds no claim for a moment; the session is stale only once neither
	// an event nor a claim came for staleAfter.
	lastReport := lastActivity
	if claim.ConfirmedAt.After(lastReport) {
		lastReport = claim.ConfirmedAt
	}
	if now.Sub(lastReport) < staleAfter {
		return "", false
	}
	return fmt.Sprintf(
		"Local daemon stopped reporting session activity for %s; marked failed to clear a stale running session.",
		staleDurationLabel(now.Sub(lastReport)),
	), true
}

func staleDurationLabel(duration time.Duration) string {
	duration = duration.Round(time.Second)
	if duration < time.Minute {
		return duration.String()
	}
	return duration.Round(time.Minute).String()
}
