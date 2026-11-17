package modelpool

import (
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

	// UnusableCooldown is the open period of an account-unusable breaker when
	// the provider names no reset time; a named reset time is honoured up to
	// MaxUnusableCooldown, so a misread date cannot lock an account for good.
	UnusableCooldown    = time.Hour
	MaxUnusableCooldown = 24 * time.Hour

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
	// Reason names why the domain's account is unusable, e.g. "402", while
	// the breaker is open for that. Empty for rate limits.
	Reason string
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
	// reason is set while the account is unusable. It is kept until a probe
	// succeeds, so clean time alone never clears the breaker.
	reason string
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

// ObserveUnusable opens the domain's breaker for an account-unusable failure
// (reason names it, e.g. "402"). Retrying in a few seconds cannot help, so the
// breaker stays open for cooldown and then admits exactly one probe.
func (t *HealthTracker) ObserveUnusable(key string, at time.Time, cooldown time.Duration, reason string) {
	d := t.domain(key)
	d.advance(at)
	d.lastEvent, d.anchor, d.saturated = at, at, false
	d.open, d.probing = true, false
	d.cooldownUntil = at.Add(cooldown)
	d.reason = reason
}

// UnusableCooldownFor is the open period for an account-unusable failure: the
// provider's reset hint when it names one (zero when none), else
// UnusableCooldown, never beyond MaxUnusableCooldown.
func UnusableCooldownFor(hint time.Duration) time.Duration {
	if hint <= 0 {
		return UnusableCooldown
	}
	return min(hint, MaxUnusableCooldown)
}

// Succeeded records a successful model request on the domain. It closes a
// half-open breaker: the probe worked.
func (t *HealthTracker) Succeeded(key string, at time.Time) {
	d := t.domain(key)
	d.advance(at)
	if d.open && !at.Before(d.cooldownUntil) {
		d.open, d.reason = false, ""
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
	status := DomainStatus{State: d.state(now), Level: d.level, Limit: d.limit, Reason: d.reason}
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
		if !d.lastEvent.IsZero() && next.Sub(d.lastEvent) >= ResetAfter && d.reason == "" {
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

// admissible reports whether the member takes a new session at the primary
// tier: its breaker is closed with headroom, or it holds the half-open probe.
func (c Candidate) admissible() bool {
	return c.Health == Probing || c.Health == Healthy && c.Active < c.Limit
}

// spillable reports whether a lower tier takes a session from the member: its
// breaker is closed (healthy or recovering) with headroom. A probe is never a
// spill target.
func (c Candidate) spillable() bool {
	return (c.Health == Healthy || c.Health == Recovering) && c.Active < c.Limit
}

// recovering reports whether the member is a closed breaker still within
// DecayPeriod of a rate limit, with headroom: the last choice before a queue.
func (c Candidate) recovering() bool {
	return c.Health == Recovering && c.Active < c.Limit
}

func (c Candidate) probing() bool { return c.Health == Probing }

// Admit returns the indexes of candidates a new session may take, in this
// order: a primary member that is admissible; the lowest lower tier with a
// spillable member (closed breakers only); a recovering primary; a lower
// tier's probe, only when every primary member is limited, so a half-open
// account is tested rather than left dead. Otherwise the session queues on the
// least-loaded primary, preferring one whose breaker is not open. It never
// refuses and never returns an open (limited) member unless it queues.
func Admit(candidates []Candidate) (indexes []int, queued bool) {
	if len(candidates) == 0 {
		return nil, false
	}
	primary := lowestTier(candidates)
	if indexes = membersWhere(candidates, primary, Candidate.admissible); len(indexes) > 0 {
		return indexes, false
	}
	if indexes = lowestSpillTier(candidates, primary, Candidate.spillable); len(indexes) > 0 {
		return indexes, false
	}
	if indexes = membersWhere(candidates, primary, Candidate.recovering); len(indexes) > 0 {
		return indexes, false
	}
	if allLimited(candidates, primary) {
		if indexes = lowestSpillTier(candidates, primary, Candidate.probing); len(indexes) > 0 {
			return indexes, false
		}
	}
	return []int{leastLoadedPrimary(candidates, primary)}, true
}

func lowestTier(candidates []Candidate) int {
	lowest := candidates[0].tier()
	for _, candidate := range candidates {
		lowest = min(lowest, candidate.tier())
	}
	return lowest
}

// membersWhere returns the indexes of the candidates in tier that satisfy ok.
func membersWhere(candidates []Candidate, tier int, ok func(Candidate) bool) []int {
	var indexes []int
	for _, candidate := range candidates {
		if candidate.tier() == tier && ok(candidate) {
			indexes = append(indexes, candidate.Index)
		}
	}
	return indexes
}

// lowestSpillTier returns the satisfying candidates of the lowest tier above
// primary, nil when no tier above primary has one.
func lowestSpillTier(candidates []Candidate, primary int, ok func(Candidate) bool) []int {
	tier := 0
	for _, candidate := range candidates {
		if candidate.tier() > primary && ok(candidate) && (tier == 0 || candidate.tier() < tier) {
			tier = candidate.tier()
		}
	}
	if tier == 0 {
		return nil
	}
	return membersWhere(candidates, tier, ok)
}

func allLimited(candidates []Candidate, primary int) bool {
	for _, candidate := range candidates {
		if candidate.tier() == primary && candidate.Health != Limited {
			return false
		}
	}
	return true
}

// leastLoadedPrimary is the primary member a session queues on: the least
// loaded one whose breaker is not open, or the least loaded of all when every
// primary is open.
func leastLoadedPrimary(candidates []Candidate, primary int) int {
	best := -1
	for _, allowLimited := range []bool{false, true} {
		for position, candidate := range candidates {
			if candidate.tier() != primary || !allowLimited && candidate.Health == Limited {
				continue
			}
			if best < 0 || candidate.Active < candidates[best].Active {
				best = position
			}
		}
		if best >= 0 {
			break
		}
	}
	return candidates[best].Index
}

// Fallback returns the spillable candidates in the lowest tier above
// fromTier. The caller restricts candidates to the running session's runtime.
// It returns nil when none has headroom with a closed breaker, and the session
// stays where it is.
func Fallback(candidates []Candidate, fromTier int) []int {
	fromTier = max(fromTier, 1)
	var best []int
	bestTier := 0
	for _, candidate := range candidates {
		if candidate.tier() <= fromTier || !candidate.spillable() {
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
