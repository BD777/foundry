package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"github.com/foundry-dev/foundry/apps/server/internal/testfixture"
)

// Option A (docs/architecture-modules.md §5.6): an agent acts for the person
// who started it, in every workspace that person belongs to, never above
// Member, and loses a workspace the moment its person does.
func TestAgentReachesItsPersonsWorkspaces(t *testing.T) {
	f := newIsolationFixture(t)
	ctx := context.Background()
	db := f.server.store
	for _, register := range []struct{ device, workspace, agent string }{
		{"dev_alice", "ws_alice", "agent_alice"}, {"dev_bob", "ws_bob", "agent_bob"},
	} {
		if err := db.RegisterDaemon(ctx, store.DaemonRegistration{
			Device:    store.DeviceProjection{ID: register.device, Label: "Device", Status: "connected", LastSeenLabel: "online"},
			Workspace: store.WorkspaceProjection{ID: register.workspace, Name: "W", LocalPath: "/tmp/w"},
			Agents: []store.AgentProjection{{
				ID: register.agent, WorkspaceID: register.workspace, DeviceID: register.device, Provider: "claude", Status: "healthy",
				AuthMode: "local_config", SecretStored: "local", ConfigScope: "workspace", ConfigLabel: "local", LastSeenLabel: "online",
			}},
		}); err != nil {
			t.Fatal(err)
		}
	}
	session, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{
		CreatedByUserID: f.bobID, WorkspaceID: "ws_bob", AgentID: "agent_bob", Provider: "claude", Prompt: "work",
	})
	if err != nil {
		t.Fatal(err)
	}
	token, err := db.MintAgentSessionToken(ctx, session.ID)
	if err != nil {
		t.Fatal(err)
	}
	agent := func(method, path, body string) int {
		return doAuthCall(t, f.handler, authCall{method: method, path: path, body: body,
			headers: map[string]string{"Authorization": "Bearer " + token}}).Code
	}
	reachable := func() string {
		body := `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_workspaces","arguments":{}}}`
		return doAuthCall(t, f.handler, authCall{method: http.MethodPost, path: "/api/mcp", body: body,
			headers: map[string]string{"Authorization": "Bearer " + token, "Content-Type": "application/json"}}).Body.String()
	}
	createInAlice := `{"workspaceId":"ws_alice","provider":"claude","prompt":"help alice"}`

	if got := agent(http.MethodGet, "/api/agent-sessions?workspaceId=ws_alice", ""); got != http.StatusNotFound {
		t.Fatalf("agent reads a workspace its person is not in: %d, want 404", got)
	}
	if got := agent(http.MethodGet, "/api/agent-sessions", ""); got != http.StatusOK {
		t.Fatalf("agent reads its own workspace: %d, want 200", got)
	}
	if got := agent(http.MethodPost, "/api/workspaces/ws_bob/members", `{"username":"owner","role":"viewer"}`); got != http.StatusForbidden {
		t.Fatalf("agent of an Owner manages members: %d, want 403", got)
	}

	expectStatus(t, doAuthCall(t, f.handler, f.as(f.alice, http.MethodPost, "/api/workspaces/ws_alice/members", `{"username":"bob","role":"viewer"}`)),
		http.StatusNoContent, "share with bob as viewer")
	if got := agent(http.MethodGet, "/api/agent-sessions?workspaceId=ws_alice", ""); got != http.StatusOK {
		t.Fatalf("agent reads its person's shared workspace: %d, want 200", got)
	}
	if listed := reachable(); !strings.Contains(listed, `\"id\": \"ws_alice\"`) || !strings.Contains(listed, `\"accessRole\": \"viewer\"`) ||
		!strings.Contains(listed, `\"accessRole\": \"member\"`) || strings.Contains(listed, `\"accessRole\": \"owner\"`) {
		t.Fatalf("list_workspaces = %s, want ws_alice as viewer and ws_bob capped at member", listed)
	}
	if got := agent(http.MethodPost, "/api/agent-sessions", createInAlice); got != http.StatusForbidden {
		t.Fatalf("agent of a Viewer starts a session: %d, want 403", got)
	}

	expectStatus(t, doAuthCall(t, f.handler, f.as(f.alice, http.MethodPatch, "/api/workspaces/ws_alice/members/"+f.bobID, `{"role":"member"}`)),
		http.StatusNoContent, "promote bob to member")
	created := doAuthCall(t, f.handler, authCall{method: http.MethodPost, path: "/api/agent-sessions", body: createInAlice,
		headers: map[string]string{"Authorization": "Bearer " + token}})
	// Authorized: it stops only at dispatch, since no daemon is connected.
	if created.Code != http.StatusConflict || !strings.Contains(created.Body.String(), "not connected") {
		t.Fatalf("agent of a Member starts a session in the shared workspace: %d %s", created.Code, created.Body.String())
	}

	// Without a runtime choice, a child in another workspace keeps its parent's
	// runtime and resolves that workspace's agent.
	mcpCreate := `{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"create_session","arguments":{"workspaceId":"ws_alice","prompt":"help alice"}}}`
	if body := doAuthCall(t, f.handler, authCall{method: http.MethodPost, path: "/api/mcp", body: mcpCreate,
		headers: map[string]string{"Authorization": "Bearer " + token, "Content-Type": "application/json"}}).Body.String(); !strings.Contains(body, "not connected") {
		t.Fatalf("MCP create in the shared workspace without a runtime = %s, want it to stop only at dispatch", body)
	}

	expectStatus(t, doAuthCall(t, f.handler, f.as(f.alice, http.MethodDelete, "/api/workspaces/ws_alice/members/"+f.bobID, "")),
		http.StatusNoContent, "remove bob")
	if got := agent(http.MethodGet, "/api/agent-sessions?workspaceId=ws_alice", ""); got != http.StatusNotFound {
		t.Fatalf("agent reads a workspace its person left: %d, want 404", got)
	}
}

// The Resource Pool directory follows the agent's reach: its person's
// devices, plus devices hosting a workspace shared with that person.
func TestListResourcesFollowsReach(t *testing.T) {
	f := newIsolationFixture(t)
	ctx := context.Background()
	db := f.server.store
	for _, register := range []struct{ device, workspace, browser string }{
		{"dev_alice", "ws_alice", "Microsoft Edge"}, {"dev_bob", "ws_bob", "Google Chrome"},
	} {
		if err := db.RegisterDaemon(ctx, store.DaemonRegistration{
			Device: store.DeviceProjection{ID: register.device, Label: register.device, Status: "connected", LastSeenLabel: "online",
				Resources: []store.DeviceResource{
					{ID: "browser:x", Kind: "browser", Name: register.browser, Available: true, Attributes: map[string]string{"path": "/x"}},
					{ID: "computer_use:macos", Kind: "computer_use", Name: "macOS screen control", Available: false, Detail: "Accessibility not granted"},
				}},
			Workspace: store.WorkspaceProjection{ID: register.workspace, Name: register.workspace, LocalPath: "/tmp/w"},
			Agents: []store.AgentProjection{{
				ID: "agent_" + register.workspace, WorkspaceID: register.workspace, DeviceID: register.device, Provider: "claude", Status: "healthy",
				AuthMode: "local_config", SecretStored: "local", ConfigScope: "workspace", ConfigLabel: "local", LastSeenLabel: "online",
			}},
		}); err != nil {
			t.Fatal(err)
		}
	}
	session, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{
		CreatedByUserID: f.bobID, WorkspaceID: "ws_bob", AgentID: "agent_ws_bob", Provider: "claude", Prompt: "work",
	})
	if err != nil {
		t.Fatal(err)
	}
	token, err := db.MintAgentSessionToken(ctx, session.ID)
	if err != nil {
		t.Fatal(err)
	}
	type listed struct {
		DeviceID   string `json:"deviceId"`
		Workspaces []struct {
			ID string `json:"id"`
		} `json:"workspaces"`
		Resources []store.DeviceResource `json:"resources"`
	}
	list := func(arguments string) []listed {
		body := `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_resources","arguments":` + arguments + `}}`
		raw := doAuthCall(t, f.handler, authCall{method: http.MethodPost, path: "/api/mcp", body: body,
			headers: map[string]string{"Authorization": "Bearer " + token, "Content-Type": "application/json"}}).Body.Bytes()
		var envelope struct {
			Result struct {
				Content []struct {
					Text string `json:"text"`
				} `json:"content"`
			} `json:"result"`
		}
		if err := json.Unmarshal(raw, &envelope); err != nil || len(envelope.Result.Content) == 0 {
			t.Fatalf("list_resources: %s", raw)
		}
		var devices []listed
		if err := json.Unmarshal([]byte(envelope.Result.Content[0].Text), &devices); err != nil {
			t.Fatalf("list_resources text: %s", envelope.Result.Content[0].Text)
		}
		return devices
	}
	devices := list(`{}`)
	if len(devices) != 1 || devices[0].DeviceID != "dev_bob" || len(devices[0].Resources) != 2 ||
		len(devices[0].Workspaces) != 1 || devices[0].Workspaces[0].ID != "ws_bob" {
		t.Fatalf("bob's agent sees %+v, want only dev_bob with its resources", devices)
	}
	expectStatus(t, doAuthCall(t, f.handler, f.as(f.alice, http.MethodPost, "/api/workspaces/ws_alice/members", `{"username":"bob","role":"member"}`)),
		http.StatusNoContent, "share with bob")
	devices = list(`{"kind":"browser"}`)
	names := map[string]string{}
	for _, device := range devices {
		if len(device.Resources) != 1 || device.Resources[0].Kind != "browser" {
			t.Fatalf("kind filter: %+v", device)
		}
		names[device.DeviceID] = device.Resources[0].Name
	}
	if names["dev_alice"] != "Microsoft Edge" || names["dev_bob"] != "Google Chrome" {
		t.Fatalf("after sharing, browsers = %v", names)
	}
}

// Only a device's owner may make it ask its person for access.
func TestRefreshDeviceResourcesIsOwnerOnly(t *testing.T) {
	f := newIsolationFixture(t)
	path := "/api/devices/dev_alice/resources/refresh"
	body := `{"requestAccess":"computer_use:macos"}`
	if got := doAuthCall(t, f.handler, f.as(f.bob, http.MethodPost, path, body)).Code; got != http.StatusForbidden && got != http.StatusNotFound {
		t.Fatalf("a stranger asks alice's device for access: %d", got)
	}
	expectStatus(t, doAuthCall(t, f.handler, f.as(f.alice, http.MethodPost, "/api/workspaces/ws_alice/members", `{"username":"bob","role":"maintainer"}`)),
		http.StatusNoContent, "share with bob")
	if got := doAuthCall(t, f.handler, f.as(f.bob, http.MethodPost, path, body)).Code; got != http.StatusForbidden && got != http.StatusNotFound {
		t.Fatalf("a maintainer of a workspace on it asks alice's device for access: %d", got)
	}
	// The owner reaches the device; it is not connected in this fixture.
	if got := doAuthCall(t, f.handler, f.as(f.alice, http.MethodPost, path, body)).Code; got != http.StatusConflict {
		t.Fatalf("owner, device offline: %d, want 409", got)
	}
}

// D6 (architecture-modules.md §6): an agent working in an Issue's candidate
// reaches only that Issue. It starts sessions only inside the Issue, controls
// only the Issue's sessions, and does not reach its person's other workspaces.
func TestAgentInAnIssueStaysInThatIssue(t *testing.T) {
	f := newIsolationFixture(t)
	ctx := context.Background()
	db := f.server.store
	for _, register := range []struct{ device, workspace, agent string }{
		{"dev_alice", "ws_alice", "agent_alice"}, {"dev_bob", "ws_bob", "agent_bob"},
	} {
		if err := db.RegisterDaemon(ctx, store.DaemonRegistration{
			Device:    store.DeviceProjection{ID: register.device, Label: "Device", Status: "connected", LastSeenLabel: "online"},
			Workspace: store.WorkspaceProjection{ID: register.workspace, Name: "W", LocalPath: "/tmp/w"},
			Agents: []store.AgentProjection{{
				ID: register.agent, WorkspaceID: register.workspace, DeviceID: register.device, Provider: "claude", Status: "healthy",
				AuthMode: "local_config", SecretStored: "local", ConfigScope: "workspace", ConfigLabel: "local", LastSeenLabel: "online",
			}},
		}); err != nil {
			t.Fatal(err)
		}
	}
	expectStatus(t, doAuthCall(t, f.handler, f.as(f.alice, http.MethodPost, "/api/workspaces/ws_alice/members", `{"username":"bob","role":"member"}`)),
		http.StatusNoContent, "share ws_alice with bob as member")
	issue, err := db.CreateIssue(ctx, store.CreateIssueInput{WorkspaceID: "ws_bob", Title: "scoped", Runtime: "claude", CreatedByUserID: f.bobID})
	if err != nil {
		t.Fatal(err)
	}
	testfixture.ConfirmContract(t, db.(store.EvidenceStore), issue.ID)
	_, executor, err := db.(store.IssueExecutionStore).ClaimIssueExecution(ctx, "dev_bob", "ws_bob")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.StartAgentSession(ctx, executor.ID); err != nil {
		t.Fatal(err)
	}
	chat, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{
		CreatedByUserID: f.bobID, WorkspaceID: "ws_bob", AgentID: "agent_bob", Provider: "claude", Prompt: "an ordinary chat",
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.StartAgentSession(ctx, chat.ID); err != nil {
		t.Fatal(err)
	}
	token, err := db.MintAgentSessionToken(ctx, executor.ID)
	if err != nil {
		t.Fatal(err)
	}
	call := func(method, path, body string) *httptest.ResponseRecorder {
		return doAuthCall(t, f.handler, authCall{method: method, path: path, body: body,
			headers: map[string]string{"Authorization": "Bearer " + token, "Content-Type": "application/json"}})
	}
	mcp := func(tool, arguments string) string {
		return call(http.MethodPost, "/api/mcp", `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"`+tool+`","arguments":`+arguments+`}}`).Body.String()
	}

	if got := call(http.MethodGet, "/api/agent-sessions?workspaceId=ws_alice", "").Code; got != http.StatusNotFound {
		t.Fatalf("an Issue's agent reads its person's other workspace: %d, want 404", got)
	}
	if got := call(http.MethodGet, "/api/agent-sessions?workspaceId=ws_bob", "").Code; got != http.StatusOK {
		t.Fatalf("an Issue's agent reads its own workspace: %d, want 200", got)
	}
	if got := call(http.MethodPost, "/api/agent-sessions", `{"workspaceId":"ws_alice","provider":"claude","prompt":"elsewhere"}`).Code; got != http.StatusForbidden {
		t.Fatalf("an Issue's agent starts a session in another workspace: %d, want 403", got)
	}
	if got := call(http.MethodPost, "/api/agent-sessions", `{"issueId":"iss_other","provider":"claude","prompt":"another issue"}`).Code; got != http.StatusForbidden {
		t.Fatalf("an Issue's agent starts a session in another Issue: %d, want 403", got)
	}
	if body := mcp("cancel_session", `{"sessionId":"`+chat.ID+`"}`); !strings.Contains(body, "cannot cancel this session") {
		t.Fatalf("an Issue's agent cancels a chat outside its Issue: %s", body)
	}
	if current, _ := db.GetAgentSession(ctx, chat.ID); current.Status != "running" {
		t.Fatalf("the chat outside the Issue was stopped: %s", current.Status)
	}
	// A child it starts without naming anything lands in the same Issue.
	actor := Actor{Kind: ActorAgent, Identity: store.SessionTokenIdentity{SessionID: executor.ID, WorkspaceID: "ws_bob", DeviceID: "dev_bob"}}
	input := store.CreateAgentSessionInput{Prompt: "help in the candidate"}
	if err := f.server.keepAgentInIssue(ctx, actor, &input); err != nil || input.IssueID != issue.ID || input.WorkspaceID != "ws_bob" {
		t.Fatalf("a child of the Issue's agent = %q in %q (%v), want the Issue's candidate", input.IssueID, input.WorkspaceID, err)
	}
}
