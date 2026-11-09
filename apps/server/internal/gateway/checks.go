package gateway

import (
	"crypto/rand"
	"encoding/hex"
	"strings"
	"sync"
	"time"
)

// CheckPrefix marks a grant that stands for a tool version check on a
// bundle rollout's canary device (docs/skills.md, Bundle 版本) rather than
// for a session.
const CheckPrefix = "chk_"

// IsCheck reports whether a grant's session id names a check.
func IsCheck(sessionID string) bool { return strings.HasPrefix(sessionID, CheckPrefix) }

// Check is one tool version check in progress: on one device, by its
// owner, with one of the owner's accounts.
type Check struct {
	ID        string
	DeviceID  string
	UserID    string
	AccountID string
	Expires   time.Time
}

// Checks are the checks in progress. A check's grant is live only while
// its check is: until End, and at most until it expires.
type Checks struct {
	Now    func() time.Time
	mu     sync.Mutex
	active map[string]Check
}

// NewChecks is an empty set of checks.
func NewChecks() *Checks {
	return &Checks{Now: time.Now, active: map[string]Check{}}
}

// Begin starts a check that may act for at most ttl.
func (c *Checks) Begin(deviceID, userID, accountID string, ttl time.Duration) Check {
	seed := make([]byte, 12)
	_, _ = rand.Read(seed)
	check := Check{ID: CheckPrefix + hex.EncodeToString(seed), DeviceID: deviceID, UserID: userID, AccountID: accountID, Expires: c.Now().Add(ttl)}
	c.mu.Lock()
	defer c.mu.Unlock()
	for id, old := range c.active {
		if c.Now().After(old.Expires) {
			delete(c.active, id)
		}
	}
	c.active[check.ID] = check
	return check
}

// End ends a check; its grant stops working.
func (c *Checks) End(id string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.active, id)
}

// Active is a check in progress and not expired.
func (c *Checks) Active(id string) (Check, bool) {
	if c == nil {
		return Check{}, false
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	check, ok := c.active[id]
	if !ok || c.Now().After(check.Expires) {
		return Check{}, false
	}
	return check, true
}
