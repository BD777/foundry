package connectors

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// ErrUnknownConnector: no device-held connector of that kind.
var ErrUnknownConnector = errors.New("no device-held connector of that kind")

// ErrNotDeviceOwner: a binding names a device the caller does not own.
var ErrNotDeviceOwner = errors.New("only a device's owner binds its connectors")

// DeviceHeld is the device-held kind: the credential stays on the device
// and the server keeps what the device read of it (never a token), with the
// expiry reminder, and which workspaces may use which device's login.
type DeviceHeld struct {
	store   store.DeviceConnectorStore
	catalog *Catalog
	// Now is the clock; tests move it.
	Now func() time.Time

	pollsMu sync.Mutex
	polls   map[string]signInPoll
}

// signInPollGap: polls of one sign-in closer than this get the last answer
// instead of another run of the device's tool.
const signInPollGap = 2 * time.Second

type signInPoll struct {
	at     time.Time
	answer store.DeviceConnectorSignIn
}

// NewDeviceHeld builds the service over the store and the catalog.
func NewDeviceHeld(st store.DeviceConnectorStore, catalog *Catalog) *DeviceHeld {
	return &DeviceHeld{store: st, catalog: catalog, Now: time.Now, polls: map[string]signInPoll{}}
}

// RecentSignInPoll is the answer of a poll of the device's sign-in made
// less than signInPollGap ago.
func (d *DeviceHeld) RecentSignInPoll(deviceID, kind string) (store.DeviceConnectorSignIn, bool) {
	d.pollsMu.Lock()
	defer d.pollsMu.Unlock()
	poll, ok := d.polls[deviceID+"\x00"+kind]
	if !ok || d.Now().Sub(poll.at) >= signInPollGap {
		return store.DeviceConnectorSignIn{}, false
	}
	return poll.answer, true
}

// RememberSignInPoll keeps a poll's answer for RecentSignInPoll.
func (d *DeviceHeld) RememberSignInPoll(deviceID, kind string, answer store.DeviceConnectorSignIn) {
	d.pollsMu.Lock()
	defer d.pollsMu.Unlock()
	now := d.Now()
	for key, poll := range d.polls {
		if now.Sub(poll.at) > time.Hour {
			delete(d.polls, key)
		}
	}
	d.polls[deviceID+"\x00"+kind] = signInPoll{at: now, answer: answer}
}

// Connector finds a device-held connector by kind.
func (d *DeviceHeld) Connector(kind string) (store.ConnectorDescriptor, error) {
	descriptor, ok := d.catalog.Lookup(kind)
	if !ok || descriptor.Holding != store.ConnectorDeviceHeld {
		return store.ConnectorDescriptor{}, fmt.Errorf("%w: %q", ErrUnknownConnector, kind)
	}
	return descriptor, nil
}

// Connectors lists the device-held connectors.
func (d *DeviceHeld) Connectors() []store.ConnectorDescriptor { return d.catalog.DeviceHeld() }

// withExpiry derives the status from the login's expiry as of now: a
// signed-in login past its end is "expired", inside the reminder window
// "expiring". The device's own word stands for everything else.
func (d *DeviceHeld) withExpiry(state store.DeviceConnectorState) store.DeviceConnectorState {
	if !state.SignedIn || (state.Status != store.DeviceConnectorReady && state.Status != store.DeviceConnectorExpiring && state.Status != store.DeviceConnectorExpired) {
		return state
	}
	expiry, err := time.Parse(time.RFC3339, state.ExpiresAt)
	if err != nil {
		state.Status = store.DeviceConnectorReady
		return state
	}
	now := d.Now()
	days := 3
	if descriptor, ok := d.catalog.Lookup(state.Kind); ok && descriptor.ExpiryReminderDays > 0 {
		days = descriptor.ExpiryReminderDays
	}
	switch {
	case !now.Before(expiry):
		state.Status = store.DeviceConnectorExpired
	case expiry.Sub(now) < time.Duration(days)*24*time.Hour:
		state.Status = store.DeviceConnectorExpiring
	default:
		state.Status = store.DeviceConnectorReady
	}
	return state
}

// Record keeps what deviceID just read of a connector. The reminder state
// carries over: the first reading inside the reminder window starts it, a
// reading of a fresh login (a new sign-in) clears it.
func (d *DeviceHeld) Record(ctx context.Context, deviceID string, reading store.DeviceConnectorState) (store.DeviceConnectorState, error) {
	if _, err := d.Connector(reading.Kind); err != nil {
		return store.DeviceConnectorState{}, err
	}
	reading.DeviceID = deviceID
	reading.CheckedAt = d.Now().UTC().Format(time.RFC3339)
	if reading.ExpiresAt != "" {
		if expiry, err := parseTime(reading.ExpiresAt); err == nil {
			reading.ExpiresAt = expiry.UTC().Format(time.RFC3339)
		} else {
			reading.ExpiresAt = ""
		}
	}
	reading.Sites = cleanSites(reading.Sites)
	reading.Identity = identityLabel(reading.Identity)
	if !reading.SignedIn {
		reading.Identity = ""
		reading.Sites = nil
		reading.ExpiresAt = ""
	}
	reading = d.withExpiry(reading)
	previous, _ := d.state(ctx, deviceID, reading.Kind)
	switch reading.Status {
	case store.DeviceConnectorExpiring, store.DeviceConnectorExpired:
		reading.ExpiringSince = previous.ExpiringSince
		if reading.ExpiringSince == "" {
			reading.ExpiringSince = reading.CheckedAt
		}
	case store.DeviceConnectorReady:
		reading.ExpiringSince = ""
	default:
		reading.ExpiringSince = previous.ExpiringSince
	}
	if err := d.store.SaveDeviceConnectorState(ctx, reading); err != nil {
		return store.DeviceConnectorState{}, err
	}
	return reading, nil
}

func (d *DeviceHeld) state(ctx context.Context, deviceID, kind string) (store.DeviceConnectorState, bool) {
	states, err := d.store.ListDeviceConnectorStates(ctx, []string{deviceID})
	if err != nil {
		return store.DeviceConnectorState{}, false
	}
	for _, state := range states {
		if state.Kind == kind {
			return state, true
		}
	}
	return store.DeviceConnectorState{}, false
}

// States lists what the devices last read, with the status brought up to
// date against the clock (a login may have expired since).
func (d *DeviceHeld) States(ctx context.Context, deviceIDs []string) ([]store.DeviceConnectorState, error) {
	states, err := d.store.ListDeviceConnectorStates(ctx, deviceIDs)
	if err != nil {
		return nil, err
	}
	known := states[:0]
	for _, state := range states {
		if _, err := d.Connector(state.Kind); err == nil {
			known = append(known, d.withExpiry(state))
		}
	}
	return known, nil
}

// SetBindings replaces the bindings userID granted in the workspace. Each
// names a device-held connector and a device userID owns.
func (d *DeviceHeld) SetBindings(ctx context.Context, workspaceID, userID string, bindings []store.DeviceConnectorBindingInput, ownsDevice func(deviceID string) bool) error {
	seen := map[string]bool{}
	clean := make([]store.DeviceConnectorBindingInput, 0, len(bindings))
	for _, binding := range bindings {
		binding.Kind = strings.TrimSpace(binding.Kind)
		binding.DeviceID = strings.TrimSpace(binding.DeviceID)
		if _, err := d.Connector(binding.Kind); err != nil {
			return err
		}
		if binding.DeviceID == "" || ownsDevice == nil || !ownsDevice(binding.DeviceID) {
			return fmt.Errorf("%w: %s", ErrNotDeviceOwner, binding.DeviceID)
		}
		key := binding.Kind + "\x00" + binding.DeviceID
		if seen[key] {
			continue
		}
		seen[key] = true
		clean = append(clean, binding)
	}
	return d.store.SetWorkspaceDeviceConnectors(ctx, workspaceID, userID, clean)
}

// Bindings lists the workspace's device-held bindings.
func (d *DeviceHeld) Bindings(ctx context.Context, workspaceID string) ([]store.DeviceConnectorBinding, error) {
	return d.store.ListWorkspaceDeviceConnectors(ctx, workspaceID)
}

// DeviceEligible says whether sessionOwner's session in workspaceID on
// deviceID, a device deviceOwner owns, may use the device's login under
// binding: the binding is the device owner's for that workspace and
// device, and the session is the owner's own or the binding lets members
// use it. The same rule as externalaccounts.Permitted, with the device's
// login in place of the person's account.
func DeviceEligible(binding store.DeviceConnectorBinding, workspaceID, deviceID, sessionOwner, deviceOwner string) bool {
	if deviceOwner == "" || sessionOwner == "" {
		return false
	}
	if binding.WorkspaceID != workspaceID || binding.DeviceID != deviceID || binding.GrantedBy != deviceOwner {
		return false
	}
	return sessionOwner == deviceOwner || binding.Members
}

// SessionUses is what a session gets of each device-held connector: the
// device's login where DeviceEligible holds; for a session someone else
// started on the device, "none" with the connector's isolation; for the
// owner's own session in an unbound workspace, nothing (the login is theirs).
func (d *DeviceHeld) SessionUses(ctx context.Context, session store.AgentSession, deviceOwner string) ([]store.DeviceConnectorUse, error) {
	connectors := d.Connectors()
	if len(connectors) == 0 || sandboxedRole(session.Role) {
		return nil, nil
	}
	bindings, err := d.store.ListWorkspaceDeviceConnectors(ctx, session.WorkspaceID)
	if err != nil {
		return nil, err
	}
	var uses []store.DeviceConnectorUse
	for _, descriptor := range connectors {
		use := store.DeviceConnectorUse{Kind: descriptor.Kind, Adapter: descriptor.Adapter, Label: descriptor.Label, Command: descriptor.Tool.Command}
		eligible := false
		for _, binding := range bindings {
			if binding.Kind == descriptor.Kind && DeviceEligible(binding, session.WorkspaceID, session.DeviceID, session.CreatedByUserID, deviceOwner) {
				eligible = true
			}
		}
		switch {
		case eligible:
			use.Access = "device_login"
		case session.CreatedByUserID != deviceOwner && len(descriptor.IsolationEnv) > 0:
			use.Access = "none"
			use.IsolationEnv = descriptor.IsolationEnv
		default:
			continue
		}
		uses = append(uses, use)
	}
	return uses, nil
}

// identityLabel keeps the name a tool shows for its login and never an
// email address: the part before an "@", at most 64 characters.
func identityLabel(identity string) string {
	identity, _, _ = strings.Cut(strings.TrimSpace(identity), "@")
	if len(identity) > 64 {
		identity = identity[:64]
	}
	return identity
}

func cleanSites(sites []string) []string {
	seen := map[string]bool{}
	var clean []string
	for _, site := range sites {
		site = strings.TrimSpace(site)
		if site == "" || len(site) > 32 || seen[site] {
			continue
		}
		seen[site] = true
		clean = append(clean, site)
	}
	sort.Strings(clean)
	return clean
}

func parseTime(value string) (time.Time, error) {
	parsed, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		parsed, err = time.Parse(time.RFC3339, value)
	}
	return parsed, err
}
