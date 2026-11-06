package httpapi

import (
	"sync"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/sessions"
)

// sessionClaimMemory is how long a claim's time is kept after the device
// last made it; far longer than any stale-session limit.
const sessionClaimMemory = 24 * time.Hour

// sessionClaims remembers when each device last claimed each session it
// runs: in its registrations, when it starts one and in every heartbeat.
// A session waiting on a long tool call or background task sends no events
// for as long as it waits; its claim is what tells the stale-session sweep
// that the device still runs it. The times live in memory: since says when
// this server began hearing claims, so a restarted server gives every
// device that long to come back before its sessions count as unclaimed.
type sessionClaims struct {
	mu    sync.Mutex
	since time.Time
	seen  map[sessionClaimKey]time.Time
}

type sessionClaimKey struct{ deviceID, sessionID string }

func newSessionClaims(since time.Time) *sessionClaims {
	return &sessionClaims{since: since, seen: make(map[sessionClaimKey]time.Time)}
}

// confirm records that the device claims these sessions at.
func (c *sessionClaims) confirm(deviceID string, sessionIDs []string, at time.Time) {
	if c == nil || deviceID == "" {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, sessionID := range sessionIDs {
		if sessionID != "" {
			c.seen[sessionClaimKey{deviceID, sessionID}] = at
		}
	}
	for key, seen := range c.seen {
		if at.Sub(seen) > sessionClaimMemory {
			delete(c.seen, key)
		}
	}
}

// forget drops a session the device reported ended.
func (c *sessionClaims) forget(deviceID string, sessionID string) {
	if c == nil {
		return
	}
	c.mu.Lock()
	delete(c.seen, sessionClaimKey{deviceID, sessionID})
	c.mu.Unlock()
}

// confirmedAt is when the device last claimed the session, and never
// earlier than when this server began hearing claims.
func (c *sessionClaims) confirmedAt(deviceID string, sessionID string) time.Time {
	if c == nil {
		return time.Time{}
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if seen := c.seen[sessionClaimKey{deviceID, sessionID}]; seen.After(c.since) {
		return seen
	}
	return c.since
}

// SessionClaim is what the device says about running the session: whether
// its current connection claims it, and when it last did.
func (h *DaemonHub) SessionClaim(deviceID string, sessionID string) sessions.Claim {
	return sessions.Claim{
		Held:        h.HasActiveSession(deviceID, sessionID),
		ConfirmedAt: h.claims.confirmedAt(deviceID, sessionID),
	}
}

// confirmActiveSessions records that the device claims, now, every session
// this connection holds.
func (c *daemonConnection) confirmActiveSessions() {
	if c.hub == nil {
		return
	}
	deviceID, _ := c.registrationSnapshot()
	c.activeMu.Lock()
	sessionIDs := make([]string, 0, len(c.activeSessions))
	for sessionID := range c.activeSessions {
		sessionIDs = append(sessionIDs, sessionID)
	}
	c.activeMu.Unlock()
	c.hub.claims.confirm(deviceID, sessionIDs, time.Now())
}
