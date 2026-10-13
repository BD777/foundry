package resources

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"sort"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

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

// settle hands out what became free and recomputes contention.
func (l *Leases) settle(ctx context.Context, state *leaseState, now time.Time) {
	l.grantWaiting(ctx, state, now)
	l.contention(state, now)
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

func newID(prefix string) string {
	var raw [10]byte
	if _, err := rand.Read(raw[:]); err != nil {
		panic(err)
	}
	return prefix + "_" + hex.EncodeToString(raw[:])
}
