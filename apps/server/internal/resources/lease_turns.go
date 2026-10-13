package resources

import (
	"context"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// TurnStarted: the session's input is queued, running or blocked again; its
// parked leases are active again.
func (l *Leases) TurnStarted(ctx context.Context, sessionID string) error {
	return l.forSession(ctx, sessionID, func(state *leaseState, lease *store.ResourceLease, now time.Time) {
		if lease.State == store.LeaseParked || lease.HolderOfflineSince != "" {
			lease.State, lease.ParkUntil, lease.HolderOfflineSince = store.LeaseActive, "", ""
			state.touch(lease)
		}
	}, false)
}

// TurnEnded: the session's input settled with status. Completed parks its
// leases; failed or canceled releases them. Its waits are canceled.
func (l *Leases) TurnEnded(ctx context.Context, sessionID, status string) error {
	return l.forSession(ctx, sessionID, func(state *leaseState, lease *store.ResourceLease, now time.Time) {
		switch status {
		case "completed":
			if lease.State == store.LeaseActive {
				lease.State = store.LeaseParked
				lease.ParkUntil = l.parkUntil(state, lease, now)
				lease.HolderOfflineSince = ""
				state.touch(lease)
			}
		case "failed":
			l.end(state, lease, store.LeaseReleased, "its session's turn failed", "foundry", now)
		default:
			l.end(state, lease, store.LeaseReleased, "its session's turn was "+status, "foundry", now)
		}
	}, true)
}

func (l *Leases) forSession(ctx context.Context, sessionID string, apply func(*leaseState, *store.ResourceLease, time.Time), cancelWaits bool) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	state, err := l.load(ctx)
	if err != nil {
		return err
	}
	now := l.Now().UTC()
	touched := false
	for _, lease := range sortedLive(state) {
		if lease.HolderSessionID == sessionID {
			apply(state, lease, now)
			touched = true
		}
	}
	if cancelWaits {
		for _, wait := range state.waits {
			if wait.State == store.WaitWaiting && wait.SessionID == sessionID {
				l.cancelWait(state, wait)
				touched = true
			}
		}
	}
	if !touched {
		return nil
	}
	l.settle(ctx, state, now)
	return l.save(ctx, state)
}

func turnRunning(status string) bool {
	return status == "queued" || status == "running" || status == "blocked"
}
