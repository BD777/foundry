package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// The streamed transcript event carries the time the server stored, which is
// also the session's lastActivityAt: a live client and a fresh read agree,
// so the live one never takes its transcript for stale.
func TestStreamedSessionEventCarriesTheStoredTime(t *testing.T) {
	db := newTestStore(t)
	server := NewServer(db)
	viewer := subscribeForTest(server.stream)
	testServer := httptest.NewServer(server.Routes())
	defer testServer.Close()
	conn := dialDaemonForTest(t, testServer)
	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	writeWSForTest(t, conn, "hello", map[string]any{
		"device":    map[string]any{"id": "dev_at", "label": "At", "status": "connected", "lastSeenLabel": "online"},
		"workspace": map[string]any{"id": "ws_at", "name": "At", "localPath": t.TempDir()},
		"agents": []map[string]any{{
			"id": "agent_at", "workspaceId": "ws_at", "deviceId": "dev_at", "provider": "codex", "status": "healthy",
			"authMode": "local_config", "secretStored": "local", "configScope": "workspace", "configLabel": "local", "lastSeenLabel": "online",
		}},
	})
	readWSTypeForTest(t, conn, "registered")
	created := postJSONForTest(t, server, "/api/agent-sessions", `{"workspaceId":"ws_at","agentId":"agent_at","provider":"codex","prompt":"first"}`, http.StatusCreated)
	sessionID := created["id"].(string)
	var run struct {
		Session store.AgentSession `json:"session"`
	}
	readWSUntilForTest(t, conn, "run_session", &run)
	writeWSForTest(t, conn, "session_started", map[string]any{"sessionId": sessionID, "inputId": run.Session.Input.ID})
	skipToAckForTest(t, conn)
	writeWSForTest(t, conn, "session_event", map[string]any{"event": map[string]any{
		"id": "evt_at", "sessionId": sessionID, "label": "Response stream", "detail": "partial", "level": "info", "at": "2000-01-01T00:00:00Z",
	}})
	skipToAckForTest(t, conn)

	streamedAt := ""
	for len(viewer.C) > 0 && streamedAt == "" {
		_, envelope := frameForTest(t, <-viewer.C)
		if payload, ok := envelope["payload"].(map[string]any); ok && envelope["type"] == "agent_session_event" && payload["id"] == "evt_at" {
			streamedAt, _ = payload["at"].(string)
		}
	}
	if streamedAt == "" || streamedAt == "2000-01-01T00:00:00Z" {
		t.Fatalf("streamed at = %q, want the server's time", streamedAt)
	}
	var read struct {
		LastActivityAt string                    `json:"lastActivityAt"`
		Events         []store.AgentSessionEvent `json:"events"`
	}
	body := requestForTest(t, server, http.MethodGet, "/api/agent-sessions/"+sessionID+"?eventsLimit=10", "", http.StatusOK).Body.Bytes()
	if err := json.Unmarshal(body, &read); err != nil {
		t.Fatal(err)
	}
	storedAt := ""
	for _, event := range read.Events {
		if event.ID == "evt_at" {
			storedAt = event.At
		}
	}
	if storedAt != streamedAt || read.LastActivityAt != streamedAt {
		t.Fatalf("streamed %q, stored %q, lastActivityAt %q: want one time", streamedAt, storedAt, read.LastActivityAt)
	}
}
