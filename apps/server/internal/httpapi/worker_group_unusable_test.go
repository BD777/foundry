package httpapi

import (
	"context"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/modelpool"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

const arrearsFailure = "402 The account associated with the API Key is in arrears and the accessed service ID has been isolated"

// A billing-arrears failure opens the primary account's breaker at once and
// moves the session to the tier 2 member on another account.
func TestArrearsFailureOpensBreakerAndFailsOver(t *testing.T) {
	f := failoverFixture(t)
	if !failRetryAttemptAs(t, f, 1, arrearsFailure, "") {
		t.Fatal("the arrears turn did not fail over")
	}
	retry := retryRowFor(t, f)
	if retry.NextProfileID != "profile_fallback" || retry.NextModel != "model-b" {
		t.Fatalf("arrears retry moved to %q/%q, want profile_fallback/model-b", retry.NextProfileID, retry.NextModel)
	}
	status := f.server.hub.health.snapshot(memberDomain("profile_lineage", "claude"), time.Now().UTC(), 0)
	if status.State != modelpool.Limited || status.Reason != "402" {
		t.Fatalf("primary account = %+v, want limited with reason 402", status)
	}
	events, _, err := f.db.AgentSessionEventWindow(context.Background(), f.child.ID, "", 50)
	if err != nil {
		t.Fatal(err)
	}
	if !hasMemberEvent(events, "Fallback model-b") {
		t.Fatalf("no failover note in events: %+v", events)
	}
}

// With no same-runtime member that has headroom, the arrears failure fails
// the session as it did before.
func TestArrearsFailureWithoutFallbackFailsAsBefore(t *testing.T) {
	f := failoverFixture(t)
	openAccountBreaker(t, f, "profile_fallback")
	if failRetryAttemptAs(t, f, 1, arrearsFailure, "") {
		t.Fatal("an arrears turn with no fallback was scheduled to retry")
	}
	retry, found, err := f.db.GetSessionRetry(context.Background(), f.child.ID, f.child.Input.ID)
	if err != nil || found && retry.Status != store.SessionRetryExhausted {
		t.Fatalf("retry = %+v found=%v err=%v, want exhausted or none", retry, found, err)
	}
}

// Admission skips the unusable account, and the domain view says why.
func TestAdmissionSkipsAnUnusableAccountAndShowsTheReason(t *testing.T) {
	f := failoverFixture(t)
	if !failRetryAttemptAs(t, f, 1, arrearsFailure, "") {
		t.Fatal("the arrears turn did not fail over")
	}
	ctx := context.Background()
	group, err := f.db.GetWorkerGroup(ctx, f.child.WorkerGroupID)
	if err != nil {
		t.Fatal(err)
	}
	member, queued, err := f.server.admitMember(ctx, group.Members, "")
	if err != nil {
		t.Fatal(err)
	}
	if member.ProviderID != "profile_fallback" || queued {
		t.Fatalf("admitted %s (queued %v), want profile_fallback without queueing", member.ProviderID, queued)
	}
	view, err := f.server.workerGroupView(ctx, group)
	if err != nil {
		t.Fatal(err)
	}
	for _, domain := range view.Domains {
		if domain.ProfileID != "profile_lineage" {
			continue
		}
		if domain.State != store.WorkerGroupDomainState("limited") || domain.Reason != "402" {
			t.Fatalf("domain view = %+v, want limited with reason 402", domain)
		}
		return
	}
	t.Fatalf("no domain view for profile_lineage in %+v", view.Domains)
}

// After the cooldown the account admits one probe; a successful probe closes
// the breaker and clears the reason.
func TestAccountUnusableRecoversByProbeAfterCooldown(t *testing.T) {
	f := failoverFixture(t)
	if !failRetryAttemptAs(t, f, 1, arrearsFailure, "") {
		t.Fatal("the arrears turn did not fail over")
	}
	domain := memberDomain("profile_lineage", "claude")
	probeAt := time.Now().UTC().Add(modelpool.UnusableCooldown + time.Minute)
	if state := f.server.hub.health.snapshot(domain, probeAt, 0).State; state != modelpool.Probing {
		t.Fatalf("after the cooldown the account is %s, want probing", state)
	}
	if !f.server.hub.health.reserve(domain, probeAt) {
		t.Fatal("the probe was not reserved after the cooldown")
	}
	f.server.hub.health.observeSuccess(domain, probeAt)
	if status := f.server.hub.health.snapshot(domain, probeAt, 0); status.State != modelpool.Healthy || status.Reason != "" {
		t.Fatalf("after a successful probe = %+v, want healthy without reason", status)
	}
}

// A session outside any worker group keeps its failure: no retry, no failover.
func TestNonGroupArrearsFailureIsUnchanged(t *testing.T) {
	f := failoverFixture(t)
	ctx := context.Background()
	solo, err := f.db.CreateAgentSession(ctx, store.CreateAgentSessionInput{
		WorkspaceID: "ws_lineage", AgentID: "agent_lineage", Provider: "claude",
		ProfileID: "profile_lineage", Model: "model-a", Prompt: "solo task", Source: "agent", ParentSessionID: f.parent.ID,
	})
	if err != nil {
		t.Fatal(err)
	}
	if solo, err = f.db.StartAgentSession(ctx, solo.ID); err != nil {
		t.Fatal(err)
	}
	scheduled, err := f.server.sessionRetries.Failed(ctx, solo, arrearsFailure)
	if err != nil {
		t.Fatal(err)
	}
	if scheduled {
		t.Fatal("a session outside a worker group was scheduled to retry")
	}
	retry, found, err := f.db.GetSessionRetry(ctx, solo.ID, solo.Input.ID)
	if err != nil || found && retry.Status != store.SessionRetryExhausted {
		t.Fatalf("retry = %+v found=%v err=%v, want exhausted or none", retry, found, err)
	}
}

// A settled session on the fallback member stays there while the primary's
// account is unusable: the return to the primary waits for a probe to succeed.
func TestSettledSessionNeverReturnsToAnUnusablePrimary(t *testing.T) {
	f := failoverFixture(t)
	ctx := context.Background()
	onFallback, err := f.db.CreateAgentSession(ctx, store.CreateAgentSessionInput{
		WorkspaceID: "ws_lineage", AgentID: "agent_fallback", Provider: "claude",
		ProfileID: "profile_fallback", Model: "model-b", WorkerGroupID: f.child.WorkerGroupID,
		Prompt: "settled task", Source: "agent", ParentSessionID: f.parent.ID,
	})
	if err != nil {
		t.Fatal(err)
	}
	if onFallback, err = f.db.StartAgentSession(ctx, onFallback.ID); err != nil {
		t.Fatal(err)
	}
	if onFallback.ProfileID != "profile_fallback" || onFallback.Model != "model-b" {
		t.Fatalf("setup: session runs on %s/%s, want profile_fallback/model-b", onFallback.ProfileID, onFallback.Model)
	}
	f.server.hub.observeAccountUnusable(ctx, f.child, arrearsFailure, "402")
	member, moved, err := f.server.settledTurnMember(ctx, onFallback)
	if err != nil {
		t.Fatal(err)
	}
	if moved {
		t.Fatalf("settled session moved to %s/%s while the primary account is unusable", member.ProviderID, member.Model)
	}
}

// A restart rebuilds the unusable breaker from the stored observation: the
// account stays limited until its cooldown ends, then admits one probe.
// Observations older than the restore window and out of cooldown are not replayed.
func TestRestartRebuildsAccountUnusableBreaker(t *testing.T) {
	f := failoverFixture(t)
	if !failRetryAttemptAs(t, f, 1, arrearsFailure, "") {
		t.Fatal("the arrears turn did not fail over")
	}
	ctx := context.Background()
	stale := time.Now().UTC().Add(-accountUnusableRestoreWindow - time.Hour)
	if err := f.db.RecordAccountUnusable(ctx, store.AccountUnusableObservation{
		Runtime: "claude", ProfileID: "profile_fallback", SessionID: "sess_stale", Reason: "402",
		ObservedAt: stale, CooldownUntil: stale.Add(time.Hour),
	}); err != nil {
		t.Fatal(err)
	}
	restarted := NewServer(f.db)
	if err := restarted.restoreMemberHealth(ctx, time.Now().UTC()); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	status := restarted.hub.health.snapshot(memberDomain("profile_lineage", "claude"), now, 0)
	if status.State != modelpool.Limited || status.Reason != "402" {
		t.Fatalf("restarted primary = %+v, want limited with reason 402", status)
	}
	if status := restarted.hub.health.snapshot(memberDomain("profile_fallback", "claude"), now, 0); status.State != modelpool.Healthy || status.Reason != "" {
		t.Fatalf("restarted fallback = %+v, want healthy: its observation is out of the window", status)
	}
	probeAt := now.Add(modelpool.UnusableCooldown + time.Minute)
	if state := restarted.hub.health.snapshot(memberDomain("profile_lineage", "claude"), probeAt, 0).State; state != modelpool.Probing {
		t.Fatalf("after the cooldown the restarted primary is %s, want probing", state)
	}
}
