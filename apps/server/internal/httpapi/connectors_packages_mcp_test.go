package httpapi

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"os/exec"
	"slices"
	"strings"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/externalaccounts"
	"github.com/foundry-dev/foundry/apps/server/internal/jsonempty"
	"github.com/foundry-dev/foundry/apps/server/internal/permission"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func TestConnectorPackagesMCPAddDevicesAndAudit(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	f := newExternalAccountsFixture(t)
	f.server.skillRepos = serverMustNotRead{t: t}
	httpServer := httptest.NewServer(f.handler)
	defer httpServer.Close()
	repo := localRepo{t: t, dir: t.TempDir()}
	repo.git("init", "--quiet", "--initial-branch=main")
	repo.commit(map[string]string{
		"plugins/open-lark/skills/olk/SKILL.md":   "---\nname: olk\ndescription: OpenLark CLI\n---\n",
		"plugins/open-lark/skills/setup/SKILL.md": "---\nname: setup\ndescription: Setup OpenLark\n---\n",
	})
	worker := &fakeFetchWorker{
		t: t, serverURL: httpServer.URL, credential: f.aliceDevice, repo: repo,
		connectors: []map[string]any{packageConnectorExtension()},
		system:     map[string]any{"os": "Linux", "arch": "x64", "nodeVersion": "22.15.0"},
	}
	session, err := f.server.store.CreateAgentSession(context.Background(), store.CreateAgentSessionInput{
		CreatedByUserID: f.aliceID, WorkspaceID: "ws_alice", AgentID: "agent_alice",
		Provider: "claude", Prompt: "enable the package", Source: store.SessionSourceChat,
	})
	if err != nil {
		t.Fatal(err)
	}
	token, err := f.server.store.MintAgentSessionToken(context.Background(), session.ID)
	if err != nil {
		t.Fatal(err)
	}
	worker.connect()
	defer worker.disconnect()
	waitFor(t, "the package device to connect", func() bool { return f.server.hub.HasConnection("dev_alice") })

	if err := f.server.store.SaveDeviceConnectorState(context.Background(), store.DeviceConnectorState{
		DeviceID: "dev_alice", Kind: "github", Status: store.DeviceConnectorReady,
		Installed: true, SignedIn: true, CheckedAt: "2026-11-11T00:00:00Z",
	}); err != nil {
		t.Fatal(err)
	}
	call := mcpToolCaller(t, f.handler, token)

	setArgs := map[string]any{
		"action": "set_devices", "kind": "openlark", "addDevices": []string{"dev_alice"},
	}
	text, failed := call("connector_packages", setArgs)
	if failed {
		t.Fatalf("addDevices = %q", text)
	}
	var summary connectorPackageMCPSummary
	if err := json.Unmarshal([]byte(text), &summary); err != nil {
		t.Fatal(err)
	}
	if !summary.Enabled || !slices.Equal(summary.EnabledDevices, []string{"dev_alice"}) ||
		summary.Repository == "" || summary.ExtensionVersion == "" || summary.ToolVersion == "" {
		t.Fatalf("package after addDevices = %+v", summary)
	}
	if len(worker.installs) != 1 || len(worker.extensions) != 1 {
		t.Fatalf("installs=%+v extensions=%v", worker.installs, worker.extensions)
	}

	if text, failed = call("connector_packages", setArgs); failed {
		t.Fatalf("repeat addDevices = %q", text)
	}
	if len(worker.installs) != 1 || len(worker.extensions) != 1 {
		t.Fatalf("a repeated add reinstalled the package: installs=%+v extensions=%v", worker.installs, worker.extensions)
	}

	text, failed = call("connector_packages", map[string]any{"action": "list"})
	if failed || !strings.Contains(text, `"kind": "openlark"`) || !strings.Contains(text, `"toolVersion"`) {
		t.Fatalf("list = %q (error %v)", text, failed)
	}
	if text, failed = call("connector_packages", map[string]any{"action": "disable", "kind": "openlark"}); failed {
		t.Fatalf("disable = %q", text)
	}
	if _, err := f.server.store.GetConnectorPackage(context.Background(), f.aliceID, "openlark"); err == nil {
		t.Fatal("the package enablement remains after disable")
	}

	events, _, err := f.server.store.AgentSessionEventWindow(context.Background(), session.ID, "", 50)
	if err != nil {
		t.Fatal(err)
	}
	audited := 0
	for _, event := range events {
		if event.Label == "Connector package action" {
			audited++
		}
	}
	if audited != 4 {
		t.Fatalf("connector package audit events = %d, want 4: %+v", audited, events)
	}
}

func TestConnectorPackagesMCPAddDevicesPreservesSelection(t *testing.T) {
	readArgs := func(raw string) map[string]json.RawMessage {
		var args map[string]json.RawMessage
		if err := json.Unmarshal([]byte(raw), &args); err != nil {
			t.Fatal(err)
		}
		return args
	}
	got, err := connectorPackageDesiredDeviceIDs(
		[]string{"dev_a", "dev_b"},
		readArgs(`{"addDevices":["dev_c","dev_a"],"removeDevices":["dev_b"]}`),
	)
	if err != nil || !slices.Equal(got, []string{"dev_a", "dev_c"}) {
		t.Fatalf("incremental selection = %v (%v)", got, err)
	}
	got, err = connectorPackageDesiredDeviceIDs(
		[]string{"dev_a", "dev_b"},
		readArgs(`{"deviceIds":["dev_x"],"addDevices":["dev_y"]}`),
	)
	if err != nil || !slices.Equal(got, []string{"dev_x", "dev_y"}) {
		t.Fatalf("replacement selection = %v (%v)", got, err)
	}
}

func TestConnectorPackagesMCPRefusesNonOwnerAndIssueSessions(t *testing.T) {
	f := newExternalAccountsFixture(t)
	ctx := context.Background()
	bobSession, err := f.server.store.CreateAgentSession(ctx, store.CreateAgentSessionInput{
		CreatedByUserID: f.bobID, WorkspaceID: "ws_bob", AgentID: "agent_bob",
		Provider: "claude", Prompt: "try alice's package", Source: store.SessionSourceChat,
	})
	if err != nil {
		t.Fatal(err)
	}
	bobToken, err := f.server.store.MintAgentSessionToken(ctx, bobSession.ID)
	if err != nil {
		t.Fatal(err)
	}
	call := mcpToolCaller(t, f.handler, bobToken)
	if text, failed := call("connector_packages", map[string]any{
		"action": "get", "kind": "openlark",
	}); !failed || text != "connector package not found" {
		t.Fatalf("non-owner = %q (error %v)", text, failed)
	}

	issueSession := store.AgentSession{
		CreatedByUserID: f.aliceID, WorkspaceID: "ws_alice", Source: store.SessionSourceIssue, IssueID: "iss_work",
	}
	if connectorInstanceSessionAllowed(issueSession) {
		t.Fatal("an Issue execution session was allowed to manage connector packages")
	}
	for _, role := range []string{store.AgentSessionRoleIssueExecution, store.AgentSessionRoleIssueClarification} {
		if err := mcpToolAllowed(role, false, "connector_packages"); err == nil {
			t.Fatalf("connector_packages was listed for %s", role)
		}
	}
	if err := mcpToolAllowed("", true, "connector_packages"); err == nil {
		t.Fatal("connector_packages was listed for a verifier")
	}
	if err := mcpToolAllowed(store.AgentSessionRolePersonalAgent, false, "connector_packages"); err != nil {
		t.Fatalf("connector_packages was withheld from the assistant: %v", err)
	}
}

func TestConnectorPackagesAssistantPermissionRequiresWrite(t *testing.T) {
	accountID := externalaccounts.DeviceAccountID("dev_alice", "openlark")
	access := permission.Access{
		Applicable: true,
		Package: store.PermissionPackage{
			ConnectorAccounts: jsonempty.List[store.ConnectorAccountPermission]{
				{AccountID: accountID, Level: store.ConnectorAccessLevelRead},
			},
		},
	}
	if connectorPackageDeviceAllowed(access, "openlark", "dev_alice") {
		t.Fatal("a read-only assistant connector permission allowed a package write")
	}
	if !connectorPackageDeviceAllowed(permission.Access{}, "openlark", "dev_alice") {
		t.Fatal("a non-assistant session was limited by the assistant permission package")
	}
}
