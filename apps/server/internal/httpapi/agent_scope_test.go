package httpapi

import (
	"context"
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

	expectStatus(t, doAuthCall(t, f.handler, f.as(f.alice, http.MethodDelete, "/api/workspaces/ws_alice/members/"+f.bobID, "")),
		http.StatusNoContent, "remove bob")
	if got := agent(http.MethodGet, "/api/agent-sessions?workspaceId=ws_alice", ""); got != http.StatusNotFound {
		t.Fatalf("agent reads a workspace its person left: %d, want 404", got)
	}
}
