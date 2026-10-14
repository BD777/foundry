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

// mcpContentCall calls a Foundry tool with a session token and answers
// every content block.
func mcpContentCall(t *testing.T, handler http.Handler, token, tool string, arguments any) ([]map[string]any, bool) {
	t.Helper()
	params, _ := json.Marshal(map[string]any{"name": tool, "arguments": arguments})
	request := httptest.NewRequest(http.MethodPost, "/api/mcp", strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":`+string(params)+`}`))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Authorization", "Bearer "+token)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	var envelope struct {
		Result struct {
			Content []map[string]any `json:"content"`
			IsError bool             `json:"isError"`
		} `json:"result"`
		Error *struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &envelope); err != nil {
		t.Fatalf("%s: %d %s", tool, response.Code, response.Body.String())
	}
	if envelope.Error != nil {
		return []map[string]any{{"type": "text", "text": envelope.Error.Message}}, true
	}
	return envelope.Result.Content, envelope.Result.IsError
}

// A session leases its person's Mac screen, operates it through the Mac's
// worker and gets the screenshot as image content; the person sees the
// operation in the audit and takes the screen back; the session is then
// refused and told why. Another person's session never sees the screen.
func TestSessionLeasesAndOperatesAScreen(t *testing.T) {
	f := newReachFixture(t)
	ctx := context.Background()
	live := httptest.NewServer(f.handler)
	defer live.Close()
	// The sessions exist before the Mac's worker says hello again.
	session := func(user, workspace, agent string) string {
		created, err := f.db.CreateAgentSession(ctx, store.CreateAgentSessionInput{
			CreatedByUserID: user, WorkspaceID: workspace, AgentID: agent, Provider: "claude", Prompt: "use the Mac",
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
	bob := session(f.bobID, "ws_bob", "agent_bob")
	device := connectFakeDevice(t, live, f.aliceDevice, map[string]any{
		"capabilities":     []string{store.DaemonCapabilityResources, store.DaemonCapabilityResourceOperations},
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
				result := store.ResourceActionResult{Op: action.Op, OK: true, Text: "window_id=2 pid=1 size=640x400"}
				if action.Op == "screenshot" {
					result.Images = []store.ResourceImage{{Data: "/9j/4AAQ", MimeType: "image/jpeg", Width: 640, Height: 400, Scale: 1, FrameID: "snap_1"}}
				}
				results = append(results, result)
			}
			return wsResourceOperatedType, store.ResourceOperateResult{Results: results, Opened: true}
		},
	})
	ready := store.ResourceReadiness{Ready: true, Level: "permitted"}
	if _, err := f.server.resources.Report(ctx, store.ResourceSource{Kind: "device", ID: "dev_alice", Label: "Alice's Mac"}, store.ResourcesReport{
		Instances: []store.DetectedResource{{Key: "computer_use/macos/console:501", Type: "computer_use", Platform: "macos", Name: "macOS screen control",
			Detector: "computer_use.macos.cua-driver@1", Readiness: ready,
			Backends: []store.ResourceBackend{{ID: "cua-driver", Version: "0.34.1", Mode: "remote_ops", Readiness: ready}}}},
	}); err != nil {
		t.Fatal(err)
	}
	screen := resources.InstanceID("dev_alice", "computer_use/macos/console:501")

	if content, isError := mcpContentCall(t, f.handler, bob, "acquire_resource", map[string]any{"resourceId": screen}); !isError || !strings.Contains(content[0]["text"].(string), "not found") {
		t.Fatalf("bob acquiring alice's screen = %v", content)
	}
	content, isError := mcpContentCall(t, f.handler, alice, "acquire_resource", map[string]any{"type": "computer_use", "reason": "check Finder"})
	if isError {
		t.Fatalf("acquire = %v", content)
	}
	var acquired struct {
		Lease    resources.View `json:"lease"`
		Resource struct {
			ID         string   `json:"id"`
			Operations []string `json:"operations"`
		} `json:"resource"`
	}
	if err := json.Unmarshal([]byte(content[0]["text"].(string)), &acquired); err != nil || acquired.Lease.State != store.LeaseActive || acquired.Resource.ID != screen || len(acquired.Resource.Operations) == 0 {
		t.Fatalf("acquired = %+v (%v)", acquired, err)
	}

	content, isError = mcpContentCall(t, f.handler, alice, "operate_resource", map[string]any{
		"leaseId": acquired.Lease.ID, "op": "type_text", "args": map[string]any{"text": "secret words", "pid": 1, "window_id": 2}, "screenshotAfter": true,
	})
	if isError || len(content) != 2 || content[1]["type"] != "image" || content[1]["mimeType"] != "image/jpeg" || content[1]["data"] != "/9j/4AAQ" {
		t.Fatalf("operate content = %v", content)
	}
	operated := device.received(wsResourceOperateType)
	var request store.ResourceOperateRequest
	_ = json.Unmarshal(operated[0], &request)
	if request.Generation != 1 || request.Backend != "cua-driver" || len(request.Actions) != 2 || request.Actions[1].Op != "screenshot" || request.Actions[1].Args["window_id"] != float64(2) {
		t.Fatalf("operate request = %+v", request)
	}
	if text, _ := mcpContentCall(t, f.handler, alice, "operate_resource", map[string]any{"leaseId": acquired.Lease.ID, "op": "format_disk"}); !strings.Contains(text[0]["text"].(string), "no operation") {
		t.Fatalf("an unknown operation = %v", text)
	}

	audit := doAuthCall(t, f.handler, f.as(f.alice, http.MethodGet, "/api/resources/"+screen+"/operations", ""))
	expectStatus(t, audit, http.StatusOK, "alice reads the audit")
	if body := audit.Body.String(); !strings.Contains(body, `"textLength":12`) || strings.Contains(body, "secret words") || !strings.Contains(body, `"op":"screenshot"`) {
		t.Fatalf("audit = %s", body)
	}
	expectStatus(t, doAuthCall(t, f.handler, f.as(f.bob, http.MethodGet, "/api/resources/"+screen+"/operations", "")), http.StatusNotFound, "bob reads alice's audit")
	expectStatus(t, doAuthCall(t, f.handler, f.as(f.bob, http.MethodPost, "/api/resources/"+screen+"/release", "")), http.StatusNotFound, "bob releases alice's screen")
	agentRelease := doAuthCall(t, f.handler, authCall{method: http.MethodPost, path: "/api/resources/" + screen + "/release",
		headers: map[string]string{"Authorization": "Bearer " + alice}})
	expectStatus(t, agentRelease, http.StatusForbidden, "a session token releasing through the person's route")

	listed := doAuthCall(t, f.handler, f.as(f.alice, http.MethodGet, "/api/resources?type=computer_use", ""))
	if !strings.Contains(listed.Body.String(), `"state":"busy"`) || !strings.Contains(listed.Body.String(), acquired.Lease.ID) {
		t.Fatalf("listing = %s", listed.Body.String())
	}
	expectStatus(t, doAuthCall(t, f.handler, f.as(f.alice, http.MethodPost, "/api/resources/"+screen+"/release", "")), http.StatusOK, "alice takes her screen back")

	content, isError = mcpContentCall(t, f.handler, alice, "operate_resource", map[string]any{"leaseId": acquired.Lease.ID, "op": "screenshot"})
	if !isError || !strings.Contains(content[0]["text"].(string), "lease_ended") {
		t.Fatalf("operating after the person released = %v", content)
	}
	if len(content) != 2 || !strings.Contains(content[1]["text"].(string), "the person released it") {
		t.Fatalf("the holder is not told why: %v", content)
	}
	deadline := time.Now().Add(5 * time.Second)
	for len(device.received(wsResourceResetType)) < 2 {
		if time.Now().After(deadline) {
			t.Fatal("the Mac was never reset after the release")
		}
		time.Sleep(10 * time.Millisecond)
	}
	status, _ := mcpContentCall(t, f.handler, alice, "resource_status", map[string]any{"resourceId": screen})
	if text := status[0]["text"].(string); !strings.Contains(text, `"recent"`) || strings.Contains(text, "secret words") {
		t.Fatalf("status = %s", text)
	}
}

// A model turn the agent runs on its own (Claude's follow-up after
// background work, a timer's) leaves the session "completed"; its worker
// tells it (session_turn) to a server that takes it, and the leases follow
// it: acquired in it, a screen is active; once it ended, parked.
func TestAgentTurnKeepsLeaseActive(t *testing.T) {
	if !strings.Contains(string(registeredEnvelope("r").Payload), `"`+sessionTurnsFeature+`"`) {
		t.Fatal("the registered answer does not say the server takes session_turn")
	}
	f := newReachFixture(t)
	ctx := context.Background()
	live := httptest.NewServer(f.handler)
	defer live.Close()
	created, err := f.db.CreateAgentSession(ctx, store.CreateAgentSessionInput{
		CreatedByUserID: f.aliceID, WorkspaceID: "ws_alice", AgentID: "agent_alice", Provider: "claude", Prompt: "wait for the build",
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.StartAgentSession(ctx, created.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.CompleteAgentSession(ctx, created.ID, "started the build", ""); err != nil {
		t.Fatal(err)
	}
	token, err := f.db.MintAgentSessionToken(ctx, created.ID)
	if err != nil {
		t.Fatal(err)
	}
	device := connectFakeDevice(t, live, f.aliceDevice, map[string]any{
		"capabilities":     []string{store.DaemonCapabilityResources, store.DaemonCapabilityResourceOperations},
		"activeSessionIds": []string{},
		"device":           map[string]any{"id": "dev_alice", "label": "Alice's Mac", "status": "connected"},
		"workspace":        map[string]any{"id": "ws_alice", "name": "W", "localPath": "/tmp/ws_alice"},
	}, map[string]fakeAnswer{
		wsResourceResetType: func(payload json.RawMessage) (string, any) {
			var request store.ResourceResetRequest
			_ = json.Unmarshal(payload, &request)
			return wsResourceResetDoneType, store.ResourceResetResult{ResourceID: request.ResourceID, Generation: request.Generation}
		},
	})
	ready := store.ResourceReadiness{Ready: true, Level: "permitted"}
	if _, err := f.server.resources.Report(ctx, store.ResourceSource{Kind: "device", ID: "dev_alice", Label: "Alice's Mac"}, store.ResourcesReport{
		Instances: []store.DetectedResource{{Key: "computer_use/macos/console:501", Type: "computer_use", Platform: "macos", Name: "macOS screen control",
			Detector: "computer_use.macos.cua-driver@1", Readiness: ready,
			Backends: []store.ResourceBackend{{ID: "cua-driver", Version: "0.34.1", Mode: "remote_ops", Readiness: ready}}}},
	}); err != nil {
		t.Fatal(err)
	}
	screen := resources.InstanceID("dev_alice", "computer_use/macos/console:501")

	device.tell(t, wsSessionTurnType, map[string]any{"sessionId": created.ID, "running": true})
	content, isError := mcpContentCall(t, f.handler, token, "acquire_resource", map[string]any{"resourceId": screen, "reason": "check the build window"})
	if isError {
		t.Fatalf("acquire = %v", content)
	}
	var acquired struct {
		Lease resources.View `json:"lease"`
	}
	if err := json.Unmarshal([]byte(content[0]["text"].(string)), &acquired); err != nil || acquired.Lease.State != store.LeaseActive {
		t.Fatalf("acquired in the agent's own turn = %+v (%v)", acquired, err)
	}
	device.tell(t, wsSessionTurnType, map[string]any{"sessionId": created.ID, "running": false})
	lease, err := f.server.leases.Lease(ctx, acquired.Lease.ID)
	if err != nil || lease.State != store.LeaseParked {
		t.Fatalf("after the agent's own turn = %+v (%v)", lease, err)
	}
}
