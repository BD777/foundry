package resources

import (
	"context"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

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
