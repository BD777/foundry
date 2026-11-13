package resources

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"slices"
	"sort"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

type leaseState struct {
	instances map[string]store.ResourceInstance
	// live: the live leases by resource id, in the order they came; one
	// exclusive lease or any number of shared ones.
	live map[string][]*store.ResourceLease
	// pending: ended shared leases by resource id whose own reset the
	// device has not confirmed yet.
	pending map[string][]*store.ResourceLease
	fences  map[string]*store.ResourceFence
	waits   []*store.ResourceWait
	changes map[string]*store.ResourceLease // touched leases, by lease id
	fenced  map[string]bool                 // touched fences
	waited  map[string]bool                 // touched waits
	resets  []resetJob
	wake    []string
	sources map[string]bool
	// remoteCommands: the sources whose owner allows remote commands.
	remoteCommands map[string]bool
	// computeSlots: the sources whose owner chose a number of compute
	// slots.
	computeSlots map[string]int
	// policies: each source's settings, for the workspaces that may lease
	// its resources.
	policies map[string]store.ResourceSourceSettings
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
	pending, err := l.store.ListResourceLeases(ctx, store.ResourceLeaseFilter{ResetPending: true})
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
		instances: map[string]store.ResourceInstance{}, live: map[string][]*store.ResourceLease{},
		pending: map[string][]*store.ResourceLease{},
		fences:  map[string]*store.ResourceFence{}, changes: map[string]*store.ResourceLease{},
		fenced: map[string]bool{}, waited: map[string]bool{}, sources: map[string]bool{},
		remoteCommands: map[string]bool{}, computeSlots: map[string]int{},
		policies: map[string]store.ResourceSourceSettings{},
	}
	for _, source := range listing.Sources {
		state.remoteCommands[source.ID] = source.AllowRemoteCommands
		if source.ComputeSlots > 0 {
			state.computeSlots[source.ID] = source.ComputeSlots
		}
		state.policies[source.ID] = store.ResourceSourceSettings{AllowWorkspaces: source.AllowWorkspaces, DenyWorkspaces: source.DenyWorkspaces}
	}
	for _, instance := range instances {
		state.instances[instance.ID] = instance
	}
	for index := range live {
		lease := live[index]
		state.live[lease.ResourceID] = append(state.live[lease.ResourceID], &lease)
	}
	for _, leases := range state.live {
		sort.Slice(leases, func(i, j int) bool { return leases[i].Generation < leases[j].Generation })
	}
	for index := range pending {
		lease := pending[index]
		state.pending[lease.ResourceID] = append(state.pending[lease.ResourceID], &lease)
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

// sortedLive is every live lease, by resource and then as they came.
func sortedLive(state *leaseState) []*store.ResourceLease {
	ids := make([]string, 0, len(state.live))
	for id := range state.live {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	leases := []*store.ResourceLease{}
	for _, id := range ids {
		leases = append(leases, state.live[id]...)
	}
	return leases
}

// leaseOf is the live lease sessionID holds on resourceID, or nil.
func (s *leaseState) leaseOf(resourceID, sessionID string) *store.ResourceLease {
	for _, lease := range s.live[resourceID] {
		if lease.HolderSessionID == sessionID {
			return lease
		}
	}
	return nil
}

// liveByID is the live lease with id, or nil.
func (s *leaseState) liveByID(resourceID, leaseID string) *store.ResourceLease {
	for _, lease := range s.live[resourceID] {
		if lease.ID == leaseID {
			return lease
		}
	}
	return nil
}

// others are the live leases on resourceID held by sessions other than
// sessionID.
func (s *leaseState) others(resourceID, sessionID string) []*store.ResourceLease {
	var others []*store.ResourceLease
	for _, lease := range s.live[resourceID] {
		if lease.HolderSessionID != sessionID {
			others = append(others, lease)
		}
	}
	return others
}

func (s *leaseState) addLive(lease *store.ResourceLease) {
	s.live[lease.ResourceID] = append(s.live[lease.ResourceID], lease)
}

func (s *leaseState) removeLive(lease *store.ResourceLease) {
	leases := slices.DeleteFunc(s.live[lease.ResourceID], func(other *store.ResourceLease) bool { return other.ID == lease.ID })
	if len(leases) == 0 {
		delete(s.live, lease.ResourceID)
		return
	}
	s.live[lease.ResourceID] = leases
}

func (s *leaseState) removePending(lease *store.ResourceLease) {
	leases := slices.DeleteFunc(s.pending[lease.ResourceID], func(other *store.ResourceLease) bool { return other.ID == lease.ID })
	if len(leases) == 0 {
		delete(s.pending, lease.ResourceID)
		return
	}
	s.pending[lease.ResourceID] = leases
}

// capacity is how many active shared leases resourceID runs at once: 1
// for a type without shared leases or a device whose worker cannot run
// them side by side, else its owner's number or AutoSlots.
func (l *Leases) capacity(state *leaseState, resourceID string) int {
	instance := state.instances[resourceID]
	spec, ok := Spec(instance.Type)
	if !ok || !spec.Shared || !l.sharedCapable(instance.Source.ID) {
		return 1
	}
	if slots := state.computeSlots[instance.Source.ID]; slots > 0 {
		return min(slots, MaxComputeSlots)
	}
	return AutoSlots(instance.Details)
}

func (l *Leases) sharedCapable(sourceID string) bool {
	return l.SharedLeases == nil || l.SharedLeases(sourceID)
}

// modeOf is the mode a wait asks for on resourceID: its own, else the
// type's default.
func modeOf(state *leaseState, wait *store.ResourceWait, resourceID string) string {
	if wait.Mode != "" {
		return wait.Mode
	}
	return specOrDefault(state.instances[resourceID].Type).DefaultMode()
}

// activeShared counts the active shared leases among leases.
func activeShared(leases []*store.ResourceLease) int {
	count := 0
	for _, lease := range leases {
		if lease.Mode == store.LeaseShared && lease.State == store.LeaseActive {
			count++
		}
	}
	return count
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

// workspaceRefused refuses an instance whose device's owner does not lease
// its resources to sessions working in workspaceID.
func workspaceRefused(state *leaseState, instance store.ResourceInstance, workspaceID string) error {
	if state.policies[instance.Source.ID].LeasesWorkspace(workspaceID) {
		return nil
	}
	return leaseError(CodeRefused, "%s: the owner of %s does not lease its resources to sessions working in workspace %s (its lease policy on the Resources page)",
		instance.Name, nameOr(instance.Source.Label, "the device"), workspaceID)
}
