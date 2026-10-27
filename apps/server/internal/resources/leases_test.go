package resources_test

import (
	"context"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/resources"
	"github.com/foundry-dev/foundry/apps/server/internal/sqlitestore"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// fakeRouter records the resets the leases send; tests confirm them.
type fakeRouter struct {
	mu     sync.Mutex
	resets []store.ResourceResetRequest
}

func (r *fakeRouter) SendReset(sourceID string, request store.ResourceResetRequest) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.resets = append(r.resets, request)
	return true
}

func (r *fakeRouter) Operate(context.Context, string, store.ResourceOperateRequest) (store.ResourceOperateResult, error) {
	return store.ResourceOperateResult{}, nil
}

// lastAt waits briefly for a reset of generation: resets are routed just
// after the lease changes commit, so a test that saw the commit may be early.
func (r *fakeRouter) lastAt(generation int64) store.ResourceResetRequest {
	deadline := time.Now().Add(5 * time.Second)
	for {
		reset := r.last()
		if reset.Generation >= generation || time.Now().After(deadline) {
			return reset
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func (r *fakeRouter) last() store.ResourceResetRequest {
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.resets) == 0 {
		return store.ResourceResetRequest{}
	}
	return r.resets[len(r.resets)-1]
}

type leaseFixture struct {
	t        *testing.T
	ctx      context.Context
	db       *sqlitestore.Store
	service  *resources.Service
	leases   *resources.Leases
	router   *fakeRouter
	mu       sync.Mutex
	now      time.Time
	sessions map[string]resources.SessionInfo
	screen   string
	other    string
}

func newLeaseFixture(t *testing.T) *leaseFixture {
	t.Helper()
	db, err := sqlitestore.Open(filepath.Join(t.TempDir(), "foundry.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	f := &leaseFixture{t: t, ctx: context.Background(), db: db, router: &fakeRouter{},
		now: time.Date(2026, 10, 13, 8, 0, 0, 0, time.UTC), sessions: map[string]resources.SessionInfo{}}
	f.service = resources.NewService(db)
	f.service.Now = f.clock
	f.attach()
	f.report(true)
	f.screen = resources.InstanceID("dev_mac", "computer_use/macos/console:501")
	f.other = resources.InstanceID("dev_mac", "computer_use/macos/console:502")
	for _, id := range []string{"sess_a", "sess_b", "sess_c"} {
		f.sessions[id] = resources.SessionInfo{Status: "running", WorkspaceID: "ws_" + id, DeviceID: "dev_linux", UserID: "usr_alice"}
	}
	return f
}

// attach builds the leases over the fixture's store, as a server start does.
func (f *leaseFixture) attach() {
	f.leases = resources.NewLeases(f.service, f.db)
	f.leases.Router = f.router
	f.leases.Session = func(_ context.Context, id string) (resources.SessionInfo, error) {
		f.mu.Lock()
		defer f.mu.Unlock()
		info, ok := f.sessions[id]
		if !ok {
			return info, store.ErrNotFound
		}
		return info, nil
	}
}

func (f *leaseFixture) clock() time.Time {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.now
}

func (f *leaseFixture) advance(d time.Duration) {
	f.mu.Lock()
	f.now = f.now.Add(d)
	f.mu.Unlock()
}

func (f *leaseFixture) setStatus(sessionID, status string) {
	f.mu.Lock()
	info := f.sessions[sessionID]
	info.Status = status
	f.sessions[sessionID] = info
	f.mu.Unlock()
}

// report has the Mac report two desktops (console 501 and 502), with
// cua-driver ready or not.
func (f *leaseFixture) report(ready bool, keys ...string) {
	f.t.Helper()
	if len(keys) == 0 {
		keys = []string{"computer_use/macos/console:501", "computer_use/macos/console:502"}
	}
	readiness := store.ResourceReadiness{Ready: ready, Level: "permitted"}
	if !ready {
		readiness = store.ResourceReadiness{Ready: false, Level: "configured", Reason: "Accessibility not granted to CuaDriver.app", Missing: []string{"tcc_accessibility"}}
	}
	report := store.ResourcesReport{ScannerVersion: 1}
	for _, key := range keys {
		report.Instances = append(report.Instances, store.DetectedResource{
			Key: key, Type: "computer_use", Platform: "macos", Name: "Mac screen " + key[len(key)-3:], Detector: "computer_use.macos.cua-driver@1",
			Readiness: readiness, Backends: []store.ResourceBackend{{ID: "cua-driver", Version: "0.34.1", Mode: "remote_ops", Readiness: readiness}},
		})
	}
	if _, err := f.service.Report(f.ctx, mac, report); err != nil {
		f.t.Fatal(err)
	}
}

func (f *leaseFixture) acquire(sessionID string, wait time.Duration, ids ...string) ([]store.ResourceLease, error) {
	return f.leases.Acquire(f.ctx, resources.AcquireRequest{SessionID: sessionID, ResourceIDs: ids, Reason: "test", Wait: wait})
}

func (f *leaseFixture) mustAcquire(sessionID string, ids ...string) store.ResourceLease {
	f.t.Helper()
	leases, err := f.acquire(sessionID, 0, ids...)
	if err != nil || len(leases) != len(ids) {
		f.t.Fatalf("%s acquiring %v: %v %+v", sessionID, ids, err, leases)
	}
	return leases[0]
}

func (f *leaseFixture) lease(id string) store.ResourceLease {
	f.t.Helper()
	lease, err := f.leases.Lease(f.ctx, id)
	if err != nil {
		f.t.Fatal(err)
	}
	return lease
}

func (f *leaseFixture) sweep() {
	f.t.Helper()
	if err := f.leases.Sweep(f.ctx); err != nil {
		f.t.Fatal(err)
	}
}

// confirm has the Mac confirm its latest reset.
func (f *leaseFixture) confirm() {
	f.t.Helper()
	reset := f.router.last()
	if err := f.leases.ResetDone(f.ctx, reset.ResourceID, reset.Generation, ""); err != nil {
		f.t.Fatal(err)
	}
}

func (f *leaseFixture) instance(id string) store.ResourceInstance {
	f.t.Helper()
	list, err := f.service.List(f.ctx, store.ResourceFilter{})
	if err != nil {
		f.t.Fatal(err)
	}
	for _, instance := range list.Instances {
		if instance.ID == id {
			return instance
		}
	}
	f.t.Fatalf("instance %s not listed", id)
	return store.ResourceInstance{}
}

func (f *leaseFixture) waitsFor(n int) {
	f.t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		waits, err := f.db.ListResourceWaits(f.ctx)
		if err != nil {
			f.t.Fatal(err)
		}
		if len(waits) == n {
			return
		}
		if time.Now().After(deadline) {
			f.t.Fatalf("%d waits, want %d", len(waits), n)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

type acquired struct {
	leases []store.ResourceLease
	err    error
}

func (f *leaseFixture) acquireAsync(sessionID string, wait time.Duration, ids ...string) chan acquired {
	done := make(chan acquired, 1)
	go func() {
		leases, err := f.acquire(sessionID, wait, ids...)
		done <- acquired{leases, err}
	}()
	return done
}

func receive(t *testing.T, done chan acquired) acquired {
	t.Helper()
	select {
	case result := <-done:
		return result
	case <-time.After(5 * time.Second):
		t.Fatal("acquire never returned")
		return acquired{}
	}
}

func code(err error) string {
	if refusal, ok := err.(*resources.LeaseError); ok {
		return refusal.Code
	}
	if err == nil {
		return ""
	}
	return "error: " + err.Error()
}

// A free instance is leased at once, active while the turn runs, at a new
// generation; the Mac is fenced and told. Another session asking without
// waiting is told who holds it; the inventory lists it busy with its holder.
func TestAcquireFreeAndBusy(t *testing.T) {
	f := newLeaseFixture(t)
	lease := f.mustAcquire("sess_a", f.screen)
	if lease.State != store.LeaseActive || lease.Generation != 1 || lease.HolderSessionID != "sess_a" || lease.ParkUntil != "" {
		t.Fatalf("lease = %+v", lease)
	}
	if reset := f.router.last(); reset.Generation != 1 || reset.ResourceID != f.screen || !strings.Contains(reset.Notify, "now using") {
		t.Fatalf("reset = %+v", reset)
	}
	_, err := f.acquire("sess_b", 0, f.screen)
	if code(err) != resources.CodeBusy || err.(*resources.LeaseError).Holder.SessionID != "sess_a" {
		t.Fatalf("second acquire = %v", err)
	}
	if waits, _ := f.db.ListResourceWaits(f.ctx); len(waits) != 0 {
		t.Fatalf("a refused acquire left waits %+v", waits)
	}
	instance := f.instance(f.screen)
	if instance.State != store.ResourceBusy || instance.Holder == nil || instance.Holder.SessionID != "sess_a" || instance.Holder.WorkspaceID != "ws_sess_a" {
		t.Fatalf("instance = %+v", instance)
	}
	again := f.mustAcquire("sess_a", f.screen)
	if again.ID != lease.ID {
		t.Fatalf("asking again for a held lease made %s, want %s", again.ID, lease.ID)
	}
}

// What is not ready or not leasable is refused with the reason.
func TestAcquireRefusesWhatCannotBeLeased(t *testing.T) {
	f := newLeaseFixture(t)
	f.report(false)
	if _, err := f.acquire("sess_a", 0, f.screen); code(err) != resources.CodeUnready || !strings.Contains(err.Error(), "Accessibility") {
		t.Fatalf("unready = %v", err)
	}
	if _, err := f.service.Report(f.ctx, mac, store.ResourcesReport{Instances: []store.DetectedResource{
		{Key: "gpu/0", Type: "gpu", Platform: "macos", Name: "GPU", Readiness: store.ResourceReadiness{Ready: true, Level: "installed"}},
	}}); err != nil {
		t.Fatal(err)
	}
	if _, err := f.acquire("sess_a", 0, resources.InstanceID("dev_mac", "gpu/0")); code(err) != resources.CodeNotLeasable {
		t.Fatalf("gpu = %v", err)
	}
	if _, err := f.acquire("sess_a", 0, "res_missing"); code(err) != resources.CodeNotFound {
		t.Fatalf("missing = %v", err)
	}
}

// The turn is the keep-alive: completed parks the lease for ParkTTL, a new
// turn makes it active again; nothing expires while the turn runs.
func TestTurnsParkAndReactivate(t *testing.T) {
	f := newLeaseFixture(t)
	lease := f.mustAcquire("sess_a", f.screen)
	f.advance(3 * time.Hour)
	f.sweep()
	if got := f.lease(lease.ID); got.State != store.LeaseActive {
		t.Fatalf("an active lease after 3 hours of turn = %+v", got)
	}
	f.setStatus("sess_a", "completed")
	if err := f.leases.TurnEnded(f.ctx, "sess_a", "completed"); err != nil {
		t.Fatal(err)
	}
	parked := f.lease(lease.ID)
	if parked.State != store.LeaseParked || parked.ParkUntil != f.clock().Add(10*time.Minute).Format(time.RFC3339Nano) {
		t.Fatalf("parked = %+v", parked)
	}
	f.setStatus("sess_a", "running")
	if err := f.leases.TurnStarted(f.ctx, "sess_a"); err != nil {
		t.Fatal(err)
	}
	if got := f.lease(lease.ID); got.State != store.LeaseActive || got.ParkUntil != "" {
		t.Fatalf("reactivated = %+v", got)
	}
}

// A turn the agent runs on its own (a timer's, or its follow-up after
// background work) is a turn: a lease acquired in it is active, it parks
// when that turn ends, and a waiter gets it only then. The session's
// status says "completed" throughout.
func TestAgentTurnKeepsLeasesActive(t *testing.T) {
	f := newLeaseFixture(t)
	f.setStatus("sess_a", "completed")
	if err := f.leases.AgentTurn(f.ctx, "sess_a", "dev_linux", true); err != nil {
		t.Fatal(err)
	}
	lease := f.mustAcquire("sess_a", f.screen)
	if lease.State != store.LeaseActive || lease.ParkUntil != "" {
		t.Fatalf("acquired in the agent's own turn = %+v", lease)
	}
	f.confirm()
	done := f.acquireAsync("sess_b", time.Minute, f.screen)
	f.waitsFor(1)
	f.sweep()
	select {
	case result := <-done:
		t.Fatalf("a waiter got a lease in use: %+v %v", result.leases, result.err)
	default:
	}
	if got := f.lease(lease.ID); got.State != store.LeaseActive || got.HolderSessionID != "sess_a" {
		t.Fatalf("with a waiter during the turn = %+v", got)
	}
	if err := f.leases.AgentTurn(f.ctx, "sess_a", "dev_linux", false); err != nil {
		t.Fatal(err)
	}
	if got := f.lease(lease.ID); got.State != store.LeaseYielded {
		t.Fatalf("once the turn ended, with a waiter = %+v", got)
	}
	f.confirm()
	result := receive(t, done)
	if result.err != nil || result.leases[0].HolderSessionID != "sess_b" {
		t.Fatalf("the waiter got = %+v %v", result.leases, result.err)
	}
}

// Its leases park when the agent's own turn ends, and are active again
// when the next one starts. A turn the session's input runs is not ended
// by it, and an input that completes while the agent's own turn runs does
// not park them.
func TestAgentTurnParksWhenItEnds(t *testing.T) {
	f := newLeaseFixture(t)
	f.setStatus("sess_a", "completed")
	_ = f.leases.AgentTurn(f.ctx, "sess_a", "dev_linux", true)
	lease := f.mustAcquire("sess_a", f.screen)
	_ = f.leases.AgentTurn(f.ctx, "sess_a", "dev_linux", false)
	parked := f.lease(lease.ID)
	if parked.State != store.LeaseParked || parked.ParkUntil != f.clock().Add(10*time.Minute).Format(time.RFC3339Nano) {
		t.Fatalf("after the agent's own turn = %+v", parked)
	}
	_ = f.leases.AgentTurn(f.ctx, "sess_a", "dev_linux", true)
	if got := f.lease(lease.ID); got.State != store.LeaseActive || got.ParkUntil != "" {
		t.Fatalf("in its next turn = %+v", got)
	}
	// Told after the session's input completed: it still runs.
	if err := f.leases.TurnEnded(f.ctx, "sess_a", "completed"); err != nil {
		t.Fatal(err)
	}
	if got := f.lease(lease.ID); got.State != store.LeaseActive {
		t.Fatalf("an input completing during the agent's own turn = %+v", got)
	}
	// Its input runs when the agent's own turn ends: the input's turn keeps it.
	f.setStatus("sess_a", "running")
	_ = f.leases.AgentTurn(f.ctx, "sess_a", "dev_linux", false)
	if got := f.lease(lease.ID); got.State != store.LeaseActive {
		t.Fatalf("the agent's own turn ended while the input runs = %+v", got)
	}
	f.setStatus("sess_a", "completed")
	_ = f.leases.TurnEnded(f.ctx, "sess_a", "completed")
	if got := f.lease(lease.ID); got.State != store.LeaseParked {
		t.Fatalf("after the input = %+v", got)
	}
	// The device going takes the agent's own turns with it.
	_ = f.leases.AgentTurn(f.ctx, "sess_a", "dev_linux", true)
	_ = f.leases.DeviceDisconnected(f.ctx, "dev_linux")
	_ = f.leases.TurnEnded(f.ctx, "sess_a", "completed")
	if got := f.lease(lease.ID); got.State != store.LeaseParked {
		t.Fatalf("after its device went = %+v", got)
	}
}

// A parked lease expires after ParkTTL; operating it outside a turn (a
// background continuation) keeps it longer; holdFor keeps it to the hold.
func TestParkedLeasesExpireUnlessUsedOrHeld(t *testing.T) {
	f := newLeaseFixture(t)
	lease := f.mustAcquire("sess_a", f.screen)
	f.setStatus("sess_a", "completed")
	_ = f.leases.TurnEnded(f.ctx, "sess_a", "completed")
	f.advance(8 * time.Minute)
	ticket, err := f.leases.Begin(f.ctx, lease.ID, "sess_a")
	if err != nil {
		t.Fatal(err)
	}
	_ = f.leases.Finish(f.ctx, ticket, nil)
	f.advance(8 * time.Minute)
	f.sweep()
	if got := f.lease(lease.ID); got.State != store.LeaseParked {
		t.Fatalf("operated 8 minutes ago = %+v", got)
	}
	f.advance(3 * time.Minute)
	f.sweep()
	if got := f.lease(lease.ID); got.State != store.LeaseExpired || got.EndedBy != "foundry" {
		t.Fatalf("after the park = %+v", got)
	}
	if !f.instance(f.screen).Resetting {
		t.Fatal("an expired lease's instance is not being reset")
	}

	f.confirm()
	hold := 40 * time.Minute
	held, err := f.leases.Acquire(f.ctx, resources.AcquireRequest{SessionID: "sess_b", ResourceIDs: []string{f.screen}, HoldFor: &hold})
	if err != nil {
		t.Fatal(err)
	}
	f.setStatus("sess_b", "completed")
	_ = f.leases.TurnEnded(f.ctx, "sess_b", "completed")
	f.advance(30 * time.Minute)
	f.sweep()
	if got := f.lease(held[0].ID); got.State != store.LeaseParked {
		t.Fatalf("held 40 minutes, after 30 = %+v", got)
	}
	f.advance(11 * time.Minute)
	f.sweep()
	if got := f.lease(held[0].ID); got.State != store.LeaseExpired {
		t.Fatalf("after the hold = %+v", got)
	}
	tooLong := 5 * time.Hour
	f.confirm()
	capped, _ := f.leases.Acquire(f.ctx, resources.AcquireRequest{SessionID: "sess_c", ResourceIDs: []string{f.screen}, HoldFor: &tooLong})
	if until := capped[0].HoldUntil; until != f.clock().Add(2*time.Hour).Format(time.RFC3339Nano) {
		t.Fatalf("hold of 5 hours capped at %s", until)
	}
}

// A failed or canceled turn releases its leases at once.
func TestFailedOrCanceledTurnReleases(t *testing.T) {
	for _, status := range []string{"failed", "canceled"} {
		f := newLeaseFixture(t)
		lease := f.mustAcquire("sess_a", f.screen)
		f.setStatus("sess_a", status)
		if err := f.leases.TurnEnded(f.ctx, "sess_a", status); err != nil {
			t.Fatal(err)
		}
		if got := f.lease(lease.ID); got.State != store.LeaseReleased || !strings.Contains(got.EndReason, status) {
			t.Fatalf("%s: lease = %+v", status, got)
		}
	}
}

// A parked lease without a hold yields to a session that asks, even
// without waiting; the new holder gets it once the Mac confirmed the
// reset, at a newer generation, and the old holder is refused and told.
func TestParkedLeaseYieldsAfterReset(t *testing.T) {
	f := newLeaseFixture(t)
	first := f.mustAcquire("sess_a", f.screen)
	f.setStatus("sess_a", "completed")
	_ = f.leases.TurnEnded(f.ctx, "sess_a", "completed")

	done := f.acquireAsync("sess_b", 0, f.screen)
	f.waitsFor(1)
	if got := f.lease(first.ID); got.State != store.LeaseYielded {
		t.Fatalf("parked lease = %+v", got)
	}
	reset := f.router.lastAt(2)
	if reset.Generation != 2 || !strings.Contains(reset.Reason, "yielded") {
		t.Fatalf("reset = %+v", reset)
	}
	f.confirm()
	result := receive(t, done)
	if result.err != nil || result.leases[0].Generation != 3 || result.leases[0].HolderSessionID != "sess_b" {
		t.Fatalf("yielded to = %+v %v", result.leases, result.err)
	}
	if _, err := f.leases.Begin(f.ctx, first.ID, "sess_a"); code(err) != resources.CodeLeaseEnded {
		t.Fatalf("the old holder operating = %v", err)
	}
	notices := f.leases.Notices(f.ctx, "sess_a")
	if len(notices) != 1 || !strings.Contains(notices[0], "yielded") {
		t.Fatalf("old holder notices = %v", notices)
	}
	if again := f.leases.Notices(f.ctx, "sess_a"); len(again) != 0 {
		t.Fatalf("an ended lease is told twice: %v", again)
	}
}

// Someone waiting makes a lease contended: the holder is told in every
// notice, warned a minute before, and preempted after 15 minutes, but
// only once its operation in flight ended. The waiter then gets it.
func TestContendedLeaseIsPreempted(t *testing.T) {
	f := newLeaseFixture(t)
	lease := f.mustAcquire("sess_a", f.screen)
	done := f.acquireAsync("sess_b", 10*time.Minute, f.screen)
	f.waitsFor(1)
	contended := f.lease(lease.ID)
	if contended.PreemptAt != f.clock().Add(15*time.Minute).Format(time.RFC3339Nano) {
		t.Fatalf("contended = %+v", contended)
	}
	if notices := f.leases.Notices(f.ctx, "sess_a"); len(notices) != 1 || !strings.Contains(notices[0], "waiting") {
		t.Fatalf("notices = %v", notices)
	}
	if instance := f.instance(f.screen); instance.Queue != 1 || instance.Holder.PreemptAt == "" {
		t.Fatalf("listed = %+v", instance)
	}
	f.advance(14*time.Minute + 30*time.Second)
	f.sweep()
	if notices := f.leases.Notices(f.ctx, "sess_a"); len(notices) != 1 || !strings.HasPrefix(notices[0], "Last warning") {
		t.Fatalf("notices a minute before = %v", notices)
	}
	ticket, err := f.leases.Begin(f.ctx, lease.ID, "sess_a")
	if err != nil {
		t.Fatal(err)
	}
	f.advance(time.Minute)
	f.sweep()
	if got := f.lease(lease.ID); got.State != store.LeaseActive {
		t.Fatalf("preempted during an operation: %+v", got)
	}
	if _, err := f.leases.Begin(f.ctx, lease.ID, "sess_a"); code(err) != resources.CodeLeaseEnded {
		t.Fatalf("a new operation past preemptAt = %v", err)
	}
	if err := f.leases.Finish(f.ctx, ticket, []store.ResourceOperationRecord{{Op: "click", Status: "ok", StartedAt: f.clock().Format(time.RFC3339Nano)}}); err != nil {
		t.Fatal(err)
	}
	if got := f.lease(lease.ID); got.State != store.LeasePreempted {
		t.Fatalf("after the operation = %+v", got)
	}
	f.confirm()
	result := receive(t, done)
	if result.err != nil || result.leases[0].HolderSessionID != "sess_b" {
		t.Fatalf("waiter = %+v %v", result.leases, result.err)
	}
	if records, _ := f.leases.Operations(f.ctx, f.screen, 10); len(records) != 1 || records[0].SessionID != "sess_a" {
		t.Fatalf("audit = %+v", records)
	}
}

// The person may let a contended holder finish once: preemption moves by
// another 15 minutes.
func TestLetFinishPostponesPreemptionOnce(t *testing.T) {
	f := newLeaseFixture(t)
	lease := f.mustAcquire("sess_a", f.screen)
	f.acquireAsync("sess_b", 10*time.Minute, f.screen)
	f.waitsFor(1)
	before := f.lease(lease.ID).PreemptAt
	extended, err := f.leases.LetFinish(f.ctx, f.screen)
	if err != nil || extended.PreemptAt == before {
		t.Fatalf("let finish = %+v %v", extended, err)
	}
	if _, err := f.leases.LetFinish(f.ctx, f.screen); code(err) != resources.CodeInvalid {
		t.Fatalf("second let finish = %v", err)
	}
	f.advance(16 * time.Minute)
	f.sweep()
	if got := f.lease(lease.ID); got.State != store.LeaseActive {
		t.Fatalf("after 16 minutes, let finish = %+v", got)
	}
}

// No hold-and-wait: a holder cannot wait for more; several instances are
// taken all at once or not at all.
func TestNoHoldAndWaitAndAllOrNothing(t *testing.T) {
	f := newLeaseFixture(t)
	f.mustAcquire("sess_a", f.screen)
	if _, err := f.acquire("sess_a", time.Minute, f.other); code(err) != resources.CodeHoldAndWait {
		t.Fatalf("holding and waiting = %v", err)
	}
	if _, err := f.acquire("sess_b", 0, f.screen, f.other); code(err) != resources.CodeBusy {
		t.Fatalf("all or nothing = %v", err)
	}
	if f.instance(f.other).Holder != nil {
		t.Fatal("a refused all-or-nothing acquire took one instance")
	}
	both := f.mustAcquire("sess_a", f.other)
	if both.ResourceID != f.other {
		t.Fatalf("taking a free one without waiting while holding = %+v", both)
	}
}

// Waits are served first come first served, all at once for several
// instances; a later wait never jumps one in front of it.
func TestWaitsAreFirstComeFirstServed(t *testing.T) {
	f := newLeaseFixture(t)
	a := f.mustAcquire("sess_a", f.screen)
	pair := f.acquireAsync("sess_b", 10*time.Minute, f.screen, f.other)
	f.waitsFor(1)
	single := f.acquireAsync("sess_c", 10*time.Minute, f.other)
	f.waitsFor(2)
	if f.instance(f.other).Holder != nil {
		t.Fatal("a later wait took an instance an earlier wait needs")
	}
	if _, err := f.leases.Release(f.ctx, a.ID, "sess_a"); err != nil {
		t.Fatal(err)
	}
	f.confirm()
	result := receive(t, pair)
	if result.err != nil || len(result.leases) != 2 {
		t.Fatalf("the earlier pair = %+v %v", result.leases, result.err)
	}
	select {
	case got := <-single:
		t.Fatalf("the later wait was served: %+v", got)
	default:
	}
}

// A wait that runs out answers its place; it keeps it for a minute, so
// asking again does not lose it; after that it expires. A waiter whose turn
// ends stops waiting.
func TestWaitTimeoutRetentionAndCancel(t *testing.T) {
	f := newLeaseFixture(t)
	f.mustAcquire("sess_a", f.screen)
	_, err := f.acquire("sess_b", 20*time.Millisecond, f.screen)
	if code(err) != resources.CodeTimeout || err.(*resources.LeaseError).Position != 1 || err.(*resources.LeaseError).Holder.SessionID != "sess_a" {
		t.Fatalf("timeout = %v", err)
	}
	f.waitsFor(1)
	_, _ = f.acquire("sess_c", 20*time.Millisecond, f.screen)
	if _, err := f.acquire("sess_b", 20*time.Millisecond, f.screen); err.(*resources.LeaseError).Position != 1 {
		t.Fatalf("asking again = %v", err)
	}
	f.advance(2 * time.Minute)
	f.sweep()
	f.waitsFor(0)

	done := f.acquireAsync("sess_c", 10*time.Minute, f.screen)
	f.waitsFor(1)
	if err := f.leases.TurnEnded(f.ctx, "sess_c", "completed"); err != nil {
		t.Fatal(err)
	}
	if result := receive(t, done); code(result.err) != resources.CodeCanceled {
		t.Fatalf("waiter whose turn ended = %v", result.err)
	}
}

// The person releases any lease, or every lease on a device (canceling
// the waits for it); the holder is told and refused.
func TestPersonRevokesAndStopsAll(t *testing.T) {
	f := newLeaseFixture(t)
	lease := f.mustAcquire("sess_a", f.screen)
	revoked, err := f.leases.Revoke(f.ctx, f.screen, "usr_alice")
	if err != nil || revoked.State != store.LeaseRevoked || revoked.EndedBy != "usr_alice" {
		t.Fatalf("revoke = %+v %v", revoked, err)
	}
	if _, err := f.leases.Begin(f.ctx, lease.ID, "sess_a"); code(err) != resources.CodeLeaseEnded {
		t.Fatalf("operating a revoked lease = %v", err)
	}
	if notices := f.leases.Notices(f.ctx, "sess_a"); len(notices) != 1 || !strings.Contains(notices[0], "the person released it") {
		t.Fatalf("notices = %v", notices)
	}
	if _, err := f.leases.Revoke(f.ctx, f.other, "usr_alice"); code(err) != resources.CodeNothingHeld {
		t.Fatalf("revoking nothing = %v", err)
	}
	f.confirm()
	f.mustAcquire("sess_a", f.screen)
	f.mustAcquire("sess_b", f.other)
	waiting := f.acquireAsync("sess_c", 10*time.Minute, f.screen)
	f.waitsFor(1)
	ended, err := f.leases.StopSource(f.ctx, "dev_mac", "usr_alice")
	if err != nil || ended != 2 {
		t.Fatalf("stop all = %d %v", ended, err)
	}
	if result := receive(t, waiting); code(result.err) != resources.CodeCanceled {
		t.Fatalf("waiter after stop all = %v", result.err)
	}
}

// The hosting device away: operations are refused while the lease is kept
// for the grace; back in time, the lease continues and the worker is
// fenced again at the same generation; away longer, the lease is revoked.
func TestHostOfflineGrace(t *testing.T) {
	f := newLeaseFixture(t)
	lease := f.mustAcquire("sess_a", f.screen)
	_ = f.leases.DeviceDisconnected(f.ctx, "dev_mac")
	if _, err := f.leases.Begin(f.ctx, lease.ID, "sess_a"); code(err) != resources.CodeOffline {
		t.Fatalf("operating while the Mac is away = %v", err)
	}
	f.advance(time.Minute)
	f.sweep()
	if err := f.leases.DeviceConnected(f.ctx, "dev_mac", true); err != nil {
		t.Fatal(err)
	}
	if reset := f.router.last(); reset.Generation != lease.Generation || reset.Notify != "" {
		t.Fatalf("fence on reconnect = %+v", reset)
	}
	if ticket, err := f.leases.Begin(f.ctx, lease.ID, "sess_a"); err != nil {
		t.Fatalf("back within the grace: %v", err)
	} else {
		_ = f.leases.Finish(f.ctx, ticket, nil)
	}
	_ = f.leases.DeviceDisconnected(f.ctx, "dev_mac")
	f.advance(2*time.Minute + time.Second)
	f.sweep()
	if got := f.lease(lease.ID); got.State != store.LeaseRevoked || !strings.Contains(got.EndReason, "offline") {
		t.Fatalf("away too long = %+v", got)
	}
}

// The holder's own device away: the lease stays active for the grace,
// then parks from when it went away.
func TestHolderDeviceOfflineParks(t *testing.T) {
	f := newLeaseFixture(t)
	lease := f.mustAcquire("sess_a", f.screen)
	went := f.clock()
	_ = f.leases.DeviceDisconnected(f.ctx, "dev_linux")
	f.advance(time.Minute)
	f.sweep()
	if got := f.lease(lease.ID); got.State != store.LeaseActive {
		t.Fatalf("within the grace = %+v", got)
	}
	f.advance(time.Minute + time.Second)
	f.sweep()
	got := f.lease(lease.ID)
	if got.State != store.LeaseParked || got.ParkUntil != went.Add(10*time.Minute).Format(time.RFC3339Nano) {
		t.Fatalf("after the grace = %+v", got)
	}
}

// A reset the Mac does not confirm leaves the instance unready and given
// to no one; the person's release sends it again; a confirmation of an
// older generation changes nothing.
func TestUnconfirmedReset(t *testing.T) {
	f := newLeaseFixture(t)
	lease := f.mustAcquire("sess_a", f.screen)
	_, _ = f.leases.Release(f.ctx, lease.ID, "sess_a")
	if err := f.leases.ResetDone(f.ctx, f.screen, lease.Generation, ""); err != nil {
		t.Fatal(err)
	}
	if !f.instance(f.screen).Resetting {
		t.Fatal("a confirmation of the old generation finished the reset")
	}
	f.advance(31 * time.Second)
	f.sweep()
	instance := f.instance(f.screen)
	if instance.State != store.ResourceUnready || !strings.Contains(instance.StateReason, "did not confirm") {
		t.Fatalf("unconfirmed = %+v", instance)
	}
	if _, err := f.acquire("sess_b", 0, f.screen); err == nil {
		t.Fatal("an unconfirmed instance was leased")
	}
	if _, err := f.leases.Revoke(f.ctx, f.screen, "usr_alice"); err != nil {
		t.Fatal(err)
	}
	f.confirm()
	if instance := f.instance(f.screen); instance.State != store.ResourceAvailable || instance.Resetting {
		t.Fatalf("after the reset is confirmed = %+v", instance)
	}
}

// Leases, waits and timers survive a restart: a lease whose turn completed
// while the server was down parks, one that failed is released, timers
// due during the restart move to the grace.
func TestLeasesSurviveRestart(t *testing.T) {
	f := newLeaseFixture(t)
	a := f.mustAcquire("sess_a", f.screen)
	b := f.mustAcquire("sess_b", f.other)
	f.setStatus("sess_a", "completed")
	f.setStatus("sess_b", "failed")
	f.advance(time.Hour)
	f.attach()
	if err := f.leases.Recover(f.ctx); err != nil {
		t.Fatal(err)
	}
	parked := f.lease(a.ID)
	if parked.State != store.LeaseParked || parked.ParkUntil != f.clock().Add(10*time.Minute).Format(time.RFC3339Nano) {
		t.Fatalf("completed while down = %+v", parked)
	}
	if got := f.lease(b.ID); got.State != store.LeaseReleased {
		t.Fatalf("failed while down = %+v", got)
	}
	if _, err := f.leases.Begin(f.ctx, a.ID, "sess_a"); code(err) != resources.CodeOffline {
		t.Fatalf("before the Mac reconnects = %v", err)
	}
	_ = f.leases.DeviceConnected(f.ctx, "dev_mac", true)
	if _, err := f.leases.Begin(f.ctx, a.ID, "sess_a"); err != nil {
		t.Fatalf("after it reconnects = %v", err)
	}
}

// An instance gone from its device's report takes its lease with it.
func TestGoneInstanceRevokesLease(t *testing.T) {
	f := newLeaseFixture(t)
	lease := f.mustAcquire("sess_a", f.screen)
	f.report(true, "computer_use/macos/console:502")
	if got := f.lease(lease.ID); got.State != store.LeaseRevoked || !strings.Contains(got.EndReason, "gone") {
		t.Fatalf("lease on a gone instance = %+v", got)
	}
}

// Operations go through only for the holder of the current generation.
func TestOnlyTheHolderOperates(t *testing.T) {
	f := newLeaseFixture(t)
	lease := f.mustAcquire("sess_a", f.screen)
	if _, err := f.leases.Begin(f.ctx, lease.ID, "sess_b"); code(err) != resources.CodeNotHolder {
		t.Fatalf("another session operating = %v", err)
	}
	if _, err := f.leases.Release(f.ctx, lease.ID, "sess_b"); code(err) != resources.CodeNotHolder {
		t.Fatalf("another session releasing = %v", err)
	}
	ticket, err := f.leases.Begin(f.ctx, lease.ID, "sess_a")
	if err != nil || ticket.Backend.ID != "cua-driver" || ticket.Lease.Generation != 1 {
		t.Fatalf("ticket = %+v %v", ticket, err)
	}
	_ = f.leases.Finish(f.ctx, ticket, nil)
	released, err := f.leases.Release(f.ctx, lease.ID, "sess_a")
	if err != nil || released.State != store.LeaseReleased {
		t.Fatalf("release = %+v %v", released, err)
	}
	if again, err := f.leases.Release(f.ctx, lease.ID, "sess_a"); err != nil || again.State != store.LeaseReleased {
		t.Fatalf("releasing twice = %+v %v", again, err)
	}
	if notices := f.leases.Notices(f.ctx, "sess_a"); len(notices) != 0 {
		t.Fatalf("the holder is told of its own release: %v", notices)
	}
}

// The audit keeps typed text as its length and drops nothing else short.
func TestAuditArgsHideText(t *testing.T) {
	spec, _ := resources.Spec("computer_use")
	typing, _ := spec.Operation("type_text")
	summary := typing.AuditArgs(map[string]any{"text": "hunter2", "pid": float64(42)})
	if summary["textLength"] != 7 || summary["pid"] != float64(42) || summary["text"] != nil {
		t.Fatalf("summary = %+v", summary)
	}
	hotkey, _ := spec.Operation("hotkey")
	if keys := hotkey.AuditArgs(map[string]any{"keys": []any{"cmd", "c"}}); len(keys["keys"].([]any)) != 2 {
		t.Fatalf("hotkey summary = %+v", keys)
	}
}
