package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
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
