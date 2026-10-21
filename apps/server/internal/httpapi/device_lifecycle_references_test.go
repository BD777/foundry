package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/personalagent"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func TestDeviceLifecycleHTTPAuthorityAndSettings(t *testing.T) {
	f := newIsolationFixture(t)
	ctx := context.Background()
	settings := personalagent.DefaultSettings()
	settings.Devices = []store.PersonalAgentDeviceSettings{{DeviceID: "dev_alice", AllowWork: true, AllowCreate: true}}
	if _, err := f.server.store.CreatePersonalAgent(ctx, store.PersonalAgent{UserID: f.aliceID, HomeDeviceID: "dev_alice", WorkspaceID: "ws_alice", Settings: settings}); err != nil {
		t.Fatal(err)
	}
	// Shared workspace membership is not device-control authority.
	if err := f.server.store.SetWorkspaceMember(ctx, "ws_alice", f.bobID, store.WorkspaceRoleMaintainer, f.aliceID); err != nil {
		t.Fatal(err)
	}
	expectStatus(t, doAuthCall(t, f.handler, f.as(f.bob, http.MethodDelete, "/api/devices/dev_alice", "")), http.StatusNotFound, "shared member cannot remove")
	expectStatus(t, doAuthCall(t, f.handler, f.as(f.alice, http.MethodDelete, "/api/devices/dev_alice", "")), http.StatusOK, "owner removes")
	expectStatus(t, doAuthCall(t, f.handler, f.as(f.alice, http.MethodDelete, "/api/devices/dev_alice", "")), http.StatusOK, "idempotent remove")
	expectStatus(t, doAuthCall(t, f.handler, f.as(f.alice, http.MethodPatch, "/api/devices/dev_alice", `{"name":"not resurrected"}`)), http.StatusGone, "history is not control authority")
	body, _ := json.Marshal(settings)
	expectStatus(t, doAuthCall(t, f.handler, f.as(f.alice, http.MethodPut, "/api/personal-agent/settings", string(body))), http.StatusGone, "stale grant rejected")
	agent, err := f.server.store.GetPersonalAgent(ctx, f.aliceID)
	if err != nil {
		t.Fatal(err)
	}
	agent.Settings.AssistantName = "Unrelated edit"
	body, _ = json.Marshal(agent.Settings)
	expectStatus(t, doAuthCall(t, f.handler, f.as(f.alice, http.MethodPut, "/api/personal-agent/settings", string(body))), http.StatusOK, "other settings remain editable")
	candidates, err := f.server.ownDevices(ctx, f.aliceID)
	if err != nil || len(candidates) != 0 {
		t.Fatalf("connector candidates %+v %v", candidates, err)
	}
	devices := doAuthCall(t, f.handler, f.as(f.alice, http.MethodGet, "/api/devices", ""))
	var history []store.DeviceProjection
	if err = json.Unmarshal(devices.Body.Bytes(), &history); err != nil {
		t.Fatal(err)
	}
	found := false
	for _, d := range history {
		if d.ID == "dev_alice" && d.Status == "removed" {
			found = true
		}
	}
	if !found {
		t.Fatal("history device disappeared")
	}
	expectStatus(t, doAuthCall(t, f.handler, deviceCall(http.MethodPost, "/api/daemon/register", registrationBody("dev_alice", "ws_alice"), f.aliceDevice)), http.StatusUnauthorized, "revoked credential cannot re-register")
}

func TestDeviceLifecycleMCPAndExplicitDefault(t *testing.T) {
	f := newAssistantFixture(t)
	ctx := context.Background()
	_, credential := pairOverHTTP(t, f.handler, f.alice, "retired-machine", "dev_retired")
	expectStatus(t, doAuthCall(t, f.handler, deviceCall(http.MethodPost, "/api/daemon/register", registrationBody("dev_retired", "ws_retired"), credential)), http.StatusOK, "register retired fixture")
	agent, err := f.server.store.GetPersonalAgent(ctx, f.aliceID)
	if err != nil {
		t.Fatal(err)
	}
	agent.Settings.PreferredDeviceID = "dev_retired"
	agent.Settings.Devices = []store.PersonalAgentDeviceSettings{{DeviceID: "dev_retired", AllowWork: true, AllowCreate: true}, {DeviceID: "dev_alice", AllowWork: true, AllowCreate: true}}
	if _, err = f.server.store.SavePersonalAgentSettings(ctx, agent.UserID, agent.Settings); err != nil {
		t.Fatal(err)
	}
	expectStatus(t, doAuthCall(t, f.handler, f.as(f.alice, http.MethodDelete, "/api/devices/dev_retired", "")), http.StatusOK, "remove retired fixture")
	for _, tool := range []string{"list_resources", "list_workspaces"} {
		text, failed := f.tool(t, f.token, tool, map[string]any{})
		if failed || strings.Contains(text, "dev_retired") || strings.Contains(text, "ws_retired") {
			t.Fatalf("%s exposes removed placement: %s", tool, text)
		}
	}
	if _, err := f.server.store.RenameWorkspace(ctx, "ws_retired", "Retired matching project"); err != nil {
		t.Fatal(err)
	}
	text, failed := f.tool(t, f.token, "find_workspace", map[string]any{"query": "Retired matching project"})
	if failed || strings.Contains(text, "ws_retired") {
		t.Fatalf("routing suggests removed project: %s", text)
	}
	// Historical membership is still honored by the digest read contract.
	if _, err := f.server.workspaceDigests().Digest(ctx, f.aliceID, "ws_retired"); err != nil {
		t.Fatalf("historical digest lost: %v", err)
	}
	scope, err := f.server.paScopeFor(ctx, agent, f.conversation.ID, f.conversation.Input)
	if err != nil {
		t.Fatal(err)
	}
	candidates, err := store.DeviceCandidates(ctx, f.server.store)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err = f.server.assistantCreateDevice(ctx, scope, candidates, paCreateSpec{}, nil); !errors.Is(err, store.ErrDeviceRemoved) {
		t.Fatalf("invalid default silently fell back: %v", err)
	}
	if err = f.server.checkPinnedAssistantRun(ctx, store.PersonalAgentRunSnapshot{DeviceID: "dev_retired", WorkspaceID: "ws_retired"}); !errors.Is(err, store.ErrDeviceRemoved) {
		t.Fatalf("pinned removed runtime: %v", err)
	}
}
