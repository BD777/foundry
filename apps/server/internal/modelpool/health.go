package modelpool

import (
	"sort"
	"time"
)

// A rate-limit domain is the account a worker group member's provider meters
// against: members that share an account share one domain. Provider limits
// are not declared; the breaker learns them from rate-limit signals (429s,
// "Rate limited, waiting to retry" events) and from successful model requests.
//
// Per domain this is a circuit breaker (closed, open for a cooldown, half-open
// with one probe) plus AIMD on the concurrent-session limit, with decay back
// to defaults after clean time. HealthTracker is pure: callers pass the clock,
// the active session count and the provider hints, and serialize access.
// Industry references: Envoy outlier ejection (growing ejection time), the
// resilience4j/Hystrix half-open breaker, Netflix concurrency-limits AIMD, and
// the AWS full-jitter backoff already in Backoff.
const (
	// StormWindow bounds the signals that count toward a storm.
	StormWindow = 2 * time.Minute
	// StormSignals and StormSessions: that many signals from that many
	// sessions inside StormWindow open the breaker.
	StormSignals  = 3
	StormSessions = 2
	// SoloLimitedFor: one session limited this long opens the breaker alone.
	SoloLimitedFor = 60 * time.Second
	// BaseCooldown and MaxCooldown bound the open period; the cooldown doubles
	// with each reopening (the level) up to MaxCooldown.
	BaseCooldown = 2 * time.Minute
	MaxCooldown  = 15 * time.Minute
	// DecayPeriod is the clean time that halves the level and grants one
	// concurrency step if the domain ran at its limit in that time.
	DecayPeriod = 10 * time.Minute
	// ResetAfter is the clean time after which a domain returns to defaults.
	ResetAfter = 30 * time.Minute
	// ProbeTimeout frees a half-open probe that never reported back.
	ProbeTimeout = 2 * time.Minute

	DefaultConcurrency = 4
	MaxConcurrency     = 16
	maxLevel           = 3
)

// HealthState is a member's admission state as the breaker shows it.
type HealthState string

const (
	// Healthy: closed, clean for DecayPeriod. Takes sessions up to its limit.
	Healthy HealthState = "healthy"
	// Recovering: closed, but a rate limit was seen within DecayPeriod. It
	// takes a session only when no healthier member exists.
	Recovering HealthState = "recovering"
	// Probing: half-open with no probe in flight. It takes one session, which
	// the caller reserves with Reserve.
	Probing HealthState = "probing"
	// Limited: open, or half-open with its probe in flight.
	Limited HealthState = "limited"
)

// DomainStatus is one domain's breaker and limit at a time.
type DomainStatus struct {
	State         HealthState
	CooldownUntil time.Time
	Level         int
	Limit         int
	// SignalsInWindow counts rate-limit signals within StormWindow.
	SignalsInWindow int
	// FailoversLastHour counts sessions moved off the domain in the last hour.
	FailoversLastHour int
}

// FailoverWindow is the period FailoversLastHour counts.
const FailoverWindow = time.Hour

type rateLimitSignal struct {
	at        time.Time
	sessionID string
}

type domainHealth struct {
	signals       []rateLimitSignal
	open          bool
	cooldownUntil time.Time
	hintUntil     time.Time
	level         int
	limit         int
	ceiling       int
	lastEvent     time.Time
	anchor        time.Time
	saturated     bool
	probeAt       time.Time
	probing       bool
	failovers     []time.Time
}

// HealthTracker holds the live health of every rate-limit domain.
type HealthTracker struct {
	domains map[string]*domainHealth
}

func NewHealthTracker() *HealthTracker {
	return &HealthTracker{domains: map[string]*domainHealth{}}
}

func (t *HealthTracker) domain(key string) *domainHealth {
	d := t.domains[key]
	if d == nil {
		d = &domainHealth{ceiling: MaxConcurrency}
		t.domains[key] = d
	}
	return d
}

// Observe records a rate-limit signal from sessionID on the domain. active is
// the sessions on the domain now; hint is the provider's Retry-After (zero if
// none), which the cooldown is never shorter than. It reports whether this
// signal opened the breaker (a new storm, or a failed probe reopening it).
func (t *HealthTracker) Observe(key, sessionID string, at time.Time, active int, hint time.Duration) bool {
	d := t.domain(key)
	d.advance(at)
	d.lastEvent, d.anchor, d.saturated = at, at, false
	d.signals = append(pruneSignals(d.signals, at), rateLimitSignal{at: at, sessionID: sessionID})
	if hint > 0 {
		// A provider's reset time floors the cooldown, but a far reset does not
		// lock the account beyond the longest cooldown.
		d.hintUntil = later(d.hintUntil, at.Add(min(hint, MaxCooldown)))
	}
	opened := false
	switch {
	case d.open && at.Before(d.cooldownUntil):
	case d.open || d.probing:
		// A half-open probe was rate limited: reopen with a longer cooldown.
		d.probing = false
		d.reopen(at)
		opened = true
	case stormAt(d.signals, sessionID, at):
		d.reopen(at)
		d.limit = max(1, active/2)
		opened = true
	}
	return opened
}

// reopen opens the breaker at at: the cooldown for the current level, never
// shorter than the provider's Retry-After hint.
func (d *domainHealth) reopen(at time.Time) {
	d.open = true
	d.cooldownUntil = later(at.Add(cooldownFor(d.level)), d.hintUntil)
	d.level = min(d.level+1, maxLevel)
}

// Succeeded records a successful model request on the domain. It closes a
// half-open breaker: the probe worked.
func (t *HealthTracker) Succeeded(key string, at time.Time) {
	d := t.domain(key)
	d.advance(at)
	if d.open && !at.Before(d.cooldownUntil) {
		d.open = false
	}
	d.probing = false
}

// Reserve takes the single probe of a half-open domain. It reports false when
// the domain is not half-open or its probe is already in flight.
func (t *HealthTracker) Reserve(key string, at time.Time) bool {
	d := t.domain(key)
	d.advance(at)
	if !d.open || at.Before(d.cooldownUntil) || d.probing && at.Sub(d.probeAt) < ProbeTimeout {
		return false
	}
	d.probing, d.probeAt = true, at
	return true
}

// Snapshot is the domain's status at now. active counts the sessions on the
// domain; a snapshot at the limit records saturation, which lets the limit
// grow at the next clean DecayPeriod. ceiling is the declared maximum
// concurrency (non-positive means MaxConcurrency).
func (t *HealthTracker) Snapshot(key string, now time.Time, ceiling, active int) DomainStatus {
	if ceiling <= 0 || ceiling > MaxConcurrency {
		ceiling = MaxConcurrency
	}
	d := t.domain(key)
	d.ceiling = ceiling
	d.advance(now)
	if d.limit == 0 {
		d.limit = min(DefaultConcurrency, ceiling)
	}
	d.limit = min(d.limit, ceiling)
	if active >= d.limit {
		d.saturated = true
	}
	status := DomainStatus{State: d.state(now), Level: d.level, Limit: d.limit}
	if d.open && now.Before(d.cooldownUntil) {
		status.CooldownUntil = d.cooldownUntil
	}
	for _, signal := range d.signals {
		if now.Sub(signal.at) <= StormWindow {
			status.SignalsInWindow++
		}
	}
	for _, at := range d.failovers {
		if now.Sub(at) <= FailoverWindow {
			status.FailoversLastHour++
		}
	}
	return status
}

// RecordFailover notes that a session was moved off the domain at at.
func (t *HealthTracker) RecordFailover(key string, at time.Time) {
	d := t.domain(key)
	kept := d.failovers[:0]
	for _, previous := range d.failovers {
		if at.Sub(previous) <= FailoverWindow {
			kept = append(kept, previous)
		}
	}
	d.failovers = append(kept, at)
}

func (d *domainHealth) state(now time.Time) HealthState {
	switch {
	case d.open && now.Before(d.cooldownUntil):
		return Limited
	case d.open && d.probing && now.Sub(d.probeAt) < ProbeTimeout:
		return Limited
	case d.open:
		return Probing
	case !d.lastEvent.IsZero() && now.Before(d.lastEvent.Add(DecayPeriod)):
		return Recovering
	default:
		return Healthy
	}
}

// advance applies the clean periods between the anchor and now: each one
// halves the level, grants one limit step when the domain was saturated, and
// after ResetAfter of clean time resets the domain to defaults.
func (d *domainHealth) advance(now time.Time) {
	if d.anchor.IsZero() {
		d.anchor = now
		return
	}
	for {
		next := d.anchor.Add(DecayPeriod)
		if now.Before(next) {
			return
		}
		d.anchor = next
		if d.saturated && d.limit > 0 && d.limit < d.ceiling {
			d.limit++
		}
		d.saturated = false
		if d.level > 0 {
			d.level--
		}
		if !d.lastEvent.IsZero() && next.Sub(d.lastEvent) >= ResetAfter {
			d.open, d.probing, d.level, d.limit, d.lastEvent, d.hintUntil = false, false, 0, 0, time.Time{}, time.Time{}
			d.signals = nil
			return
		}
	}
}

func later(a, b time.Time) time.Time {
	if b.After(a) {
		return b
	}
	return a
}

func cooldownFor(level int) time.Duration {
	return min(BaseCooldown<<level, MaxCooldown)
}

func pruneSignals(signals []rateLimitSignal, now time.Time) []rateLimitSignal {
	kept := signals[:0]
	for _, signal := range signals {
		if now.Sub(signal.at) <= StormWindow {
			kept = append(kept, signal)
		}
	}
	return kept
}

func stormAt(signals []rateLimitSignal, sessionID string, at time.Time) bool {
	sessions := map[string]bool{}
	count := 0
	var sessionFirst time.Time
	for _, signal := range signals {
		count++
		sessions[signal.sessionID] = true
		if signal.sessionID == sessionID && (sessionFirst.IsZero() || signal.at.Before(sessionFirst)) {
			sessionFirst = signal.at
		}
	}
	if count >= StormSignals && len(sessions) >= StormSessions {
		return true
	}
	return !sessionFirst.IsZero() && at.Sub(sessionFirst) >= SoloLimitedFor
}

// Candidate is one group member as admission sees it.
type Candidate struct {
	Index  int
	Tier   int
	Health HealthState
	Active int
	Limit  int
}

func (c Candidate) tier() int { return max(c.Tier, 1) }

// admissible reports whether a new session may start on the member now.
func (c Candidate) admissible() bool {
	return c.Health == Probing || c.Health == Healthy && c.Active < c.Limit
}

// Admit returns the indexes of candidates a new session may take, from the
// lowest tier that has an admissible member. When no member is admissible,
// it returns the least-loaded primary member with queued set: the session
// waits there rather than being refused.
func Admit(candidates []Candidate) (indexes []int, queued bool) {
	if len(candidates) == 0 {
		return nil, false
	}
	tiers := make([]int, 0, len(candidates))
	for _, candidate := range candidates {
		tiers = append(tiers, candidate.tier())
	}
	sort.Ints(tiers)
	for _, tier := range tiers {
		for _, candidate := range candidates {
			if candidate.tier() == tier && candidate.admissible() {
				indexes = append(indexes, candidate.Index)
			}
		}
		if len(indexes) > 0 {
			return indexes, false
		}
	}
	primary, best := tiers[0], -1
	for position, candidate := range candidates {
		if candidate.tier() != primary {
			continue
		}
		if best < 0 || candidate.Active < candidates[best].Active {
			best = position
		}
	}
	return []int{candidates[best].Index}, true
}

// Fallback returns the admissible candidates in the lowest tier above
// fromTier. The caller restricts candidates to the running session's runtime.
// It returns nil when none has headroom, and the session stays where it is.
func Fallback(candidates []Candidate, fromTier int) []int {
	fromTier = max(fromTier, 1)
	var best []int
	bestTier := 0
	for _, candidate := range candidates {
		if candidate.tier() <= fromTier || !candidate.admissible() {
			continue
		}
		switch {
		case best == nil || candidate.tier() < bestTier:
			best, bestTier = []int{candidate.Index}, candidate.tier()
		case candidate.tier() == bestTier:
			best = append(best, candidate.Index)
		}
	}
	return best
}

// Primary returns a primary member a session on a fallback may return to: a
// primary whose domain is healthy (clean for DecayPeriod) with headroom.
func Primary(candidates []Candidate) (index int, ok bool) {
	for _, candidate := range candidates {
		if candidate.tier() == 1 && candidate.Health == Healthy && candidate.Active < candidate.Limit {
			return candidate.Index, true
		}
	}
	return 0, false
}
