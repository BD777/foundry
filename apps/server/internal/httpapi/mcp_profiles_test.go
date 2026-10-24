package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// An agent diagnosing a run needs the model service it ran under: list_profiles
// shows the services set up in Foundry and assigned to the device, with their
// endpoint and never the key, and list_models finds them by id.
func TestListProfilesShowsAssignedModelServices(t *testing.T) {
	f := newIsolationFixture(t)
	ctx := context.Background()
	db := f.server.store
	for _, register := range []struct{ device, workspace string }{{"dev_alice", "ws_alice"}, {"dev_bob", "ws_bob"}} {
		if err := db.RegisterDaemon(ctx, store.DaemonRegistration{
			Device:    store.DeviceProjection{ID: register.device, Label: register.device, Status: "connected", LastSeenLabel: "online"},
			Workspace: store.WorkspaceProjection{ID: register.workspace, Name: register.workspace, LocalPath: "/tmp/w"},
			Agents: []store.AgentProjection{{
				ID: "agent_" + register.workspace, WorkspaceID: register.workspace, DeviceID: register.device, Provider: "codex", Status: "healthy",
				AuthMode: "local_config", SecretStored: "local", ConfigScope: "workspace", ConfigLabel: "local", LastSeenLabel: "online",
			}},
		}); err != nil {
			t.Fatal(err)
		}
	}
	created := doAuthCall(t, f.handler, f.as(f.alice, http.MethodPost, "/api/profiles",
		`{"runtime":"claude","label":"hell-tw","authMode":"custom","baseUrl":"astergate.cc/v1/","model":"claude-opus-5-5"}`))
	expectStatus(t, created, http.StatusCreated, "alice creates a model service")
	var service store.ProfileDefinition
	_ = json.Unmarshal(created.Body.Bytes(), &service)
	if service.BaseURL != "https://astergate.cc" {
		t.Fatalf("saved baseUrl = %q, want the Claude form https://astergate.cc", service.BaseURL)
	}
	expectStatus(t, doAuthCall(t, f.handler, f.as(f.alice, http.MethodPut, "/api/devices/dev_alice/profiles",
		`{"deviceId":"dev_alice","profileIds":["`+service.ID+`"]}`)), http.StatusOK, "assign it to dev_alice")

	mcpAs := func(owner string) func(tool, arguments string) string {
		workspace := map[string]string{f.aliceID: "ws_alice", f.bobID: "ws_bob"}[owner]
		session, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{
			CreatedByUserID: owner, WorkspaceID: workspace, AgentID: "agent_" + workspace, Provider: "codex", Prompt: "diagnose",
		})
		if err != nil {
			t.Fatal(err)
		}
		token, err := db.MintAgentSessionToken(ctx, session.ID)
		if err != nil {
			t.Fatal(err)
		}
		return func(tool, arguments string) string {
			body := `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"` + tool + `","arguments":` + arguments + `}}`
			return doAuthCall(t, f.handler, authCall{method: http.MethodPost, path: "/api/mcp", body: body,
				headers: map[string]string{"Authorization": "Bearer " + token, "Content-Type": "application/json"}}).Body.String()
		}
	}
	alice := mcpAs(f.aliceID)
	var envelope struct {
		Result struct {
			IsError bool `json:"isError"`
			Content []struct {
				Text string `json:"text"`
			} `json:"content"`
		} `json:"result"`
	}
	raw := alice("list_profiles", `{}`)
	if err := json.Unmarshal([]byte(raw), &envelope); err != nil || envelope.Result.IsError || len(envelope.Result.Content) == 0 {
		t.Fatalf("list_profiles: %s", raw)
	}
	var profiles []store.AgentProfileProjection
	if err := json.Unmarshal([]byte(envelope.Result.Content[0].Text), &profiles); err != nil {
		t.Fatalf("list_profiles text: %s", envelope.Result.Content[0].Text)
	}
	listed, ok := findAgentProfile(profiles, service.ID)
	if !ok || listed.Origin != profileOriginServer || listed.BaseURL != "https://astergate.cc" ||
		listed.Model != "claude-opus-5-5" || listed.DeviceID != "dev_alice" {
		t.Fatalf("list_profiles = %+v, want %s from the server with its endpoint", profiles, service.ID)
	}
	if body := alice("list_profiles", `{"runtime":"codex"}`); strings.Contains(body, service.ID) {
		t.Fatalf("runtime filter kept a Claude service: %s", body)
	}
	// Found by id: what remains is the device's answer, not "unknown profile".
	if body := alice("list_models", `{"profileId":"`+service.ID+`"}`); strings.Contains(body, "unknown profile") {
		t.Fatalf("list_models does not find the service: %s", body)
	}

	// Another person's agent reaches neither the device nor the service.
	if body := mcpAs(f.bobID)("list_profiles", `{"deviceId":"dev_alice"}`); strings.Contains(body, service.ID) || !strings.Contains(body, "device not found") {
		t.Fatalf("bob's agent lists dev_alice: %s", body)
	}
}
