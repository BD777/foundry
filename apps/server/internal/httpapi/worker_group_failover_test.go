package httpapi

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/modelpool"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// failoverFixture is a child session in a worker group whose members run on
// two accounts of one device: tier 1 (model-a) on profile_lineage and tier 2
// (model-b) on profile_fallback. The child runs on the tier 1 member.
func failoverFixture(t *testing.T) *childReportFixture {
	t.Helper()
	ctx := context.Background()
	db := newTestStore(t)
	if err := db.RegisterDaemon(ctx, store.DaemonRegistration{
		Device:    store.DeviceProjection{ID: "dev_lineage", Label: "Studio", Status: "connected", LastSeenLabel: "online"},
		Workspace: store.WorkspaceProjection{ID: "ws_lineage", Name: "Foundry", LocalPath: t.TempDir()},
		Agents: []store.AgentProjection{
			{ID: "agent_lineage", WorkspaceID: "ws_lineage", DeviceID: "dev_lineage", Provider: "claude", ProfileID: "profile_lineage",
				Status: "healthy", AuthMode: "local_config", SecretStored: "local", ConfigScope: "workspace", ConfigLabel: "local", LastSeenLabel: "online"},
			{ID: "agent_fallback", WorkspaceID: "ws_lineage", DeviceID: "dev_lineage", Provider: "claude", ProfileID: "profile_fallback",
				Status: "healthy", AuthMode: "local_config", SecretStored: "local", ConfigScope: "workspace", ConfigLabel: "local", LastSeenLabel: "online"},
		},
	}); err != nil {
		t.Fatalf("register daemon: %v", err)
	}
	parent, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{
		WorkspaceID: "ws_lineage", AgentID: "agent_lineage", Provider: "claude", Prompt: "parent task", Source: "chat",
	})
	if err != nil {
		t.Fatalf("create parent: %v", err)
	}
	if parent, err = db.StartAgentSession(ctx, parent.ID); err != nil {
		t.Fatalf("start parent: %v", err)
	}
	group, err := db.SaveWorkerGroup(ctx, store.StoredWorkerGroup{
		OwnerUserID: "user_lineage", Label: "Tiered",
		Members: []store.WorkerGroupMember{
			{ProviderKind: "subscription", ProviderID: "profile_lineage", Runtime: "claude", Model: "model-a", Tier: 1},
			{ProviderKind: "subscription", ProviderID: "profile_fallback", Runtime: "claude", Model: "model-b", Tier: 2},
		},
	})
	if err != nil {
		t.Fatalf("save group: %v", err)
	}
	child, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{
		WorkspaceID: "ws_lineage", AgentID: "agent_lineage", Provider: "claude",
		ProfileID: "profile_lineage", Model: "model-a", WorkerGroupID: group.ID,
		Prompt: "retry this input once", Source: "agent", ParentSessionID: parent.ID,
	})
	if err != nil {
		t.Fatalf("create child: %v", err)
	}
	if child, err = db.StartAgentSession(ctx, child.ID); err != nil {
		t.Fatalf("start child: %v", err)
	}
	f := &childReportFixture{t: t, db: db, server: NewServer(db), parent: parent, child: child}
	connection := newDaemonConnection(f.server.hub, nil)
	connection.registration = store.DaemonRegistration{Capabilities: []string{store.DaemonCapabilityDispatchRetry}}
	f.server.hub.connections["dev_lineage"] = connection
	t.Cleanup(func() { delete(f.server.hub.connections, "dev_lineage") })
	return f
}

// openAccountBreaker opens the breaker of profileID's Claude account with a
// storm: three rate-limit signals from two other sessions.
func openAccountBreaker(t *testing.T, f *childReportFixture, profileID string) {
	t.Helper()
	now := time.Now().UTC()
	domain := memberDomain(profileID, "claude")
	for index, session := range []string{"sess_storm_a", "sess_storm_b", "sess_storm_a"} {
		f.server.hub.health.observeRateLimit(domain, session, now.Add(time.Duration(index)*time.Second), 2, 0)
	}
	if state := f.server.hub.health.snapshot(domain, now.Add(3*time.Second), 0).State; state != modelpool.Limited {
		t.Fatalf("breaker of %s = %s, want limited", profileID, state)
	}
}

func retryRowFor(t *testing.T, f *childReportFixture) store.SessionRetry {
	t.Helper()
	retry, found, err := f.db.GetSessionRetry(context.Background(), f.child.ID, f.child.Input.ID)
	if err != nil || !found {
		t.Fatalf("session retry = %+v found=%v err=%v", retry, found, err)
	}
	return retry
}

// With the tier 1 account's breaker open, a rate-limited retry moves to the
// tier 2 member after a short settle, and claiming it runs on that account.
func TestBreakerOpenFailsOverToTierTwo(t *testing.T) {
	f := failoverFixture(t)
	openAccountBreaker(t, f, "profile_lineage")
	if !failRetryAttempt(t, f, 1) {
		t.Fatal("the rate-limited turn was not retried")
	}
	retry := retryRowFor(t, f)
	if retry.NextProfileID != "profile_fallback" || retry.NextModel != "model-b" {
		t.Fatalf("retry moved to %q/%q, want profile_fallback/model-b", retry.NextProfileID, retry.NextModel)
	}
	if wait := time.Until(retry.NextAttemptAt); wait > 10*time.Second {
		t.Fatalf("fallback retry waits %s, want a short settle", wait)
	}
	claimed, err := f.db.ClaimAgentSessionRetry(context.Background(), retry, time.Now().Add(time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	if claimed.ProfileID != "profile_fallback" || claimed.Model != "model-b" {
		t.Fatalf("claimed retry runs on %s/%s, want profile_fallback/model-b", claimed.ProfileID, claimed.Model)
	}
	events, _, err := f.db.AgentSessionEventWindow(context.Background(), f.child.ID, "", 50)
	if err != nil {
		t.Fatal(err)
	}
	if !hasMemberEvent(events, "Fallback model-b") {
		t.Fatalf("no failover note in events: %+v", events)
	}
}

// One isolated 429 on a healthy account keeps the same model.
func TestIsolatedRateLimitKeepsTheSameModel(t *testing.T) {
	f := failoverFixture(t)
	if !failRetryAttempt(t, f, 1) {
		t.Fatal("the rate-limited turn was not retried")
	}
	retry := retryRowFor(t, f)
	if retry.NextProfileID != "" || retry.NextModel != "model-a" {
		t.Fatalf("isolated 429 moved to %q/%q, want the same model", retry.NextProfileID, retry.NextModel)
	}
}

// A manual switch to a same-group member rewrites the pending retry and makes
// it due now.
func TestManualSwitchRewritesPendingRetryAndRunsNow(t *testing.T) {
	f := failoverFixture(t)
	ctx := context.Background()
	if !failRetryAttempt(t, f, 1) {
		t.Fatal("the rate-limited turn was not retried")
	}
	input := store.SendAgentSessionInput{ProfileID: "profile_fallback", Model: "model-b"}
	applied, err := f.server.applyRunningMemberSwitch(ctx, f.child, &input)
	if err != nil || !applied {
		t.Fatalf("applied=%v err=%v, want the switch taken", applied, err)
	}
	if input.ProfileID != "" || input.Model != "" {
		t.Fatalf("input keeps member fields %+v", input)
	}
	retry := retryRowFor(t, f)
	if retry.NextProfileID != "profile_fallback" || retry.NextModel != "model-b" {
		t.Fatalf("retry = %q/%q, want the switched member", retry.NextProfileID, retry.NextModel)
	}
	due, err := f.db.DueSessionRetries(ctx, time.Now().UTC().Add(time.Second), 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(due) != 1 {
		t.Fatalf("due retries = %d, want the switched retry now", len(due))
	}
	if memberSwitch, ok := f.server.memberSwitchFor(ctx, f.child); !ok || memberSwitch.State != "retry_now" {
		t.Fatalf("member switch = %+v, %v; want retry_now", memberSwitch, ok)
	}
}

// A switch while the session runs is taken, reported as next_turn, and
// applied to the next turn once the running one settles.
func TestRunningSwitchIsDeferredToTheNextTurn(t *testing.T) {
	f := failoverFixture(t)
	ctx := context.Background()
	input := store.SendAgentSessionInput{ProfileID: "profile_fallback", Model: "model-b"}
	applied, err := f.server.applyRunningMemberSwitch(ctx, f.child, &input)
	if err != nil || !applied {
		t.Fatalf("applied=%v err=%v, want the switch taken", applied, err)
	}
	running, err := f.db.GetAgentSessionRecord(ctx, f.child.ID)
	if err != nil || running.Model != "model-a" || running.ProfileID != "profile_lineage" {
		t.Fatalf("running session moved mid-turn: %+v, %v", running, err)
	}
	if memberSwitch, ok := f.server.memberSwitchFor(ctx, running); !ok || memberSwitch.State != "next_turn" {
		t.Fatalf("member switch = %+v, %v; want next_turn", memberSwitch, ok)
	}
	settled := f.finish("first turn done")
	next := store.SendAgentSessionInput{Prompt: "second turn"}
	if err := f.server.chooseRuntimeSwitch(ctx, settled, &next); err != nil {
		t.Fatal(err)
	}
	if next.ProfileID != "profile_fallback" || next.Model != "model-b" {
		t.Fatalf("next turn input = %s/%s, want the deferred switch", next.ProfileID, next.Model)
	}
	if _, ok, _ := f.db.GetPendingSessionMember(ctx, f.child.ID); ok {
		t.Fatal("the deferred switch was not consumed by the next turn")
	}
}

// A session on the fallback stays there while its primary is limited, and
// returns to the primary once the primary's breaker has recovered.
func TestSettledSessionReturnsToPrimaryAfterRecovery(t *testing.T) {
	f := failoverFixture(t)
	ctx := context.Background()
	input := store.SendAgentSessionInput{ProfileID: "profile_fallback", Model: "model-b"}
	if _, err := f.server.applyRunningMemberSwitch(ctx, f.child, &input); err != nil {
		t.Fatal(err)
	}
	settled := f.finish("first turn done")
	next := store.SendAgentSessionInput{Prompt: "second turn"}
	if err := f.server.chooseRuntimeSwitch(ctx, settled, &next); err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.SendAgentSessionInput(ctx, settled.ID, next); err != nil {
		t.Fatal(err)
	}
	onFallback := f.finish("second turn done")

	openAccountBreaker(t, f, "profile_lineage")
	stays := store.SendAgentSessionInput{Prompt: "third turn"}
	if err := f.server.chooseRuntimeSwitch(ctx, onFallback, &stays); err != nil {
		t.Fatal(err)
	}
	if stays.ProfileID != "" || stays.Model != "" {
		t.Fatalf("session left the fallback while its primary is limited: %+v", stays)
	}

	f.server.hub.health = newMemberHealth()
	back := store.SendAgentSessionInput{Prompt: "third turn"}
	if err := f.server.chooseRuntimeSwitch(ctx, onFallback, &back); err != nil {
		t.Fatal(err)
	}
	if back.ProfileID != "profile_lineage" || back.Model != "model-a" {
		t.Fatalf("after recovery the next turn = %s/%s, want the primary", back.ProfileID, back.Model)
	}
}

// With the tier 1 account's breaker open, admission chooses the tier 2 member
// and the routing note explains why.
func TestAdmissionChoosesTierTwoWhenTierOneIsOpen(t *testing.T) {
	f := failoverFixture(t)
	ctx := context.Background()
	openAccountBreaker(t, f, "profile_lineage")
	group, err := f.db.GetWorkerGroup(ctx, f.child.WorkerGroupID)
	if err != nil {
		t.Fatal(err)
	}
	workspace, err := f.db.GetWorkspace(ctx, "ws_lineage")
	if err != nil {
		t.Fatal(err)
	}
	member, err := f.server.chooseWorkerGroupMember(ctx, group, workspace)
	if err != nil {
		t.Fatal(err)
	}
	if member.ProviderID != "profile_fallback" || member.Model != "model-b" {
		t.Fatalf("admission chose %s/%s, want the tier 2 member", member.ProviderID, member.Model)
	}
	note, err := f.server.memberRoutingNote(ctx, group, member)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(note, "Fallback model-b") || !strings.Contains(note, "rate limited") {
		t.Fatalf("routing note = %q", note)
	}
}

// The group view reports each account's breaker: state, cooldown and the
// signals in the window.
func TestWorkerGroupViewReportsDomainState(t *testing.T) {
	f := failoverFixture(t)
	ctx := context.Background()
	openAccountBreaker(t, f, "profile_lineage")
	group, err := f.db.GetWorkerGroup(ctx, f.child.WorkerGroupID)
	if err != nil {
		t.Fatal(err)
	}
	view, err := f.server.workerGroupView(ctx, group)
	if err != nil {
		t.Fatal(err)
	}
	if len(view.Domains) != 2 {
		t.Fatalf("domains = %+v, want one per account", view.Domains)
	}
	primary := view.Domains[0]
	if primary.ProfileID != "profile_lineage" || primary.State != store.WorkerGroupDomainState(modelpool.Limited) ||
		primary.CooldownUntil == "" || primary.SignalsInWindow < 3 || primary.Active != 2 {
		t.Fatalf("primary domain = %+v", primary)
	}
}

// A restart replays the storm from the stored events of the active sessions.
func TestRestartReplaysRateLimitStormFromEvents(t *testing.T) {
	f := failoverFixture(t)
	ctx := context.Background()
	at := time.Now().UTC().Add(-time.Minute).Format(time.RFC3339Nano)
	for index, sessionID := range []string{f.child.ID, f.parent.ID, f.child.ID} {
		if err := f.db.AppendAgentSessionEvent(ctx, store.AgentSessionEvent{
			ID: "evt_storm_" + string(rune('a'+index)), SessionID: sessionID, At: at,
			Label: store.ProcessLabelRateLimited, Detail: "Rate limited", Level: "warning",
		}); err != nil {
			t.Fatal(err)
		}
	}
	restarted := NewServer(f.db)
	if err := restarted.restoreMemberHealth(ctx, time.Now().UTC()); err != nil {
		t.Fatal(err)
	}
	if state := restarted.hub.health.snapshot(memberDomain("profile_lineage", "claude"), time.Now().UTC(), 0).State; state != modelpool.Limited {
		t.Fatalf("breaker after restart = %s, want limited", state)
	}
}

func hasMemberEvent(events []store.AgentSessionEvent, text string) bool {
	for _, event := range events {
		if event.Label == "Worker group member" && strings.Contains(event.Detail, text) {
			return true
		}
	}
	return false
}
