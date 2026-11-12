package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/feishuevents/feishueventstest"
	"github.com/foundry-dev/foundry/apps/server/internal/resources"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// DEV-191 P0: the assistant's permission package holds at every entry.

func (f assistantFixture) editPackage(t *testing.T, edit func(*store.PermissionPackage)) {
	t.Helper()
	ctx := context.Background()
	agent := mustAgent(t, f)
	pkg, err := f.server.store.GetPermissionPackage(ctx, agent.UserID, agent.PermissionPackageID)
	if err != nil {
		t.Fatal(err)
	}
	edit(&pkg)
	if _, err := f.server.store.SavePermissionPackage(ctx, pkg); err != nil {
		t.Fatal(err)
	}
}

func (f assistantFixture) currentPackage(t *testing.T) store.PermissionPackage {
	t.Helper()
	agent := mustAgent(t, f)
	pkg, err := f.server.store.GetPermissionPackage(context.Background(), agent.UserID, agent.PermissionPackageID)
	if err != nil {
		t.Fatal(err)
	}
	return pkg
}

func TestPermissionPackageSaveValidatesEveryReference(t *testing.T) {
	f := newAssistantFixture(t)
	agent := mustAgent(t, f)
	registerDeviceForTest(t, f.server, registrationBody("dev_bob", "ws_bob_private"))
	compute, browser, _ := f.reportAliceResources(t)
	paths := []string{
		"/api/personal-agent/permission-package",
		"/api/assistants/" + agent.ID + "/permission-package",
	}
	cases := []struct {
		name    string
		edit    func(*store.PermissionPackage)
		invalid string
	}{
		{"inaccessible include workspace", func(pkg *store.PermissionPackage) {
			pkg.Workspaces.Include = []string{"ws_bob_private"}
		}, "ws_bob_private"},
		{"nonexistent exclude workspace", func(pkg *store.PermissionPackage) {
			pkg.Workspaces.Exclude = []string{"ws_missing"}
		}, "ws_missing"},
		{"nonexistent identity resource", func(pkg *store.PermissionPackage) {
			pkg.IdentityResources.Allowed = []string{"res_missing"}
		}, "res_missing"},
		{"resource without identity", func(pkg *store.PermissionPackage) {
			pkg.IdentityResources.Allowed = []string{compute}
		}, compute},
	}
	for _, path := range paths {
		for _, tc := range cases {
			t.Run(tc.name+" "+path, func(t *testing.T) {
				pkg := f.currentPackage(t)
				tc.edit(&pkg)
				body, err := json.Marshal(pkg)
				if err != nil {
					t.Fatal(err)
				}
				response := doAuthCall(t, f.handler, f.as(f.alice, http.MethodPut, path, string(body)))
				expectStatus(t, response, http.StatusBadRequest, tc.name)
				if !strings.Contains(response.Body.String(), tc.invalid) {
					t.Fatalf("invalid ids not listed: %s", response.Body)
				}
			})
		}
	}

	pkg := f.currentPackage(t)
	pkg.Workspaces = store.PermissionListRule{Scope: store.PermissionListScopeListed, Include: []string{"ws_alice"}}
	pkg.IdentityResources = store.PermissionIdentityResources{Scope: store.PermissionListScopeListed, Allowed: []string{browser}}
	body, err := json.Marshal(pkg)
	if err != nil {
		t.Fatal(err)
	}
	response := doAuthCall(t, f.handler, f.as(f.alice, http.MethodPut, paths[1], string(body)))
	expectStatus(t, response, http.StatusOK, "save a valid package")
}

func TestNonDefaultAssistantPromptLinksItsOwnSettings(t *testing.T) {
	f := newAssistantFixture(t)
	ctx := context.Background()
	work, err := f.server.store.CreatePersonalAgent(ctx, store.PersonalAgent{
		UserID: f.aliceID, Name: "Work", WorkspaceID: "ws_alice", HomeDeviceID: "dev_alice",
	})
	if err != nil || work.IsDefault {
		t.Fatalf("new assistant = %+v (%v)", work, err)
	}
	input, err := f.server.assistant.PromptInput(ctx, work, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if want := "/assistants/" + work.ID + "/settings"; !strings.HasSuffix(input.SettingsURL, want) {
		t.Fatalf("settings link = %q, want suffix %q", input.SettingsURL, want)
	}
}

// A workspace the package leaves out is neither dispatched to nor read;
// a project the assistant creates joins its package.
func TestAssistantPackageGatesDispatchReadsAndCreatedWorkspaces(t *testing.T) {
	f := newAssistantFixture(t)
	ctx := context.Background()
	agent := mustAgent(t, f)
	f.editPackage(t, func(pkg *store.PermissionPackage) {
		pkg.Workspaces = store.PermissionListRule{Scope: store.PermissionListScopeListed, Include: []string{"ws_bob"}}
	})
	item, err := f.server.store.AddPersonalAgentItem(ctx, store.PersonalAgentListItem{
		UserID: f.aliceID, AssistantID: agent.ID, Text: "Work outside the package",
		Plan: &store.PersonalAgentItemPlan{Mode: "execute", Progress: "ready", WorkspaceID: "ws_alice"},
	})
	if err != nil {
		t.Fatal(err)
	}
	dispatch := func(workspaceID, stepKey string) (string, bool) {
		return f.tool(t, f.token, "dispatch_item", map[string]any{
			"itemId": item.ID, "intentRevision": item.IntentRevision, "stepKey": stepKey,
			"workspaceId": workspaceID, "prompt": "Do the work.",
		})
	}
	if text, failed := dispatch("ws_alice", "excluded"); !failed || !strings.Contains(text, "permissions do not include") {
		t.Fatalf("dispatch to an excluded workspace: %s", text)
	}
	if text, _ := dispatch("ws_bob", "included"); strings.Contains(text, "permissions do not include") {
		t.Fatalf("dispatch to an included workspace was refused: %s", text)
	}
	if text, failed := f.tool(t, f.token, "get_workspace", map[string]any{"workspaceId": "ws_alice"}); !failed || !strings.Contains(text, "not found") {
		t.Fatalf("get_workspace of an excluded workspace: %s", text)
	}
	if text, _ := f.tool(t, f.token, "find_workspace", map[string]any{"query": "ws_alice"}); strings.Contains(text, `"ws_alice"`) {
		t.Fatalf("find_workspace proposed an excluded workspace: %s", text)
	}
	f.setPolicy(t, store.PersonalAgentActionCreateWorkspace, store.PersonalAgentAuto)
	text, failed := f.tool(t, f.token, "create_workspace", map[string]any{"name": "Fresh", "purpose": "x", "deviceId": "dev_alice", "source": map[string]any{"kind": "empty"}})
	if failed {
		t.Fatalf("create_workspace: %s", text)
	}
	if pkg := f.currentPackage(t); !slices.Contains([]string(pkg.Workspaces.Include), "ws_new") || pkg.Workspaces.Scope != store.PermissionListScopeListed {
		t.Fatalf("the created workspace did not join the package: %+v", pkg.Workspaces)
	}
}

// reportAliceResources reports compute, a browser and the screen on
// dev_alice and answers their ids.
func (f assistantFixture) reportAliceResources(t *testing.T) (compute, browser, screen string) {
	t.Helper()
	ready := store.ResourceReadiness{Ready: true, Level: "configured"}
	if _, err := f.server.resources.Report(context.Background(), store.ResourceSource{Kind: "device", ID: "dev_alice", Label: "Alice's Mac"}, store.ResourcesReport{
		Instances: []store.DetectedResource{
			{Key: "compute", Type: "compute", Platform: "macos", Name: "Compute", Detector: "compute@1", Readiness: ready,
				Backends: []store.ResourceBackend{{ID: "foundry-compute", Mode: "remote_ops", Readiness: ready}}},
			{Key: "browser/chrome", Type: "browser", Platform: "macos", Name: "Chrome", Detector: "browser@1",
				Readiness: store.ResourceReadiness{Ready: true, Level: "permitted"}},
			{Key: "computer_use/macos/console:501", Type: "computer_use", Platform: "macos", Name: "macOS screen control",
				Detector: "computer_use.macos.cua-driver@1", Readiness: ready,
				Backends: []store.ResourceBackend{{ID: "cua-driver", Version: "0.34.1", Mode: "remote_ops", Readiness: ready}}},
		},
	}); err != nil {
		t.Fatal(err)
	}
	return resources.InstanceID("dev_alice", "compute"), resources.InstanceID("dev_alice", "browser/chrome"),
		resources.InstanceID("dev_alice", "computer_use/macos/console:501")
}

// The default assistant's helper keeps every resource, identity ones
// included, on a device where its package allows a workspace; off that
// device it leases nothing. The person's own chat is unchanged.
func TestDefaultAssistantHelperLeasesIdentityResourcesOnItsDevices(t *testing.T) {
	f := newAssistantFixture(t)
	ctx := context.Background()
	agent := mustAgent(t, f)
	if pkg := f.currentPackage(t); pkg.IdentityResources.Scope != store.PermissionListScopeAll {
		t.Fatalf("default assistant identity resources = %+v", pkg.IdentityResources)
	}
	helper := f.startSession(t, "ws_alice", f.conversation.ID, "use the browser")
	f.server.assistant.RecordTask(ctx, agent, f.conversation.ID, helper)
	helperToken := f.mint(t, helper.ID)
	ordinaryToken := f.mint(t, f.startSession(t, "ws_alice", "", "my own chat").ID)
	compute, browser, screen := f.reportAliceResources(t)
	// The package lets the lease through; the lease service itself does not
	// lease browsers to sessions yet (they use $FOUNDRY_BROWSER_BIN).
	if text, _ := f.tool(t, helperToken, "acquire_resource", map[string]any{"resourceId": browser, "reason": "check the page"}); !strings.Contains(text, "not_leasable") {
		t.Fatalf("default assistant's helper leasing the browser: %s", text)
	}
	for _, id := range []string{compute, browser, screen} {
		if text, failed := f.tool(t, helperToken, "resource_status", map[string]any{"resourceId": id}); failed {
			t.Fatalf("default assistant's helper refused %s: %s", id, text)
		}
	}
	f.editPackage(t, func(pkg *store.PermissionPackage) {
		pkg.Workspaces = store.PermissionListRule{Scope: store.PermissionListScopeListed, Include: []string{"ws_bob"}}
	})
	for _, id := range []string{compute, screen} {
		if text, failed := f.tool(t, helperToken, "resource_status", map[string]any{"resourceId": id}); !failed || !strings.Contains(text, "include no workspace") {
			t.Fatalf("helper reached %s on a device outside its package: %s", id, text)
		}
		if text, failed := f.tool(t, ordinaryToken, "resource_status", map[string]any{"resourceId": id}); failed {
			t.Fatalf("the person's own chat lost %s: %s", id, text)
		}
	}
}

// A new assistant's helper leases an identity resource only once its
// package lists it; compute follows the device.
func TestNewAssistantHelperLeasesOnlyListedIdentityResources(t *testing.T) {
	f := newAssistantFixture(t)
	ctx, db := context.Background(), f.server.store
	if err := db.RegisterDaemon(ctx, store.DaemonRegistration{
		Device:    store.DeviceProjection{ID: "dev_alice", Label: "Device", Status: "connected", LastSeenLabel: "online"},
		Workspace: store.WorkspaceProjection{ID: "ws_work_pa", Name: "ws_work_pa", LocalPath: "/tmp/ws_work_pa"},
		Agents: []store.AgentProjection{{
			ID: "agent_ws_work_pa", WorkspaceID: "ws_work_pa", DeviceID: "dev_alice", Provider: "claude", Status: "healthy",
			AuthMode: "local_config", SecretStored: "local", ConfigScope: "workspace", ConfigLabel: "local", LastSeenLabel: "online",
		}},
	}); err != nil {
		t.Fatal(err)
	}
	work, err := db.CreatePersonalAgent(ctx, store.PersonalAgent{UserID: f.aliceID, Name: "Work", WorkspaceID: "ws_work_pa", HomeDeviceID: "dev_alice"})
	if err != nil || work.IsDefault {
		t.Fatalf("new assistant = %+v (%v)", work, err)
	}
	pkg, err := db.GetPermissionPackage(ctx, f.aliceID, work.PermissionPackageID)
	if err != nil || pkg.IdentityResources.Scope != store.PermissionListScopeListed || len(pkg.IdentityResources.Allowed) != 0 {
		t.Fatalf("new assistant identity resources = %+v (%v)", pkg.IdentityResources, err)
	}
	pkg.Workspaces.Include = []string{"ws_alice"}
	if pkg, err = db.SavePermissionPackage(ctx, pkg); err != nil {
		t.Fatal(err)
	}
	conversation := f.startSession(t, "ws_work_pa", "", "work things")
	helperToken := f.mint(t, f.startSession(t, "ws_alice", conversation.ID, "use the browser").ID)
	compute, browser, _ := f.reportAliceResources(t)
	if text, failed := f.tool(t, helperToken, "acquire_resource", map[string]any{"resourceId": browser}); !failed || !strings.Contains(text, "Identity resources") {
		t.Fatalf("new assistant's helper leased an unlisted browser: %s", text)
	}
	if text, failed := f.tool(t, helperToken, "resource_status", map[string]any{"resourceId": compute}); failed {
		t.Fatalf("new assistant's helper refused compute on a device of its package: %s", text)
	}
	pkg.IdentityResources.Allowed = []string{browser}
	if _, err := db.SavePermissionPackage(ctx, pkg); err != nil {
		t.Fatal(err)
	}
	if text, _ := f.tool(t, helperToken, "acquire_resource", map[string]any{"resourceId": browser, "reason": "check the page"}); !strings.Contains(text, "not_leasable") {
		t.Fatalf("new assistant's helper leasing a listed browser: %s", text)
	}
	if text, failed := f.tool(t, helperToken, "resource_status", map[string]any{"resourceId": browser}); failed {
		t.Fatalf("new assistant's helper refused a listed browser: %s", text)
	}
}

// A helper subscribes to Feishu events only through an account its
// assistant's package does not turn off; the person's own chat is
// unchanged.
func TestAssistantHelperFeishuEventsFollowThePackage(t *testing.T) {
	f := newExternalAccountsFixture(t)
	account := f.connect(f.alice, f.createApp(f.alice, ""))
	source := feishueventstest.NewFakeSource("cli_fake", "secret_fake")
	t.Cleanup(source.Close)
	f.server.feishuEvents.Domain = source.URL()
	t.Cleanup(f.server.feishuEvents.Stop)
	ctx := context.Background()
	if err := f.db.RegisterDaemon(ctx, store.DaemonRegistration{
		Device:    store.DeviceProjection{ID: "dev_alice", Label: "Device", Status: "connected", LastSeenLabel: "online"},
		Workspace: store.WorkspaceProjection{ID: "ws_alice_pa", Name: "Assistant", LocalPath: "/tmp/ws_alice_pa"},
		Agents: []store.AgentProjection{{
			ID: "agent_alice_pa", WorkspaceID: "ws_alice_pa", DeviceID: "dev_alice", Provider: "claude", Status: "healthy",
			AuthMode: "local_config", SecretStored: "local", ConfigScope: "workspace", ConfigLabel: "local", LastSeenLabel: "online",
		}},
	}); err != nil {
		t.Fatal(err)
	}
	if err := f.db.SetWorkspaceKind(ctx, "ws_alice_pa", store.WorkspaceKindPersonalAgent); err != nil {
		t.Fatal(err)
	}
	agent, err := f.db.CreatePersonalAgent(ctx, store.PersonalAgent{UserID: f.aliceID, WorkspaceID: "ws_alice_pa", HomeDeviceID: f.aliceDevice})
	if err != nil {
		t.Fatal(err)
	}
	session := func(workspaceID, agentID, source, parentID string) (string, string) {
		t.Helper()
		created, err := f.db.CreateAgentSession(ctx, store.CreateAgentSessionInput{
			CreatedByUserID: f.aliceID, WorkspaceID: workspaceID, AgentID: agentID, Provider: "claude",
			Prompt: "watch the group", Source: source, ParentSessionID: parentID,
		})
		if err != nil {
			t.Fatal(err)
		}
		token, err := f.db.MintAgentSessionToken(ctx, created.ID)
		if err != nil {
			t.Fatal(err)
		}
		return created.ID, token
	}
	conversation, _ := session("ws_alice_pa", "agent_alice_pa", "chat", "")
	_, helperToken := session("ws_alice", "agent_alice", "agent", conversation)
	_, ordinaryToken := session("ws_alice", "agent_alice", "chat", "")
	helper := mcpToolCaller(t, f.handler, helperToken)
	ordinary := mcpToolCaller(t, f.handler, ordinaryToken)
	subscribe := map[string]any{"eventTypes": []string{"im.message.receive_v1"}, "chatId": "oc_1"}

	if _, err := f.db.SetPersonalAgentConnectorLevels(ctx, agent.ID, []store.ConnectorAccountPermission{{AccountID: account.ID, Level: store.ConnectorAccessLevelOff}}); err != nil {
		t.Fatal(err)
	}
	if text, isError := helper("feishu_events", subscribe); !isError || !strings.Contains(text, "turn off") {
		t.Fatalf("helper subscribed through an account turned off: %s", text)
	}
	if text, isError := ordinary("feishu_events", subscribe); isError || !strings.Contains(text, "fsub_") {
		t.Fatalf("the person's own chat could not subscribe: %s", text)
	}
	if _, err := f.db.SetPersonalAgentConnectorLevels(ctx, agent.ID, []store.ConnectorAccountPermission{{AccountID: account.ID, Level: store.ConnectorAccessLevelRead}}); err != nil {
		t.Fatal(err)
	}
	if text, isError := helper("feishu_events", subscribe); isError || !strings.Contains(text, "fsub_") {
		t.Fatalf("helper with the account at read could not subscribe: %s", text)
	}
}
