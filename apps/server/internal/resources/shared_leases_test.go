package resources_test

import (
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/resources"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// computeWithSlots reports the Mac's compute instance and sets its slots.
func (f *leaseFixture) computeWithSlots(slots int) string {
	f.t.Helper()
	compute := f.reportCompute(true)
	if err := f.service.SetSettings(f.ctx, "dev_mac", store.ResourceSourceSettings{AllowRemoteCommands: true, ComputeSlots: slots}, "usr_alice"); err != nil {
		f.t.Fatal(err)
	}
	return compute
}

func (f *leaseFixture) acquireMode(sessionID, mode string, wait time.Duration, ids ...string) ([]store.ResourceLease, error) {
	return f.leases.Acquire(f.ctx, resources.AcquireRequest{SessionID: sessionID, ResourceIDs: ids, Reason: "test", Wait: wait, Mode: mode})
}

func (f *leaseFixture) acquireModeAsync(sessionID, mode string, wait time.Duration, ids ...string) chan acquired {
	done := make(chan acquired, 1)
	go func() {
		leases, err := f.acquireMode(sessionID, mode, wait, ids...)
		done <- acquired{leases, err}
	}()
	return done
}

func (f *leaseFixture) resetCount() int {
	f.router.mu.Lock()
	defer f.router.mu.Unlock()
	return len(f.router.resets)
}

func (f *leaseFixture) turnEnded(sessionID string) {
	f.t.Helper()
	f.setStatus(sessionID, "completed")
	if err := f.leases.TurnEnded(f.ctx, sessionID, "completed"); err != nil {
		f.t.Fatal(err)
	}
}

// Compute leases are shared by default: sessions run side by side up to
// the slots, the first one fences the instance and later ones do not; one
// more is refused while the slots are full and granted once a holder's
// turn ends, since a parked lease takes no slot.
func TestSharedLeasesRunTogetherUpToSlots(t *testing.T) {
	f := newLeaseFixture(t)
	compute := f.computeWithSlots(2)
	a := f.mustAcquire("sess_a", compute)
	f.confirm()
	resets := f.resetCount()
	f.advance(time.Second)
	b := f.mustAcquire("sess_b", compute)
	if a.Mode != store.LeaseShared || b.Mode != store.LeaseShared || b.Generation <= a.Generation {
		t.Fatalf("leases = %+v %+v", a, b)
	}
	if f.resetCount() != resets {
		t.Fatalf("a shared lease joining another sent a reset: %+v", f.router.last())
	}
	for _, lease := range []store.ResourceLease{a, b} {
		ticket, err := f.leases.Begin(f.ctx, lease.ID, lease.HolderSessionID)
		if err != nil {
			t.Fatalf("begin %s: %v", lease.ID, err)
		}
		if err := f.leases.Finish(f.ctx, ticket, nil); err != nil {
			t.Fatal(err)
		}
	}
	instance := f.instance(compute)
	if instance.State != store.ResourceBusy || len(instance.Holders) != 2 || instance.Slots == nil ||
		*instance.Slots != (store.ResourceSlots{Capacity: 2, InUse: 2}) {
		t.Fatalf("instance with full slots = %+v slots %+v", instance, instance.Slots)
	}
	if _, err := f.acquire("sess_c", 0, compute); code(err) != resources.CodeBusy {
		t.Fatalf("a third shared lease on two slots = %v", err)
	}
	waiting := f.acquireAsync("sess_c", 10*time.Minute, compute)
	f.waitsFor(1)
	if contended := f.lease(a.ID); contended.PreemptAt == "" {
		t.Fatalf("the oldest active shared lease is not told someone waits: %+v", contended)
	}
	f.turnEnded("sess_a")
	result := receive(t, waiting)
	if result.err != nil || len(result.leases) != 1 || result.leases[0].Mode != store.LeaseShared {
		t.Fatalf("waiting shared lease = %+v %v", result.leases, result.err)
	}
	if parked := f.lease(a.ID); parked.State != store.LeaseParked || parked.PreemptAt != "" {
		t.Fatalf("a parked shared lease = %+v", parked)
	}
	instance = f.instance(compute)
	if len(instance.Holders) != 3 || instance.Slots.InUse != 2 {
		t.Fatalf("instance after = %+v slots %+v", instance.Holders, instance.Slots)
	}
	if listed := f.instance(compute); listed.Holder == nil || listed.Holder.Mode != store.LeaseShared {
		t.Fatalf("holder = %+v", listed.Holder)
	}
}

// An exclusive request waits for the shared holders and, queued, keeps new
// shared leases off (no starvation); it starts once the last one ended and
// the instance was reset. A shared lease does not become exclusive in place.
func TestExclusiveWaitsForSharedAndBlocksNewShared(t *testing.T) {
	f := newLeaseFixture(t)
	compute := f.computeWithSlots(4)
	a := f.mustAcquire("sess_a", compute)
	f.confirm()
	if _, err := f.acquireMode("sess_a", store.LeaseExclusive, 0, compute); code(err) != resources.CodeInvalid {
		t.Fatalf("upgrading a shared lease in place = %v", err)
	}
	exclusive := f.acquireModeAsync("sess_b", store.LeaseExclusive, 10*time.Minute, compute)
	f.waitsFor(1)
	if _, err := f.acquire("sess_c", 0, compute); code(err) != resources.CodeBusy {
		t.Fatalf("a shared lease behind a queued exclusive one = %v", err)
	}
	if contended := f.lease(a.ID); contended.PreemptAt == "" {
		t.Fatalf("shared holder not told an exclusive request waits: %+v", contended)
	}
	if _, err := f.leases.Release(f.ctx, a.ID, "sess_a"); err != nil {
		t.Fatal(err)
	}
	if reset := f.router.last(); reset.LeaseOnly || reset.Generation <= a.Generation {
		t.Fatalf("the last lease ending resets the instance: %+v", reset)
	}
	f.confirm()
	result := receive(t, exclusive)
	if result.err != nil || len(result.leases) != 1 || result.leases[0].Mode != store.LeaseExclusive {
		t.Fatalf("exclusive lease = %+v %v", result.leases, result.err)
	}
	if _, err := f.acquire("sess_c", 0, compute); code(err) != resources.CodeBusy {
		t.Fatalf("a shared lease beside an exclusive one = %v", err)
	}
	if instance := f.instance(compute); instance.State != store.ResourceBusy || instance.Holder.Mode != store.LeaseExclusive {
		t.Fatalf("instance with an exclusive holder = %+v", instance)
	}
}

// A parked shared lease without a hold neither blocks shared leases nor
// survives an exclusive request: it is yielded and the instance reset.
func TestParkedSharedLeaseYieldsToExclusive(t *testing.T) {
	f := newLeaseFixture(t)
	compute := f.computeWithSlots(1)
	a := f.mustAcquire("sess_a", compute)
	f.confirm()
	f.turnEnded("sess_a")
	b := f.mustAcquire("sess_b", compute)
	if b.State != store.LeaseActive || f.lease(a.ID).State != store.LeaseParked {
		t.Fatalf("shared lease beside a parked one = %+v, parked %+v", b, f.lease(a.ID))
	}
	if _, err := f.leases.Release(f.ctx, b.ID, "sess_b"); err != nil {
		t.Fatal(err)
	}
	if reset := f.router.last(); !reset.LeaseOnly || reset.Generation != b.Generation {
		t.Fatalf("a shared lease ending beside another = %+v", reset)
	}
	exclusive := f.acquireModeAsync("sess_c", store.LeaseExclusive, time.Minute, compute)
	f.waitsFor(1)
	if yielded := f.lease(a.ID); yielded.State != store.LeaseYielded {
		t.Fatalf("parked lease when an exclusive request waits = %+v", yielded)
	}
	// The instance reset (a was the last lease) and b's own reset both
	// come before the exclusive lease.
	f.confirm()
	select {
	case result := <-exclusive:
		t.Fatalf("exclusive lease before b's commands were stopped: %+v %v", result.leases, result.err)
	case <-time.After(50 * time.Millisecond):
	}
	if err := f.leases.ResetDone(f.ctx, compute, b.Generation, ""); err != nil {
		t.Fatal(err)
	}
	if result := receive(t, exclusive); result.err != nil || result.leases[0].Mode != store.LeaseExclusive {
		t.Fatalf("exclusive after the yield = %+v %v", result.leases, result.err)
	}
}

// A shared lease that ends beside others stops only its own commands: the
// others keep operating, an unconfirmed stop is asked again without making
// the instance unready, and a reconnect never fences the live leases.
func TestSharedLeaseEndsAlone(t *testing.T) {
	f := newLeaseFixture(t)
	compute := f.computeWithSlots(3)
	a := f.mustAcquire("sess_a", compute)
	f.confirm()
	b := f.mustAcquire("sess_b", compute)
	if _, err := f.leases.Release(f.ctx, a.ID, "sess_a"); err != nil {
		t.Fatal(err)
	}
	reset := f.router.last()
	if !reset.LeaseOnly || reset.Generation != a.Generation || reset.ResourceID != compute {
		t.Fatalf("reset of a shared lease = %+v", reset)
	}
	if ticket, err := f.leases.Begin(f.ctx, b.ID, "sess_b"); err != nil {
		t.Fatalf("the other shared lease after one ended: %v", err)
	} else if err := f.leases.Finish(f.ctx, ticket, nil); err != nil {
		t.Fatal(err)
	}
	// Unconfirmed in time: asked again, and the instance stays usable for
	// shared leases; an exclusive request waits for the confirmation.
	resets := f.resetCount()
	f.advance(time.Minute)
	f.sweep()
	if again := f.router.last(); f.resetCount() == resets || !again.LeaseOnly || again.Generation != a.Generation {
		t.Fatalf("an unconfirmed lease reset is not asked again: %+v", again)
	}
	if instance := f.instance(compute); instance.State == store.ResourceUnready {
		t.Fatalf("instance after an unconfirmed lease reset = %+v", instance)
	}
	f.mustAcquire("sess_c", compute)
	// A reconnect with shared leases live never fences past them.
	if err := f.leases.DeviceDisconnected(f.ctx, "dev_mac"); err != nil {
		t.Fatal(err)
	}
	if err := f.leases.DeviceConnected(f.ctx, "dev_mac"); err != nil {
		t.Fatal(err)
	}
	f.router.mu.Lock()
	for _, reset := range f.router.resets {
		if !reset.LeaseOnly && reset.Generation > b.Generation {
			f.router.mu.Unlock()
			t.Fatalf("a reset fenced live shared lease %s (generation %d): %+v", b.ID, b.Generation, reset)
		}
	}
	f.router.mu.Unlock()
	if ticket, err := f.leases.Begin(f.ctx, b.ID, "sess_b"); err != nil {
		t.Fatalf("the shared lease after a reconnect: %v", err)
	} else if err := f.leases.Finish(f.ctx, ticket, nil); err != nil {
		t.Fatal(err)
	}
}

// Screens stay exclusive: a shared request is refused and a second
// session waits.
func TestComputerUseStaysExclusive(t *testing.T) {
	f := newLeaseFixture(t)
	if _, err := f.acquireMode("sess_a", store.LeaseShared, 0, f.screen); code(err) != resources.CodeInvalid {
		t.Fatalf("a shared screen = %v", err)
	}
	if lease := f.mustAcquire("sess_a", f.screen); lease.Mode != store.LeaseExclusive {
		t.Fatalf("screen lease = %+v", lease)
	}
	if _, err := f.acquire("sess_b", 0, f.screen); code(err) != resources.CodeBusy {
		t.Fatalf("a second session on a screen = %v", err)
	}
	if instance := f.instance(f.screen); instance.Slots != nil {
		t.Fatalf("screen slots = %+v", instance.Slots)
	}
}

// Waits are served in the order they came whatever their mode: an
// exclusive wait queued between shared ones goes before the later one.
func TestMixedWaitsKeepTheirOrder(t *testing.T) {
	f := newLeaseFixture(t)
	compute := f.computeWithSlots(1)
	a := f.mustAcquire("sess_a", compute)
	f.confirm()
	exclusive := f.acquireModeAsync("sess_b", store.LeaseExclusive, 10*time.Minute, compute)
	f.waitsFor(1)
	shared := f.acquireAsync("sess_c", 10*time.Minute, compute)
	f.waitsFor(2)
	if _, err := f.leases.Release(f.ctx, a.ID, "sess_a"); err != nil {
		t.Fatal(err)
	}
	f.confirm()
	first := receive(t, exclusive)
	if first.err != nil {
		t.Fatalf("exclusive first = %v", first.err)
	}
	if _, err := f.leases.Release(f.ctx, first.leases[0].ID, "sess_b"); err != nil {
		t.Fatal(err)
	}
	f.confirm()
	if second := receive(t, shared); second.err != nil || second.leases[0].Mode != store.LeaseShared {
		t.Fatalf("shared second = %+v %v", second.leases, second.err)
	}
}

// A worker that cannot run shared leases side by side gets one at a time.
func TestOldWorkerGetsOneLeaseAtATime(t *testing.T) {
	f := newLeaseFixture(t)
	f.leases.SharedLeases = func(string) bool { return false }
	compute := f.computeWithSlots(4)
	f.mustAcquire("sess_a", compute)
	f.confirm()
	if _, err := f.acquire("sess_b", 0, compute); code(err) != resources.CodeBusy {
		t.Fatalf("a second lease on an old worker = %v", err)
	}
	if slots := f.instance(compute).Slots; slots == nil || slots.Capacity != 1 {
		t.Fatalf("slots on an old worker = %+v", slots)
	}
}

// Reconnecting fences below the oldest live shared lease, not past it.
func TestReconnectKeepsSharedLeases(t *testing.T) {
	f := newLeaseFixture(t)
	compute := f.computeWithSlots(2)
	a := f.mustAcquire("sess_a", compute)
	f.confirm()
	f.mustAcquire("sess_b", compute)
	if err := f.leases.DeviceDisconnected(f.ctx, "dev_mac"); err != nil {
		t.Fatal(err)
	}
	if err := f.leases.DeviceConnected(f.ctx, "dev_mac"); err != nil {
		t.Fatal(err)
	}
	if reset := f.router.last(); reset.ResourceID != compute || reset.Generation != a.Generation || reset.LeaseOnly {
		t.Fatalf("reconnect reset = %+v", reset)
	}
}

func TestAutoSlots(t *testing.T) {
	for _, tc := range []struct {
		cpus, memory string
		want         int
	}{
		{"10", "16", 4}, {"64", "252", 16}, {"8", "15", 3}, {"2", "8", 1}, {"4", "15", 2}, {"2", "2", 1}, {"", "", 1},
	} {
		if got := resources.AutoSlots(map[string]string{"cpus": tc.cpus, "memoryGiB": tc.memory}); got != tc.want {
			t.Errorf("AutoSlots(%s CPUs, %s GiB) = %d, want %d", tc.cpus, tc.memory, got, tc.want)
		}
	}
}

// The device's lease policy keeps a workspace's sessions off its
// resources: they are refused, and those holding a lease lose it when the
// owner adds their workspace to the deny list.
func TestLeasePolicyRefusesWorkspaces(t *testing.T) {
	f := newLeaseFixture(t)
	compute := f.computeWithSlots(4)
	deny := func(workspaces ...string) {
		t.Helper()
		if err := f.service.SetSettings(f.ctx, "dev_mac", store.ResourceSourceSettings{AllowRemoteCommands: true, ComputeSlots: 4, DenyWorkspaces: workspaces}, "usr_alice"); err != nil {
			t.Fatal(err)
		}
	}
	deny("ws_sess_a")
	if _, err := f.acquire("sess_a", 0, compute); code(err) != resources.CodeRefused {
		t.Fatalf("a session of a denied workspace = %v", err)
	}
	b := f.mustAcquire("sess_b", compute)
	deny("ws_sess_a", "ws_sess_b")
	if ended := f.lease(b.ID); ended.State != store.LeaseRevoked {
		t.Fatalf("lease of a workspace denied afterwards = %+v", ended)
	}
	if err := f.service.SetSettings(f.ctx, "dev_mac", store.ResourceSourceSettings{AllowRemoteCommands: true, AllowWorkspaces: []string{"ws_sess_c"}}, "usr_alice"); err != nil {
		t.Fatal(err)
	}
	f.confirm()
	if _, err := f.acquire("sess_b", 0, compute); code(err) != resources.CodeRefused {
		t.Fatalf("a workspace outside the allow list = %v", err)
	}
	f.mustAcquire("sess_c", compute)
}
