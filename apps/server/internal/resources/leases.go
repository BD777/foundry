package resources

// Leases: which session holds which instance, how long, and who waits.
// The rules are docs resource-lease-liveness.md (approved as the default):
//
//   - A lease lives with its holder session's turn. While the turn runs
//     (queued, running, blocked) the lease is active and never expires; the
//     session's own status events are its keep-alive.
//   - When the turn completes the lease is parked: kept for ParkTTL (longer
//     with holdFor, at most MaxHoldFor), handed over at once when another
//     session asks and it holds no holdFor. A failed or canceled turn
//     releases it.
//   - Another session waiting makes it contended: the holder is told in
//     every Foundry tool result, warned PreemptWarning before, and
//     preempted ContendedCap after the wait began (once its operation in
//     flight ended). The person may let it finish once more.
//   - Every new lease raises the instance's fencing generation; operations
//     of an older one are refused by the server and by the hosting worker.
//     A lease that ends raises it again and the hosting worker resets the
//     instance; it goes to the next session only once the worker confirmed.
//   - No hold-and-wait: a session holding a lease cannot wait for another;
//     several instances are taken all at once or not at all.
//   - The person ends any lease (revoke); a device offline longer than its
//     grace loses its leases; one whose holder's device went away parks.
//
// Everything is in the store, so leases, waits and timers survive a server
// restart; timers due during the restart are pushed back by RestartGrace.

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"log"
	"slices"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// LeaseConfig holds the timings that are not per type.
type LeaseConfig struct {
	// HolderDisconnectGrace: a holder whose device disconnected keeps an
	// active lease this long before it parks.
	HolderDisconnectGrace time.Duration
	// HostOfflineGrace: an instance's device may be away this long before
	// its leases are revoked.
	HostOfflineGrace time.Duration
	// ResetAckTimeout: a device that does not confirm a reset in time
	// leaves the instance unready (reset_unconfirmed).
	ResetAckTimeout time.Duration
	// RestartGrace pushes back timers due while the server was down.
	RestartGrace time.Duration
	// QueueRetention keeps a wait's place after its call returned.
	QueueRetention time.Duration
	// MaxWait bounds one acquire call's wait.
	MaxWait time.Duration
	// EndedRetention: ended leases and the audit are kept this long.
	EndedRetention time.Duration
	// MaxResources bounds one all-or-nothing acquire.
	MaxResources int
}

// DefaultLeaseConfig is resource-lease-liveness.md §6.
func DefaultLeaseConfig() LeaseConfig {
	return LeaseConfig{
		HolderDisconnectGrace: 2 * time.Minute,
		HostOfflineGrace:      2 * time.Minute,
		ResetAckTimeout:       30 * time.Second,
		RestartGrace:          2 * time.Minute,
		QueueRetention:        time.Minute,
		MaxWait:               10 * time.Minute,
		EndedRetention:        30 * 24 * time.Hour,
		MaxResources:          8,
	}
}

// SessionInfo is what leases need of a session.
type SessionInfo struct {
	Status      string
	WorkspaceID string
	DeviceID    string
	UserID      string
}

// Router reaches the device that hosts an instance.
type Router interface {
	// SendReset asks the hosting device to fence and reset an instance; its
	// answer comes back through Leases.ResetDone. False: the device is not
	// connected (it is sent again when the device reconnects).
	SendReset(sourceID string, request store.ResourceResetRequest) bool
	// Operate runs operations on the hosting device.
	Operate(ctx context.Context, sourceID string, request store.ResourceOperateRequest) (store.ResourceOperateResult, error)
}

// Lease error codes (LeaseError.Code).
const (
	CodeNotFound    = "not_found"
	CodeNotLeasable = "not_leasable"
	CodeUnready     = "unready"
	CodeBusy        = "busy"
	CodeHoldAndWait = "hold_and_wait"
	CodeTimeout     = "timeout"
	CodeCanceled    = "wait_canceled"
	CodeNotHolder   = "not_holder"
	CodeLeaseEnded  = "lease_ended"
	CodeOffline     = "device_offline"
	CodeInvalid     = "invalid"
	CodeNothingHeld = "nothing_held"
)

// LeaseError is a refusal an agent or person can act on.
type LeaseError struct {
	Code    string
	Message string
	// Holder holds what was asked for (busy, timeout).
	Holder *store.ResourceHolder
	// Position is the caller's place in the queue (timeout), from 1.
	Position int
	// Lease is the ended lease (lease_ended).
	Lease *store.ResourceLease
}

func (e *LeaseError) Error() string { return e.Message }

func leaseError(code, format string, args ...any) *LeaseError {
	return &LeaseError{Code: code, Message: fmt.Sprintf(format, args...)}
}

// AcquireRequest asks for one or several instances for a session.
type AcquireRequest struct {
	SessionID   string
	ResourceIDs []string
	Reason      string
	// HoldFor keeps the lease parked longer after the turn (0: no hold);
	// nil leaves a held lease's hold as it is.
	HoldFor *time.Duration
	// Wait: how long to wait when busy (0: answer at once).
	Wait time.Duration
}

// Leases decides leases over the inventory of a Service.
type Leases struct {
	inventory *Service
	store     store.ResourceLeaseStore
	mu        sync.Mutex
	// Now is the clock (the inventory's).
	Now    func() time.Time
	Config LeaseConfig
	// Session reads a session; an error means it does not exist.
	Session func(ctx context.Context, sessionID string) (SessionInfo, error)
	Router  Router
	// HostOnline reports whether an instance's source is connected.
	HostOnline func(sourceID string) bool

	waiters     map[string]chan struct{}
	inflight    map[string]int
	notices     map[string][]string
	hostOffline map[string]time.Time
	lastCleanup time.Time
}

// NewLeases decides leases over inventory, keeping them in st.
func NewLeases(inventory *Service, st store.ResourceLeaseStore) *Leases {
	leases := &Leases{
		inventory:   inventory,
		store:       st,
		Now:         func() time.Time { return inventory.Now() },
		Config:      DefaultLeaseConfig(),
		waiters:     map[string]chan struct{}{},
		inflight:    map[string]int{},
		notices:     map[string][]string{},
		hostOffline: map[string]time.Time{},
	}
	inventory.leases = leases
	return leases
}

// --- the state one decision works on -----------------------------------

type leaseState struct {
	instances map[string]store.ResourceInstance
	live      map[string]*store.ResourceLease // by resource id
	fences    map[string]*store.ResourceFence
	waits     []*store.ResourceWait
	changes   map[string]*store.ResourceLease // touched leases, by lease id
	fenced    map[string]bool                 // touched fences
	waited    map[string]bool                 // touched waits
	resets    []resetJob
	wake      []string
	sources   map[string]bool
	// remoteCommands: the sources whose owner allows remote commands.
	remoteCommands map[string]bool
}

type resetJob struct {
	sourceID string
	request  store.ResourceResetRequest
}

func (l *Leases) load(ctx context.Context) (*leaseState, error) {
	listing, err := l.inventory.listWithSources(ctx, store.ResourceFilter{IncludeGone: true})
	if err != nil {
		return nil, err
	}
	instances := listing.Instances
	live, err := l.store.ListResourceLeases(ctx, store.ResourceLeaseFilter{Live: true})
	if err != nil {
		return nil, err
	}
	fences, err := l.store.ListResourceFences(ctx)
	if err != nil {
		return nil, err
	}
	waits, err := l.store.ListResourceWaits(ctx)
	if err != nil {
		return nil, err
	}
	state := &leaseState{
		instances: map[string]store.ResourceInstance{}, live: map[string]*store.ResourceLease{},
		fences: map[string]*store.ResourceFence{}, changes: map[string]*store.ResourceLease{},
		fenced: map[string]bool{}, waited: map[string]bool{}, sources: map[string]bool{},
		remoteCommands: map[string]bool{},
	}
	for _, source := range listing.Sources {
		state.remoteCommands[source.ID] = source.AllowRemoteCommands
	}
	for _, instance := range instances {
		state.instances[instance.ID] = instance
	}
	for index := range live {
		lease := live[index]
		state.live[lease.ResourceID] = &lease
	}
	for index := range fences {
		fence := fences[index]
		state.fences[fence.ResourceID] = &fence
	}
	for index := range waits {
		wait := waits[index]
		state.waits = append(state.waits, &wait)
	}
	return state, nil
}

// save writes what the decision changed, then sends its resets, wakes its
// waiters and tells readers which sources changed.
func (l *Leases) save(ctx context.Context, state *leaseState) error {
	changes := store.ResourceLeaseChanges{}
	ids := make([]string, 0, len(state.changes))
	for id := range state.changes {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	now := formatTime(l.Now())
	for _, id := range ids {
		lease := *state.changes[id]
		lease.UpdatedAt = now
		changes.Leases = append(changes.Leases, lease)
	}
	for id := range state.fenced {
		changes.Fences = append(changes.Fences, *state.fences[id])
	}
	for _, wait := range state.waits {
		if state.waited[wait.ID] {
			changes.Waits = append(changes.Waits, *wait)
		}
	}
	if len(changes.Leases)+len(changes.Fences)+len(changes.Waits) > 0 {
		if err := l.store.SaveResourceLeaseChanges(ctx, changes); err != nil {
			return err
		}
	}
	for _, job := range state.resets {
		if l.Router != nil {
			l.Router.SendReset(job.sourceID, job.request)
		}
	}
	for _, id := range state.wake {
		if waiter, ok := l.waiters[id]; ok {
			close(waiter)
			delete(l.waiters, id)
		}
	}
	if l.inventory.Changed != nil {
		for sourceID := range state.sources {
			l.inventory.Changed(sourceID)
		}
	}
	return nil
}

func (s *leaseState) touch(lease *store.ResourceLease) {
	s.changes[lease.ID] = lease
	s.sources[lease.SourceID] = true
}

func (s *leaseState) fence(resourceID, sourceID string) *store.ResourceFence {
	fence := s.fences[resourceID]
	if fence == nil {
		fence = &store.ResourceFence{ResourceID: resourceID, SourceID: sourceID}
		s.fences[resourceID] = fence
	}
	if fence.SourceID == "" {
		fence.SourceID = sourceID
	}
	s.fenced[resourceID] = true
	return fence
}

func (s *leaseState) touchWait(wait *store.ResourceWait) {
	s.waited[wait.ID] = true
	for _, id := range wait.ResourceIDs {
		if instance, ok := s.instances[id]; ok {
			s.sources[instance.Source.ID] = true
		}
	}
}

// --- acquire -----------------------------------------------------------

// Acquire leases every instance req names to its session, or none. Busy
// instances are waited for (all at once, first come first served) up to
// req.Wait; a session that holds a lease cannot wait for another.
func (l *Leases) Acquire(ctx context.Context, req AcquireRequest) ([]store.ResourceLease, error) {
	ids, err := l.normalizeIDs(req.ResourceIDs)
	if err != nil {
		return nil, err
	}
	if req.Wait > l.Config.MaxWait {
		req.Wait = l.Config.MaxWait
	}
	session, err := l.Session(ctx, req.SessionID)
	if err != nil {
		return nil, leaseError(CodeInvalid, "session %s not found", req.SessionID)
	}
	l.mu.Lock()
	state, err := l.load(ctx)
	if err != nil {
		l.mu.Unlock()
		return nil, err
	}
	now := l.Now().UTC()
	for _, id := range ids {
		if err := l.usable(state, id, now); err != nil {
			l.mu.Unlock()
			return nil, err
		}
	}
	held := heldBy(state, req.SessionID)
	if mine := ownLeases(held, ids); len(mine) == len(ids) {
		// Asking again for what it holds: the leases, with a new hold.
		for _, lease := range mine {
			l.applyHold(state, lease, req.HoldFor, now)
		}
		result := copies(mine)
		err := l.save(ctx, state)
		l.mu.Unlock()
		return result, err
	}
	if len(held) > 0 && req.Wait > 0 {
		names := []string{}
		for _, lease := range held {
			names = append(names, lease.ID+" ("+state.instances[lease.ResourceID].Name+")")
		}
		l.mu.Unlock()
		return nil, leaseError(CodeHoldAndWait, "this session holds %s and cannot wait for more: release it first, or acquire everything you need in one call (resourceIds) without waiting",
			strings.Join(names, ", "))
	}
	wait := findWait(state, req.SessionID, ids)
	created := wait == nil
	if created {
		wait = &store.ResourceWait{
			ID: newID("rwait"), SessionID: req.SessionID, UserID: session.UserID, DeviceID: session.DeviceID,
			ResourceIDs: ids, Reason: req.Reason, EnqueuedAt: formatTime(now), State: store.WaitWaiting,
		}
		state.waits = append(state.waits, wait)
	}
	if req.HoldFor != nil && *req.HoldFor > 0 {
		wait.HoldUntil = formatTime(now.Add(l.holdFor(ids, state, *req.HoldFor)))
	}
	effective := req.Wait
	wait.RetainUntil = formatTime(now.Add(max(effective, l.Config.ResetAckTimeout) + l.Config.QueueRetention))
	state.touchWait(wait)
	l.grantWaiting(ctx, state, now)
	if wait.State == store.WaitGranted {
		result := leasesFor(state, req.SessionID, ids)
		err := l.save(ctx, state)
		l.mu.Unlock()
		return result, err
	}
	blocked := l.blockers(state, wait, now)
	if blocked.busy != nil && effective == 0 {
		// Asked without waiting: refuse, and leave no wait behind.
		if created {
			wait.State = store.WaitCanceled
		}
		position := l.position(state, wait)
		if created {
			state.waits = slices.DeleteFunc(state.waits, func(w *store.ResourceWait) bool { return w.ID == wait.ID })
			delete(state.waited, wait.ID)
		}
		err := l.save(ctx, state)
		l.mu.Unlock()
		if err != nil {
			return nil, err
		}
		refusal := leaseError(CodeBusy, "%s is held by session %s since %s; acquire with waitMs to queue for it", blocked.name, blocked.busy.SessionID, blocked.busy.Since)
		refusal.Holder, refusal.Position = blocked.busy, position
		return nil, refusal
	}
	if effective < l.Config.ResetAckTimeout && blocked.busy == nil {
		// Only resets stand in the way: they take seconds.
		effective = l.Config.ResetAckTimeout
	}
	l.contention(state, now)
	waiter := make(chan struct{})
	l.waiters[wait.ID] = waiter
	waitID := wait.ID
	if err := l.save(ctx, state); err != nil {
		delete(l.waiters, waitID)
		l.mu.Unlock()
		return nil, err
	}
	l.mu.Unlock()

	timer := time.NewTimer(effective)
	defer timer.Stop()
	select {
	case <-waiter:
	case <-timer.C:
	case <-ctx.Done():
	}
	return l.afterWait(context.WithoutCancel(ctx), req.SessionID, waitID, ids)
}

// afterWait reads how a wait ended for its caller.
func (l *Leases) afterWait(ctx context.Context, sessionID, waitID string, ids []string) ([]store.ResourceLease, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	delete(l.waiters, waitID)
	state, err := l.load(ctx)
	if err != nil {
		return nil, err
	}
	now := l.Now().UTC()
	if granted := leasesFor(state, sessionID, ids); len(granted) == len(ids) {
		return granted, nil
	}
	var wait *store.ResourceWait
	for _, candidate := range state.waits {
		if candidate.ID == waitID {
			wait = candidate
		}
	}
	if wait == nil {
		return nil, leaseError(CodeCanceled, "the wait for %s ended without a lease: the session's turn ended, the person stopped the device's resources, or what was granted was already taken back; acquire again if you still need it", strings.Join(ids, ", "))
	}
	wait.RetainUntil = formatTime(now.Add(l.Config.QueueRetention))
	state.touchWait(wait)
	blocked := l.blockers(state, wait, now)
	position := l.position(state, wait)
	if err := l.save(ctx, state); err != nil {
		return nil, err
	}
	refusal := leaseError(CodeTimeout, "still waiting (place %d in the queue); call acquire_resource again within %d s to keep the place",
		position, int(l.Config.QueueRetention/time.Second))
	refusal.Holder, refusal.Position = blocked.busy, position
	return nil, refusal
}

func (l *Leases) normalizeIDs(ids []string) ([]string, error) {
	seen := map[string]bool{}
	result := []string{}
	for _, id := range ids {
		id = strings.TrimSpace(id)
		if id != "" && !seen[id] {
			seen[id] = true
			result = append(result, id)
		}
	}
	if len(result) == 0 {
		return nil, leaseError(CodeInvalid, "name the resource to acquire (resourceId or resourceIds)")
	}
	if len(result) > l.Config.MaxResources {
		return nil, leaseError(CodeInvalid, "at most %d resources in one acquire", l.Config.MaxResources)
	}
	sort.Strings(result)
	return result, nil
}

// usable refuses an instance no lease may be granted on.
func (l *Leases) usable(state *leaseState, id string, now time.Time) error {
	instance, ok := state.instances[id]
	if !ok {
		return leaseError(CodeNotFound, "resource %s not found", id)
	}
	spec, ok := Spec(instance.Type)
	if !ok {
		return leaseError(CodeNotLeasable, "%s (%s) is listed only: sessions do not lease %s resources yet", instance.Name, id, instance.Type)
	}
	if spec.RemoteCommands && !state.remoteCommands[instance.Source.ID] {
		return remoteCommandsOff(instance)
	}
	switch instance.State {
	case store.ResourceGone:
		return leaseError(CodeNotFound, "%s (%s) is gone from its device", instance.Name, id)
	case store.ResourceOffline:
		return leaseError(CodeOffline, "%s is on %s, which is offline", instance.Name, instance.Source.Label)
	}
	if !l.hostOnline(instance.Source.ID) {
		return leaseError(CodeOffline, "%s is on %s, which is offline", instance.Name, instance.Source.Label)
	}
	if fence := state.fences[id]; fence != nil && fence.Unconfirmed {
		return leaseError(CodeUnready, "%s is not ready: %s; the person can release it on the Resources page to reset it again", instance.Name, fence.ResetReason)
	}
	if _, err := OperableBackend(instance); err != nil {
		return err
	}
	return nil
}

// OperableBackend is the backend operations on instance go through: the
// first ready one Foundry drives remotely.
func OperableBackend(instance store.ResourceInstance) (store.ResourceBackend, error) {
	var reasons []string
	for _, backend := range instance.Backends {
		if backend.Mode != "remote_ops" {
			continue
		}
		if backend.Readiness.Ready {
			return backend, nil
		}
		reason := backend.Readiness.Reason
		if reason == "" {
			reason = "not ready (" + strings.Join(backend.Readiness.Missing, ", ") + ")"
		}
		reasons = append(reasons, backend.ID+": "+reason)
	}
	if len(reasons) == 0 {
		return store.ResourceBackend{}, leaseError(CodeUnready, "%s has no backend Foundry can operate remotely (install cua-driver from the Resources page)", instance.Name)
	}
	return store.ResourceBackend{}, leaseError(CodeUnready, "%s is not ready: %s", instance.Name, strings.Join(reasons, "; "))
}

func (l *Leases) hostOnline(sourceID string) bool {
	if _, away := l.hostOffline[sourceID]; away {
		return false
	}
	return l.HostOnline == nil || l.HostOnline(sourceID)
}

func heldBy(state *leaseState, sessionID string) []*store.ResourceLease {
	var held []*store.ResourceLease
	for _, lease := range state.live {
		if lease.HolderSessionID == sessionID {
			held = append(held, lease)
		}
	}
	sort.Slice(held, func(i, j int) bool { return held[i].ResourceID < held[j].ResourceID })
	return held
}

func ownLeases(held []*store.ResourceLease, ids []string) []*store.ResourceLease {
	var mine []*store.ResourceLease
	for _, lease := range held {
		if slices.Contains(ids, lease.ResourceID) {
			mine = append(mine, lease)
		}
	}
	return mine
}

func leasesFor(state *leaseState, sessionID string, ids []string) []store.ResourceLease {
	result := []store.ResourceLease{}
	for _, id := range ids {
		if lease := state.live[id]; lease != nil && lease.HolderSessionID == sessionID {
			result = append(result, *lease)
		}
	}
	return result
}

func copies(leases []*store.ResourceLease) []store.ResourceLease {
	result := make([]store.ResourceLease, len(leases))
	for index, lease := range leases {
		result[index] = *lease
	}
	return result
}

func findWait(state *leaseState, sessionID string, ids []string) *store.ResourceWait {
	for _, wait := range state.waits {
		if wait.SessionID == sessionID && slices.Equal(wait.ResourceIDs, ids) {
			return wait
		}
	}
	return nil
}

// holdFor bounds a hold by the strictest type among ids.
func (l *Leases) holdFor(ids []string, state *leaseState, hold time.Duration) time.Duration {
	for _, id := range ids {
		if spec, ok := Spec(state.instances[id].Type); ok && hold > spec.MaxHoldFor {
			hold = spec.MaxHoldFor
		}
	}
	return hold
}

func (l *Leases) applyHold(state *leaseState, lease *store.ResourceLease, hold *time.Duration, now time.Time) {
	if hold == nil {
		return
	}
	if *hold <= 0 {
		lease.HoldUntil = ""
	} else {
		lease.HoldUntil = formatTime(now.Add(l.holdFor([]string{lease.ResourceID}, state, *hold)))
		if lease.State == store.LeaseParked && lease.HoldUntil > lease.ParkUntil {
			lease.ParkUntil = lease.HoldUntil
		}
	}
	state.touch(lease)
}

type blocker struct {
	name string
	busy *store.ResourceHolder
}

// blockers says what stands between a wait and its instances: a holder
// (busy), else only resets or earlier waits.
func (l *Leases) blockers(state *leaseState, wait *store.ResourceWait, now time.Time) blocker {
	for _, id := range wait.ResourceIDs {
		if lease := state.live[id]; lease != nil && lease.HolderSessionID != wait.SessionID {
			return blocker{name: state.instances[id].Name, busy: holderOf(lease, "")}
		}
	}
	for _, earlier := range state.waits {
		if earlier.ID == wait.ID {
			break
		}
		for _, id := range wait.ResourceIDs {
			if slices.Contains(earlier.ResourceIDs, id) {
				return blocker{name: state.instances[id].Name, busy: &store.ResourceHolder{SessionID: earlier.SessionID, State: "waiting", Since: earlier.EnqueuedAt}}
			}
		}
	}
	return blocker{}
}

// position is a wait's place among the waits for any of its instances.
func (l *Leases) position(state *leaseState, wait *store.ResourceWait) int {
	position := 1
	for _, earlier := range state.waits {
		if earlier.ID == wait.ID {
			return position
		}
		for _, id := range wait.ResourceIDs {
			if slices.Contains(earlier.ResourceIDs, id) {
				position++
				break
			}
		}
	}
	return position
}

func holderOf(lease *store.ResourceLease, workspaceID string) *store.ResourceHolder {
	return &store.ResourceHolder{
		LeaseID: lease.ID, SessionID: lease.HolderSessionID, WorkspaceID: workspaceID, State: lease.State,
		Since: lease.AcquiredAt, ParkUntil: lease.ParkUntil, HoldUntil: lease.HoldUntil, PreemptAt: lease.PreemptAt,
	}
}

// grantWaiting hands free instances to the waits, first come first served:
// a wait that cannot be granted keeps later waits off its instances. A
// parked lease without a hold that a wait at the front needs is yielded.
func (l *Leases) grantWaiting(ctx context.Context, state *leaseState, now time.Time) {
	blocked := map[string]bool{}
	for _, wait := range state.waits {
		if wait.State != store.WaitWaiting {
			continue
		}
		front := true
		for _, id := range wait.ResourceIDs {
			front = front && !blocked[id]
		}
		if !front {
			for _, id := range wait.ResourceIDs {
				blocked[id] = true
			}
			continue
		}
		ready := true
		var yieldable []*store.ResourceLease
		for _, id := range wait.ResourceIDs {
			if l.usable(state, id, now) != nil {
				ready = false
				continue
			}
			if lease := state.live[id]; lease != nil {
				if lease.HolderSessionID == wait.SessionID {
					continue
				}
				if lease.State == store.LeaseParked && !held(lease, now) {
					yieldable = append(yieldable, lease)
				}
				ready = false
				continue
			}
			if fence := state.fences[id]; fence != nil && (fence.Resetting || fence.Unconfirmed) {
				ready = false
			}
		}
		if !ready {
			// The parked leases in the way go only when nothing else is in
			// the way, so a wait never empties a screen it cannot take.
			if len(yieldable) > 0 && l.onlyYieldable(state, wait, now) {
				for _, lease := range yieldable {
					l.end(state, lease, store.LeaseYielded, "another session asked for it while its holder's turn was over", "foundry", now)
				}
			}
			for _, id := range wait.ResourceIDs {
				blocked[id] = true
			}
			continue
		}
		l.grant(ctx, state, wait, now)
	}
}

// onlyYieldable: every instance of wait is free, resetting, or held by a
// parked lease without a hold.
func (l *Leases) onlyYieldable(state *leaseState, wait *store.ResourceWait, now time.Time) bool {
	for _, id := range wait.ResourceIDs {
		if l.usable(state, id, now) != nil {
			return false
		}
		if lease := state.live[id]; lease != nil && lease.HolderSessionID != wait.SessionID &&
			(lease.State != store.LeaseParked || held(lease, now)) {
			return false
		}
	}
	return true
}

func held(lease *store.ResourceLease, now time.Time) bool {
	return lease.HoldUntil != "" && parseTime(lease.HoldUntil).After(now)
}

// grant leases a wait's instances to its session.
func (l *Leases) grant(ctx context.Context, state *leaseState, wait *store.ResourceWait, now time.Time) {
	info, err := l.Session(ctx, wait.SessionID)
	if err != nil {
		wait.State = store.WaitCanceled
		state.touchWait(wait)
		state.wake = append(state.wake, wait.ID)
		return
	}
	turn := turnRunning(info.Status)
	for _, id := range wait.ResourceIDs {
		if lease := state.live[id]; lease != nil && lease.HolderSessionID == wait.SessionID {
			continue
		}
		instance := state.instances[id]
		fence := state.fence(id, instance.Source.ID)
		fence.Generation++
		lease := &store.ResourceLease{
			ID: newID("lease"), ResourceID: id, SourceID: instance.Source.ID, Generation: fence.Generation,
			HolderSessionID: wait.SessionID, HolderUserID: wait.UserID, HolderDeviceID: wait.DeviceID,
			Reason: wait.Reason, State: store.LeaseActive, AcquiredAt: formatTime(now), HoldUntil: wait.HoldUntil,
		}
		if !turn {
			lease.State = store.LeaseParked
			lease.ParkUntil = l.parkUntil(state, lease, now)
		}
		state.live[id] = lease
		state.touch(lease)
		notify := "A Foundry session is now using " + instance.Name + "."
		if wait.Reason != "" {
			notify = "A Foundry session is now using " + instance.Name + ": " + clipRunes(wait.Reason, 80)
		}
		state.resets = append(state.resets, resetJob{sourceID: instance.Source.ID, request: store.ResourceResetRequest{
			ResourceID: id, Key: instance.Key, Type: instance.Type, Generation: fence.Generation,
			Reason: "leased to session " + wait.SessionID, Notify: notify,
		}})
	}
	wait.State = store.WaitGranted
	state.touchWait(wait)
	state.wake = append(state.wake, wait.ID)
}

// parkUntil is when a lease parked now ends: ParkTTL from now, or its hold.
func (l *Leases) parkUntil(state *leaseState, lease *store.ResourceLease, now time.Time) string {
	until := formatTime(now.Add(l.specIn(state, lease).ParkTTL))
	if lease.HoldUntil > until {
		return lease.HoldUntil
	}
	return until
}

// specIn is the type spec of a lease's instance, read from state.
func (l *Leases) specIn(state *leaseState, lease *store.ResourceLease) TypeSpec {
	return specOrDefault(state.instances[lease.ResourceID].Type)
}

// specOf is the type spec of a lease's instance, read from the inventory.
func (l *Leases) specOf(ctx context.Context, lease *store.ResourceLease) TypeSpec {
	instances, err := l.inventory.store.ListResourceInstances(ctx, store.ResourceFilter{SourceID: lease.SourceID, IncludeGone: true})
	if err == nil {
		for _, instance := range instances {
			if instance.ID == lease.ResourceID {
				return specOrDefault(instance.Type)
			}
		}
	}
	return specOrDefault("")
}

// specOrDefault is a type's spec; a lease on an instance no longer known
// keeps the timings every leasable type shares today.
func specOrDefault(typeID string) TypeSpec {
	if spec, ok := Spec(typeID); ok {
		return spec
	}
	return typeSpecs["computer_use"]
}

// end ends a live lease: the instance is fenced past it and reset before
// anyone else gets it. by is the holder session, a person's account or
// "foundry".
func (l *Leases) end(state *leaseState, lease *store.ResourceLease, how, reason, by string, now time.Time) {
	lease.State = how
	lease.EndedAt = formatTime(now)
	lease.EndReason = reason
	lease.EndedBy = by
	lease.ContendedSince, lease.PreemptAt = "", ""
	delete(state.live, lease.ResourceID)
	state.touch(lease)
	fence := state.fence(lease.ResourceID, lease.SourceID)
	if fence.Generation <= lease.Generation {
		fence.Generation = lease.Generation
	}
	fence.Generation++
	fence.Resetting, fence.Unconfirmed = true, false
	fence.ResetSince, fence.ResetReason = formatTime(now), reason
	instance := state.instances[lease.ResourceID]
	state.resets = append(state.resets, resetJob{sourceID: lease.SourceID, request: store.ResourceResetRequest{
		ResourceID: lease.ResourceID, Key: instance.Key, Type: instance.Type, Generation: fence.Generation,
		Reason: how + ": " + reason, Notify: "A Foundry session stopped using " + nameOr(instance.Name, "this resource") + ".",
	}})
	if by != lease.HolderSessionID {
		l.notices[lease.HolderSessionID] = append(l.notices[lease.HolderSessionID],
			fmt.Sprintf("Your lease %s on %s ended (%s: %s). Acquire it again before operating%s.",
				lease.ID, nameOr(instance.Name, lease.ResourceID), how, reason, l.specIn(state, lease).ResumeHint))
	}
}

// contention marks the live leases someone waits for, and clears it from
// those no one waits for any more.
func (l *Leases) contention(state *leaseState, now time.Time) {
	for _, lease := range state.live {
		waiting := false
		for _, wait := range state.waits {
			if wait.State == store.WaitWaiting && wait.SessionID != lease.HolderSessionID && slices.Contains(wait.ResourceIDs, lease.ResourceID) {
				waiting = true
				break
			}
		}
		switch {
		case waiting && lease.ContendedSince == "":
			spec := l.specIn(state, lease)
			lease.ContendedSince = formatTime(now)
			lease.PreemptAt = formatTime(now.Add(spec.ContendedCap))
			state.touch(lease)
		case !waiting && lease.ContendedSince != "":
			lease.ContendedSince, lease.PreemptAt, lease.WarnedAt, lease.Extended = "", "", "", false
			state.touch(lease)
		}
	}
}

// --- holders -----------------------------------------------------------

// Release ends a lease its holder no longer needs. Releasing a lease that
// already ended answers it as it ended.
func (l *Leases) Release(ctx context.Context, leaseID, sessionID string) (store.ResourceLease, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	lease, err := l.leaseByID(ctx, leaseID)
	if err != nil {
		return store.ResourceLease{}, err
	}
	if lease.HolderSessionID != sessionID {
		return store.ResourceLease{}, leaseError(CodeNotHolder, "lease %s belongs to another session; only its holder releases it (the person can release any lease on the Resources page)", leaseID)
	}
	if !store.LeaseLive(lease.State) {
		return lease, nil
	}
	state, err := l.load(ctx)
	if err != nil {
		return store.ResourceLease{}, err
	}
	live := state.live[lease.ResourceID]
	if live == nil || live.ID != leaseID {
		return lease, nil
	}
	now := l.Now().UTC()
	l.end(state, live, store.LeaseReleased, "released by its holder", sessionID, now)
	l.settle(ctx, state, now)
	return *live, l.save(ctx, state)
}

// SetHold changes the hold of a lease its holder keeps.
func (l *Leases) SetHold(ctx context.Context, leaseID, sessionID string, hold time.Duration) (store.ResourceLease, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	state, err := l.load(ctx)
	if err != nil {
		return store.ResourceLease{}, err
	}
	for _, lease := range state.live {
		if lease.ID == leaseID && lease.HolderSessionID == sessionID {
			l.applyHold(state, lease, &hold, l.Now().UTC())
			return *lease, l.save(ctx, state)
		}
	}
	return store.ResourceLease{}, leaseError(CodeNotHolder, "this session holds no live lease %s", leaseID)
}

func (l *Leases) leaseByID(ctx context.Context, leaseID string) (store.ResourceLease, error) {
	leases, err := l.store.ListResourceLeases(ctx, store.ResourceLeaseFilter{ID: strings.TrimSpace(leaseID)})
	if err != nil {
		return store.ResourceLease{}, err
	}
	if len(leases) == 0 {
		return store.ResourceLease{}, leaseError(CodeNotFound, "lease %s not found", leaseID)
	}
	return leases[0], nil
}

// Lease reads one lease.
func (l *Leases) Lease(ctx context.Context, leaseID string) (store.ResourceLease, error) {
	return l.leaseByID(ctx, leaseID)
}

// LiveLeases lists the live leases a session holds.
func (l *Leases) LiveLeases(ctx context.Context, sessionID string) ([]store.ResourceLease, error) {
	return l.store.ListResourceLeases(ctx, store.ResourceLeaseFilter{SessionID: sessionID, Live: true})
}

// --- the person --------------------------------------------------------

// Revoke ends the lease on an instance for a person (byUserID). An
// instance whose last reset went unconfirmed is reset again.
func (l *Leases) Revoke(ctx context.Context, resourceID, byUserID string) (store.ResourceLease, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	state, err := l.load(ctx)
	if err != nil {
		return store.ResourceLease{}, err
	}
	now := l.Now().UTC()
	lease := state.live[resourceID]
	if lease == nil {
		if fence := state.fences[resourceID]; fence != nil && (fence.Unconfirmed || fence.Resetting) {
			l.resendReset(state, fence, now)
			return store.ResourceLease{}, l.save(ctx, state)
		}
		return store.ResourceLease{}, leaseError(CodeNothingHeld, "no session holds %s", resourceID)
	}
	l.end(state, lease, store.LeaseRevoked, "the person released it", byUserID, now)
	l.settle(ctx, state, now)
	return *lease, l.save(ctx, state)
}

// LetFinish postpones the pending preemption of the lease on an instance
// once, by its type's ContendedCap: the person lets the holder finish.
func (l *Leases) LetFinish(ctx context.Context, resourceID string) (store.ResourceLease, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	state, err := l.load(ctx)
	if err != nil {
		return store.ResourceLease{}, err
	}
	lease := state.live[resourceID]
	if lease == nil || lease.PreemptAt == "" {
		return store.ResourceLease{}, leaseError(CodeNothingHeld, "no session is about to lose %s", resourceID)
	}
	if lease.Extended {
		return store.ResourceLease{}, leaseError(CodeInvalid, "this lease was already let finish once")
	}
	spec := l.specIn(state, lease)
	lease.PreemptAt = formatTime(parseTime(lease.PreemptAt).Add(spec.ContendedCap))
	lease.Extended, lease.WarnedAt = true, ""
	state.touch(lease)
	return *lease, l.save(ctx, state)
}

// StopSource ends every lease on a source's instances and cancels the waits
// for them: the person takes the device back. It answers how many leases
// ended.
func (l *Leases) StopSource(ctx context.Context, sourceID, byUserID string) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	state, err := l.load(ctx)
	if err != nil {
		return 0, err
	}
	now := l.Now().UTC()
	ended := 0
	for _, lease := range sortedLive(state) {
		if lease.SourceID == sourceID {
			l.end(state, lease, store.LeaseRevoked, "the person stopped every session using this device", byUserID, now)
			ended++
		}
	}
	for _, wait := range state.waits {
		if wait.State != store.WaitWaiting {
			continue
		}
		for _, id := range wait.ResourceIDs {
			if state.instances[id].Source.ID == sourceID {
				l.cancelWait(state, wait)
				break
			}
		}
	}
	state.sources[sourceID] = true
	l.settle(ctx, state, now)
	return ended, l.save(ctx, state)
}

// remoteCommandsOff refuses an instance whose owner does not allow remote
// commands on its device.
func remoteCommandsOff(instance store.ResourceInstance) *LeaseError {
	return leaseError(CodeUnready, "%s: the owner of %s has not allowed remote commands there; they turn on \"Allow remote commands from my sessions\" on the Resources page",
		instance.Name, nameOr(instance.Source.Label, "the device"))
}

// SettingsChanged applies a source's new settings: when remote commands
// are no longer allowed, the leases on its instances that need them end
// and the waits for them are canceled; when they are, waits may be granted.
func (l *Leases) SettingsChanged(ctx context.Context, sourceID string, settings store.ResourceSourceSettings, byUserID string) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	state, err := l.load(ctx)
	if err != nil {
		return err
	}
	now := l.Now().UTC()
	state.remoteCommands[sourceID] = settings.AllowRemoteCommands
	needs := func(resourceID string) bool {
		instance, ok := state.instances[resourceID]
		spec, leasable := Spec(instance.Type)
		return ok && leasable && spec.RemoteCommands && instance.Source.ID == sourceID
	}
	if !settings.AllowRemoteCommands {
		for _, lease := range sortedLive(state) {
			if needs(lease.ResourceID) {
				l.end(state, lease, store.LeaseRevoked, "the device's owner turned off remote commands", byUserID, now)
			}
		}
		for _, wait := range state.waits {
			if wait.State == store.WaitWaiting && slices.ContainsFunc(wait.ResourceIDs, needs) {
				l.cancelWait(state, wait)
			}
		}
	}
	state.sources[sourceID] = true
	l.settle(ctx, state, now)
	return l.save(ctx, state)
}

func (l *Leases) cancelWait(state *leaseState, wait *store.ResourceWait) {
	wait.State = store.WaitCanceled
	state.touchWait(wait)
	state.wake = append(state.wake, wait.ID)
}

func sortedLive(state *leaseState) []*store.ResourceLease {
	leases := make([]*store.ResourceLease, 0, len(state.live))
	for _, lease := range state.live {
		leases = append(leases, lease)
	}
	sort.Slice(leases, func(i, j int) bool { return leases[i].ResourceID < leases[j].ResourceID })
	return leases
}

// --- what sessions do --------------------------------------------------

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

// --- devices -----------------------------------------------------------

// DeviceDisconnected: the device's instances are away (revoked after
// HostOfflineGrace) and the leases its sessions hold are unattended
// (parked after HolderDisconnectGrace).
func (l *Leases) DeviceDisconnected(ctx context.Context, deviceID string) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.Now().UTC()
	l.hostOffline[deviceID] = now
	state, err := l.load(ctx)
	if err != nil {
		return err
	}
	for _, lease := range state.live {
		if lease.HolderDeviceID == deviceID && lease.State == store.LeaseActive && lease.HolderOfflineSince == "" {
			lease.HolderOfflineSince = formatTime(now)
			state.touch(lease)
		}
	}
	return l.save(ctx, state)
}

// DeviceConnected: the device is back. Its sessions' leases are attended
// again, and its worker is fenced at every generation the server handed out
// for its instances (a reset still unconfirmed is sent again).
func (l *Leases) DeviceConnected(ctx context.Context, deviceID string, operates bool) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	delete(l.hostOffline, deviceID)
	state, err := l.load(ctx)
	if err != nil {
		return err
	}
	now := l.Now().UTC()
	for _, lease := range state.live {
		if lease.HolderDeviceID == deviceID && lease.HolderOfflineSince != "" {
			lease.HolderOfflineSince = ""
			state.touch(lease)
		}
	}
	if operates {
		for _, fence := range state.fences {
			if fence.SourceID != deviceID {
				continue
			}
			if fence.Resetting || fence.Unconfirmed {
				l.resendReset(state, fence, now)
				continue
			}
			instance := state.instances[fence.ResourceID]
			state.resets = append(state.resets, resetJob{sourceID: deviceID, request: store.ResourceResetRequest{
				ResourceID: fence.ResourceID, Key: instance.Key, Type: instance.Type, Generation: fence.Generation,
				Reason: "device reconnected",
			}})
		}
	}
	l.settle(ctx, state, now)
	return l.save(ctx, state)
}

func (l *Leases) resendReset(state *leaseState, fence *store.ResourceFence, now time.Time) {
	instance := state.instances[fence.ResourceID]
	fence = state.fence(fence.ResourceID, fence.SourceID)
	fence.Resetting, fence.Unconfirmed, fence.ResetSince = true, false, formatTime(now)
	state.resets = append(state.resets, resetJob{sourceID: fence.SourceID, request: store.ResourceResetRequest{
		ResourceID: fence.ResourceID, Key: instance.Key, Type: instance.Type, Generation: fence.Generation,
		Reason: nameOr(fence.ResetReason, "reset"),
	}})
	state.sources[fence.SourceID] = true
}

// ResetDone: the hosting device fenced and reset an instance at
// generation. An error leaves it unready until a reset succeeds.
func (l *Leases) ResetDone(ctx context.Context, resourceID string, generation int64, resetErr string) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	state, err := l.load(ctx)
	if err != nil {
		return err
	}
	fence := state.fences[resourceID]
	if fence == nil || fence.Generation != generation || !(fence.Resetting || fence.Unconfirmed) {
		return nil
	}
	fence = state.fence(resourceID, fence.SourceID)
	if resetErr != "" {
		fence.Resetting, fence.Unconfirmed = false, true
		fence.ResetReason = "reset failed: " + clipRunes(resetErr, 200)
	} else {
		fence.Resetting, fence.Unconfirmed, fence.ResetSince = false, false, ""
	}
	state.sources[fence.SourceID] = true
	now := l.Now().UTC()
	l.settle(ctx, state, now)
	return l.save(ctx, state)
}

// InventoryChanged: a source reported. Leases on instances now gone are
// revoked; instances that became usable go to their waits.
func (l *Leases) InventoryChanged(ctx context.Context, sourceID string) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	state, err := l.load(ctx)
	if err != nil {
		return err
	}
	now := l.Now().UTC()
	for _, lease := range sortedLive(state) {
		if instance, ok := state.instances[lease.ResourceID]; lease.SourceID == sourceID && (!ok || instance.State == store.ResourceGone) {
			l.end(state, lease, store.LeaseRevoked, "the resource is gone from its device", "foundry", now)
		}
	}
	l.settle(ctx, state, now)
	return l.save(ctx, state)
}

// settle hands out what became free and recomputes contention.
func (l *Leases) settle(ctx context.Context, state *leaseState, now time.Time) {
	l.grantWaiting(ctx, state, now)
	l.contention(state, now)
}

// --- timers ------------------------------------------------------------

// Sweep applies what is due: parked leases expire, contended ones are
// preempted, unattended ones park, ones on a device away too long are
// revoked, unconfirmed resets leave their instance unready, waits past
// their retention expire. Run it every few seconds.
func (l *Leases) Sweep(ctx context.Context) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	state, err := l.load(ctx)
	if err != nil {
		return err
	}
	now := l.Now().UTC()
	for _, lease := range sortedLive(state) {
		switch {
		case lease.State == store.LeaseParked && lease.ParkUntil != "" && !parseTime(lease.ParkUntil).After(now):
			l.end(state, lease, store.LeaseExpired, "its holder's turn ended and it was kept as long as allowed", "foundry", now)
		case lease.PreemptAt != "" && !parseTime(lease.PreemptAt).After(now) && l.inflight[lease.ID] == 0:
			l.end(state, lease, store.LeasePreempted, "another session waited for it as long as a holder may keep it", "foundry", now)
		case l.awayTooLong(lease.SourceID, now):
			l.end(state, lease, store.LeaseRevoked, "its device was offline longer than "+l.Config.HostOfflineGrace.String(), "foundry", now)
		case lease.State == store.LeaseActive && lease.HolderOfflineSince != "" &&
			!parseTime(lease.HolderOfflineSince).Add(l.Config.HolderDisconnectGrace).After(now):
			since := parseTime(lease.HolderOfflineSince)
			lease.State = store.LeaseParked
			lease.ParkUntil = l.parkUntil(state, lease, since)
			state.touch(lease)
		case lease.PreemptAt != "" && lease.WarnedAt == "":
			if spec := l.specIn(state, lease); !parseTime(lease.PreemptAt).Add(-spec.PreemptWarning).After(now) {
				lease.WarnedAt = formatTime(now)
				state.touch(lease)
			}
		}
	}
	for _, fence := range state.fences {
		if fence.Resetting && l.hostOnline(fence.SourceID) && fence.ResetSince != "" &&
			!parseTime(fence.ResetSince).Add(l.Config.ResetAckTimeout).After(now) {
			fence = state.fence(fence.ResourceID, fence.SourceID)
			fence.Resetting, fence.Unconfirmed = false, true
			fence.ResetReason = "its device did not confirm the reset within " + l.Config.ResetAckTimeout.String()
			state.sources[fence.SourceID] = true
		}
	}
	for _, wait := range state.waits {
		if wait.State != store.WaitWaiting {
			continue
		}
		if _, calling := l.waiters[wait.ID]; !calling && !parseTime(wait.RetainUntil).After(now) {
			wait.State = store.WaitExpired
			state.touchWait(wait)
		}
	}
	l.settle(ctx, state, now)
	if err := l.save(ctx, state); err != nil {
		return err
	}
	if now.Sub(l.lastCleanup) > time.Hour {
		l.lastCleanup = now
		if _, err := l.store.DeleteEndedResourceLeases(ctx, now.Add(-l.Config.EndedRetention)); err != nil {
			return err
		}
		if _, err := l.store.DeleteResourceOperations(ctx, now.Add(-l.Config.EndedRetention)); err != nil {
			return err
		}
	}
	return nil
}

func (l *Leases) awayTooLong(sourceID string, now time.Time) bool {
	since, away := l.hostOffline[sourceID]
	return away && !since.Add(l.Config.HostOfflineGrace).After(now)
}

// Run sweeps every interval until ctx ends.
func (l *Leases) Run(ctx context.Context, interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := l.Sweep(ctx); err != nil && ctx.Err() == nil {
				log.Printf("resource leases sweep: %v", err)
			}
		}
	}
}

// Recover runs once at server start: every device counts as just gone
// (they reconnect within the grace), the holders' sessions are read again
// (a turn that ended while the server was down parks or releases), and
// timers due during the restart are pushed back by RestartGrace.
func (l *Leases) Recover(ctx context.Context) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	state, err := l.load(ctx)
	if err != nil {
		return err
	}
	now := l.Now().UTC()
	grace := formatTime(now.Add(l.Config.RestartGrace))
	for _, fence := range state.fences {
		if l.HostOnline == nil || !l.HostOnline(fence.SourceID) {
			l.hostOffline[fence.SourceID] = now
		}
		if fence.Resetting {
			fence = state.fence(fence.ResourceID, fence.SourceID)
			fence.ResetSince = formatTime(now)
		}
	}
	for _, lease := range sortedLive(state) {
		if l.HostOnline == nil || !l.HostOnline(lease.SourceID) {
			l.hostOffline[lease.SourceID] = now
		}
		info, err := l.Session(ctx, lease.HolderSessionID)
		switch {
		case err != nil:
			l.end(state, lease, store.LeaseReleased, "its session no longer exists", "foundry", now)
			continue
		case info.Status == "failed" || info.Status == "canceled":
			l.end(state, lease, store.LeaseReleased, "its session's turn ended ("+info.Status+") while the server was down", "foundry", now)
			continue
		case !turnRunning(info.Status) && lease.State == store.LeaseActive:
			lease.State = store.LeaseParked
			lease.ParkUntil = l.parkUntil(state, lease, now)
		}
		if lease.ParkUntil != "" && lease.ParkUntil < grace {
			lease.ParkUntil = grace
		}
		if lease.PreemptAt != "" && lease.PreemptAt < grace {
			lease.PreemptAt = grace
		}
		if lease.HolderOfflineSince != "" {
			lease.HolderOfflineSince = formatTime(now)
		}
		state.touch(lease)
	}
	for _, wait := range state.waits {
		if wait.RetainUntil < grace {
			wait.RetainUntil = grace
			state.touchWait(wait)
		}
	}
	l.contention(state, now)
	return l.save(ctx, state)
}

// --- operations --------------------------------------------------------

// Ticket is an operation the server let through: run it on the hosting
// device, then Finish it.
type Ticket struct {
	Lease    store.ResourceLease
	Instance store.ResourceInstance
	Spec     TypeSpec
	Backend  store.ResourceBackend
}

// Begin lets one operation request on a lease through: its holder, live,
// at the instance's generation, on a device that is online. A parked lease
// operated outside a turn (background work) is kept ParkTTL longer.
func (l *Leases) Begin(ctx context.Context, leaseID, sessionID string) (Ticket, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	lease, err := l.leaseByID(ctx, leaseID)
	if err != nil {
		return Ticket{}, err
	}
	if lease.HolderSessionID != sessionID {
		return Ticket{}, leaseError(CodeNotHolder, "lease %s belongs to another session", leaseID)
	}
	state, err := l.load(ctx)
	if err != nil {
		return Ticket{}, err
	}
	instance := state.instances[lease.ResourceID]
	if !store.LeaseLive(lease.State) {
		refusal := leaseError(CodeLeaseEnded, "lease %s on %s ended (%s: %s); acquire the resource again%s", lease.ID, nameOr(instance.Name, lease.ResourceID), lease.State, lease.EndReason, specOrDefault(instance.Type).ResumeHint)
		refusal.Lease = &lease
		return Ticket{}, refusal
	}
	live := state.live[lease.ResourceID]
	now := l.Now().UTC()
	if live.PreemptAt != "" && !parseTime(live.PreemptAt).After(now) {
		if l.inflight[live.ID] == 0 {
			l.end(state, live, store.LeasePreempted, "another session waited for it as long as a holder may keep it", "foundry", now)
			l.settle(ctx, state, now)
			if err := l.save(ctx, state); err != nil {
				return Ticket{}, err
			}
		}
		refusal := leaseError(CodeLeaseEnded, "lease %s on %s was taken for the session waiting for it; acquire it again later", lease.ID, instance.Name)
		refusal.Lease = live
		return Ticket{}, refusal
	}
	if fence := state.fences[lease.ResourceID]; fence != nil && fence.Generation != live.Generation {
		return Ticket{}, leaseError(CodeLeaseEnded, "lease %s is stale (generation %d, now %d); acquire again", lease.ID, live.Generation, fence.Generation)
	}
	if !l.hostOnline(live.SourceID) || instance.State == store.ResourceOffline {
		return Ticket{}, leaseError(CodeOffline, "%s is offline; the lease is kept for %s while it reconnects", nameOr(instance.Source.Label, "its device"), l.Config.HostOfflineGrace)
	}
	spec, ok := Spec(instance.Type)
	if !ok {
		return Ticket{}, leaseError(CodeNotLeasable, "%s is not operable", instance.Name)
	}
	if spec.RemoteCommands && !state.remoteCommands[instance.Source.ID] {
		return Ticket{}, remoteCommandsOff(instance)
	}
	backend, err := OperableBackend(instance)
	if err != nil {
		return Ticket{}, err
	}
	if live.State == store.LeaseParked {
		if until := formatTime(now.Add(spec.ParkTTL)); until > live.ParkUntil {
			live.ParkUntil = until
			state.touch(live)
			if err := l.save(ctx, state); err != nil {
				return Ticket{}, err
			}
		}
	}
	l.inflight[live.ID]++
	return Ticket{Lease: *live, Instance: instance, Spec: spec, Backend: backend}, nil
}

// Finish ends an operation request Begin let through and audits its
// actions. A preemption that waited for it happens now.
func (l *Leases) Finish(ctx context.Context, ticket Ticket, records []store.ResourceOperationRecord) error {
	l.mu.Lock()
	l.inflight[ticket.Lease.ID]--
	if l.inflight[ticket.Lease.ID] <= 0 {
		delete(l.inflight, ticket.Lease.ID)
	}
	l.mu.Unlock()
	var failed error
	for _, record := range records {
		if record.ID == "" {
			record.ID = newID("rop")
		}
		record.LeaseID, record.ResourceID, record.SourceID = ticket.Lease.ID, ticket.Lease.ResourceID, ticket.Lease.SourceID
		record.SessionID, record.UserID = ticket.Lease.HolderSessionID, ticket.Lease.HolderUserID
		if err := l.store.RecordResourceOperation(ctx, record); err != nil {
			failed = err
		}
	}
	if ticket.Lease.PreemptAt != "" && !parseTime(ticket.Lease.PreemptAt).After(l.Now()) {
		if err := l.Sweep(ctx); err != nil {
			return err
		}
	}
	return failed
}

// Operations lists an instance's audited operations, newest first.
func (l *Leases) Operations(ctx context.Context, resourceID string, limit int) ([]store.ResourceOperationRecord, error) {
	return l.store.ListResourceOperations(ctx, resourceID, limit)
}

// --- what holders are told ---------------------------------------------

// Notices are what a session should know of its leases, for every Foundry
// tool result: someone waits (and when the lease will be taken), the last
// warning, and leases that ended since it was last told.
func (l *Leases) Notices(ctx context.Context, sessionID string) []string {
	if sessionID == "" {
		return nil
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	notices := l.notices[sessionID]
	delete(l.notices, sessionID)
	leases, err := l.store.ListResourceLeases(ctx, store.ResourceLeaseFilter{SessionID: sessionID, Live: true})
	if err != nil {
		return notices
	}
	for _, lease := range leases {
		if notice := l.contendedNotice(ctx, lease); notice != "" {
			notices = append(notices, notice)
		}
	}
	return notices
}

func (l *Leases) contendedNotice(ctx context.Context, lease store.ResourceLease) string {
	if lease.PreemptAt == "" {
		return ""
	}
	at := parseTime(lease.PreemptAt)
	spec := l.specOf(ctx, &lease)
	if !at.Add(-spec.PreemptWarning).After(l.Now()) {
		return fmt.Sprintf("Last warning: lease %s will be taken at %s for the session waiting for it. Finish now and call release_resource.", lease.ID, lease.PreemptAt)
	}
	return fmt.Sprintf("Another session is waiting for the resource of lease %s. Release it with release_resource when done; it will be taken at %s.", lease.ID, lease.PreemptAt)
}

// View is a lease as resource tools answer it, so an agent need not guess
// how long it keeps it.
type View struct {
	ID         string `json:"id"`
	ResourceID string `json:"resourceId"`
	Generation int64  `json:"generation"`
	State      string `json:"state"`
	Renewal    string `json:"renewal,omitempty"`
	AfterTurn  string `json:"afterTurn,omitempty"`
	ParkUntil  string `json:"parkUntil,omitempty"`
	HoldUntil  string `json:"holdUntil,omitempty"`
	Waiters    int    `json:"waiters"`
	PreemptAt  string `json:"preemptAt,omitempty"`
	Notice     string `json:"notice,omitempty"`
	EndReason  string `json:"endReason,omitempty"`
}

// ViewOf describes a lease.
func (l *Leases) ViewOf(ctx context.Context, lease store.ResourceLease) View {
	view := View{
		ID: lease.ID, ResourceID: lease.ResourceID, Generation: lease.Generation, State: lease.State,
		ParkUntil: lease.ParkUntil, HoldUntil: lease.HoldUntil, PreemptAt: lease.PreemptAt, EndReason: lease.EndReason,
	}
	if !store.LeaseLive(lease.State) {
		return view
	}
	spec := l.specOf(ctx, &lease)
	view.Renewal = "automatic while your current turn runs"
	view.AfterTurn = fmt.Sprintf("parked for up to %s (longer with holdFor, at most %s); given at once to a session that asks unless you hold it",
		spec.ParkTTL, spec.MaxHoldFor)
	if waits, err := l.store.ListResourceWaits(ctx); err == nil {
		for _, wait := range waits {
			if wait.SessionID != lease.HolderSessionID && slices.Contains(wait.ResourceIDs, lease.ResourceID) {
				view.Waiters++
			}
		}
	}
	view.Notice = l.contendedNotice(ctx, lease)
	return view
}

// --- listing -----------------------------------------------------------

// overlay adds who holds each instance, how many wait and whether it is
// being reset; a held available instance reads busy, one whose reset went
// unconfirmed unready.
func (l *Leases) overlay(ctx context.Context, instances []store.ResourceInstance) error {
	live, err := l.store.ListResourceLeases(ctx, store.ResourceLeaseFilter{Live: true})
	if err != nil {
		return err
	}
	fences, err := l.store.ListResourceFences(ctx)
	if err != nil {
		return err
	}
	waits, err := l.store.ListResourceWaits(ctx)
	if err != nil {
		return err
	}
	byResource := map[string]store.ResourceLease{}
	for _, lease := range live {
		byResource[lease.ResourceID] = lease
	}
	fenceOf := map[string]store.ResourceFence{}
	for _, fence := range fences {
		fenceOf[fence.ResourceID] = fence
	}
	for index := range instances {
		instance := &instances[index]
		for _, wait := range waits {
			if slices.Contains(wait.ResourceIDs, instance.ID) {
				instance.Queue++
			}
		}
		if lease, ok := byResource[instance.ID]; ok {
			workspaceID := ""
			if l.Session != nil {
				if info, err := l.Session(ctx, lease.HolderSessionID); err == nil {
					workspaceID = info.WorkspaceID
				}
			}
			instance.Holder = holderOf(&lease, workspaceID)
			if instance.State == store.ResourceAvailable {
				instance.State = store.ResourceBusy
			}
		}
		if fence, ok := fenceOf[instance.ID]; ok {
			instance.Resetting = fence.Resetting
			if fence.Unconfirmed && instance.State == store.ResourceAvailable {
				instance.State, instance.StateReason = store.ResourceUnready, fence.ResetReason+"; release it on the Resources page to reset it again"
			}
		}
	}
	return nil
}

// --- helpers -----------------------------------------------------------

func turnRunning(status string) bool {
	return status == "queued" || status == "running" || status == "blocked"
}

func parseTime(value string) time.Time {
	parsed, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		return time.Time{}
	}
	return parsed
}

func newID(prefix string) string {
	var raw [10]byte
	if _, err := rand.Read(raw[:]); err != nil {
		panic(err)
	}
	return prefix + "_" + hex.EncodeToString(raw[:])
}

func nameOr(name, fallback string) string {
	if strings.TrimSpace(name) == "" {
		return fallback
	}
	return name
}

func clipRunes(text string, limit int) string {
	runes := []rune(text)
	if len(runes) <= limit {
		return text
	}
	return string(runes[:limit]) + "…"
}

// IsLeaseError reports a refusal with code.
func IsLeaseError(err error, code string) bool {
	var refusal *LeaseError
	return errors.As(err, &refusal) && refusal.Code == code
}
