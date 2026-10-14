package connectors

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/externalaccounts"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// memoryStore keeps device connector records in memory.
type memoryStore struct {
	states   map[string]store.DeviceConnectorState
	bindings []store.DeviceConnectorBinding
}

func newMemoryStore() *memoryStore {
	return &memoryStore{states: map[string]store.DeviceConnectorState{}}
}

func (m *memoryStore) SaveDeviceConnectorState(_ context.Context, state store.DeviceConnectorState) error {
	m.states[state.DeviceID+"/"+state.Kind] = state
	return nil
}

func (m *memoryStore) ListDeviceConnectorStates(_ context.Context, deviceIDs []string) ([]store.DeviceConnectorState, error) {
	var states []store.DeviceConnectorState
	for _, id := range deviceIDs {
		for key, state := range m.states {
			if strings.HasPrefix(key, id+"/") {
				states = append(states, state)
			}
		}
	}
	return states, nil
}

func (m *memoryStore) SetWorkspaceDeviceConnectors(_ context.Context, workspaceID, userID string, bindings []store.DeviceConnectorBindingInput) error {
	kept := m.bindings[:0]
	for _, binding := range m.bindings {
		if binding.WorkspaceID != workspaceID || binding.GrantedBy != userID {
			kept = append(kept, binding)
		}
	}
	m.bindings = kept
	for _, binding := range bindings {
		m.bindings = append(m.bindings, store.DeviceConnectorBinding{WorkspaceID: workspaceID, Kind: binding.Kind, DeviceID: binding.DeviceID, Members: binding.Members, GrantedBy: userID})
	}
	return nil
}

func (m *memoryStore) ListWorkspaceDeviceConnectors(_ context.Context, workspaceID string) ([]store.DeviceConnectorBinding, error) {
	var bindings []store.DeviceConnectorBinding
	for _, binding := range m.bindings {
		if binding.WorkspaceID == workspaceID {
			bindings = append(bindings, binding)
		}
	}
	return bindings, nil
}

func TestCatalogDescribesFeishuAndBytedcli(t *testing.T) {
	catalog := DefaultCatalog()
	feishu, ok := catalog.Lookup("feishu")
	if !ok || feishu.Holding != store.ConnectorServerHeld || feishu.Tool.Command != "feishu-cli" {
		t.Fatalf("feishu = %+v", feishu)
	}
	bytedcli, ok := catalog.Lookup("bytedcli")
	if !ok || bytedcli.Holding != store.ConnectorDeviceHeld || bytedcli.Tool.Package != "@bytedance-dev/bytedcli" ||
		bytedcli.Tool.Registry != "device" || len(bytedcli.Requires) != 1 || bytedcli.Requires[0].Host != "cloud.bytedance.net" ||
		bytedcli.IsolationEnv["BYTEDCLI_PROFILE"] == "" {
		t.Fatalf("bytedcli = %+v", bytedcli)
	}
	if held := catalog.DeviceHeld(); len(held) != 1 || held[0].Kind != "bytedcli" {
		t.Fatalf("device-held = %+v", held)
	}
}

// Every server-held connector has its adapter in externalaccounts, with the
// same tool, and no provider is outside the catalog.
func TestServerHeldConnectorsMatchTheirProviders(t *testing.T) {
	catalog := DefaultCatalog()
	providers := externalaccounts.NewRegistry(&externalaccounts.Feishu{}).Describe()
	held := map[string]store.ConnectorDescriptor{}
	for _, descriptor := range catalog.All() {
		if descriptor.Holding == store.ConnectorServerHeld {
			held[descriptor.Kind] = descriptor
		}
	}
	if len(held) != len(providers) {
		t.Fatalf("server-held connectors %v, providers %+v", held, providers)
	}
	for _, provider := range providers {
		descriptor, ok := held[provider.Kind]
		if !ok || len(provider.Tools) == 0 || provider.Tools[0] != descriptor.Tool.Command || provider.CredentialMode != store.ExternalCredentialServerHeld {
			t.Errorf("provider %+v does not match %+v", provider, descriptor)
		}
	}
}

func TestCatalogRejectsWhatAWorkerCouldNotUseSafely(t *testing.T) {
	for name, data := range map[string]string{
		"duplicate":          `[{"kind":"a","label":"A","holding":"server_held","adapter":"a","tool":{"command":"a"}},{"kind":"a","label":"A","holding":"server_held","adapter":"a","tool":{"command":"a"}}]`,
		"bad kind":           `[{"kind":"A B","label":"A","holding":"server_held","adapter":"a","tool":{"command":"a"}}]`,
		"bad holding":        `[{"kind":"a","label":"A","holding":"cloud","adapter":"a","tool":{"command":"a"}}]`,
		"command path":       `[{"kind":"a","label":"A","holding":"server_held","adapter":"a","tool":{"command":"../a"}}]`,
		"device without npm": `[{"kind":"a","label":"A","holding":"device_held","adapter":"a","tool":{"command":"a"}}]`,
		"server isolation":   `[{"kind":"a","label":"A","holding":"server_held","adapter":"a","tool":{"command":"a"},"isolationEnv":{"X":"y"}}]`,
		"odd requirement":    `[{"kind":"a","label":"A","holding":"device_held","adapter":"a","tool":{"command":"a","source":"npm","package":"a","registry":"device"},"requires":[{"kind":"ping","host":"x","port":1,"label":"x"}]}]`,
		"shell in isolation": `[{"kind":"a","label":"A","holding":"device_held","adapter":"a","tool":{"command":"a","source":"npm","package":"a","registry":"device"},"isolationEnv":{"X":"$(rm -rf ~)"}}]`,
	} {
		if _, err := ParseCatalog([]byte(data)); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

func TestDeviceEligible(t *testing.T) {
	binding := store.DeviceConnectorBinding{WorkspaceID: "ws", Kind: "bytedcli", DeviceID: "dev", GrantedBy: "owner"}
	members := binding
	members.Members = true
	for _, check := range []struct {
		name                                  string
		binding                               store.DeviceConnectorBinding
		workspace, device, session, deviceOwn string
		want                                  bool
	}{
		{"the owner's session on the device", binding, "ws", "dev", "owner", "owner", true},
		{"another workspace", binding, "ws2", "dev", "owner", "owner", false},
		{"another device", binding, "ws", "dev2", "owner", "owner", false},
		{"a member's session", binding, "ws", "dev", "member", "owner", false},
		{"a member's session, members allowed", members, "ws", "dev", "member", "owner", true},
		{"the device changed hands", binding, "ws", "dev", "new", "new", false},
		{"an ownerless device", binding, "ws", "dev", "", "", false},
	} {
		if got := DeviceEligible(check.binding, check.workspace, check.device, check.session, check.deviceOwn); got != check.want {
			t.Errorf("%s: %v, want %v", check.name, got, check.want)
		}
	}
}

func TestRecordKeepsMetadataAndTheReminder(t *testing.T) {
	st := newMemoryStore()
	devices := NewDeviceHeld(st, DefaultCatalog())
	now := time.Date(2026, 10, 15, 0, 0, 0, 0, time.UTC)
	devices.Now = func() time.Time { return now }
	ctx := context.Background()
	reading := store.DeviceConnectorState{Kind: "bytedcli", Status: store.DeviceConnectorReady, Installed: true, SignedIn: true,
		Identity: "someone@example.com", Sites: []string{" cn", "cn", ""}, ExpiresAt: "2026-10-30T08:00:00+08:00"}
	state, err := devices.Record(ctx, "dev", reading)
	if err != nil {
		t.Fatal(err)
	}
	if state.Status != store.DeviceConnectorReady || state.Identity != "someone" || strings.Join(state.Sites, ",") != "cn" ||
		state.ExpiresAt != "2026-10-30T00:00:00Z" || state.ExpiringSince != "" || state.DeviceID != "dev" {
		t.Fatalf("ready = %+v", state)
	}
	now = time.Date(2026, 10, 28, 0, 0, 0, 0, time.UTC)
	if state, _ = devices.Record(ctx, "dev", reading); state.Status != store.DeviceConnectorExpiring || state.ExpiringSince != "2026-10-28T00:00:00Z" {
		t.Fatalf("expiring = %+v", state)
	}
	now = now.Add(24 * time.Hour)
	if state, _ = devices.Record(ctx, "dev", reading); state.ExpiringSince != "2026-10-28T00:00:00Z" {
		t.Fatalf("the reminder moved: %+v", state)
	}
	// Read later without a check, the login has expired by the clock.
	now = time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC)
	states, _ := devices.States(ctx, []string{"dev"})
	if len(states) != 1 || states[0].Status != store.DeviceConnectorExpired {
		t.Fatalf("states = %+v", states)
	}
	// A new sign-in clears the reminder.
	reading.ExpiresAt = "2026-12-01T00:00:00Z"
	if state, _ = devices.Record(ctx, "dev", reading); state.Status != store.DeviceConnectorReady || state.ExpiringSince != "" {
		t.Fatalf("after a new sign-in = %+v", state)
	}
	// Signed out keeps nothing of the login.
	if state, _ = devices.Record(ctx, "dev", store.DeviceConnectorState{Kind: "bytedcli", Status: store.DeviceConnectorSignedOut, Identity: "x", ExpiresAt: "2026-12-01T00:00:00Z"}); state.Identity != "" || state.ExpiresAt != "" {
		t.Fatalf("signed out = %+v", state)
	}
	if _, err := devices.Record(ctx, "dev", store.DeviceConnectorState{Kind: "feishu"}); !errors.Is(err, ErrUnknownConnector) {
		t.Fatalf("a server-held kind was recorded: %v", err)
	}
}

func TestSessionUsesFollowTheBindings(t *testing.T) {
	st := newMemoryStore()
	devices := NewDeviceHeld(st, DefaultCatalog())
	ctx := context.Background()
	owns := func(deviceID string) bool { return deviceID == "dev" }
	if err := devices.SetBindings(ctx, "ws", "owner", []store.DeviceConnectorBindingInput{{Kind: "bytedcli", DeviceID: "other"}}, owns); !errors.Is(err, ErrNotDeviceOwner) {
		t.Fatalf("bound another's device: %v", err)
	}
	if err := devices.SetBindings(ctx, "ws", "owner", []store.DeviceConnectorBindingInput{{Kind: "feishu", DeviceID: "dev"}}, owns); !errors.Is(err, ErrUnknownConnector) {
		t.Fatalf("bound a server-held kind: %v", err)
	}
	session := store.AgentSession{ID: "s", WorkspaceID: "ws", DeviceID: "dev", CreatedByUserID: "owner"}
	member := session
	member.CreatedByUserID = "member"
	sandboxed := session
	sandboxed.Role = store.AgentSessionRoleIssueExecution

	uses := func(session store.AgentSession) string {
		got, err := devices.SessionUses(ctx, session, "owner")
		if err != nil {
			t.Fatal(err)
		}
		var parts []string
		for _, use := range got {
			parts = append(parts, use.Kind+":"+use.Access)
		}
		return strings.Join(parts, ",")
	}
	// Unbound: the owner's own session gets nothing, a member's is kept out.
	if got := uses(session); got != "" {
		t.Fatalf("owner, unbound = %q", got)
	}
	if got := uses(member); got != "bytedcli:none" {
		t.Fatalf("member, unbound = %q", got)
	}
	if err := devices.SetBindings(ctx, "ws", "owner", []store.DeviceConnectorBindingInput{{Kind: "bytedcli", DeviceID: "dev"}}, owns); err != nil {
		t.Fatal(err)
	}
	if got := uses(session); got != "bytedcli:device_login" {
		t.Fatalf("owner, bound = %q", got)
	}
	if got := uses(member); got != "bytedcli:none" {
		t.Fatalf("member, bound to the owner only = %q", got)
	}
	if got := uses(sandboxed); got != "" {
		t.Fatalf("sandboxed = %q", got)
	}
	if err := devices.SetBindings(ctx, "ws", "owner", []store.DeviceConnectorBindingInput{{Kind: "bytedcli", DeviceID: "dev", Members: true}}, owns); err != nil {
		t.Fatal(err)
	}
	if got := uses(member); got != "bytedcli:device_login" {
		t.Fatalf("member, members allowed = %q", got)
	}
	elsewhere := session
	elsewhere.DeviceID = "dev2"
	if got := uses(elsewhere); got != "" {
		t.Fatalf("the owner's session on another device = %q", got)
	}
}

func TestSignInPollsCloseTogetherShareAnAnswer(t *testing.T) {
	devices := NewDeviceHeld(newMemoryStore(), DefaultCatalog())
	now := time.Now()
	devices.Now = func() time.Time { return now }
	if _, ok := devices.RecentSignInPoll("dev", "bytedcli"); ok {
		t.Fatal("an answer before any poll")
	}
	devices.RememberSignInPoll("dev", "bytedcli", store.DeviceConnectorSignIn{Status: "pending"})
	if answer, ok := devices.RecentSignInPoll("dev", "bytedcli"); !ok || answer.Status != "pending" {
		t.Fatalf("recent = %+v %v", answer, ok)
	}
	now = now.Add(signInPollGap)
	if _, ok := devices.RecentSignInPoll("dev", "bytedcli"); ok {
		t.Fatal("an old answer was reused")
	}
}
