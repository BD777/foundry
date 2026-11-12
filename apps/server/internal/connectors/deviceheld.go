package connectors

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/externalaccounts"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// ErrUnknownConnector: no device-held connector of that kind.
var ErrUnknownConnector = errors.New("no device-held connector of that kind")

// ErrNotDeviceOwner: a binding names a device the caller does not own.
var ErrNotDeviceOwner = errors.New("only a device's owner binds its connectors")

var connectorRegionPattern = regexp.MustCompile(
	`^[a-z]{2}(-[a-z]+)+-\d{1,2}$`,
)

// DeviceHeld is the device-held kind: the credential stays on the device
// and the server keeps what the device read of it (never a token), with the
// expiry reminder, and which workspaces may use which device's login.
type DeviceHeld struct {
	store   DeviceHeldStore
	access  externalaccounts.ConnectorAccessStore
	catalog *Catalog
	// Now is the clock; tests move it.
	Now func() time.Time

	authorizationMu sync.Mutex
	authorizations  map[string]*authorizationSlot
}

// DeviceHeldStore is the device-held records plus the workspace and
// Personal Agent lookup its session policy needs.
type DeviceHeldStore interface {
	store.DeviceConnectorStore
	externalaccounts.ConnectorAccessStore
	DevicesOwnedBy(context.Context, string) ([]string, error)
}

// NewDeviceHeld builds the service over the store and the catalog.
func NewDeviceHeld(st DeviceHeldStore, catalog *Catalog) *DeviceHeld {
	return &DeviceHeld{store: st, access: st, catalog: catalog, Now: time.Now}
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
func (d *DeviceHeld) withExpiry(state store.DeviceConnectorState, descriptor store.ConnectorDescriptor) store.DeviceConnectorState {
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
	if descriptor.ExpiryReminderDays > 0 {
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
	descriptor, err := d.ConnectorOn(ctx, deviceID, reading.Kind)
	if err != nil {
		return store.DeviceConnectorState{}, err
	}
	reading.DeviceID = deviceID
	reading.CheckedAt = d.Now().UTC().Format(time.RFC3339)
	if reading.Configuration != nil {
		region := strings.TrimSpace(reading.Configuration.Region)
		if region == "" || !connectorRegionPattern.MatchString(region) {
			reading.Configuration = nil
		} else {
			reading.Configuration = &store.ConnectorConfiguration{
				Region: region,
			}
		}
	}
	if reading.ExpiresAt != "" {
		if expiry, err := parseTime(reading.ExpiresAt); err == nil {
			reading.ExpiresAt = expiry.UTC().Format(time.RFC3339)
		} else {
			reading.ExpiresAt = ""
		}
	}
	cleanAuth := []store.ConnectorAuthorizationState{}
	for _, group := range descriptor.AuthorizationGroups {
		for _, a := range reading.Authorizations {
			if a.ID != group.ID || a.Revision != group.Revision {
				continue
			}
			switch a.Status {
			case "ready", "needs_auth", "expired", "unknown", "unavailable":
			default:
				a.Status = "unknown"
			}
			if a.Verification != "local_state" {
				a.Verification = "not_checked"
			}
			switch a.Reason {
			case "bootstrap_available", "cli_upgrade", "check_failed":
			default:
				a.Reason = ""
			}
			granted := []string{}
			for _, scope := range group.Scopes {
				for _, value := range a.GrantedScopes {
					if value == scope.ID {
						granted = append(granted, value)
						break
					}
				}
			}
			a.GrantedScopes = granted
			a.LastChange = cleanScopeChange(a.LastChange, group.Scopes)
			a.CheckedAt = reading.CheckedAt
			cleanAuth = append(cleanAuth, a)
			break
		}
	}
	reading.Authorizations = cleanAuth
	reading.SessionCheck = cleanSessionCheck(reading.SessionCheck, reading.CheckedAt, reading.SignedIn)
	reading.Sites = cleanSites(reading.Sites)
	reading.Identity = identityLabel(reading.Identity)
	if !reading.SignedIn {
		reading.Identity = ""
		reading.Sites = nil
		reading.ExpiresAt = ""
	}
	reading = d.withExpiry(reading, descriptor)
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
	on, err := d.connectorsOn(ctx, deviceIDs)
	if err != nil {
		return nil, err
	}
	known := states[:0]
	for _, state := range states {
		for _, descriptor := range on[state.DeviceID] {
			if descriptor.Kind == state.Kind {
				known = append(known, d.withExpiry(state, descriptor))
				break
			}
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
		if binding.DeviceID == "" || ownsDevice == nil || !ownsDevice(binding.DeviceID) {
			return fmt.Errorf("%w: %s", ErrNotDeviceOwner, binding.DeviceID)
		}
		descriptor, err := d.ConnectorOn(ctx, binding.DeviceID, binding.Kind)
		if err != nil {
			return err
		}
		if connectorHasVisibilityGate(descriptor) {
			visible, err := d.VisibleKinds(ctx, []string{binding.DeviceID})
			if err != nil {
				return err
			}
			if !visible[binding.Kind] {
				return ErrUnknownConnector
			}
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

// SessionUses provides ready device logins automatically to their owner's
// sessions that take connectors. Other members still need an explicit
// workspace grant.
// Unavailable member access carries the connector's isolation environment
// (when it declares one).
func (d *DeviceHeld) SessionUses(ctx context.Context, session store.AgentSession, deviceOwner string) ([]store.DeviceConnectorUse, error) {
	if !takesConnectors(session) {
		return nil, nil
	}
	on, err := d.connectorsOn(ctx, []string{session.DeviceID})
	if err != nil {
		return nil, err
	}
	connectors := on[session.DeviceID]
	if len(connectors) == 0 {
		return nil, nil
	}
	visible, err := d.VisibleKinds(ctx, []string{session.DeviceID})
	if err != nil {
		return nil, err
	}
	states, err := d.States(ctx, []string{session.DeviceID})
	if err != nil {
		return nil, err
	}
	bindings, err := d.store.ListWorkspaceDeviceConnectors(ctx, session.WorkspaceID)
	if err != nil {
		return nil, err
	}
	policy, err := externalaccounts.ResolvePolicy(ctx, d.access, session)
	if err != nil {
		return nil, err
	}
	var uses []store.DeviceConnectorUse
	for _, descriptor := range connectors {
		if connectorHasVisibilityGate(descriptor) && !visible[descriptor.Kind] {
			continue
		}
		use := store.DeviceConnectorUse{Kind: descriptor.Kind, Adapter: descriptor.Adapter, Label: descriptor.Label, Command: descriptor.Tool.Command}
		accountID := externalaccounts.DeviceAccountID(session.DeviceID, descriptor.Kind)
		assistantDisabled := policy.Assistant() && !policy.Allows(accountID)
		var state *store.DeviceConnectorState
		for _, reading := range states {
			if reading.Kind == descriptor.Kind && reading.SignedIn && (reading.Status == store.DeviceConnectorReady || reading.Status == store.DeviceConnectorExpiring) {
				state = &reading
				break
			}
		}
		eligible := deviceOwner != "" && session.CreatedByUserID == deviceOwner
		for _, binding := range bindings {
			if binding.Kind == descriptor.Kind && DeviceEligible(binding, session.WorkspaceID, session.DeviceID, session.CreatedByUserID, deviceOwner) {
				eligible = true
			}
		}
		if assistantDisabled {
			eligible = false
		}
		switch {
		case assistantDisabled:
			use.Access = "none"
			use.IsolationEnv = descriptor.IsolationEnv
			use.State = state
		case eligible && state != nil:
			use.Access = "device_login"
			use.State = state
		case session.CreatedByUserID != deviceOwner:
			// Another person's session with no grant is kept from every
			// device login on the device, whether or not the descriptor
			// declares isolation variables: the worker isolates with what
			// it has (the adapter's own isolation, the declared variables).
			use.Access = "none"
			use.IsolationEnv = descriptor.IsolationEnv
		default:
			continue
		}
		uses = append(uses, use)
	}
	return uses, nil
}

// cleanSessionCheck keeps what the worker checked of a session's environment:
// the booleans and short sentences, never longer text. A connector that is
// not signed in has nothing to check.
func cleanSessionCheck(check *store.DeviceConnectorSessionCheck, checkedAt string, signedIn bool) *store.DeviceConnectorSessionCheck {
	if check == nil || !signedIn {
		return nil
	}
	clean := store.DeviceConnectorSessionCheck{Usable: check.Usable, IsolationHolds: check.IsolationHolds, CheckedAt: checkedAt}
	if !check.Usable {
		clean.Reason = shortText(check.Reason, 300)
		if clean.Reason == "" {
			clean.Reason = "this connector did not work in a session's environment"
		}
	}
	if check.IsolationHolds != nil && !*check.IsolationHolds {
		clean.IsolationReason = shortText(check.IsolationReason, 300)
	}
	return &clean
}

func shortText(text string, limit int) string {
	text = strings.Map(func(r rune) rune {
		if r < 0x20 {
			return ' '
		}
		return r
	}, strings.TrimSpace(text))
	if len(text) > limit {
		text = text[:limit]
	}
	return text
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

// cleanScopeChange keeps a reported change of granted scopes only in the
// group's own scope names, from a known source, at a real time.
func cleanScopeChange(change *store.ConnectorScopeChange, scopes []store.ConnectorAuthorizationScope) *store.ConnectorScopeChange {
	if change == nil || (change.Source != "foundry" && change.Source != "outside") {
		return nil
	}
	if _, err := time.Parse(time.RFC3339Nano, change.At); err != nil {
		return nil
	}
	listed := func(values []string) []string {
		kept := []string{}
		for _, value := range values {
			for _, scope := range scopes {
				if scope.ID == value {
					kept = append(kept, value)
					break
				}
			}
		}
		return kept
	}
	clean := store.ConnectorScopeChange{Source: change.Source, At: change.At, Added: listed(change.Added), Removed: listed(change.Removed)}
	if len(clean.Added) == 0 && len(clean.Removed) == 0 {
		return nil
	}
	return &clean
}
