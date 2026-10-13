package resources

import (
	"context"
	"slices"
	"sort"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

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
	attempt, err := l.tryAcquire(ctx, req, ids, session)
	if err != nil || attempt.waiter == nil {
		return attempt.leases, err
	}
	timer := time.NewTimer(attempt.wait)
	defer timer.Stop()
	select {
	case <-attempt.waiter:
	case <-timer.C:
	case <-ctx.Done():
	}
	return l.afterWait(context.WithoutCancel(ctx), req.SessionID, attempt.waitID, ids)
}

// acquireAttempt is how tryAcquire left a request: granted (leases), or
// queued (waiter is closed when the wait ends, waited for at most wait).
type acquireAttempt struct {
	leases []store.ResourceLease
	waitID string
	waiter chan struct{}
	wait   time.Duration
}

// tryAcquire grants what can be granted at once, refuses what must not
// wait, and queues the rest.
func (l *Leases) tryAcquire(ctx context.Context, req AcquireRequest, ids []string, session SessionInfo) (acquireAttempt, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	state, err := l.load(ctx)
	if err != nil {
		return acquireAttempt{}, err
	}
	now := l.Now().UTC()
	for _, id := range ids {
		if err := l.usable(state, id, now); err != nil {
			return acquireAttempt{}, err
		}
	}
	held := heldBy(state, req.SessionID)
	if mine := ownLeases(held, ids); len(mine) == len(ids) {
		// Asking again for what it holds: the leases, with a new hold.
		for _, lease := range mine {
			l.applyHold(state, lease, req.HoldFor, now)
		}
		result := copies(mine)
		return acquireAttempt{leases: result}, l.save(ctx, state)
	}
	if len(held) > 0 && req.Wait > 0 {
		names := []string{}
		for _, lease := range held {
			names = append(names, lease.ID+" ("+state.instances[lease.ResourceID].Name+")")
		}
		return acquireAttempt{}, leaseError(CodeHoldAndWait, "this session holds %s and cannot wait for more: release it first, or acquire everything you need in one call (resourceIds) without waiting",
			strings.Join(names, ", "))
	}
	wait, created := l.queue(state, req, ids, session, now)
	l.grantWaiting(ctx, state, now)
	if wait.State == store.WaitGranted {
		result := leasesFor(state, req.SessionID, ids)
		return acquireAttempt{leases: result}, l.save(ctx, state)
	}
	blocked := l.blockers(state, wait, now)
	if blocked.busy != nil && req.Wait == 0 {
		// Asked without waiting: refuse, and leave no wait behind.
		if created {
			wait.State = store.WaitCanceled
		}
		position := l.position(state, wait)
		if created {
			state.waits = slices.DeleteFunc(state.waits, func(w *store.ResourceWait) bool { return w.ID == wait.ID })
			delete(state.waited, wait.ID)
		}
		if err := l.save(ctx, state); err != nil {
			return acquireAttempt{}, err
		}
		refusal := leaseError(CodeBusy, "%s is held by session %s since %s; acquire with waitMs to queue for it", blocked.name, blocked.busy.SessionID, blocked.busy.Since)
		refusal.Holder, refusal.Position = blocked.busy, position
		return acquireAttempt{}, refusal
	}
	effective := req.Wait
	if effective < l.Config.ResetAckTimeout && blocked.busy == nil {
		// Only resets stand in the way: they take seconds.
		effective = l.Config.ResetAckTimeout
	}
	l.contention(state, now)
	waiter := make(chan struct{})
	l.waiters[wait.ID] = waiter
	if err := l.save(ctx, state); err != nil {
		delete(l.waiters, wait.ID)
		return acquireAttempt{}, err
	}
	return acquireAttempt{waitID: wait.ID, waiter: waiter, wait: effective}, nil
}

// queue finds the session's wait for ids, or adds it at the end, and keeps
// its place as long as the caller waits.
func (l *Leases) queue(state *leaseState, req AcquireRequest, ids []string, session SessionInfo, now time.Time) (*store.ResourceWait, bool) {
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
	wait.RetainUntil = formatTime(now.Add(max(req.Wait, l.Config.ResetAckTimeout) + l.Config.QueueRetention))
	state.touchWait(wait)
	return wait, created
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

// remoteCommandsOff refuses an instance whose owner does not allow remote
// commands on its device.
func remoteCommandsOff(instance store.ResourceInstance) *LeaseError {
	return leaseError(CodeUnready, "%s: the owner of %s has not allowed remote commands there; they turn on \"Allow remote commands from my sessions\" on the Resources page",
		instance.Name, nameOr(instance.Source.Label, "the device"))
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
