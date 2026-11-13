package resources

import (
	"context"
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// end ends a live lease. The last lease on an instance fences it past
// every generation and the instance is reset before anyone else gets it;
// a shared lease that ends beside others has only its own commands
// stopped (ResetPending until the device confirms). by is the holder
// session, a person's account or "foundry".
func (l *Leases) end(state *leaseState, lease *store.ResourceLease, how, reason, by string, now time.Time) {
	lease.State = how
	lease.EndedAt = formatTime(now)
	lease.EndReason = reason
	lease.EndedBy = by
	lease.ContendedSince, lease.PreemptAt = "", ""
	state.removeLive(lease)
	state.touch(lease)
	instance := state.instances[lease.ResourceID]
	l.endNotice(state, lease, how, reason, by)
	if len(state.live[lease.ResourceID]) > 0 {
		lease.ResetSince = formatTime(now)
		state.pending[lease.ResourceID] = append(state.pending[lease.ResourceID], lease)
		state.resets = append(state.resets, resetJob{sourceID: lease.SourceID, request: store.ResourceResetRequest{
			ResourceID: lease.ResourceID, Key: instance.Key, Type: instance.Type, Generation: lease.Generation,
			LeaseOnly: true, Reason: how + ": " + reason,
		}})
		return
	}
	fence := state.fence(lease.ResourceID, lease.SourceID)
	if fence.Generation <= lease.Generation {
		fence.Generation = lease.Generation
	}
	fence.Generation++
	fence.Resetting, fence.Unconfirmed = true, false
	fence.ResetSince, fence.ResetReason = formatTime(now), reason
	state.resets = append(state.resets, resetJob{sourceID: lease.SourceID, request: store.ResourceResetRequest{
		ResourceID: lease.ResourceID, Key: instance.Key, Type: instance.Type, Generation: fence.Generation,
		Reason: how + ": " + reason, Notify: "A Foundry session stopped using " + nameOr(instance.Name, "this resource") + ".",
	}})
}

// endNotice tells a holder whose lease someone else ended.
func (l *Leases) endNotice(state *leaseState, lease *store.ResourceLease, how, reason, by string) {
	instance := state.instances[lease.ResourceID]
	if by != lease.HolderSessionID {
		l.notices[lease.HolderSessionID] = append(l.notices[lease.HolderSessionID],
			fmt.Sprintf("Your lease %s on %s ended (%s: %s). Acquire it again before operating%s.",
				lease.ID, nameOr(instance.Name, lease.ResourceID), how, reason, l.specIn(state, lease).ResumeHint))
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
	live := state.liveByID(lease.ResourceID, leaseID)
	if live == nil {
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
	for _, lease := range sortedLive(state) {
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

// Revoke ends leases on an instance for a person (byUserID): the one with
// leaseID, or every one when leaseID is empty. An instance nobody holds
// whose last reset went unconfirmed is reset again.
func (l *Leases) Revoke(ctx context.Context, resourceID, leaseID, byUserID string) ([]store.ResourceLease, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	state, err := l.load(ctx)
	if err != nil {
		return nil, err
	}
	now := l.Now().UTC()
	var ending []*store.ResourceLease
	for _, lease := range state.live[resourceID] {
		if leaseID == "" || lease.ID == leaseID {
			ending = append(ending, lease)
		}
	}
	if len(ending) == 0 {
		if fence := state.fences[resourceID]; leaseID == "" && fence != nil && (fence.Unconfirmed || fence.Resetting) {
			l.resendReset(state, fence, now)
			return nil, l.save(ctx, state)
		}
		if leaseID != "" {
			return nil, leaseError(CodeNothingHeld, "lease %s on %s is not live", leaseID, resourceID)
		}
		return nil, leaseError(CodeNothingHeld, "no session holds %s", resourceID)
	}
	ended := []store.ResourceLease{}
	for _, lease := range ending {
		l.end(state, lease, store.LeaseRevoked, "the person released it", byUserID, now)
		ended = append(ended, *lease)
	}
	l.settle(ctx, state, now)
	return ended, l.save(ctx, state)
}

// LetFinish postpones the pending preemption of leases on an instance
// once, by its type's ContendedCap: the person lets the holders finish
// (the one with leaseID, or every one about to lose it when empty).
func (l *Leases) LetFinish(ctx context.Context, resourceID, leaseID string) ([]store.ResourceLease, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	state, err := l.load(ctx)
	if err != nil {
		return nil, err
	}
	extended := []store.ResourceLease{}
	already := false
	for _, lease := range state.live[resourceID] {
		if lease.PreemptAt == "" || (leaseID != "" && lease.ID != leaseID) {
			continue
		}
		if lease.Extended {
			already = true
			continue
		}
		spec := l.specIn(state, lease)
		lease.PreemptAt = formatTime(parseTime(lease.PreemptAt).Add(spec.ContendedCap))
		lease.Extended, lease.WarnedAt = true, ""
		state.touch(lease)
		extended = append(extended, *lease)
	}
	if len(extended) == 0 {
		if already {
			return nil, leaseError(CodeInvalid, "this lease was already let finish once")
		}
		return nil, leaseError(CodeNothingHeld, "no session is about to lose %s", resourceID)
	}
	return extended, l.save(ctx, state)
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
	if settings.ComputeSlots > 0 {
		state.computeSlots[sourceID] = settings.ComputeSlots
	} else {
		delete(state.computeSlots, sourceID)
	}
	state.policies[sourceID] = settings
	// Sessions of a workspace the policy now refuses lose their leases and
	// waits on the device.
	refused := func(sessionID, resourceID string) bool {
		instance, ok := state.instances[resourceID]
		if !ok || instance.Source.ID != sourceID {
			return false
		}
		info, err := l.Session(ctx, sessionID)
		return err == nil && !settings.LeasesWorkspace(info.WorkspaceID)
	}
	for _, lease := range sortedLive(state) {
		if refused(lease.HolderSessionID, lease.ResourceID) {
			l.end(state, lease, store.LeaseRevoked, "the device's owner no longer leases it to sessions of this workspace", byUserID, now)
		}
	}
	for _, wait := range state.waits {
		if wait.State == store.WaitWaiting && slices.ContainsFunc(wait.ResourceIDs, func(id string) bool { return refused(wait.SessionID, id) }) {
			l.cancelWait(state, wait)
		}
	}
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
