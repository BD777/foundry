package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/jsonempty"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func connectorMCPCall(t *testing.T, handler http.Handler, token string, args map[string]any, resolvedByWorker bool) (string, bool) {
	t.Helper()
	requestBody := map[string]any{
		"jsonrpc": "2.0",
		"id":      1,
		"method":  "tools/call",
		"params": map[string]any{
			"name": "connector_instances", "arguments": args,
		},
	}
	raw, err := json.Marshal(requestBody)
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, "/api/mcp", strings.NewReader(string(raw)))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Authorization", "Bearer "+token)
	if resolvedByWorker {
		request.Header.Set(connectorInstanceSecretProxyHeader, connectorInstanceSecretProxyValue)
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	var envelope struct {
		Result struct {
			Content []struct {
				Text string `json:"text"`
			} `json:"content"`
			IsError bool `json:"isError"`
		} `json:"result"`
		Error *struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &envelope); err != nil {
		t.Fatalf("connector_instances: %d %s", response.Code, response.Body.String())
	}
	if envelope.Error != nil {
		return envelope.Error.Message, true
	}
	if len(envelope.Result.Content) == 0 {
		t.Fatalf("connector_instances answered no content: %s", response.Body.String())
	}
	return envelope.Result.Content[0].Text, envelope.Result.IsError
}

func TestConnectorInstancesMCPCreateProbeAndListWithoutSecrets(t *testing.T) {
	f := newExternalAccountsFixture(t)
	f.server.connectors.ServerHeld.ExtensionDeviceRequest = f.server.extensionDeviceRequest
	f.server.connectors.ServerHeld.ExtensionDevices = f.server.extensionDevices
	const secret = "mcp-fixture-secret-value"
	var upstreamCalls []string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upstreamCalls = append(upstreamCalls, r.URL.Path)
		if r.Header.Get("Authorization") != "Bearer "+secret {
			http.Error(w, "wrong credential "+r.Header.Get("Authorization"), http.StatusUnauthorized)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/connector/agent/v1/accounts":
			_, _ = w.Write([]byte(`{"accounts":[{"id":"42","name":"Ada"}]}`))
		case "/connector/agent/v1/":
			_, _ = w.Write([]byte(`{"routes":[{"method":"GET","path":"/agent/v1/read","access":"read"}]}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer upstream.Close()

	httpServer := httptest.NewServer(f.handler)
	defer httpServer.Close()
	ctx := context.Background()
	session, err := f.server.store.CreateAgentSession(ctx, store.CreateAgentSessionInput{
		CreatedByUserID: f.aliceID, WorkspaceID: "ws_alice", AgentID: "agent_alice",
		Provider: "claude", Prompt: "configure the connector", Source: store.SessionSourceChat,
	})
	if err != nil {
		t.Fatal(err)
	}
	token, err := f.server.store.MintAgentSessionToken(ctx, session.ID)
	if err != nil {
		t.Fatal(err)
	}
	worker := &fakeConnectorWorker{t: t, reportedConnectors: []any{acmeServerHeldExtension()}}
	worker.connect(httpServer.URL, f.aliceDevice)
	defer worker.disconnect()
	waitFor(t, "the extension device to connect", func() bool { return f.server.hub.HasConnection("dev_alice") })

	baseArgs := map[string]any{
		"kind": "acme-api", "network": "device", "probeDeviceId": "dev_alice",
		"fields": map[string]string{
			"baseUrl": upstream.URL + "/connector", "account": "42",
		},
		"secretValues": map[string]string{"readToken": secret},
	}
	probeArgs := map[string]any{"action": "probe"}
	for key, value := range baseArgs {
		probeArgs[key] = value
	}
	probe, failed := connectorMCPCall(t, f.handler, token, probeArgs, true)
	if failed || !strings.Contains(probe, `"network": "device"`) || strings.Contains(probe, secret) {
		t.Fatalf("probe = %q (error %v)", probe, failed)
	}

	createArgs := map[string]any{"action": "create", "label": "Acme through MCP"}
	for key, value := range baseArgs {
		createArgs[key] = value
	}
	createdText, failed := connectorMCPCall(t, f.handler, token, createArgs, true)
	if failed || strings.Contains(createdText, secret) {
		t.Fatalf("create = %q (error %v)", createdText, failed)
	}
	var created connectorInstanceSummary
	if err := json.Unmarshal([]byte(createdText), &created); err != nil || created.ID == "" || created.AccountID == "" {
		t.Fatalf("created instance = %+v (%v), %s", created, err, createdText)
	}

	listedText, failed := connectorMCPCall(t, f.handler, token, map[string]any{
		"action": "list", "kind": "acme-api",
	}, false)
	if failed || strings.Contains(listedText, secret) || strings.Contains(listedText, `"secretValues"`) {
		t.Fatalf("list = %q (error %v)", listedText, failed)
	}
	var listed connectorInstanceListResult
	if err := json.Unmarshal([]byte(listedText), &listed); err != nil {
		t.Fatal(err)
	}
	if len(listed.Instances) != 1 || listed.Instances[0].ID != created.ID ||
		listed.Instances[0].BaseURL != upstream.URL+"/connector" ||
		listed.Instances[0].AccountID != created.AccountID {
		t.Fatalf("list result = %+v", listed)
	}
	bound, failed := connectorMCPCall(t, f.handler, token, map[string]any{
		"action": "bind_workspace", "kind": "acme-api", "instanceId": created.ID, "workspaceId": "ws_alice",
	}, false)
	if failed || strings.Contains(bound, secret) {
		t.Fatalf("bind workspace = %q (error %v)", bound, failed)
	}
	bindings, err := f.server.store.ListWorkspaceExternalAccounts(ctx, "ws_alice")
	if err != nil {
		t.Fatal(err)
	}
	boundAccount := false
	for _, binding := range bindings {
		boundAccount = boundAccount || binding.AccountID == created.AccountID
	}
	if !boundAccount {
		t.Fatalf("bindings after bind = %+v", bindings)
	}
	unbound, failed := connectorMCPCall(t, f.handler, token, map[string]any{
		"action": "unbind_workspace", "kind": "acme-api", "instanceId": created.ID, "workspaceId": "ws_alice",
	}, false)
	if failed || strings.Contains(unbound, secret) {
		t.Fatalf("unbind workspace = %q (error %v)", unbound, failed)
	}
	bindings, err = f.server.store.ListWorkspaceExternalAccounts(ctx, "ws_alice")
	if err != nil {
		t.Fatal(err)
	}
	for _, binding := range bindings {
		if binding.AccountID == created.AccountID {
			t.Fatalf("binding survived unbind: %+v", bindings)
		}
	}

	badSecret := "mcp-wrong-secret-value"
	badProbeArgs := map[string]any{"action": "probe"}
	for key, value := range baseArgs {
		badProbeArgs[key] = value
	}
	badProbeArgs["secretValues"] = map[string]string{"readToken": badSecret}
	badProbe, failed := connectorMCPCall(t, f.handler, token, badProbeArgs, true)
	if !failed || strings.Contains(badProbe, badSecret) {
		t.Fatalf("failed probe = %q (error %v)", badProbe, failed)
	}

	plain, failed := connectorMCPCall(t, f.handler, token, map[string]any{
		"action": "create", "kind": "acme-api",
		"fields": map[string]string{"baseUrl": upstream.URL + "/connector", "readToken": secret},
	}, false)
	if !failed || !strings.Contains(plain, "secret fields cannot be supplied in fields") || strings.Contains(plain, secret) {
		t.Fatalf("plaintext secret = %q (error %v)", plain, failed)
	}
	unresolved, failed := connectorMCPCall(t, f.handler, token, map[string]any{
		"action": "create", "kind": "acme-api",
		"secretFiles": map[string]any{"readToken": map[string]string{"path": ".env", "key": "ACME_TOKEN"}},
		"fields":      map[string]string{"baseUrl": upstream.URL + "/connector"},
	}, false)
	if !failed || !strings.Contains(unresolved, "must be resolved by the session worker") || strings.Contains(unresolved, secret) {
		t.Fatalf("unresolved secretFiles = %q (error %v)", unresolved, failed)
	}

	events, _, err := f.server.store.AgentSessionEventWindow(ctx, session.ID, "", 50)
	if err != nil {
		t.Fatal(err)
	}
	audited := 0
	for _, event := range events {
		if event.Label == "Connector instance action" {
			audited++
			if strings.Contains(event.Detail, secret) {
				t.Fatalf("audit contains a secret: %+v", event)
			}
		}
	}
	if audited != 8 {
		t.Fatalf("connector audit events = %d, want 8: %+v", audited, events)
	}
	if len(upstreamCalls) < 5 {
		t.Fatalf("upstream probe calls = %v", upstreamCalls)
	}
}

type extensionInstallFixture struct {
	f           *externalAccountsFixture
	upstreamURL string
	targetID    string
	source      *fakeConnectorWorker
	target      *fakeConnectorWorker
	mcpToken    string
}

func waitForExtensionInstallDevice(t *testing.T, what string, done func() bool) {
	t.Helper()
	deadline := time.Now().Add(30 * time.Second)
	for !done() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func newExtensionInstallFixture(t *testing.T) extensionInstallFixture {
	t.Helper()
	const sourceDeviceID = "dev_alice"
	f := newExternalAccountsFixture(t)
	f.server.connectors.ServerHeld.ExtensionDeviceRequest = f.server.extensionDeviceRequest
	f.server.connectors.ServerHeld.ExtensionDevices = f.server.extensionDevices
	const secret = "extension-install-secret"
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+secret {
			http.Error(w, "wrong credential", http.StatusUnauthorized)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/connector/agent/v1/accounts":
			_, _ = w.Write([]byte(`{"accounts":[{"id":"42","name":"Ada"}]}`))
		case "/connector/agent/v1/":
			_, _ = w.Write([]byte(`{"routes":[{"method":"GET","path":"/agent/v1/read","access":"read"}]}`))
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(upstream.Close)
	httpServer := httptest.NewServer(f.handler)
	t.Cleanup(httpServer.Close)

	session, err := f.server.store.CreateAgentSession(context.Background(), store.CreateAgentSessionInput{
		CreatedByUserID: f.aliceID, WorkspaceID: "ws_alice", AgentID: "agent_alice",
		Provider: "claude", Prompt: "configure the connector", Source: store.SessionSourceChat,
	})
	if err != nil {
		t.Fatal(err)
	}
	mcpToken, err := f.server.store.MintAgentSessionToken(context.Background(), session.ID)
	if err != nil {
		t.Fatal(err)
	}
	source := &fakeConnectorWorker{t: t, reportedConnectors: []any{acmeServerHeldExtension()}}
	source.connect(httpServer.URL, f.aliceDevice)
	t.Cleanup(source.disconnect)
	targetID, targetCredential := pairOverHTTP(t, f.handler, f.alice, "machine-alice-target", "dev_alice_target")
	target := &fakeConnectorWorker{
		t: t, deviceID: targetID, deviceLabel: "alice-target",
		workspaceID: "ws_alice_target", reportedConnectors: []any{},
		installedConnectors: []any{acmeServerHeldExtension()},
	}
	target.connect(httpServer.URL, targetCredential)
	t.Cleanup(target.disconnect)
	waitForExtensionInstallDevice(t, "both extension-install devices to connect", func() bool {
		return f.server.hub.HasConnection(sourceDeviceID) && f.server.hub.HasConnection(targetID)
	})
	waitForExtensionInstallDevice(t, "the source device to report the extension", func() bool {
		_, err := f.server.connectors.Devices.ServerHeldDescriptorOn(context.Background(), sourceDeviceID, "acme-api")
		return err == nil
	})
	if _, err := f.server.connectors.Devices.ServerHeldDescriptorOn(context.Background(), targetID, "acme-api"); err == nil {
		t.Fatal("the target device reported the extension before the probe")
	}
	return extensionInstallFixture{
		f: f, upstreamURL: upstream.URL, targetID: targetID, source: source, target: target, mcpToken: mcpToken,
	}
}

func extensionInstallProbeBody(upstreamURL, targetID string) map[string]any {
	return map[string]any{
		"label": "Acme on the target", "network": "device", "deviceId": targetID,
		"fields": map[string]string{
			"baseUrl": upstreamURL + "/connector", "account": "42", "readToken": "extension-install-secret",
		},
	}
}

func TestConnectorInstanceWebFlowInstallsMissingExtensionBeforeProbe(t *testing.T) {
	fixture := newExtensionInstallFixture(t)
	probeBody := extensionInstallProbeBody(fixture.upstreamURL, fixture.targetID)
	encoded, err := json.Marshal(probeBody)
	if err != nil {
		t.Fatal(err)
	}
	probe := doAuthCall(t, fixture.f.handler, fixture.f.as(fixture.f.alice, http.MethodPost, "/api/connectors/extensions/acme-api/instances/probe", string(encoded)))
	expectStatus(t, probe, http.StatusOK, "probe through a device without the extension")
	if strings.Contains(probe.Body.String(), "extension-install-secret") {
		t.Fatal("the probe response contains the secret")
	}
	fixture.target.mu.Lock()
	installRequests := append([]store.ExtensionRequestPayload(nil), fixture.target.extensionRequests...)
	extensionCalls := len(fixture.target.extensionHTTP)
	fixture.target.mu.Unlock()
	if len(installRequests) != 1 || installRequests[0].BundledExtensionID != "acme" {
		t.Fatalf("extension installs = %+v", installRequests)
	}
	if extensionCalls < 2 {
		t.Fatalf("probe exchanges on target = %d", extensionCalls)
	}
	if _, err := fixture.f.server.connectors.Devices.ServerHeldDescriptorOn(context.Background(), fixture.targetID, "acme-api"); err != nil {
		t.Fatalf("target did not report the installed extension: %v", err)
	}

	create := doAuthCall(t, fixture.f.handler, fixture.f.as(fixture.f.alice, http.MethodPost, "/api/connectors/extensions/acme-api/instances", string(encoded)))
	expectStatus(t, create, http.StatusCreated, "create through the Web endpoint")
	var created store.ConnectorServerHeldInstance
	if err := json.Unmarshal(create.Body.Bytes(), &created); err != nil || created.ID == "" {
		t.Fatalf("created instance = %+v (%v), %s", created, err, create.Body.String())
	}
}

func TestDeviceNetworkCreateInstallsMissingExtensionOnTargetDevice(t *testing.T) {
	fixture := newExtensionInstallFixture(t)
	f := fixture.f

	ctx := context.Background()
	createdText, failed := connectorMCPCall(t, f.handler, fixture.mcpToken, map[string]any{
		"action": "create", "kind": "acme-api", "network": "device", "probeDeviceId": fixture.targetID,
		"label":        "Acme through the target",
		"fields":       map[string]string{"baseUrl": fixture.upstreamURL + "/connector", "account": "42"},
		"secretValues": map[string]string{"readToken": "extension-install-secret"},
	}, true)
	if failed || strings.Contains(createdText, "extension-install-secret") {
		t.Fatalf("create = %q (error %v)", createdText, failed)
	}
	var created connectorInstanceSummary
	if err := json.Unmarshal([]byte(createdText), &created); err != nil || created.ID == "" {
		t.Fatalf("created instance = %+v (%v), %s", created, err, createdText)
	}
	fixture.target.mu.Lock()
	installRequests := append([]store.ExtensionRequestPayload(nil), fixture.target.extensionRequests...)
	extensionCalls := len(fixture.target.extensionHTTP)
	fixture.target.mu.Unlock()
	if len(installRequests) != 1 || installRequests[0].BundledExtensionID != "acme" {
		t.Fatalf("extension installs = %+v", installRequests)
	}
	if extensionCalls < 2 {
		t.Fatalf("probe exchanges on target = %d", extensionCalls)
	}
	if _, err := f.server.connectors.Devices.ServerHeldDescriptorOn(ctx, fixture.targetID, "acme-api"); err != nil {
		t.Fatalf("target did not report the installed extension: %v", err)
	}
}

func TestConnectorInstancesMCPRefusesNonOwnerAndIssueSessions(t *testing.T) {
	f := newExternalAccountsFixture(t)
	ctx := context.Background()
	bobSession, err := f.server.store.CreateAgentSession(ctx, store.CreateAgentSessionInput{
		CreatedByUserID: f.bobID, WorkspaceID: "ws_bob", AgentID: "agent_bob",
		Provider: "claude", Prompt: "try alice's connector", Source: store.SessionSourceChat,
	})
	if err != nil {
		t.Fatal(err)
	}
	bobToken, err := f.server.store.MintAgentSessionToken(ctx, bobSession.ID)
	if err != nil {
		t.Fatal(err)
	}
	if text, failed := connectorMCPCall(t, f.handler, bobToken, map[string]any{
		"action": "list", "kind": "acme-api",
	}, false); !failed || text != store.ErrExternalAppNotFound.Error() {
		t.Fatalf("non-owner = %q (error %v)", text, failed)
	}

	if connectorInstanceSessionAllowed(store.AgentSession{
		CreatedByUserID: f.aliceID, WorkspaceID: "ws_alice", Source: store.SessionSourceIssue, IssueID: "iss_work",
	}) {
		t.Fatal("an Issue execution session was allowed to manage connector instances")
	}
	if err := mcpToolAllowed(store.AgentSessionRoleIssueExecution, false, "connector_instances"); err == nil {
		t.Fatal("connector_instances was listed for an Issue execution")
	}
}

func TestConnectorInstancesAssistantUsesPermissionPackage(t *testing.T) {
	f := newIsolationFixture(t)
	ctx := context.Background()
	db := f.server.store
	if err := db.RegisterDaemon(ctx, store.DaemonRegistration{
		Device:    store.DeviceProjection{ID: "dev_alice", Label: "Device", Status: "connected", LastSeenLabel: "online"},
		Workspace: store.WorkspaceProjection{ID: "ws_connector_pa", Name: "Assistant", LocalPath: "/tmp/ws_connector_pa"},
		Agents: []store.AgentProjection{{
			ID: "agent_connector_pa", WorkspaceID: "ws_connector_pa", DeviceID: "dev_alice", Provider: "claude", Status: "healthy",
			AuthMode: "local_config", SecretStored: "local", ConfigScope: "workspace", ConfigLabel: "local", LastSeenLabel: "online",
		}},
	}); err != nil {
		t.Fatal(err)
	}
	if err := db.SetWorkspaceKind(ctx, "ws_connector_pa", store.WorkspaceKindPersonalAgent); err != nil {
		t.Fatal(err)
	}
	agent, err := db.CreatePersonalAgent(ctx, store.PersonalAgent{
		UserID: f.aliceID, WorkspaceID: "ws_connector_pa", HomeDeviceID: "dev_alice",
	})
	if err != nil {
		t.Fatal(err)
	}
	pkg, err := db.GetPermissionPackage(ctx, agent.UserID, agent.PermissionPackageID)
	if err != nil {
		t.Fatal(err)
	}
	pkg.ConnectorAccounts = jsonempty.List[store.ConnectorAccountPermission]{
		{AccountID: "acct_read", Level: store.ConnectorAccessLevelRead},
		{AccountID: "acct_off", Level: store.ConnectorAccessLevelOff},
	}
	if _, err := db.SavePermissionPackage(ctx, pkg); err != nil {
		t.Fatal(err)
	}
	session, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{
		CreatedByUserID: f.aliceID, WorkspaceID: "ws_connector_pa", AgentID: "agent_connector_pa",
		Provider: "claude", Prompt: "assistant conversation", Source: store.SessionSourceChat,
	})
	if err != nil {
		t.Fatal(err)
	}
	caller := connectorInstanceSession{session: session, ownerID: f.aliceID, device: "dev_alice"}
	access, err := f.server.connectorInstancePermission(ctx, caller)
	if err != nil || !access.Applicable || !access.AllowsConnector("acct_read") || access.AllowsConnectorWrite("acct_read") || access.AllowsConnector("acct_off") {
		t.Fatalf("assistant package = %+v (%v)", access, err)
	}
	if err := f.server.requireConnectorInstanceWrite(ctx, caller, "acct_read"); errorStatus(err) != http.StatusForbidden {
		t.Fatalf("read account write = %v", err)
	}
	if err := f.server.requireConnectorInstanceWrite(ctx, caller, "acct_off"); errorStatus(err) != http.StatusForbidden {
		t.Fatalf("off account write = %v", err)
	}
}
