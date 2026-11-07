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
		"capabilities":     []string{},
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

// A session hands one compute lease to a command it runs (forCommands): the
// command token operates, reads and releases that lease and nothing else,
// and stops working once the lease ends.
func TestLeaseCommandTokenActsOnItsLeaseOnly(t *testing.T) {
	f := newReachFixture(t)
	ctx := context.Background()
	live := httptest.NewServer(f.handler)
	defer live.Close()
	chat, err := f.db.CreateAgentSession(ctx, store.CreateAgentSessionInput{
		CreatedByUserID: f.aliceID, WorkspaceID: "ws_alice", AgentID: "agent_alice", Provider: "claude", Prompt: "check on the Mac",
	})
	if err != nil {
		t.Fatal(err)
	}
	session, err := f.db.MintAgentSessionToken(ctx, chat.ID)
	if err != nil {
		t.Fatal(err)
	}
	connectFakeDevice(t, live, f.aliceDevice, map[string]any{
		"capabilities":     []string{},
		"activeSessionIds": []string{},
		"device":           map[string]any{"id": "dev_alice", "label": "Alice's Mac", "status": "connected"},
		"workspace":        map[string]any{"id": "ws_alice", "name": "W", "localPath": "/tmp/ws_alice"},
	}, map[string]fakeAnswer{
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
				results = append(results, store.ResourceActionResult{Op: action.Op, OK: true, Text: `{"exitCode":0,"stdout":"ok"}`})
			}
			return wsResourceOperatedType, store.ResourceOperateResult{Results: results}
		},
	})
	ready := store.ResourceReadiness{Ready: true, Level: "configured"}
	if _, err := f.server.resources.Report(ctx, store.ResourceSource{Kind: "device", ID: "dev_alice", Label: "Alice's Mac"}, store.ResourcesReport{
		Instances: []store.DetectedResource{{Key: "compute", Type: "compute", Platform: "macos", Name: "Compute",
			Detector: "compute@1", Readiness: ready, Backends: []store.ResourceBackend{{ID: "foundry-compute", Mode: "remote_ops", Readiness: ready}}},
			{Key: "computer_use/macos/console:501", Type: "computer_use", Platform: "macos", Name: "macOS screen control",
				Detector: "computer_use.macos.cua-driver@1", Readiness: ready,
				Backends: []store.ResourceBackend{{ID: "cua-driver", Version: "0.34.1", Mode: "remote_ops", Readiness: ready}}}},
	}); err != nil {
		t.Fatal(err)
	}

	// Without forCommands no command token is made.
	content, isError := mcpContentCall(t, f.handler, session, "acquire_resource", map[string]any{"type": "compute", "deviceId": "dev_alice"})
	if isError || strings.Contains(content[0]["text"].(string), "commandToken") {
		t.Fatalf("plain acquire = %v", content)
	}
	var first struct {
		Lease resources.View `json:"lease"`
	}
	_ = json.Unmarshal([]byte(content[0]["text"].(string)), &first)
	if _, isError := mcpContentCall(t, f.handler, session, "release_resource", map[string]any{"leaseId": first.Lease.ID}); isError {
		t.Fatal("release the plain lease")
	}

	content, isError = mcpContentCall(t, f.handler, session, "acquire_resource", map[string]any{"type": "compute", "deviceId": "dev_alice", "forCommands": true})
	if isError {
		t.Fatalf("acquire forCommands = %v", content)
	}
	var acquired struct {
		Lease        resources.View `json:"lease"`
		CommandToken string         `json:"commandToken"`
		Next         string         `json:"next"`
	}
	_ = json.Unmarshal([]byte(content[0]["text"].(string)), &acquired)
	command := acquired.CommandToken
	if command == "" || command == session || !strings.Contains(acquired.Next, "FOUNDRY_LEASE_TOKEN") {
		t.Fatalf("acquire forCommands = %s", content[0]["text"])
	}

	// It lists and calls only its lease's tools, on its lease.
	list := doAuthCall(t, f.handler, authCall{method: http.MethodPost, path: "/api/mcp", body: `{"jsonrpc":"2.0","id":1,"method":"tools/list"}`,
		headers: map[string]string{"Authorization": "Bearer " + command, "Content-Type": "application/json"}})
	var listed struct {
		Result struct {
			Tools []struct {
				Name string `json:"name"`
			} `json:"tools"`
		} `json:"result"`
	}
	_ = json.Unmarshal(list.Body.Bytes(), &listed)
	names := []string{}
	for _, tool := range listed.Result.Tools {
		names = append(names, tool.Name)
	}
	if strings.Join(names, ",") != "operate_resource,release_resource,resource_status" {
		t.Fatalf("a command token's tools = %v", names)
	}
	if content, isError := mcpContentCall(t, f.handler, command, "operate_resource", map[string]any{
		"leaseId": acquired.Lease.ID, "op": "run", "args": map[string]any{"command": "true"},
	}); isError {
		t.Fatalf("run through the command token = %v", content)
	}
	if content, isError := mcpContentCall(t, f.handler, command, "resource_status", map[string]any{"leaseId": acquired.Lease.ID}); isError {
		t.Fatalf("status through the command token = %v", content)
	}
	for tool, arguments := range map[string]map[string]any{
		"list_sessions":    {},
		"acquire_resource": {"type": "compute", "forCommands": true},
		"resource_status":  {"resourceId": acquired.Lease.ResourceID},
		"operate_resource": {"leaseId": first.Lease.ID, "op": "run", "args": map[string]any{"command": "true"}},
	} {
		if content, isError := mcpContentCall(t, f.handler, command, tool, arguments); !isError {
			t.Fatalf("%s %v through the command token = %v", tool, arguments, content)
		}
	}
	outside := doAuthCall(t, f.handler, authCall{method: http.MethodGet, path: "/api/chats?workspaceId=ws_alice",
		headers: map[string]string{"Authorization": "Bearer " + command}})
	expectStatus(t, outside, http.StatusForbidden, "a command token on another agent route")
	if !strings.Contains(outside.Body.String(), "command token") {
		t.Fatalf("refusal = %s", outside.Body.String())
	}
	expectStatus(t, doAuthCall(t, f.handler, authCall{method: http.MethodGet, path: "/api/chats?workspaceId=ws_alice",
		headers: map[string]string{"Authorization": "Bearer " + session}}), http.StatusOK, "the session's own token on that route")

	// forCommands hands over one compute lease, not a screen.
	if content, isError := mcpContentCall(t, f.handler, session, "acquire_resource", map[string]any{"type": "computer_use", "forCommands": true}); !isError ||
		!strings.Contains(content[0]["text"].(string), "forCommands") {
		t.Fatalf("forCommands on a screen = %v", content)
	}

	// Releasing ends it; so does the lease ending any other way.
	if content, isError := mcpContentCall(t, f.handler, command, "release_resource", map[string]any{"leaseId": acquired.Lease.ID}); isError {
		t.Fatalf("release through the command token = %v", content)
	}
	if content, isError := mcpContentCall(t, f.handler, command, "operate_resource", map[string]any{
		"leaseId": acquired.Lease.ID, "op": "run", "args": map[string]any{"command": "true"},
	}); !isError || !strings.Contains(content[0]["text"].(string), "has ended") {
		t.Fatalf("run after the lease ended = %v", content)
	}
	// The session's own token is unchanged.
	if content, isError := mcpContentCall(t, f.handler, session, "list_sessions", map[string]any{}); isError {
		t.Fatalf("the session's own token = %v", content)
	}
}
