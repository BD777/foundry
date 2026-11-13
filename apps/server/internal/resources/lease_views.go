package resources

import (
	"context"
	"fmt"
	"slices"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

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
	Mode       string `json:"mode"`
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
		ID: lease.ID, ResourceID: lease.ResourceID, Generation: lease.Generation, Mode: lease.Mode, State: lease.State,
		ParkUntil: lease.ParkUntil, HoldUntil: lease.HoldUntil, PreemptAt: lease.PreemptAt, EndReason: lease.EndReason,
	}
	if !store.LeaseLive(lease.State) {
		return view
	}
	spec := l.specOf(ctx, &lease)
	view.Renewal = "automatic while your current turn runs"
	view.AfterTurn = fmt.Sprintf("parked for up to %s (longer with holdFor, at most %s); given at once to a session that asks unless you hold it",
		spec.ParkTTL, spec.MaxHoldFor)
	if lease.Mode == store.LeaseShared {
		view.AfterTurn = fmt.Sprintf("parked for up to %s (longer with holdFor, at most %s); a parked shared lease takes no slot, and ends at once when an exclusive request needs the resource unless you hold it",
			spec.ParkTTL, spec.MaxHoldFor)
	}
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

// overlay adds who holds each instance (exclusive holders first, then as
// they came), its slots for a type with shared leases, how many wait and
// whether it is being reset. An available instance reads busy when a new
// shared lease could not start on it now (an exclusive holder, or every
// slot in use), unready when its last reset went unconfirmed.
func (l *Leases) overlay(ctx context.Context, instances []store.ResourceInstance, sources []store.ResourceSourceStatus) error {
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
	byResource := map[string][]store.ResourceLease{}
	for _, lease := range live {
		byResource[lease.ResourceID] = append(byResource[lease.ResourceID], lease)
	}
	fenceOf := map[string]store.ResourceFence{}
	for _, fence := range fences {
		fenceOf[fence.ResourceID] = fence
	}
	state := &leaseState{instances: map[string]store.ResourceInstance{}, computeSlots: map[string]int{}}
	for _, source := range sources {
		if source.ComputeSlots > 0 {
			state.computeSlots[source.ID] = source.ComputeSlots
		}
	}
	workspaces := map[string]string{}
	workspaceOf := func(sessionID string) string {
		if workspaceID, ok := workspaces[sessionID]; ok || l.Session == nil {
			return workspaceID
		}
		if info, err := l.Session(ctx, sessionID); err == nil {
			workspaces[sessionID] = info.WorkspaceID
		}
		return workspaces[sessionID]
	}
	for index := range instances {
		instance := &instances[index]
		state.instances[instance.ID] = *instance
		for _, wait := range waits {
			if slices.Contains(wait.ResourceIDs, instance.ID) {
				instance.Queue++
			}
		}
		leases := byResource[instance.ID]
		slices.SortStableFunc(leases, func(a, b store.ResourceLease) int {
			return boolOrder(a.Mode == store.LeaseShared) - boolOrder(b.Mode == store.LeaseShared)
		})
		exclusive, inUse := false, 0
		for index := range leases {
			lease := &leases[index]
			instance.Holders = append(instance.Holders, *holderOf(lease, workspaceOf(lease.HolderSessionID)))
			if lease.Mode == store.LeaseShared {
				if lease.State == store.LeaseActive {
					inUse++
				}
			} else {
				exclusive = true
			}
		}
		if len(instance.Holders) > 0 {
			instance.Holder = &instance.Holders[0]
		}
		capacity := 1
		if spec, ok := Spec(instance.Type); ok && spec.Shared {
			capacity = l.capacity(state, instance.ID)
			instance.Slots = &store.ResourceSlots{Capacity: capacity, InUse: inUse, Auto: state.computeSlots[instance.Source.ID] == 0}
		}
		full := exclusive || (len(leases) > 0 && (instance.Slots == nil || inUse >= capacity))
		if full && instance.State == store.ResourceAvailable {
			instance.State = store.ResourceBusy
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

func boolOrder(value bool) int {
	if value {
		return 1
	}
	return 0
}
