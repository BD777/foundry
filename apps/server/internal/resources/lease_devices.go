package resources

import (
	"context"
	"log"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

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
