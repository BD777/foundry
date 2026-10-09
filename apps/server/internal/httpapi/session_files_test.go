package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// readWSUntilForTest skips envelopes the test does not answer (a queued
// session's dispatch, heartbeats) until the expected type arrives.
func readWSUntilForTest(t *testing.T, conn *websocket.Conn, expectedType string, payload any) string {
	t.Helper()
	for {
		var envelope struct {
			ID      string          `json:"id"`
			Type    string          `json:"type"`
			Payload json.RawMessage `json:"payload"`
		}
		if err := conn.ReadJSON(&envelope); err != nil {
			t.Fatalf("read websocket %s: %v", expectedType, err)
		}
		if envelope.Type != expectedType {
			continue
		}
		if err := json.Unmarshal(envelope.Payload, payload); err != nil {
			t.Fatalf("decode websocket payload %s: %v", expectedType, err)
		}
		return envelope.ID
	}
}

func TestSessionFileReadsFollowTheFileOrigin(t *testing.T) {
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
		AgentID: "agent_alice", WorkspaceID: "ws_alice", Provider: "claude", Prompt: "write reports", Source: "chat",
		CreatedByUserID: f.aliceID,
	})
	if err != nil {
		t.Fatalf("create session: %v", err)
	}

	read := func(caller, path string, answer map[string]any) *httptest.ResponseRecorder {
		t.Helper()
		done := make(chan *httptest.ResponseRecorder, 1)
		go func() {
			done <- doAuthCall(t, f.handler, f.as(caller, http.MethodGet,
				"/api/agent-sessions/"+session.ID+"/files/read?path="+url.QueryEscape(path), ""))
		}()
		if answer != nil {
			var request wsReadSessionFilePayload
			id := readWSUntilForTest(t, conn, wsReadSessionFileType, &request)
			if request.SessionID != session.ID || request.WorkspaceID != "ws_alice" || request.Path != path {
				t.Errorf("relayed request = %+v", request)
			}
			writeWSIDForTest(t, conn, id, wsSessionFileReadType, answer)
		}
		select {
		case recorder := <-done:
			return recorder
		case <-time.After(10 * time.Second):
			t.Fatalf("read %s did not answer", path)
			return nil
		}
	}
	file := func(path, origin string, inside bool) map[string]any {
		return map[string]any{
			"sessionId": session.ID, "path": path, "origin": origin, "insideWorkspace": inside,
			"kind": "text", "content": "# Report", "truncated": false, "changedSinceRecorded": false,
		}
	}

	// Not shared yet: the session is not found, and the device is not asked.
	expectStatus(t, read(f.bob, "/tmp/out/report.md", nil), http.StatusNotFound, "stranger reads a session file")

	ownership := f.server.store.(store.OwnershipStore)
	if err := ownership.SetWorkspaceMember(context.Background(), "ws_alice", f.bobID, store.WorkspaceRoleViewer, f.aliceID); err != nil {
		t.Fatal(err)
	}
	toolFile := read(f.bob, "/tmp/out/report.md", file("/tmp/out/report.md", "tool", false))
	expectStatus(t, toolFile, http.StatusOK, "viewer reads a file the tools wrote")
	if toolFile.Header().Get("Cache-Control") != "no-store" || !strings.Contains(toolFile.Body.String(), "# Report") {
		t.Fatalf("tool file response %v %s", toolFile.Header(), toolFile.Body.String())
	}
	expectStatus(t, read(f.bob, "/tmp/w/notes.md", file("/tmp/w/notes.md", "reference", true)),
		http.StatusOK, "viewer reads a named file inside the workspace")
	named := read(f.bob, "/tmp/elsewhere/named.md", file("/tmp/elsewhere/named.md", "reference", false))
	expectStatus(t, named, http.StatusForbidden, "viewer reads a named file outside the workspace")
	if strings.Contains(named.Body.String(), "# Report") || named.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("a refused read must not leak content: %v %s", named.Header(), named.Body.String())
	}
	refused := read(f.bob, "/tmp/never.md", map[string]any{
		"sessionId": session.ID, "path": "/tmp/never.md", "origin": "tool", "insideWorkspace": false,
		"kind": "missing", "truncated": false, "changedSinceRecorded": false,
		"error": "This file is not one this chat's tools wrote or its answers named.",
	})
	expectStatus(t, refused, http.StatusNotFound, "a path outside the ledger")
	if !strings.Contains(refused.Body.String(), "not one this chat") {
		t.Fatalf("refusal body %s", refused.Body.String())
	}

	if err := ownership.SetWorkspaceMember(context.Background(), "ws_alice", f.bobID, store.WorkspaceRoleMember, f.aliceID); err != nil {
		t.Fatal(err)
	}
	expectStatus(t, read(f.bob, "/tmp/elsewhere/named.md", file("/tmp/elsewhere/named.md", "reference", false)),
		http.StatusOK, "member reads a named file outside the workspace")
	expectStatus(t, read(f.alice, "/tmp/elsewhere/named.md", file("/tmp/elsewhere/named.md", "reference", false)),
		http.StatusOK, "owner reads a named file outside the workspace")
}

func TestSessionFileReadRuleIsDeclared(t *testing.T) {
	server, _ := newAccountsTestServer(t)
	for _, route := range server.routeTable() {
		if route.pattern == "GET /api/agent-sessions/{id}/files/read" {
			if route.rule.kind != "workspace:"+store.WorkspaceRoleViewer {
				t.Fatalf("session file read rule = %q, want workspace:viewer (Member enforced in handler)", route.rule.kind)
			}
			return
		}
	}
	t.Fatal("GET /api/agent-sessions/{id}/files/read is not registered")
}
