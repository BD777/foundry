package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

const providerTestKey = "tk-provider-test-9f3a1c77e2b04d18"

// providerTools calls the Foundry tools as a session the input describes.
type providerTools struct {
	t     *testing.T
	f     *externalAccountsFixture
	token string
}

func (f *externalAccountsFixture) providerSession(input store.CreateAgentSessionInput) providerTools {
	f.t.Helper()
	ctx := context.Background()
	if input.AgentID == "" {
		input.AgentID = "agent_alice"
		input.WorkspaceID = "ws_alice"
	}
	input.Provider, input.Prompt = "claude", "manage my providers"
	session, err := f.db.CreateAgentSession(ctx, input)
	if err != nil {
		f.t.Fatal(err)
	}
	token, err := f.db.MintAgentSessionToken(ctx, session.ID)
	if err != nil {
		f.t.Fatal(err)
	}
	return providerTools{t: f.t, f: f, token: token}
}

// call answers the tool's text, whether it is an error result, and a
// JSON-RPC refusal's message.
func (p providerTools) call(tool, arguments string) (string, bool, string) {
	p.t.Helper()
	body := `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"` + tool + `","arguments":` + arguments + `}}`
	response := doAuthCall(p.t, p.f.handler, authCall{method: http.MethodPost, path: "/api/mcp", body: body,
		headers: map[string]string{"Authorization": "Bearer " + p.token, "Content-Type": "application/json"}})
	if strings.Contains(response.Body.String(), providerTestKey) {
		p.t.Fatalf("%s answered the key: %s", tool, response.Body.String())
	}
	var envelope struct {
		Result struct {
			IsError bool `json:"isError"`
			Content []struct {
				Text string `json:"text"`
			} `json:"content"`
		} `json:"result"`
		Error *struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &envelope); err != nil {
		p.t.Fatalf("%s: %s", tool, response.Body.String())
	}
	if envelope.Error != nil {
		return "", true, envelope.Error.Message
	}
	text := ""
	if len(envelope.Result.Content) > 0 {
		text = envelope.Result.Content[0].Text
	}
	return text, envelope.Result.IsError, ""
}

func (p providerTools) ok(tool, arguments string, into any) {
	p.t.Helper()
	text, failed, refused := p.call(tool, arguments)
	if failed || refused != "" {
		p.t.Fatalf("%s %s: %s%s", tool, arguments, text, refused)
	}
	if into != nil {
		if err := json.Unmarshal([]byte(text), into); err != nil {
			p.t.Fatalf("%s: %v: %s", tool, err, text)
		}
	}
}

func (p providerTools) tools() string {
	p.t.Helper()
	response := doAuthCall(p.t, p.f.handler, authCall{method: http.MethodPost, path: "/api/mcp",
		body:    `{"jsonrpc":"2.0","id":1,"method":"tools/list"}`,
		headers: map[string]string{"Authorization": "Bearer " + p.token, "Content-Type": "application/json"}})
	return response.Body.String()
}

// attachProfileCheckWorker connects dev_alice's worker, declaring
// capabilities, and answers its next request with reply.
func attachProfileCheckWorker(t *testing.T, server *Server, capabilities []string, reply string) chan wsEnvelope {
	t.Helper()
	connection := newDaemonConnection(server.hub, nil)
	connection.registration = store.DaemonRegistration{Capabilities: capabilities}
	server.hub.mu.Lock()
	server.hub.connections["dev_alice"] = connection
	server.hub.mu.Unlock()
	t.Cleanup(func() {
		server.hub.mu.Lock()
		delete(server.hub.connections, "dev_alice")
		server.hub.mu.Unlock()
		close(connection.done)
	})
	asked := make(chan wsEnvelope, 1)
	go func() {
		for envelope := range connection.send {
			asked <- envelope
			_ = deliverDaemonResponse[wsAgentProfileCheckedPayload](connection, wsEnvelope{ID: envelope.ID, Payload: json.RawMessage(reply)}, nil)
			return
		}
	}()
	return asked
}

// The person's chat adds an endpoint with a key, scopes it to a device, sets
// its default model, checks it there, updates it and deletes it: what the
// Model providers page does, and the key is never answered.
func TestModelProviderToolsManageAnEndpointLikeThePage(t *testing.T) {
	f := newExternalAccountsFixture(t)
	ctx := context.Background()
	alice := f.providerSession(store.CreateAgentSessionInput{CreatedByUserID: f.aliceID})

	var created mcpProvider
	alice.ok("save_model_provider", `{"runtime":"claude","label":"Relay","baseUrl":"relay.example/v1/messages","apiKey":"`+providerTestKey+`","model":"claude-opus-5-5"}`, &created)
	if created.Kind != providerKindAPI || created.BaseURL != "https://relay.example" || created.Model != "claude-opus-5-5" ||
		created.KeySet == nil || !*created.KeySet || len(created.Devices) != 0 {
		t.Fatalf("created = %+v; want the corrected endpoint with a key and no devices", created)
	}
	stored, err := f.db.GetProfile(ctx, created.ID)
	if err != nil || stored.OwnerUserID != f.aliceID {
		t.Fatalf("stored = %+v %v", stored, err)
	}
	if key, err := f.server.hub.serverProfileCredential(ctx, created.ID); err != nil || key != providerTestKey {
		t.Fatalf("the key is not sealed where the page seals it: %v", err)
	}

	var scoped mcpProvider
	alice.ok("save_model_provider", `{"providerId":"`+created.ID+`","deviceIds":["dev_alice"],"model":"claude-sonnet-5","effort":"high"}`, &scoped)
	if len(scoped.Devices) != 1 || scoped.Devices[0].DeviceID != "dev_alice" || scoped.Model != "claude-sonnet-5" ||
		scoped.Effort != "high" || scoped.Label != "Relay" || !*scoped.KeySet {
		t.Fatalf("scoped = %+v", scoped)
	}
	if enabled, _ := f.server.profileEnabledOnDevice(ctx, "dev_alice", created.ID); !enabled {
		t.Fatal("the device binding the page reads was not written")
	}

	// The check runs on the device through its agent, with the sealed key.
	asked := attachProfileCheckWorker(t, f.server, []string{store.DaemonCapabilityProfileCheck},
		`{"result":{"status":"passed","checkedAt":"2026-11-09T05:00:00Z"}}`)
	var checked struct {
		Check store.AgentProfileCheck `json:"check"`
	}
	alice.ok("check_model_provider", `{"providerId":"`+created.ID+`","deviceId":"dev_alice"}`, &checked)
	envelope := <-asked
	var payload wsCheckAgentProfilePayload
	_ = json.Unmarshal(envelope.Payload, &payload)
	if envelope.Type != wsCheckAgentProfileType || payload.Profile.ID != created.ID || payload.Credential != providerTestKey ||
		payload.Profile.BaseURL != "https://relay.example" {
		t.Fatalf("asked the device %s %+v", envelope.Type, payload.Profile)
	}
	if checked.Check.Status != "passed" {
		t.Fatalf("check = %+v", checked.Check)
	}
	var listed struct {
		Total     int           `json:"total"`
		Providers []mcpProvider `json:"providers"`
	}
	alice.ok("list_model_providers", `{"kind":"api"}`, &listed)
	if listed.Total != 1 || len(listed.Providers[0].Devices) != 1 || listed.Providers[0].Devices[0].Check == nil ||
		listed.Providers[0].Devices[0].Check.Status != "passed" {
		t.Fatalf("listed = %+v", listed)
	}
	// The page's projection carries the same check.
	rows, err := f.server.deviceAgentProfiles(ctx, Actor{Kind: ActorAccount, Account: &store.User{ID: f.aliceID}}, "dev_alice")
	if err != nil {
		t.Fatal(err)
	}
	if row, ok := findAgentProfile(rows, created.ID); !ok || row.Check == nil || row.Check.Status != "passed" {
		t.Fatalf("projection row = %+v", row)
	}

	// Changing the endpoint clears the check; the key stays until cleared.
	var updated mcpProvider
	alice.ok("save_model_provider", `{"providerId":"`+created.ID+`","baseUrl":"https://relay2.example"}`, &updated)
	if updated.BaseURL != "https://relay2.example" || !*updated.KeySet || updated.Devices[0].Check != nil {
		t.Fatalf("updated = %+v", updated)
	}
	alice.ok("save_model_provider", `{"providerId":"`+created.ID+`","clearApiKey":true}`, &updated)
	if *updated.KeySet {
		t.Fatal("clearApiKey kept the key")
	}

	var deleted map[string]any
	alice.ok("delete_model_provider", `{"providerId":"`+created.ID+`"}`, &deleted)
	if deleted["deleted"] != created.ID {
		t.Fatalf("deleted = %+v", deleted)
	}
	if _, err := f.db.GetProfile(ctx, created.ID); err == nil {
		t.Fatal("the provider survived")
	}
	alice.ok("list_model_providers", `{"kind":"api"}`, &listed)
	if listed.Total != 0 {
		t.Fatalf("listed after delete = %+v", listed)
	}
}

// Only the person's own chats and assistant manage their providers: another
// member's session reaches neither the provider nor the device, and an
// Issue's sessions, verifiers and utility sessions get no provider tool.
func TestModelProviderToolsRefuseOthers(t *testing.T) {
	f := newExternalAccountsFixture(t)
	alice := f.providerSession(store.CreateAgentSessionInput{CreatedByUserID: f.aliceID})
	var created mcpProvider
	alice.ok("save_model_provider", `{"runtime":"codex","label":"Gateway","baseUrl":"https://gw.example","apiKey":"`+providerTestKey+`"}`, &created)
	if created.BaseURL != "https://gw.example/v1" {
		t.Fatalf("codex endpoint = %q", created.BaseURL)
	}

	bob := f.providerSession(store.CreateAgentSessionInput{CreatedByUserID: f.bobID, AgentID: "agent_bob", WorkspaceID: "ws_bob"})
	for _, call := range []struct{ tool, args string }{
		{"save_model_provider", `{"providerId":"` + created.ID + `","label":"Mine now"}`},
		{"delete_model_provider", `{"providerId":"` + created.ID + `"}`},
		{"check_model_provider", `{"providerId":"` + created.ID + `","deviceId":"dev_alice"}`},
		{"save_model_provider", `{"runtime":"claude","label":"X","baseUrl":"https://x.example","deviceIds":["dev_alice"]}`},
		{"set_model_defaults", `{"providerId":"claude_local","deviceId":"dev_alice","model":"opus"}`},
		{"sign_in_subscription", `{"deviceId":"dev_alice","runtime":"claude","action":"start"}`},
	} {
		text, failed, _ := bob.call(call.tool, call.args)
		if !failed || !strings.Contains(text, "not found") {
			t.Fatalf("bob %s: %q", call.tool, text)
		}
	}
	var bobs struct {
		Total int `json:"total"`
	}
	bob.ok("list_model_providers", `{}`, &bobs)
	if text, _, _ := bob.call("list_model_providers", `{"kind":"api"}`); strings.Contains(text, created.ID) {
		t.Fatalf("bob lists alice's provider: %s", text)
	}
	if profile, _ := f.db.GetProfile(context.Background(), created.ID); profile.Label != "Gateway" {
		t.Fatalf("bob changed alice's provider: %+v", profile)
	}

	for name, input := range map[string]store.CreateAgentSessionInput{
		"verifier": {CreatedByUserID: f.aliceID, Verification: true, Source: store.SessionSourceVerification},
		"naming":   {CreatedByUserID: f.aliceID, Source: store.SessionSourceNaming},
		"nobody's": {},
	} {
		session := f.providerSession(input)
		if _, failed, refused := session.call("list_model_providers", `{}`); !failed {
			t.Fatalf("a %s session lists providers", name)
		} else if refused == "" {
			// Visible but refused when called is fine; it must not answer.
		}
		if _, failed, _ := session.call("save_model_provider", `{"runtime":"claude","label":"X","baseUrl":"https://x.example"}`); !failed {
			t.Fatalf("a %s session saves a provider", name)
		}
	}
}

func TestModelProviderToolsAreNotGivenToIssueRolesOrVerifiers(t *testing.T) {
	for name := range modelProviderMCPTools {
		for _, role := range []string{store.AgentSessionRoleIssueExecution, store.AgentSessionRoleIssueClarification} {
			if mcpToolAllowed(role, false, name) == nil {
				t.Fatalf("%s reaches %s", role, name)
			}
		}
		if mcpToolAllowed("", true, name) == nil {
			t.Fatalf("a verifier reaches %s", name)
		}
		if mcpToolAllowed("", false, name) != nil || mcpToolAllowed(store.AgentSessionRolePersonalAgent, false, name) != nil {
			t.Fatalf("the person's chat or assistant lacks %s", name)
		}
	}
}

// A check needs the provider on the device and a worker that can run it.
func TestCheckModelProviderNeedsTheDeviceAndAWorkerThatChecks(t *testing.T) {
	f := newExternalAccountsFixture(t)
	alice := f.providerSession(store.CreateAgentSessionInput{CreatedByUserID: f.aliceID})
	var created mcpProvider
	alice.ok("save_model_provider", `{"runtime":"claude","label":"Relay","baseUrl":"https://relay.example"}`, &created)
	if text, failed, _ := alice.call("check_model_provider", `{"providerId":"`+created.ID+`","deviceId":"dev_alice"}`); !failed || !strings.Contains(text, "not assigned") {
		t.Fatalf("unassigned check: %q", text)
	}
	alice.ok("save_model_provider", `{"providerId":"`+created.ID+`","deviceIds":["dev_alice"]}`, nil)
	attachProfileCheckWorker(t, f.server, nil, `{}`)
	if text, failed, _ := alice.call("check_model_provider", `{"providerId":"`+created.ID+`","deviceId":"dev_alice"}`); !failed || !strings.Contains(text, "update its worker") {
		t.Fatalf("old worker check: %q", text)
	}
	// The page's route answers the same.
	call := f.as(f.alice, http.MethodPost, "/api/profiles/"+created.ID+"/check", `{"deviceId":"dev_alice"}`)
	if response := doAuthCall(t, f.handler, call); response.Code != http.StatusConflict {
		t.Fatalf("route: %d %s", response.Code, response.Body.String())
	}
	if response := doAuthCall(t, f.handler, f.as(f.bob, http.MethodPost, "/api/profiles/"+created.ID+"/check", `{"deviceId":"dev_alice"}`)); response.Code != http.StatusNotFound {
		t.Fatalf("bob's route call: %d", response.Code)
	}
}

// attachWorker connects dev_alice's worker, declaring capabilities, and
// answers its next request with reply decoded as T.
func attachWorker[T any](t *testing.T, server *Server, capabilities []string, reply string) chan wsEnvelope {
	t.Helper()
	connection := newDaemonConnection(server.hub, nil)
	connection.registration = store.DaemonRegistration{Capabilities: capabilities}
	server.hub.mu.Lock()
	server.hub.connections["dev_alice"] = connection
	server.hub.mu.Unlock()
	t.Cleanup(func() {
		server.hub.mu.Lock()
		delete(server.hub.connections, "dev_alice")
		server.hub.mu.Unlock()
		close(connection.done)
	})
	asked := make(chan wsEnvelope, 1)
	go func() {
		for envelope := range connection.send {
			asked <- envelope
			_ = deliverDaemonResponse[T](connection, wsEnvelope{ID: envelope.ID, Payload: json.RawMessage(reply)}, nil)
			return
		}
	}()
	return asked
}

// reportSubscription has dev_alice report its Claude login.
func reportSubscription(t *testing.T, f *externalAccountsFixture) {
	t.Helper()
	if err := f.db.RegisterDaemon(context.Background(), store.DaemonRegistration{
		Device:    store.DeviceProjection{ID: "dev_alice", Label: "Device", Status: "connected", LastSeenLabel: "online"},
		Workspace: store.WorkspaceProjection{ID: "ws_alice", Name: "W", LocalPath: "/tmp/ws_alice"},
		Agents: []store.AgentProjection{{
			ID: "agent_alice", WorkspaceID: "ws_alice", DeviceID: "dev_alice", Provider: "claude", Status: "healthy",
			AuthMode: "local_config", SecretStored: "local", ConfigScope: "workspace", ConfigLabel: "local", LastSeenLabel: "online",
		}},
		AgentProfiles: []store.AgentProfileProjection{{
			ID: "claude_local", DeviceID: "dev_alice", Runtime: "claude", Label: "Claude", ConnectionType: "local_login",
			Status: "healthy", AuthMode: "local_config", SecretStored: "local", ConfigScope: "device", ConfigLabel: "login", Model: "claude-sonnet-5",
		}},
	}); err != nil {
		t.Fatal(err)
	}
}

// A subscription's device defaults are written on its device the way the
// page's Defaults… writes them.
func TestSetModelDefaultsWritesTheDeviceProfile(t *testing.T) {
	f := newExternalAccountsFixture(t)
	reportSubscription(t, f)
	alice := f.providerSession(store.CreateAgentSessionInput{CreatedByUserID: f.aliceID})
	var listed struct {
		Providers []mcpProvider `json:"providers"`
	}
	alice.ok("list_model_providers", `{"kind":"subscription"}`, &listed)
	if len(listed.Providers) != 1 || listed.Providers[0].ID != "claude_local" || listed.Providers[0].Devices[0].Model != "claude-sonnet-5" {
		t.Fatalf("subscriptions = %+v", listed.Providers)
	}
	if text, failed, _ := alice.call("set_model_defaults", `{"providerId":"claude_local","deviceId":"dev_alice","effort":"huge"}`); !failed || !strings.Contains(text, "effort") {
		t.Fatalf("bad effort: %q", text)
	}
	asked := attachWorker[wsAgentProfileUpsertedPayload](t, f.server, nil,
		`{"profile":{"id":"claude_local","deviceId":"dev_alice","runtime":"claude","label":"Claude","connectionType":"local_login","model":"claude-opus-5-5","claudeEffort":"high"}}`)
	alice.ok("set_model_defaults", `{"providerId":"claude_local","deviceId":"dev_alice","model":"claude-opus-5-5","effort":"high"}`, nil)
	envelope := <-asked
	var payload wsUpsertAgentProfilePayload
	_ = json.Unmarshal(envelope.Payload, &payload)
	if envelope.Type != wsUpsertAgentProfileType || payload.Profile.ID != "claude_local" || payload.Profile.ConnectionType != "local_login" ||
		payload.Profile.Model != "claude-opus-5-5" || payload.Profile.ClaudeEffort != "high" || payload.Profile.ConfigScope != "device" {
		t.Fatalf("asked %s %+v", envelope.Type, payload.Profile)
	}
}

// A subscription's sign-in is started on its device and its link handed
// back; the agent never signs in itself.
func TestSignInSubscriptionRelaysTheDevicesSignIn(t *testing.T) {
	f := newExternalAccountsFixture(t)
	alice := f.providerSession(store.CreateAgentSessionInput{CreatedByUserID: f.aliceID})
	asked := attachWorker[store.NativeSignInReplyPayload](t, f.server, []string{store.DaemonCapabilityNativeSignIn},
		`{"signIn":{"status":"pending","operationId":"nsi_x","verificationUrl":"https://chatgpt.example/device","userCode":"ABCD-1234"}}`)
	var step store.NativeSignInStep
	alice.ok("sign_in_subscription", `{"deviceId":"dev_alice","runtime":"codex","action":"start"}`, &step)
	envelope := <-asked
	var request store.NativeSignInRequestPayload
	_ = json.Unmarshal(envelope.Payload, &request)
	if envelope.Type != wsNativeSignInType || request.Runtime != "codex" || request.Action != store.NativeSignInActionBegin || request.OperationID == "" {
		t.Fatalf("asked %s %+v", envelope.Type, request)
	}
	if step.VerificationURL != "https://chatgpt.example/device" || step.UserCode != "ABCD-1234" {
		t.Fatalf("step = %+v", step)
	}
	if text, failed, _ := alice.call("sign_in_subscription", `{"deviceId":"dev_alice","runtime":"codex","action":"code"}`); !failed || !strings.Contains(text, "operation") {
		t.Fatalf("code without an operation: %q", text)
	}
}

func modelProviderToolNames() []string {
	names := []string{}
	for name := range modelProviderMCPTools {
		names = append(names, name)
	}
	return names
}
