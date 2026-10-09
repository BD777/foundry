package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func TestBackgroundTaskRoutesNeedMembers(t *testing.T) {
	server, _ := newAccountsTestServer(t)
	want := map[string]bool{
		"GET /api/agent-sessions/{id}/background-tasks/{taskId}/output": false,
		"POST /api/agent-sessions/{id}/background-tasks/{taskId}/stop":  false,
	}
	for _, route := range server.routeTable() {
		if _, ok := want[route.pattern]; !ok {
			continue
		}
		want[route.pattern] = true
		if route.rule.kind != "workspace:"+store.WorkspaceRoleMember {
			t.Errorf("%s rule = %q, want workspace:member", route.pattern, route.rule.kind)
		}
	}
	for pattern, found := range want {
		if !found {
			t.Errorf("%s is not registered", pattern)
		}
	}
}

func TestBackgroundTaskOutputAndStopFollowRoles(t *testing.T) {
	f := newIsolationFixture(t)
	live := httptest.NewServer(f.handler)
	defer live.Close()
	headers := http.Header{}
	headers.Set(deviceCredentialHeader, f.aliceDevice)
	conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(live.URL, "http")+"/api/daemon/ws", headers)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.Close()
	_ = conn.SetReadDeadline(time.Now().Add(10 * time.Second))
	writeWSForTest(t, conn, "hello", map[string]any{
		"device":         map[string]any{"id": "dev_alice", "label": "Alice's laptop", "status": "connected", "lastSeenLabel": "online"},
		"workspace":      map[string]any{"id": "ws_alice", "name": "W", "localPath": "/tmp/w", "baseline": "main", "contextSummary": "", "acceptedCount": 0, "resolvedCount": 0},
		"providerHealth": []map[string]any{},
		"assets":         []map[string]any{},
		"agents": []map[string]any{{
			"id": "agent_alice", "workspaceId": "ws_alice", "deviceId": "dev_alice", "deviceLabel": "Alice's laptop",
			"provider": "claude", "status": "healthy", "authMode": "local_config", "secretStored": "local",
			"configScope": "workspace", "configLabel": "device local login", "lastSeenLabel": "online",
		}},
	})
	readWSTypeForTest(t, conn, "registered")
	session, err := f.server.store.CreateAgentSession(context.Background(), store.CreateAgentSessionInput{
		AgentID: "agent_alice", WorkspaceID: "ws_alice", Provider: "claude", Prompt: "run the suite in the background", Source: "chat",
		CreatedByUserID: f.aliceID,
	})
	if err != nil {
		t.Fatalf("create session: %v", err)
	}

	call := func(caller, method, path, requestType, answerType string, answer map[string]any) *httptest.ResponseRecorder {
		t.Helper()
		done := make(chan *httptest.ResponseRecorder, 1)
		go func() { done <- doAuthCall(t, f.handler, f.as(caller, method, path, "")) }()
		if answer != nil {
			var request map[string]any
			id := readWSUntilForTest(t, conn, requestType, &request)
			if request["sessionId"] != session.ID || request["taskId"] != "b7qp2" || request["workspaceId"] != "ws_alice" {
				t.Errorf("relayed request = %v", request)
			}
			if _, ok := request["path"]; ok {
				t.Errorf("a background task request must name the task, not a path: %v", request)
			}
			writeWSIDForTest(t, conn, id, answerType, answer)
		}
		select {
		case recorder := <-done:
			return recorder
		case <-time.After(10 * time.Second):
			t.Fatalf("%s %s did not answer", method, path)
			return nil
		}
	}
	outputPath := "/api/agent-sessions/" + session.ID + "/background-tasks/b7qp2/output"
	stopPath := "/api/agent-sessions/" + session.ID + "/background-tasks/b7qp2/stop"
	output := map[string]any{
		"sessionId": session.ID, "taskId": "b7qp2", "command": "npm test", "content": "ok 12 tests\n",
		"truncated": false, "bytes": 12, "kind": "text",
	}

	ownership := f.server.store.(store.OwnershipStore)
	if err := ownership.SetWorkspaceMember(context.Background(), "ws_alice", f.bobID, store.WorkspaceRoleViewer, f.aliceID); err != nil {
		t.Fatal(err)
	}
	expectStatus(t, call(f.bob, http.MethodGet, outputPath, "", "", nil), http.StatusForbidden, "viewer reads background output")
	expectStatus(t, call(f.bob, http.MethodPost, stopPath, "", "", nil), http.StatusForbidden, "viewer stops background work")

	if err := ownership.SetWorkspaceMember(context.Background(), "ws_alice", f.bobID, store.WorkspaceRoleMember, f.aliceID); err != nil {
		t.Fatal(err)
	}
	read := call(f.bob, http.MethodGet, outputPath, wsReadBackgroundTaskOutputType, wsBackgroundTaskOutputReadType, output)
	expectStatus(t, read, http.StatusOK, "member reads background output")
	if read.Header().Get("Cache-Control") != "no-store" || !strings.Contains(read.Body.String(), "ok 12 tests") || !strings.Contains(read.Body.String(), "npm test") {
		t.Fatalf("output response %v %s", read.Header(), read.Body.String())
	}
	refused := call(f.bob, http.MethodGet, outputPath, wsReadBackgroundTaskOutputType, wsBackgroundTaskOutputReadType, map[string]any{
		"sessionId": session.ID, "taskId": "b7qp2", "content": "", "truncated": false, "bytes": 0, "kind": "missing",
		"error": "This background task is not one of this chat's.",
	})
	expectStatus(t, refused, http.StatusNotFound, "a task the session does not have")
	expectStatus(t, call(f.bob, http.MethodGet, "/api/agent-sessions/"+session.ID+"/background-tasks/..%2Fetc/output", "", "", nil),
		http.StatusBadRequest, "a task id that is not one")

	// Members control their own sessions; alice's needs its owner or a maintainer.
	expectStatus(t, call(f.bob, http.MethodPost, stopPath, "", "", nil), http.StatusForbidden, "member stops another member's background work")
	expectStatus(t, call(f.alice, http.MethodPost, stopPath, wsStopBackgroundTaskType, wsBackgroundTaskStoppedType,
		map[string]any{"sessionId": session.ID, "taskId": "b7qp2"}), http.StatusOK, "owner stops background work")
	notRunning := call(f.alice, http.MethodPost, stopPath, wsStopBackgroundTaskType, wsBackgroundTaskStoppedType,
		map[string]any{"sessionId": session.ID, "taskId": "b7qp2", "error": "This background task is not running."})
	expectStatus(t, notRunning, http.StatusConflict, "stop a task that ended")
	if !strings.Contains(notRunning.Body.String(), "not running") {
		t.Fatalf("stop refusal body %s", notRunning.Body.String())
	}
}

// Snapshots replace earlier ones: an empty one must survive storage, or the
// last timer or task would never disappear.
func TestEmptySnapshotsSurviveEncoding(t *testing.T) {
	var event store.AgentSessionEvent
	if err := json.Unmarshal([]byte(`{"id":"e","sessionId":"s","label":"Background tasks updated","detail":"","level":"info","metadata":{"backgroundTaskSnapshot":[],"timerSnapshot":[]}}`), &event); err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(event)
	if err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{`"backgroundTaskSnapshot":[]`, `"timerSnapshot":[]`} {
		if !strings.Contains(string(encoded), key) {
			t.Errorf("%s lost in %s", key, encoded)
		}
	}
	var bare store.AgentSessionEvent
	if err := json.Unmarshal([]byte(`{"id":"e","sessionId":"s","label":"Thinking","detail":"","level":"info","metadata":{"taskId":"t"}}`), &bare); err != nil {
		t.Fatal(err)
	}
	encoded, _ = json.Marshal(bare)
	if strings.Contains(string(encoded), "Snapshot") {
		t.Errorf("an event without snapshots gained one: %s", encoded)
	}
}
