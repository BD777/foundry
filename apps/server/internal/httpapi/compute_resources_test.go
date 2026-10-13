package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/resources"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// A session runs commands on its person's other device unless the person
// turned remote commands off there (they are on by default); the server names the workspace
// folder (never the caller), the audit keeps the command and its outcome,
// and turning the permission off ends the lease.
func TestSessionRunsCommandsOnAnotherDevicesCompute(t *testing.T) {
	f := newReachFixture(t)
	ctx := context.Background()
	live := httptest.NewServer(f.handler)
	defer live.Close()
	session := func(user, workspace, agent string) string {
		created, err := f.db.CreateAgentSession(ctx, store.CreateAgentSessionInput{
			CreatedByUserID: user, WorkspaceID: workspace, AgentID: agent, Provider: "claude", Prompt: "run the tests",
		})
		if err != nil {
			t.Fatal(err)
		}
		token, err := f.db.MintAgentSessionToken(ctx, created.ID)
		if err != nil {
			t.Fatal(err)
		}
		return token
	}
	alice := session(f.aliceID, "ws_alice", "agent_alice")
	device := connectFakeDevice(t, live, f.aliceDevice, map[string]any{
		"capabilities": []string{store.DaemonCapabilityResources, store.DaemonCapabilityResourceOperations,
			store.DaemonCapabilityResourceCompute},
		"activeSessionIds": []string{},
		"device":           map[string]any{"id": "dev_alice", "label": "Alice's Mac", "status": "connected"},
		"workspace":        map[string]any{"id": "ws_alice", "name": "W", "localPath": "/tmp/ws_alice"},
	}, map[string]fakeAnswer{
		wsResourceSettingsType: func(payload json.RawMessage) (string, any) {
			var settings store.ResourceSourceSettings
			_ = json.Unmarshal(payload, &settings)
			return wsResourceSettingsAppliedType, settings
		},
		wsResourceResetType: func(payload json.RawMessage) (string, any) {
			var request store.ResourceResetRequest
			_ = json.Unmarshal(payload, &request)
			return wsResourceResetDoneType, store.ResourceResetResult{ResourceID: request.ResourceID, Generation: request.Generation}
		},
		wsResourceOperateType: func(payload json.RawMessage) (string, any) {
			var request store.ResourceOperateRequest
			_ = json.Unmarshal(payload, &request)
			results := []store.ResourceActionResult{}
			for _, action := range request.Actions {
				results = append(results, store.ResourceActionResult{Op: action.Op, OK: true, Text: `{"exitCode":0,"stdout":"ok"}`,
					Outcome: map[string]any{"exitCode": 0, "durationMs": 1200, "stdoutBytes": 2, "stderrBytes": 0}})
			}
			return wsResourceOperatedType, store.ResourceOperateResult{Results: results}
		},
	})
	ready := store.ResourceReadiness{Ready: true, Level: "configured"}
	if _, err := f.server.resources.Report(ctx, store.ResourceSource{Kind: "device", ID: "dev_alice", Label: "Alice's Mac"}, store.ResourcesReport{
		Instances: []store.DetectedResource{{Key: "compute", Type: "compute", Platform: "macos", Name: "Compute (10 CPUs, 16 GiB)",
			Detector: "compute@1", Readiness: ready, Backends: []store.ResourceBackend{{ID: "foundry-compute", Mode: "remote_ops", Readiness: ready}}}},
	}); err != nil {
		t.Fatal(err)
	}
	compute := resources.InstanceID("dev_alice", "compute")
	settingsPath := "/api/devices/dev_alice/resources/settings"

	// On by default; an explicit off keeps the session out.
	expectStatus(t, doAuthCall(t, f.handler, f.as(f.alice, http.MethodPut, settingsPath, `{"allowRemoteCommands":false}`)), http.StatusOK, "alice turns it off first")
	content, isError := mcpContentCall(t, f.handler, alice, "acquire_resource", map[string]any{"type": "compute", "deviceId": "dev_alice"})
	if !isError || !strings.Contains(content[0]["text"].(string), "Allow remote commands") {
		t.Fatalf("acquiring after the owner turned it off = %v", content)
	}
	expectStatus(t, doAuthCall(t, f.handler, f.as(f.bob, http.MethodPut, settingsPath, `{"allowRemoteCommands":true}`)), http.StatusNotFound, "bob allows commands on alice's Mac")
	expectStatus(t, doAuthCall(t, f.handler, authCall{method: http.MethodPut, path: settingsPath, body: `{"allowRemoteCommands":true}`,
		headers: map[string]string{"Authorization": "Bearer " + alice, "Content-Type": "application/json"}}), http.StatusForbidden, "a session allows itself")
	allowed := doAuthCall(t, f.handler, f.as(f.alice, http.MethodPut, settingsPath, `{"allowRemoteCommands":true}`))
	expectStatus(t, allowed, http.StatusOK, "alice allows remote commands")
	if body := allowed.Body.String(); !strings.Contains(body, `"applied":true`) {
		t.Fatalf("allowed = %s", body)
	}

	content, isError = mcpContentCall(t, f.handler, alice, "acquire_resource", map[string]any{"type": "compute", "deviceId": "dev_alice"})
	if isError || !strings.Contains(content[0]["text"].(string), "put_files") {
		t.Fatalf("acquire = %v", content)
	}
	var acquired struct {
		Lease resources.View `json:"lease"`
	}
	_ = json.Unmarshal([]byte(content[0]["text"].(string)), &acquired)

	// The caller's own folder is dropped; the server names the workspace's.
	content, isError = mcpContentCall(t, f.handler, alice, "operate_resource", map[string]any{
		"leaseId": acquired.Lease.ID, "op": "run",
		"args": map[string]any{"command": "pnpm test", "workspaceId": "ws_alice", "workspacePath": "/etc", "timeoutSec": 900,
			"env": map[string]any{"TOKEN": "secret"}},
	})
	if isError {
		t.Fatalf("run = %v", content)
	}
	var request store.ResourceOperateRequest
	_ = json.Unmarshal(device.received(wsResourceOperateType)[0], &request)
	if request.Type != "compute" || request.Backend != "foundry-compute" || request.Actions[0].Args["workspacePath"] != "/tmp/ws_alice" ||
		request.DeadlineMs < (900*time.Second).Milliseconds() {
		t.Fatalf("operate request = %+v", request)
	}
	if content, isError := mcpContentCall(t, f.handler, alice, "operate_resource", map[string]any{
		"leaseId": acquired.Lease.ID, "op": "run", "args": map[string]any{"argv": []string{"ls"}, "workspaceId": "ws_bob"},
	}); !isError || !strings.Contains(content[0]["text"].(string), "may work in") {
		t.Fatalf("a workspace the session may not work in = %v", content)
	}

	audit := doAuthCall(t, f.handler, f.as(f.alice, http.MethodGet, "/api/resources/"+compute+"/operations", ""))
	if body := audit.Body.String(); !strings.Contains(body, `"command":"pnpm test"`) || !strings.Contains(body, `"exitCode":0`) ||
		strings.Contains(body, "secret") || !strings.Contains(body, `"TOKEN"`) || !strings.Contains(body, `"bytesOut":2`) {
		t.Fatalf("audit = %s", body)
	}

	expectStatus(t, doAuthCall(t, f.handler, f.as(f.alice, http.MethodPut, settingsPath, `{"allowRemoteCommands":false}`)), http.StatusOK, "alice turns it off")
	content, isError = mcpContentCall(t, f.handler, alice, "operate_resource", map[string]any{"leaseId": acquired.Lease.ID, "op": "run", "args": map[string]any{"argv": []string{"ls"}}})
	if !isError || !strings.Contains(content[0]["text"].(string), "lease_ended") {
		t.Fatalf("running after the owner turned it off = %v", content)
	}
	settings := device.received(wsResourceSettingsType)
	if len(settings) < 2 || !strings.Contains(string(settings[len(settings)-1]), `"allowRemoteCommands":false`) {
		t.Fatalf("settings sent to the worker = %s", settings)
	}
}
