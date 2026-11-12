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
	expectStatus(t, doAuthCall(t, f.handler, f.as(f.alice, http.MethodDelete, "/api/devices/dev_alice", "")), http.StatusOK, "removing again before the purge")
	expectStatus(t, doAuthCall(t, f.handler, f.as(f.alice, http.MethodPatch, "/api/devices/dev_alice", `{"name":"not resurrected"}`)), http.StatusGone, "a removed device is not control authority")
	body, _ := json.Marshal(settings)
	expectStatus(t, doAuthCall(t, f.handler, f.as(f.alice, http.MethodPut, "/api/personal-agent/settings", string(body))), http.StatusBadRequest, "stale grant rejected: the device is no longer one of the person's computers")
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
	listed := func() map[string]string {
		devices := doAuthCall(t, f.handler, f.as(f.alice, http.MethodGet, "/api/devices", ""))
		var projections []store.DeviceProjection
		if err := json.Unmarshal(devices.Body.Bytes(), &projections); err != nil {
			t.Fatal(err)
		}
		statuses := map[string]string{}
		for _, d := range projections {
			statuses[d.ID] = d.Status
		}
		return statuses
	}
	// It is not listed from its removal on, before its data is purged too.
	if status, ok := listed()["dev_alice"]; ok {
		t.Fatalf("removed device still listed as %q", status)
	}
	f.server.purgeRemovedDevices(ctx)
	if status, ok := listed()["dev_alice"]; ok {
		t.Fatalf("purged device still listed as %q", status)
	}
	if _, err := f.server.store.GetWorkspace(ctx, "ws_alice"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("the removed device's workspace: %v", err)
	}
	expectStatus(t, doAuthCall(t, f.handler, f.as(f.alice, http.MethodDelete, "/api/devices/dev_alice", "")), http.StatusNotFound, "a purged device is gone")
	if answer := helloForTest(t, serveForTest(t, f.server), f.aliceDevice, registrationBody("dev_alice", "ws_alice")); answer != "close 4001" {
		t.Fatalf("its worker's hello: %s, want it told the device was removed", answer)
	}
}

func TestDeviceLifecycleMCPAndExplicitDefault(t *testing.T) {
	f := newAssistantFixture(t)
	ctx := context.Background()
	pairOverHTTP(t, f.handler, f.alice, "retired-machine", "dev_retired")
	registerDeviceForTest(t, f.server, registrationBody("dev_retired", "ws_retired"))
	agent, err := f.server.store.GetPersonalAgent(ctx, f.aliceID)
	if err != nil {
		t.Fatal(err)
	}
	agent.Settings.PreferredDeviceID = "dev_retired"
	agent.Settings.Devices = []store.PersonalAgentDeviceSettings{{DeviceID: "dev_retired", AllowWork: true, AllowCreate: true}, {DeviceID: "dev_alice", AllowWork: true, AllowCreate: true}}
	if _, err = f.server.store.SavePersonalAgentSettings(ctx, agent.ID, agent.Settings); err != nil {
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
	// Then its data is purged: the workspace and its digests are gone.
	f.server.purgeRemovedDevices(ctx)
	if _, err := f.server.store.GetWorkspace(ctx, "ws_retired"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("the removed device's workspace: %v", err)
	}
	scope, err := f.server.assistant.ScopeFor(ctx, agent, f.conversation.ID, f.conversation.Input)
	if err != nil {
		t.Fatal(err)
	}
	args := map[string]json.RawMessage{"name": json.RawMessage(`"Retired default"`), "source": json.RawMessage(`{"kind":"empty"}`)}
	if _, err = f.server.assistant.RunTool(ctx, scope, "create_workspace", args); !errors.Is(err, store.ErrDeviceRemoved) {
		t.Fatalf("invalid default silently fell back: %v", err)
	}
	if err = f.server.runs.CheckPinned(ctx, store.PersonalAgentRunSnapshot{DeviceID: "dev_retired", WorkspaceID: "ws_retired"}); !errors.Is(err, store.ErrDeviceRemoved) {
		t.Fatalf("pinned removed runtime: %v", err)
	}
}
