package modelpool

import (
	"testing"
	"time"
)

var t0 = time.Date(2026, 11, 17, 0, 0, 0, 0, time.UTC)

func TestStormOpensBreakerFromTwoSessions(t *testing.T) {
	h := NewHealthTracker()
	if h.Observe("acc", "s1", t0, 4, 0) {
		t.Fatal("one signal must not open the breaker")
	}
	if h.Observe("acc", "s2", t0.Add(10*time.Second), 4, 0) {
		t.Fatal("two signals must not open the breaker")
	}
	if !h.Observe("acc", "s1", t0.Add(20*time.Second), 4, 0) {
		t.Fatal("three signals from two sessions in 2 minutes must open the breaker")
	}
	status := h.Snapshot("acc", t0.Add(20*time.Second), 0, 4)
	if status.State != Limited {
		t.Fatalf("state = %s, want limited", status.State)
	}
	if want := t0.Add(20*time.Second + BaseCooldown); !status.CooldownUntil.Equal(want) {
		t.Fatalf("cooldown until %s, want %s", status.CooldownUntil, want)
	}
	if status.Limit != 2 {
		t.Fatalf("limit after storm = %d, want half of 4 active", status.Limit)
	}
}

func TestOneSessionLimitedLongOpensAlone(t *testing.T) {
	h := NewHealthTracker()
	h.Observe("acc", "s1", t0, 1, 0)
	if h.Observe("acc", "s1", t0.Add(30*time.Second), 1, 0) {
		t.Fatal("30 seconds of one session must not open the breaker")
	}
	if !h.Observe("acc", "s1", t0.Add(SoloLimitedFor), 1, 0) {
		t.Fatal("a session limited for 60 seconds must open the breaker")
	}
}

func TestHalfOpenAdmitsExactlyOneProbe(t *testing.T) {
	h := NewHealthTracker()
	openAt := openedBreaker(h, t0)
	after := openAt.Add(BaseCooldown)
	if got := h.Snapshot("acc", after, 0, 0).State; got != Probing {
		t.Fatalf("state after cooldown = %s, want probing", got)
	}
	if !h.Reserve("acc", after) {
		t.Fatal("the first probe must be reserved")
	}
	if h.Reserve("acc", after.Add(time.Second)) {
		t.Fatal("a second probe must not be reserved while the first is in flight")
	}
	if got := h.Snapshot("acc", after.Add(time.Second), 0, 0).State; got != Limited {
		t.Fatalf("state with probe in flight = %s, want limited", got)
	}
}

func TestProbeSuccessClosesBreaker(t *testing.T) {
	h := NewHealthTracker()
	openAt := openedBreaker(h, t0)
	after := openAt.Add(BaseCooldown)
	h.Reserve("acc", after)
	h.Succeeded("acc", after.Add(5*time.Second))
	if got := h.Snapshot("acc", after.Add(5*time.Second), 0, 0).State; got == Limited || got == Probing {
		t.Fatalf("state after probe success = %s, want closed", got)
	}
}

func TestProbeFailureDoublesCooldown(t *testing.T) {
	h := NewHealthTracker()
	openAt := openedBreaker(h, t0)
	after := openAt.Add(BaseCooldown)
	h.Reserve("acc", after)
	if !h.Observe("acc", "s1", after.Add(time.Second), 1, 0) {
		t.Fatal("a rate limit on the probe must reopen the breaker")
	}
	status := h.Snapshot("acc", after.Add(time.Second), 0, 0)
	if want := after.Add(time.Second + 2*BaseCooldown); !status.CooldownUntil.Equal(want) {
		t.Fatalf("cooldown after failed probe until %s, want %s (doubled)", status.CooldownUntil, want)
	}
}

func TestCooldownCapsAtMax(t *testing.T) {
	if got := cooldownFor(maxLevel + 5); got != MaxCooldown {
		t.Fatalf("cooldown at high level = %s, want %s", got, MaxCooldown)
	}
	if got := cooldownFor(0); got != BaseCooldown {
		t.Fatalf("base cooldown = %s, want %s", got, BaseCooldown)
	}
}

func TestDecayHalvesLevelEachCleanPeriod(t *testing.T) {
	h := NewHealthTracker()
	openAt := openedBreaker(h, t0)
	after := openAt.Add(BaseCooldown)
	h.Reserve("acc", after)
	h.Observe("acc", "s1", after.Add(time.Second), 1, 0)
	level := h.domains["acc"].level
	if level != 2 {
		t.Fatalf("level after two openings = %d, want 2", level)
	}
	h.Snapshot("acc", after.Add(time.Second+DecayPeriod), 0, 0)
	if got := h.domains["acc"].level; got != level-1 {
		t.Fatalf("level after one clean period = %d, want %d", got, level-1)
	}
}

func TestThirtyCleanMinutesResetToDefaults(t *testing.T) {
	h := NewHealthTracker()
	openAt := openedBreaker(h, t0)
	h.Snapshot("acc", openAt.Add(ResetAfter+time.Minute), 0, 0)
	status := h.Snapshot("acc", openAt.Add(ResetAfter+time.Minute), 0, 0)
	if status.State != Healthy || status.Level != 0 || status.Limit != DefaultConcurrency {
		t.Fatalf("after %s clean: %+v, want healthy level 0 default limit", ResetAfter, status)
	}
}

func TestRetryAfterHintExtendsCooldown(t *testing.T) {
	h := NewHealthTracker()
	hint := 9 * time.Minute
	h.Observe("acc", "s1", t0, 1, hint)
	h.Observe("acc", "s2", t0, 1, 0)
	if !h.Observe("acc", "s1", t0.Add(time.Second), 1, 0) {
		t.Fatal("storm expected on the third signal")
	}
	status := h.Snapshot("acc", t0.Add(time.Second), 0, 1)
	if want := t0.Add(hint); status.CooldownUntil.Before(want) {
		t.Fatalf("cooldown until %s, want at least the Retry-After %s", status.CooldownUntil, want)
	}
}

func TestLimitGrowsOnlyUnderSaturation(t *testing.T) {
	h := NewHealthTracker()
	openAt := openedBreaker(h, t0)
	h.Snapshot("acc", openAt.Add(BaseCooldown), 0, 0)
	start := h.Snapshot("acc", openAt.Add(BaseCooldown), 0, 0).Limit
	idle := h.Snapshot("acc", openAt.Add(BaseCooldown+DecayPeriod+time.Second), 0, 0).Limit
	if idle != start {
		t.Fatalf("idle domain limit %d grew from %d, want no growth without saturation", idle, start)
	}
	h.Snapshot("acc", openAt.Add(BaseCooldown+DecayPeriod+time.Second), 0, start)
	grown := h.Snapshot("acc", openAt.Add(BaseCooldown+2*DecayPeriod+time.Second), 0, 0).Limit
	if grown != start+1 {
		t.Fatalf("saturated domain limit = %d, want %d", grown, start+1)
	}
}

func TestLimitRespectsDeclaredCeiling(t *testing.T) {
	h := NewHealthTracker()
	if got := h.Snapshot("acc", t0, 2, 0).Limit; got != 2 {
		t.Fatalf("limit with ceiling 2 = %d", got)
	}
}

func TestAdmitPrefersLowestTierWithHeadroom(t *testing.T) {
	members := []Candidate{
		{Index: 0, Tier: 1, Health: Limited, Active: 0, Limit: 4},
		{Index: 1, Tier: 2, Health: Healthy, Active: 0, Limit: 4},
	}
	indexes, queued := Admit(members)
	if queued || len(indexes) != 1 || indexes[0] != 1 {
		t.Fatalf("admit = %v queued=%v, want the fallback tier 2 member", indexes, queued)
	}
}

func TestAdmitQueuesOnLeastLoadedPrimaryWhenNothingHasHeadroom(t *testing.T) {
	members := []Candidate{
		{Index: 0, Tier: 1, Health: Limited, Active: 3, Limit: 4},
		{Index: 1, Tier: 1, Health: Limited, Active: 1, Limit: 4},
		{Index: 2, Tier: 2, Health: Limited, Active: 0, Limit: 4},
	}
	indexes, queued := Admit(members)
	if !queued || len(indexes) != 1 || indexes[0] != 1 {
		t.Fatalf("admit = %v queued=%v, want queue on least-loaded primary 1", indexes, queued)
	}
}

func TestAdmitUsesProbeMemberOnceAndSkipsRecovering(t *testing.T) {
	members := []Candidate{
		{Index: 0, Tier: 1, Health: Recovering, Active: 0, Limit: 4},
		{Index: 1, Tier: 2, Health: Probing, Active: 0, Limit: 4},
	}
	indexes, queued := Admit(members)
	if queued || len(indexes) != 1 || indexes[0] != 1 {
		t.Fatalf("admit = %v queued=%v, want probe member 1 over recovering primary", indexes, queued)
	}
}

func TestFallbackAndReturn(t *testing.T) {
	limitedPrimary := []Candidate{
		{Index: 0, Tier: 1, Health: Limited, Active: 4, Limit: 4},
		{Index: 1, Tier: 2, Health: Healthy, Active: 0, Limit: 4},
	}
	if got := Fallback(limitedPrimary, 1); len(got) != 1 || got[0] != 1 {
		t.Fatalf("fallback = %v, want tier 2 member", got)
	}
	if got := Fallback(limitedPrimary, 2); got != nil {
		t.Fatalf("fallback from tier 2 = %v, want none (never a lower tier)", got)
	}
	healed := []Candidate{
		{Index: 0, Tier: 1, Health: Healthy, Active: 0, Limit: 4},
		{Index: 1, Tier: 2, Health: Healthy, Active: 0, Limit: 4},
	}
	if index, ok := Primary(healed); !ok || index != 0 {
		t.Fatalf("primary = %d %v, want the healthy tier 1 member", index, ok)
	}
	recovering := []Candidate{{Index: 0, Tier: 1, Health: Recovering, Active: 0, Limit: 4}}
	if _, ok := Primary(recovering); ok {
		t.Fatal("a recovering primary must not take a session back")
	}
}

// openedBreaker opens the breaker of "acc" at t and returns when it opened.
func openedBreaker(h *HealthTracker, at time.Time) time.Time {
	h.Observe("acc", "s1", at, 2, 0)
	h.Observe("acc", "s2", at.Add(time.Second), 2, 0)
	h.Observe("acc", "s1", at.Add(2*time.Second), 2, 0)
	return at.Add(2 * time.Second)
}

func TestSnapshotCountsSignalsAndFailovers(t *testing.T) {
	h := NewHealthTracker()
	h.Observe("acc", "s1", t0, 2, 0)
	h.Observe("acc", "s2", t0.Add(time.Second), 2, 0)
	h.RecordFailover("acc", t0.Add(2*time.Second))
	status := h.Snapshot("acc", t0.Add(3*time.Second), 0, 0)
	if status.SignalsInWindow != 2 || status.FailoversLastHour != 1 {
		t.Fatalf("signals=%d failovers=%d, want 2 and 1", status.SignalsInWindow, status.FailoversLastHour)
	}
	later := h.Snapshot("acc", t0.Add(FailoverWindow+time.Minute), 0, 0)
	if later.SignalsInWindow != 0 || later.FailoversLastHour != 0 {
		t.Fatalf("after the windows: signals=%d failovers=%d, want 0 and 0", later.SignalsInWindow, later.FailoversLastHour)
	}
}

func TestRetryAfterFloorIsCappedAtMaxCooldown(t *testing.T) {
	h := NewHealthTracker()
	h.Observe("acc", "s1", t0, 1, 24*time.Hour)
	h.Observe("acc", "s2", t0, 1, 0)
	if !h.Observe("acc", "s1", t0.Add(time.Second), 1, 0) {
		t.Fatal("storm expected on the third signal")
	}
	if until := h.Snapshot("acc", t0.Add(time.Second), 0, 1).CooldownUntil; until.After(t0.Add(MaxCooldown)) {
		t.Fatalf("cooldown until %s, want at most %s after the first signal", until, t0.Add(MaxCooldown))
	}
}
