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

	"github.com/foundry-dev/foundry/apps/server/internal/browserevent"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// connectAliceDeviceForTest opens alice's device socket and says hello.
func connectAliceDeviceForTest(t *testing.T, f isolationFixture, live *httptest.Server) *websocket.Conn {
	t.Helper()
	headers := http.Header{}
	headers.Set(deviceCredentialHeader, f.aliceDevice)
	conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(live.URL, "http")+"/api/daemon/ws", headers)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	t.Cleanup(func() { conn.Close() })
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
	return conn
}

func TestFollowedBackgroundOutputIsReadOnwardAndToldWhenItGrows(t *testing.T) {
	f := newIsolationFixture(t)
	live := httptest.NewServer(f.handler)
	defer live.Close()
	conn := connectAliceDeviceForTest(t, f, live)
	session, err := f.server.store.CreateAgentSession(context.Background(), store.CreateAgentSessionInput{
		AgentID: "agent_alice", WorkspaceID: "ws_alice", Provider: "claude", Prompt: "watch the build", Source: "chat",
		CreatedByUserID: f.aliceID,
	})
	if err != nil {
		t.Fatalf("create session: %v", err)
	}
	viewer := subscribeForTest(f.server.stream)

	outputPath := "/api/agent-sessions/" + session.ID + "/background-tasks/b7qp2/output"
	done := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		done <- doAuthCall(t, f.handler, f.as(f.alice, http.MethodGet, outputPath+"?after=120&follow=1", ""))
	}()
	var request map[string]any
	id := readWSUntilForTest(t, conn, wsReadBackgroundTaskOutputType, &request)
	if request["after"] != float64(120) || request["follow"] != true || request["taskId"] != "b7qp2" {
		t.Fatalf("relayed read = %v", request)
	}
	writeWSIDForTest(t, conn, id, wsBackgroundTaskOutputReadType, map[string]any{
		"sessionId": session.ID, "taskId": "b7qp2", "content": "step 3\nstep", "truncated": false, "bytes": 131,
		"kind": "text", "from": 120, "lineEnd": 127, "stable": 7, "following": true,
	})
	read := <-done
	expectStatus(t, read, http.StatusOK, "continued read")
	var output store.AgentBackgroundTaskOutput
	if err := json.Unmarshal(read.Body.Bytes(), &output); err != nil {
		t.Fatal(err)
	}
	if output.From == nil || *output.From != 120 || output.LineEnd == nil || *output.LineEnd != 127 ||
		output.Stable == nil || *output.Stable != 7 || !output.Following {
		t.Fatalf("continued read answer = %s", read.Body.String())
	}
	expectStatus(t, doAuthCall(t, f.handler, f.as(f.alice, http.MethodGet, outputPath+"?after=-1", "")),
		http.StatusBadRequest, "an offset no read returned")

	// The device tells growth; another session's (or no session's) is not told,
	// and the notice leaves cached workspace data current.
	revision := f.server.stream.Revision()
	writeWSForTest(t, conn, wsBackgroundTaskOutputChangedType, map[string]any{"sessionId": "sess_unknown", "taskId": "b7qp2"})
	writeWSForTest(t, conn, wsBackgroundTaskOutputChangedType, map[string]any{"sessionId": session.ID, "taskId": "b7qp2"})
	notice := nextStreamedForTest(t, viewer, browserevent.BackgroundTaskOutputChanged)
	if got := payloadForTest[browserevent.BackgroundTaskOutputChangedPayload](t, notice); got != (browserevent.BackgroundTaskOutputChangedPayload{WorkspaceID: "ws_alice", SessionID: session.ID, TaskID: "b7qp2"}) {
		t.Fatalf("growth notice = %s", notice.payload)
	}
	if f.server.stream.Revision() != revision {
		t.Fatal("a growth notice made cached workspace data stale")
	}
}

func TestIssueEnvironmentStatusAsksForChangesAndTellsThemToItsWorkspace(t *testing.T) {
	f := newIsolationFixture(t)
	live := httptest.NewServer(f.handler)
	defer live.Close()
	conn := connectAliceDeviceForTest(t, f, live)
	viewer := subscribeForTest(f.server.stream)

	done := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		done <- doAuthCall(t, f.handler, f.as(f.alice, http.MethodGet, "/api/issues/"+f.aliceIssue+"/environment", ""))
	}()
	var request map[string]any
	id := readWSUntilForTest(t, conn, wsIssueEnvironmentType, &request)
	if request["action"] != "status" || request["notifyChanges"] != true {
		t.Fatalf("status request = %v", request)
	}
	writeWSIDForTest(t, conn, id, wsIssueEnvironmentResultType, map[string]any{
		"status": "ok", "revision": 0, "environment": map[string]any{"status": "review", "repositories": []any{}}, "notifiesChanges": true,
	})
	read := <-done
	expectStatus(t, read, http.StatusOK, "environment status")
	if !strings.Contains(read.Body.String(), `"notifiesChanges":true`) {
		t.Fatalf("status answer = %s", read.Body.String())
	}

	// Only workspaces the device serves are told.
	writeWSForTest(t, conn, wsIssueEnvironmentChangedType, map[string]any{"workspaceId": "ws_bob"})
	writeWSForTest(t, conn, wsIssueEnvironmentChangedType, map[string]any{"issueId": "issue_unknown"})
	writeWSForTest(t, conn, wsIssueEnvironmentChangedType, map[string]any{"issueId": f.aliceIssue})
	notice := nextStreamedForTest(t, viewer, browserevent.IssueEnvironmentChanged)
	if got := payloadForTest[browserevent.IssueEnvironmentChangedPayload](t, notice); got != (browserevent.IssueEnvironmentChangedPayload{WorkspaceID: "ws_alice", IssueID: f.aliceIssue}) {
		t.Fatalf("environment notice = %s", notice.payload)
	}
	writeWSForTest(t, conn, wsIssueEnvironmentChangedType, map[string]any{"workspaceId": "ws_alice"})
	notice = nextStreamedForTest(t, viewer, browserevent.IssueEnvironmentChanged)
	if got := payloadForTest[browserevent.IssueEnvironmentChangedPayload](t, notice); got != (browserevent.IssueEnvironmentChangedPayload{WorkspaceID: "ws_alice"}) {
		t.Fatalf("workspace-wide notice = %s", notice.payload)
	}
}
