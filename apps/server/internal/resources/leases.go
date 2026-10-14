package resources

// Leases: which session holds which instance, how long, and who waits.
// The rules (docs/resources.md):
//
//   - A lease lives with its holder session's turns: an input that is
//     queued, running or blocked, and a turn the agent runs on its own (a
//     timer, a background task's continuation; lease_turns.go). While one
//     runs the lease is active and never expires.
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
	"errors"
	"fmt"
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

// DefaultLeaseConfig holds the default timings (docs/resources.md).
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

// IsLeaseError reports a refusal with code.
func IsLeaseError(err error, code string) bool {
	var refusal *LeaseError
	return errors.As(err, &refusal) && refusal.Code == code
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
	// agentTurns: the sessions whose agent runs a turn of its own, by
	// session, with the device that runs it (see AgentTurn).
	agentTurns  map[string]string
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
		agentTurns:  map[string]string{},
	}
	inventory.leases = leases
	return leases
}
