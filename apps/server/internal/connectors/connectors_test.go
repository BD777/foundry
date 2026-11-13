package connectors

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/externalaccounts"
	"github.com/foundry-dev/foundry/apps/server/internal/jsonempty"
	"github.com/foundry-dev/foundry/apps/server/internal/permission"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// memoryStore keeps device connector records in memory.
type memoryStore struct {
	states     map[string]store.DeviceConnectorState
	bindings   []store.DeviceConnectorBinding
	workspaces map[string]store.WorkspaceProjection
	assistants map[string]store.PersonalAgent
	helpers    map[string]store.PersonalAgent
	packages   map[string]store.PermissionPackage
	sessions   map[string]store.AgentSession
	// extensions: what each device's extensions provide; "*" for every device.
	extensions map[string][]store.ConnectorDescriptor
	visibility map[string]store.ConnectorVisibilityCheck
}

func newMemoryStore() *memoryStore {
	return &memoryStore{
		states:     map[string]store.DeviceConnectorState{},
		workspaces: map[string]store.WorkspaceProjection{},
		assistants: map[string]store.PersonalAgent{},
		packages:   map[string]store.PermissionPackage{},
		sessions:   map[string]store.AgentSession{},
		extensions: map[string][]store.ConnectorDescriptor{"*": {corpcli()}},
		visibility: map[string]store.ConnectorVisibilityCheck{},
	}
}

func allowConnectorRequirements(t *testing.T, st *memoryStore, deviceID string, descriptor store.ConnectorDescriptor) {
	t.Helper()
	if err := st.SaveConnectorVisibilityCheck(context.Background(), store.ConnectorVisibilityCheck{
		DeviceID: deviceID, Result: store.ConnectorVisibilityRequirements, Kind: descriptor.Kind,
		Via: requirementVisibilitySignature(descriptor), Status: "ok",
	}); err != nil {
		t.Fatal(err)
	}
}

// corpcli is an extension's device-held connector, as a device reports it.
func corpcli() store.ConnectorDescriptor {
	return store.ConnectorDescriptor{
		Kind: "corpcli", Label: "corpcli", Holding: store.ConnectorDeviceHeld, Adapter: "extension:corp",
		Extension:           &store.ConnectorExtensionSource{ID: "corp", Name: "Corp tools", Version: "1.2.0"},
		Tool:                store.ConnectorTool{Command: "corpcli", Source: "npm", Package: "@corp/cli", Registry: "device"},
		Requires:            []store.ConnectorRequirement{{Kind: "tcp_reachable", Host: "intranet.example", Port: 443, Label: "Corp network"}},
		IsolationEnv:        map[string]string{"CORPCLI_PROFILE": "foundry-no-login"},
		SignIn:              &store.ConnectorSignIn{Methods: []store.ConnectorSignInMethod{{ID: "device", Kind: "guided", Label: "Scan a code"}}},
		AuthorizationGroups: []store.ConnectorAuthorizationGroup{{ID: "feishu_web_session", Revision: 1, Label: "Web session", Capabilities: []string{"web"}, Credential: "native_web_session"}},
	}
}

func (m *memoryStore) DeviceExtensionConnectors(_ context.Context, deviceIDs []string) (map[string][]store.ConnectorDescriptor, error) {
	result := map[string][]store.ConnectorDescriptor{}
	for _, id := range deviceIDs {
		if reported, ok := m.extensions[id]; ok {
			result[id] = reported
		} else if reported, ok := m.extensions["*"]; ok {
			result[id] = reported
		}
	}
	return result, nil
}

func (m *memoryStore) SaveConnectorVisibilityCheck(_ context.Context, check store.ConnectorVisibilityCheck) error {
	m.visibility[visibilityKey(check.DeviceID, check.Result, check.Kind, check.Via, check.Repository)] = check
	return nil
}

func (m *memoryStore) ListConnectorVisibilityChecks(_ context.Context, deviceIDs []string) ([]store.ConnectorVisibilityCheck, error) {
	var checks []store.ConnectorVisibilityCheck
	for _, deviceID := range deviceIDs {
		for _, check := range m.visibility {
			if check.DeviceID == deviceID {
				checks = append(checks, check)
			}
		}
	}
	return checks, nil
}

func (m *memoryStore) DeleteConnectorVisibilityChecks(_ context.Context, deviceID, via string) error {
	for key, check := range m.visibility {
		if check.DeviceID == deviceID && (via == "" || check.Via == via) {
			delete(m.visibility, key)
		}
	}
	return nil
}

func (m *memoryStore) DevicesOwnedBy(_ context.Context, _ string) ([]string, error) {
	var ids []string
	for id := range m.extensions {
		if id != "*" {
			ids = append(ids, id)
		}
	}
	return ids, nil
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

func (m *memoryStore) GetWorkspace(_ context.Context, workspaceID string) (store.WorkspaceProjection, error) {
	if workspace, ok := m.workspaces[workspaceID]; ok {
		return workspace, nil
	}
	return store.WorkspaceProjection{ID: workspaceID, Kind: store.WorkspaceKindProject}, nil
}

func (m *memoryStore) AssistantForWorkspace(_ context.Context, workspaceID string) (store.PersonalAgent, error) {
	if agent, ok := m.assistants[workspaceID]; ok {
		return agent, nil
	}
	return store.PersonalAgent{}, store.ErrNotFound
}

func (m *memoryStore) AssistantForSession(_ context.Context, sessionID string) (store.PersonalAgent, error) {
	if agent, ok := m.helpers[sessionID]; ok {
		return agent, nil
	}
	if session, ok := m.sessions[sessionID]; ok {
		if agent, ok := m.assistants[session.WorkspaceID]; ok {
			return agent, nil
		}
	}
	return store.PersonalAgent{}, store.ErrNotFound
}

func (m *memoryStore) GetAgentSessionSummary(_ context.Context, id string) (store.AgentSession, error) {
	if session, ok := m.sessions[id]; ok {
		return session, nil
	}
	return store.AgentSession{}, store.ErrNotFound
}

func (m *memoryStore) GetPermissionPackage(_ context.Context, owner, id string) (store.PermissionPackage, error) {
	if pkg, ok := m.packages[id]; ok && pkg.Owner == owner {
		return pkg, nil
	}
	return store.PermissionPackage{}, store.ErrNotFound
}

func (m *memoryStore) SavePermissionPackage(_ context.Context, pkg store.PermissionPackage) (store.PermissionPackage, error) {
	pkg = permission.Normalize(pkg)
	m.packages[pkg.ID] = pkg
	return pkg, nil
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

func TestCatalogDescribesTheBuiltInConnectors(t *testing.T) {
	catalog := DefaultCatalog()
	feishu, ok := catalog.Lookup("feishu")
	if !ok || feishu.Holding != store.ConnectorServerHeld || feishu.Tool.Command != "feishu-cli" {
		t.Fatalf("feishu = %+v", feishu)
	}
	aws, ok := catalog.Lookup("aws")
	if !ok || aws.Tool.Command != "aws" || aws.Tool.Source != "installer" || aws.Tool.MinimumVersion != "2.0.0" || aws.IsolationEnv["AWS_PROFILE"] == "" {
		t.Fatalf("aws = %+v", aws)
	}
	var methods []string
	for _, method := range aws.SignIn.Methods {
		methods = append(methods, method.ID+":"+method.Kind)
	}
	if strings.Join(methods, ",") != "console:guided,sso:guided,terminal:terminal" {
		t.Fatalf("aws sign-in = %v", methods)
	}
	var held []string
	for _, descriptor := range catalog.DeviceHeld() {
		held = append(held, descriptor.Kind)
	}
	if strings.Join(held, ",") != "aws,github,tencentcloud,alibabacloud" {
		t.Fatalf("device-held = %v", held)
	}
	for kind, isolation := range map[string][2]string{
		"tencentcloud": {"tccli", "TCCLI_PROFILE"},
		"alibabacloud": {"aliyun", "ALIBABA_CLOUD_IGNORE_PROFILE"},
	} {
		descriptor, ok := catalog.Lookup(kind)
		if !ok || descriptor.Tool.Command != isolation[0] || descriptor.Tool.Source != "installer" || descriptor.IsolationEnv[isolation[1]] == "" || descriptor.SignIn == nil || descriptor.SignIn.SignOut == nil || *descriptor.SignIn.SignOut {
			t.Fatalf("%s = %+v", kind, descriptor)
		}
	}
	// Nothing private is built in: company tools come as extensions.
	for _, descriptor := range catalog.All() {
		for _, word := range []string{"bytedcli", "bytedance", "limen", "meego"} {
			if strings.Contains(strings.ToLower(descriptor.Kind+descriptor.Label+descriptor.Tool.Package), word) {
				t.Errorf("built-in %s names %s", descriptor.Kind, word)
			}
		}
	}
}

func TestExtensionConnectorsAreCheckedAndStayOnTheirDevice(t *testing.T) {
	catalog := DefaultCatalog()
	good := corpcli()
	builtin := corpcli()
	builtin.Kind = "aws"
	unnamed := corpcli()
	unnamed.Extension = nil
	wrongAdapter := corpcli()
	wrongAdapter.Adapter = "corp"
	serverHeld := corpcli()
	serverHeld.Holding = store.ConnectorServerHeld
	badField := corpcli()
	badField.SignIn = &store.ConnectorSignIn{Methods: []store.ConnectorSignInMethod{{ID: "x", Kind: "guided", Label: "X", Fields: []store.ConnectorField{{ID: "method", Label: "M", Type: "text"}}}}}
	// An extension's model access serves Claude only (its session helper).
	codexAccess := corpcli()
	codexAccess.Kind = "corpgw"
	codexAccess.Provides = &store.ConnectorProvides{ModelAccess: &store.ConnectorModelAccess{Runtimes: []string{"codex"}}}
	missingProvider := corpcli()
	missingProvider.Kind = "missing-provider"
	missingProvider.Access = &store.ConnectorSourceAccess{Via: "aws", Repository: "owner/repository"}
	kept := catalog.ExtensionConnectors([]store.ConnectorDescriptor{good, good, builtin, unnamed, wrongAdapter, serverHeld, badField, codexAccess, missingProvider})
	if len(kept) != 1 || kept[0].Kind != "corpcli" {
		t.Fatalf("kept = %+v", kept)
	}
	_, refused := catalog.ExtensionConnectorsWithErrors([]store.ConnectorDescriptor{badField, missingProvider})
	if len(refused) != 2 || refused[0].Reason == "" || refused[1].Reason == "" {
		t.Fatalf("refused reasons = %+v", refused)
	}

	st := newMemoryStore()
	st.extensions = map[string][]store.ConnectorDescriptor{"dev": {good}}
	devices := NewDeviceHeld(st, catalog)
	ctx := context.Background()
	if _, err := devices.ConnectorOn(ctx, "dev", "corpcli"); err != nil {
		t.Fatal(err)
	}
	if _, err := devices.ConnectorOn(ctx, "other", "corpcli"); !errors.Is(err, ErrUnknownConnector) {
		t.Fatalf("offered on a device without the extension: %v", err)
	}
	if _, err := devices.Record(ctx, "other", store.DeviceConnectorState{Kind: "corpcli", Status: store.DeviceConnectorSignedOut}); !errors.Is(err, ErrUnknownConnector) {
		t.Fatalf("recorded on a device without the extension: %v", err)
	}
	listed, kinds, err := devices.ConnectorsFor(ctx, []string{"dev", "other"})
	builtinDeviceHeld := len(catalog.DeviceHeld())
	if err != nil || len(listed) != builtinDeviceHeld+1 || listed[builtinDeviceHeld].Kind != "corpcli" || len(kinds["dev"]) != 1 || len(kinds["other"]) != 0 {
		t.Fatalf("listed=%+v kinds=%v err=%v", listed, kinds, err)
	}
	newer := good
	newer.Extension = &store.ConnectorExtensionSource{ID: "corp", Name: "Corp tools", Version: "1.10.0"}
	st.extensions["other"] = []store.ConnectorDescriptor{newer}
	if listed, _, _ = devices.ConnectorsFor(ctx, []string{"dev", "other"}); listed[builtinDeviceHeld].Extension.Version != "1.10.0" {
		t.Fatalf("the newest version is not listed: %+v", listed[builtinDeviceHeld].Extension)
	}
}

func TestConnectorVisibilityRequiresEveryGateOnTheSameDevice(t *testing.T) {
	st := newMemoryStore()
	descriptor := corpcli()
	descriptor.Access = &store.ConnectorSourceAccess{
		Via: "github", Repository: "owner/repository",
	}
	st.extensions = map[string][]store.ConnectorDescriptor{
		"mac":   {descriptor},
		"linux": {descriptor},
	}
	devices := NewDeviceHeld(st, DefaultCatalog())
	ctx := context.Background()
	now := time.Now().UTC().Format(time.RFC3339)
	for _, check := range []store.ConnectorVisibilityCheck{
		{DeviceID: "mac", Result: store.ConnectorVisibilityRequirements, Kind: descriptor.Kind, Via: requirementVisibilitySignature(descriptor), Status: "ok", CheckedAt: now},
		{DeviceID: "mac", Result: store.ConnectorVisibilityRepository, Kind: descriptor.Kind, Via: "github", Repository: descriptor.Access.Repository, Status: "no_access", CheckedAt: now},
		{DeviceID: "linux", Result: store.ConnectorVisibilityRequirements, Kind: descriptor.Kind, Via: requirementVisibilitySignature(descriptor), Status: "ok", CheckedAt: now},
		{DeviceID: "linux", Result: store.ConnectorVisibilityRepository, Kind: descriptor.Kind, Via: "github", Repository: descriptor.Access.Repository, Status: "ok", Identity: "reader", CheckedAt: now},
	} {
		if err := st.SaveConnectorVisibilityCheck(ctx, check); err != nil {
			t.Fatal(err)
		}
	}
	visible, err := devices.VisibleKinds(ctx, []string{"mac", "linux"})
	if err != nil || !visible[descriptor.Kind] {
		t.Fatalf("visible=%v err=%v", visible, err)
	}

	st.visibility[visibilityKey("linux", store.ConnectorVisibilityRepository, descriptor.Kind, "github", descriptor.Access.Repository)] = store.ConnectorVisibilityCheck{
		DeviceID: "linux", Result: store.ConnectorVisibilityRepository, Kind: descriptor.Kind,
		Via: "github", Repository: descriptor.Access.Repository, Status: "no_access", CheckedAt: now,
	}
	visible, err = devices.VisibleKinds(ctx, []string{"mac", "linux"})
	if err != nil || visible[descriptor.Kind] {
		t.Fatalf("hidden connector is visible: visible=%v err=%v", visible, err)
	}
}

// Every server-held connector has its adapter in externalaccounts, with the
// same tool, and no provider is outside the catalog.
func TestServerHeldConnectorsMatchTheirProviders(t *testing.T) {
	catalog := DefaultCatalog()
	providers := externalaccounts.NewRegistry(&externalaccounts.Feishu{}, externalaccounts.NewCloudflare(), externalaccounts.NewAppStoreConnect()).Describe()
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
		"duplicate":             `[{"kind":"a","label":"A","holding":"server_held","adapter":"a","tool":{"command":"a"}},{"kind":"a","label":"A","holding":"server_held","adapter":"a","tool":{"command":"a"}}]`,
		"bad kind":              `[{"kind":"A B","label":"A","holding":"server_held","adapter":"a","tool":{"command":"a"}}]`,
		"bad holding":           `[{"kind":"a","label":"A","holding":"cloud","adapter":"a","tool":{"command":"a"}}]`,
		"command path":          `[{"kind":"a","label":"A","holding":"server_held","adapter":"a","tool":{"command":"../a"}}]`,
		"device without npm":    `[{"kind":"a","label":"A","holding":"device_held","adapter":"a","tool":{"command":"a"}}]`,
		"server isolation":      `[{"kind":"a","label":"A","holding":"server_held","adapter":"a","tool":{"command":"a"},"isolationEnv":{"X":"y"}}]`,
		"odd requirement":       `[{"kind":"a","label":"A","holding":"device_held","adapter":"a","tool":{"command":"a","source":"npm","package":"a","registry":"device"},"requires":[{"kind":"ping","host":"x","port":1,"label":"x"}]}]`,
		"server sign-in":        `[{"kind":"a","label":"A","holding":"server_held","adapter":"a","tool":{"command":"a"},"signIn":{"methods":[{"id":"x","kind":"guided","label":"X"}]}}]`,
		"odd method kind":       `[{"kind":"a","label":"A","holding":"device_held","adapter":"a","tool":{"command":"a","source":"device"},"signIn":{"methods":[{"id":"x","kind":"magic","label":"X"}]}}]`,
		"terminal no command":   `[{"kind":"a","label":"A","holding":"device_held","adapter":"a","tool":{"command":"a","source":"device"},"signIn":{"methods":[{"id":"x","kind":"terminal","label":"X"}]}}]`,
		"odd field type":        `[{"kind":"a","label":"A","holding":"device_held","adapter":"a","tool":{"command":"a","source":"device"},"signIn":{"methods":[{"id":"x","kind":"guided","label":"X","fields":[{"id":"f","label":"F","type":"file"}]}]}}]`,
		"secret default":        `[{"kind":"a","label":"A","holding":"device_held","adapter":"a","tool":{"command":"a","source":"device"},"signIn":{"methods":[{"id":"x","kind":"guided","label":"X","fields":[{"id":"f","label":"F","type":"secret","default":"hunter2"}]}]}}]`,
		"dangling showWhen":     `[{"kind":"a","label":"A","holding":"device_held","adapter":"a","tool":{"command":"a","source":"device"},"signIn":{"methods":[{"id":"x","kind":"guided","label":"X","fields":[{"id":"f","label":"F","type":"text","showWhen":{"field":"g","equals":["1"]}}]}]}}]`,
		"http setup page":       `[{"kind":"a","label":"A","holding":"device_held","adapter":"a","tool":{"command":"a","source":"device"},"setup":{"url":"http://x"}}]`,
		"extension builtin":     `[{"kind":"a","label":"A","holding":"device_held","adapter":"extension:x","tool":{"command":"a","source":"device"}}]`,
		"shell in isolation":    `[{"kind":"a","label":"A","holding":"device_held","adapter":"a","tool":{"command":"a","source":"npm","package":"a","registry":"device"},"isolationEnv":{"X":"$(rm -rf ~)"}}]`,
		"preset unknown scope":  `[{"kind":"a","label":"A","holding":"device_held","adapter":"a","tool":{"command":"a","source":"device"},"authorizationGroups":[{"id":"permissions","revision":1,"label":"Permissions","scopes":[{"id":"repo","label":"Repo"}],"presets":[{"id":"except","label":"Except","hint":"Except one","excludeScopes":["missing"]}],"capabilities":["scopes"],"credential":"native_login"}]}]`,
		"preset required scope": `[{"kind":"a","label":"A","holding":"device_held","adapter":"a","tool":{"command":"a","source":"device"},"authorizationGroups":[{"id":"permissions","revision":1,"label":"Permissions","scopes":[{"id":"repo","label":"Repo","required":true}],"presets":[{"id":"except","label":"Except","hint":"Except one","excludeScopes":["repo"]}],"capabilities":["scopes"],"credential":"native_login"}]}]`,
	} {
		if _, err := ParseCatalog([]byte(data)); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

func TestDeviceEligible(t *testing.T) {
	binding := store.DeviceConnectorBinding{WorkspaceID: "ws", Kind: "corpcli", DeviceID: "dev", GrantedBy: "owner"}
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

// A device's check of what a session gets (DEV-128) is kept as short plain
// sentences and booleans, only for a login that reads as signed in.
func TestRecordKeepsTheSessionCheckOfASignedInLogin(t *testing.T) {
	st := newMemoryStore()
	devices := NewDeviceHeld(st, DefaultCatalog())
	ctx := context.Background()
	holds := false
	reading := store.DeviceConnectorState{Kind: "corpcli", Status: store.DeviceConnectorReady, Installed: true, SignedIn: true,
		SessionCheck: &store.DeviceConnectorSessionCheck{Usable: false, Reason: "gh is not on the\nPATH a session gets " + strings.Repeat("x", 400), IsolationHolds: &holds, IsolationReason: "still signed in", CheckedAt: "ignored"}}
	state, err := devices.Record(ctx, "dev", reading)
	if err != nil {
		t.Fatal(err)
	}
	check := state.SessionCheck
	if check == nil || check.Usable || strings.ContainsAny(check.Reason, "\n") || len(check.Reason) != 300 || check.IsolationHolds == nil || *check.IsolationHolds || check.IsolationReason != "still signed in" || check.CheckedAt != state.CheckedAt {
		t.Fatalf("session check = %+v", check)
	}
	// A usable one carries no reason; one that was not checked for isolation
	// says nothing of it; a login that is not signed in has no check.
	reading.SessionCheck = &store.DeviceConnectorSessionCheck{Usable: true, Reason: "stale", IsolationReason: "stale"}
	if state, _ = devices.Record(ctx, "dev", reading); state.SessionCheck == nil || !state.SessionCheck.Usable || state.SessionCheck.Reason != "" || state.SessionCheck.IsolationHolds != nil || state.SessionCheck.IsolationReason != "" {
		t.Fatalf("usable check = %+v", state.SessionCheck)
	}
	reading.SignedIn, reading.Status = false, store.DeviceConnectorSignedOut
	if state, _ = devices.Record(ctx, "dev", reading); state.SessionCheck != nil {
		t.Fatalf("signed-out login kept a check: %+v", state.SessionCheck)
	}
}

func TestRecordKeepsMetadataAndTheReminder(t *testing.T) {
	st := newMemoryStore()
	devices := NewDeviceHeld(st, DefaultCatalog())
	now := time.Date(2026, 10, 15, 0, 0, 0, 0, time.UTC)
	devices.Now = func() time.Time { return now }
	ctx := context.Background()
	reading := store.DeviceConnectorState{Kind: "corpcli", Status: store.DeviceConnectorReady, Installed: true, SignedIn: true,
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
	if state, _ = devices.Record(ctx, "dev", store.DeviceConnectorState{Kind: "corpcli", Status: store.DeviceConnectorSignedOut, Identity: "x", ExpiresAt: "2026-12-01T00:00:00Z"}); state.Identity != "" || state.ExpiresAt != "" {
		t.Fatalf("signed out = %+v", state)
	}
	if _, err := devices.Record(ctx, "dev", store.DeviceConnectorState{Kind: "feishu"}); !errors.Is(err, ErrUnknownConnector) {
		t.Fatalf("a server-held kind was recorded: %v", err)
	}
}

// DEV-128: whether another person's session is kept from a device login does
// not depend on the descriptor declaring isolation variables. GitHub CLI
// declares none (the worker's adapter isolates with its own); before, such
// sessions got no isolation at all.
func TestSessionsOfOtherPeopleAreIsolatedFromEveryDeviceLogin(t *testing.T) {
	st := newMemoryStore()
	devices := NewDeviceHeld(st, DefaultCatalog())
	ctx := context.Background()
	session := store.AgentSession{ID: "s", WorkspaceID: "ws", DeviceID: "dev", CreatedByUserID: "member"}
	github := func(session store.AgentSession) *store.DeviceConnectorUse {
		uses, err := devices.SessionUses(ctx, session, "owner")
		if err != nil {
			t.Fatal(err)
		}
		for i := range uses {
			if uses[i].Kind == "github" {
				return &uses[i]
			}
		}
		return nil
	}
	for _, descriptor := range DefaultCatalog().DeviceHeld() {
		if descriptor.Kind == "github" && len(descriptor.IsolationEnv) != 0 {
			t.Fatalf("this test is for a connector that declares no isolation variables: %+v", descriptor.IsolationEnv)
		}
	}
	if use := github(session); use == nil || use.Access != "none" || len(use.IsolationEnv) != 0 || use.State != nil {
		t.Fatalf("a member's session on a device with a GitHub login kept nothing out: %+v", use)
	}
	if _, err := devices.Record(ctx, "dev", store.DeviceConnectorState{Kind: "github", Status: store.DeviceConnectorReady, Installed: true, SignedIn: true, Identity: "BD777"}); err != nil {
		t.Fatal(err)
	}
	if use := github(session); use == nil || use.Access != "none" {
		t.Fatalf("a member's session was not isolated from a ready GitHub login: %+v", use)
	}
	// The owner gets the login; a member the owner shared it with does too.
	owner := session
	owner.CreatedByUserID = "owner"
	if use := github(owner); use == nil || use.Access != "device_login" || use.State == nil || use.State.Identity != "BD777" {
		t.Fatalf("the owner's session: %+v", use)
	}
	if err := devices.SetBindings(ctx, "ws", "owner", []store.DeviceConnectorBindingInput{{Kind: "github", DeviceID: "dev", Members: true}}, func(id string) bool { return id == "dev" }); err != nil {
		t.Fatal(err)
	}
	if use := github(session); use == nil || use.Access != "device_login" {
		t.Fatalf("a member with a shared binding: %+v", use)
	}
}

func TestPersonalAgentDeviceConnectorLevelIsolatesTheLogin(t *testing.T) {
	st := newMemoryStore()
	st.workspaces["ws_pa"] = store.WorkspaceProjection{ID: "ws_pa", Kind: store.WorkspaceKindPersonalAgent}
	pkg := permission.DefaultPackage("owner", "pp_owner")
	st.packages[pkg.ID] = pkg
	st.assistants["ws_pa"] = store.PersonalAgent{UserID: "owner", WorkspaceID: "ws_pa", HomeDeviceID: "dev", PermissionPackageID: pkg.ID}
	devices := NewDeviceHeld(st, DefaultCatalog())
	ctx := context.Background()
	if _, err := devices.Record(ctx, "dev", store.DeviceConnectorState{Kind: "github", Status: store.DeviceConnectorReady, Installed: true, SignedIn: true, Identity: "BD777"}); err != nil {
		t.Fatal(err)
	}
	session := store.AgentSession{ID: "pa", WorkspaceID: "ws_pa", DeviceID: "dev", CreatedByUserID: "owner"}
	st.sessions[session.ID] = session
	github := func() *store.DeviceConnectorUse {
		uses, err := devices.SessionUses(ctx, session, "owner")
		if err != nil {
			t.Fatal(err)
		}
		for i := range uses {
			if uses[i].Kind == "github" {
				return &uses[i]
			}
		}
		return nil
	}
	if use := github(); use == nil || use.Access != "device_login" {
		t.Fatalf("enabled assistant login: %+v", use)
	}
	st.assistants["ws_pa"] = store.PersonalAgent{
		UserID: "owner", WorkspaceID: "ws_pa", HomeDeviceID: "dev", PermissionPackageID: pkg.ID,
	}
	pkg.ConnectorAccounts = jsonempty.List[store.ConnectorAccountPermission]{
		{AccountID: externalaccounts.DeviceAccountID("dev", "github"), Level: store.ConnectorAccessLevelOff},
	}
	st.packages[pkg.ID] = pkg
	if use := github(); use == nil || use.Access != "none" {
		t.Fatalf("disabled assistant login: %+v", use)
	}
}

// DEV-191 P0: a helper the assistant started inherits the package's off.
func TestAssistantHelperDeviceConnectorOffIsolatesTheLogin(t *testing.T) {
	st := newMemoryStore()
	pkg := permission.DefaultPackage("owner", "pp_owner")
	st.packages[pkg.ID] = pkg
	agent := store.PersonalAgent{ID: "asst_work", UserID: "owner", WorkspaceID: "ws_pa", HomeDeviceID: "dev", PermissionPackageID: pkg.ID}
	st.helpers = map[string]store.PersonalAgent{"helper": agent}
	devices := NewDeviceHeld(st, DefaultCatalog())
	ctx := context.Background()
	if _, err := devices.Record(ctx, "dev", store.DeviceConnectorState{Kind: "github", Status: store.DeviceConnectorReady, Installed: true, SignedIn: true, Identity: "BD777"}); err != nil {
		t.Fatal(err)
	}
	helper := store.AgentSession{ID: "helper", WorkspaceID: "ws_project", DeviceID: "dev", CreatedByUserID: "owner", Source: store.SessionSourceAgent}
	ordinary := helper
	ordinary.ID = "ordinary"
	st.sessions[helper.ID], st.sessions[ordinary.ID] = helper, ordinary
	github := func(session store.AgentSession) string {
		uses, err := devices.SessionUses(ctx, session, "owner")
		if err != nil {
			t.Fatal(err)
		}
		for _, use := range uses {
			if use.Kind == "github" {
				return use.Access
			}
		}
		return ""
	}
	if got := github(helper); got != "device_login" {
		t.Fatalf("helper with the login allowed = %q", got)
	}
	pkg.ConnectorAccounts = jsonempty.List[store.ConnectorAccountPermission]{
		{AccountID: externalaccounts.DeviceAccountID("dev", "github"), Level: store.ConnectorAccessLevelOff},
	}
	st.packages[pkg.ID] = pkg
	if got := github(helper); got != "none" {
		t.Fatalf("helper with the login off = %q", got)
	}
	if got := github(ordinary); got != "device_login" {
		t.Fatalf("an ordinary session followed the assistant's package: %q", got)
	}
}

func TestSessionUsesFollowTheBindings(t *testing.T) {
	st := newMemoryStore()
	devices := NewDeviceHeld(st, DefaultCatalog())
	ctx := context.Background()
	owns := func(deviceID string) bool { return deviceID == "dev" }
	if err := devices.SetBindings(ctx, "ws", "owner", []store.DeviceConnectorBindingInput{{Kind: "corpcli", DeviceID: "other"}}, owns); !errors.Is(err, ErrNotDeviceOwner) {
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
	allowConnectorRequirements(t, st, "dev", corpcli())
	// Without a ready login, the owner gets nothing; a member is kept out.
	if got := uses(session); got != "" {
		t.Fatalf("owner, unbound = %q", got)
	}
	if got := uses(member); got != "aws:none,github:none,tencentcloud:none,alibabacloud:none,corpcli:none" {
		t.Fatalf("member, unbound = %q", got)
	}
	if _, err := devices.Record(ctx, "dev", store.DeviceConnectorState{Kind: "corpcli", Status: store.DeviceConnectorReady, SignedIn: true}); err != nil {
		t.Fatal(err)
	}
	if got := uses(session); got != "corpcli:device_login" {
		t.Fatalf("owner, ready and unbound = %q", got)
	}
	if err := devices.SetBindings(ctx, "ws", "owner", []store.DeviceConnectorBindingInput{{Kind: "corpcli", DeviceID: "dev"}}, owns); err != nil {
		t.Fatal(err)
	}
	if got := uses(session); got != "corpcli:device_login" {
		t.Fatalf("owner, bound = %q", got)
	}
	if got := uses(member); got != "aws:none,github:none,tencentcloud:none,alibabacloud:none,corpcli:none" {
		t.Fatalf("member, bound to the owner only = %q", got)
	}
	if got := uses(sandboxed); got != "" {
		t.Fatalf("sandboxed = %q", got)
	}
	if err := devices.SetBindings(ctx, "ws", "owner", []store.DeviceConnectorBindingInput{{Kind: "corpcli", DeviceID: "dev", Members: true}}, owns); err != nil {
		t.Fatal(err)
	}
	if got := uses(member); got != "aws:none,github:none,tencentcloud:none,alibabacloud:none,corpcli:device_login" {
		t.Fatalf("member, members allowed = %q", got)
	}
	elsewhere := session
	elsewhere.DeviceID = "dev2"
	if got := uses(elsewhere); got != "" {
		t.Fatalf("the owner's session on another device = %q", got)
	}
	if _, err := devices.Record(ctx, "dev", store.DeviceConnectorState{Kind: "corpcli", Status: store.DeviceConnectorReady, SignedIn: true, ExpiresAt: "2020-01-01T00:00:00Z"}); err != nil {
		t.Fatal(err)
	}
	if got := uses(session); got != "" {
		t.Fatalf("expired owner login = %q", got)
	}
	if got := uses(member); got != "aws:none,github:none,tencentcloud:none,alibabacloud:none,corpcli:none" {
		t.Fatalf("expired shared login = %q", got)
	}
}

func TestAWSBindingsUseTheDeviceCredentialChain(t *testing.T) {
	st := newMemoryStore()
	devices := NewDeviceHeld(st, DefaultCatalog())
	ctx := context.Background()
	if _, err := devices.Record(ctx, "dev", store.DeviceConnectorState{Kind: "aws", Status: store.DeviceConnectorReady, SignedIn: true}); err != nil {
		t.Fatal(err)
	}
	allowConnectorRequirements(t, st, "dev", corpcli())
	if err := devices.SetBindings(ctx, "ws", "owner", []store.DeviceConnectorBindingInput{{Kind: "aws", DeviceID: "dev"}}, func(id string) bool { return id == "dev" }); err != nil {
		t.Fatal(err)
	}
	session := store.AgentSession{WorkspaceID: "ws", DeviceID: "dev", CreatedByUserID: "owner"}
	uses, err := devices.SessionUses(ctx, session, "owner")
	if err != nil || len(uses) != 1 || uses[0].Kind != "aws" || uses[0].Command != "aws" || uses[0].Access != "device_login" {
		t.Fatalf("uses=%+v err=%v", uses, err)
	}
	session.CreatedByUserID = "member"
	uses, err = devices.SessionUses(ctx, session, "owner")
	if err != nil || len(uses) != 5 || uses[0].Kind != "aws" || uses[0].Access != "none" || uses[0].IsolationEnv["AWS_EC2_METADATA_DISABLED"] != "true" || uses[1].Kind != "github" || uses[1].Access != "none" {
		t.Fatalf("uses=%+v err=%v", uses, err)
	}
}

// DEV-052: the reported linux-dev shape works in a workspace with no binding.
func TestOwnerDeviceLoginWithoutWorkspaceBinding(t *testing.T) {
	ctx := context.Background()
	now := time.Date(2026, 10, 27, 8, 0, 0, 0, time.UTC)
	for _, tc := range []struct {
		name, status, expiry, role, source, issueID, sessionOwner, deviceOwner string
		signedIn, want                                                         bool
	}{
		{name: "linux-dev ready", status: "ready", expiry: "2026-11-26T07:00:00Z", signedIn: true, want: true},
		{name: "expiring", status: "ready", expiry: "2026-10-28T07:00:00Z", signedIn: true, want: true},
		{name: "expired since check", status: "ready", expiry: "2026-10-26T07:00:00Z", signedIn: true},
		{name: "signed out", status: "signed_out"},
		{name: "inconsistent ready", status: "ready"},
		{name: "unavailable", status: "unavailable", signedIn: true},
		{name: "not installed", status: "not_installed"},
		{name: "read error", status: "error", signedIn: true},
		{name: "issue execution", status: "ready", signedIn: true, role: store.AgentSessionRoleIssueExecution},
		{name: "issue clarification", status: "ready", signedIn: true, role: store.AgentSessionRoleIssueClarification},
		{name: "verifier", status: "ready", signedIn: true, source: "verification"},
		{name: "an Issue's other session", status: "ready", signedIn: true, source: "agent", issueID: "iss_1"},
		{name: "naming", status: "ready", signedIn: true, source: "naming"},
		{name: "maintenance", status: "ready", signedIn: true, source: "maintenance"},
		{name: "other member", status: "ready", signedIn: true, sessionOwner: "member"},
		{name: "missing device owner", status: "ready", signedIn: true, deviceOwner: "missing"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			st := newMemoryStore()
			devices := NewDeviceHeld(st, DefaultCatalog())
			devices.Now = func() time.Time { return now }
			_, err := devices.Record(ctx, "linux-dev", store.DeviceConnectorState{Kind: "corpcli", Status: tc.status, Installed: true, SignedIn: tc.signedIn, Identity: "someone", Sites: []string{"cn"}, Version: "0.178.0", ExpiresAt: tc.expiry, Authorizations: []store.ConnectorAuthorizationState{{ID: "feishu_web_session", Revision: 1, Status: "ready", Verification: "local_state"}}})
			if err != nil {
				t.Fatal(err)
			}
			allowConnectorRequirements(t, st, "linux-dev", corpcli())
			owner := "owner"
			if tc.deviceOwner == "missing" {
				owner = ""
			}
			creator := tc.sessionOwner
			if creator == "" {
				creator = "owner"
			}
			got, err := devices.SessionUses(ctx, store.AgentSession{WorkspaceID: "new-unbound-workspace", DeviceID: "linux-dev", CreatedByUserID: creator, Role: tc.role, Source: tc.source, IssueID: tc.issueID}, owner)
			if err != nil {
				t.Fatal(err)
			}
			var login *store.DeviceConnectorUse
			for i := range got {
				if got[i].Access == "device_login" {
					login = &got[i]
				}
			}
			if (login != nil) != tc.want {
				t.Fatalf("uses=%+v", got)
			}
			if login != nil && (login.State == nil || login.State.Identity != "someone" || len(login.State.Authorizations) != 1 || login.State.Authorizations[0].Status != "ready") {
				t.Fatalf("missing metadata: %+v", login)
			}
			// A member without a grant is isolated from every device login,
			// GitHub's too: it declares no isolation variables, the worker's
			// adapter isolates with its own (an empty gh folder).
			if tc.sessionOwner == "member" && (len(got) != 5 || got[1].Kind != "github" || got[1].Access != "none" || len(got[1].IsolationEnv) != 0 || got[2].IsolationEnv["TCCLI_PROFILE"] == "" || got[3].IsolationEnv["ALIBABA_CLOUD_IGNORE_PROFILE"] != "TRUE" || got[4].Access != "none" || got[4].IsolationEnv["CORPCLI_PROFILE"] == "") {
				t.Fatalf("member isolation=%+v", got)
			}
		})
	}
}
