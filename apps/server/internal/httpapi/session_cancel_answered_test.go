package httpapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// Stopping a turn that already answered ends only the background work it
// waited for: the device completes the session with the answer, and the
// server must not record it as canceled first.
func TestStoppingAnAnsweredTurnLeavesItsCompletionToTheDevice(t *testing.T) {
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

	stop := func(answer map[string]any) store.AgentSession {
		t.Helper()
		session, err := f.server.store.CreateAgentSession(context.Background(), store.CreateAgentSessionInput{
			AgentID: "agent_alice", WorkspaceID: "ws_alice", Provider: "claude", Prompt: "answer, then watch the build", Source: "agent",
			CreatedByUserID: f.aliceID,
		})
		if err != nil {
			t.Fatalf("create session: %v", err)
		}
		done := make(chan *httptest.ResponseRecorder, 1)
		go func() {
			done <- doAuthCall(t, f.handler, f.as(f.alice, http.MethodPost, "/api/agent-sessions/"+session.ID+"/cancel", ""))
		}()
		var request map[string]any
		id := readWSUntilForTest(t, conn, wsCancelSessionType, &request)
		if request["sessionId"] != session.ID {
			t.Fatalf("cancel request = %v", request)
		}
		answer["sessionId"] = session.ID
		writeWSIDForTest(t, conn, id, wsSessionCanceledType, answer)
		select {
		case recorder := <-done:
			expectStatus(t, recorder, http.StatusOK, "stop the session")
		case <-time.After(10 * time.Second):
			t.Fatal("the stop did not answer")
		}
		got, err := f.server.store.GetAgentSessionRecord(context.Background(), session.ID)
		if err != nil {
			t.Fatal(err)
		}
		return got
	}

	answered := stop(map[string]any{"answered": true})
	if answered.Status == "canceled" {
		t.Fatalf("an answered turn was recorded as canceled: %+v", answered)
	}
	writeWSForTest(t, conn, wsSessionCompleteType, map[string]any{
		"sessionId": answered.ID, "response": "Here is the answer.",
	})
	deadline := time.Now().Add(5 * time.Second)
	for {
		got, err := f.server.store.GetAgentSessionRecord(context.Background(), answered.ID)
		if err != nil {
			t.Fatal(err)
		}
		if got.Status == "completed" {
			if got.Response != "Here is the answer." {
				t.Fatalf("response = %q", got.Response)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("the device's completion was not recorded: %s", got.Status)
		}
		time.Sleep(20 * time.Millisecond)
	}

	if stopped := stop(map[string]any{}); stopped.Status != "canceled" {
		t.Fatalf("a turn without an answer stops as canceled, got %s", stopped.Status)
	}
}
