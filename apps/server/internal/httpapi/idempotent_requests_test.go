package httpapi

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// A queued chat item is sent again after a reload with its Idempotency-Key:
// the same key and body returns the original result without a second
// session or input; the same key with another body is refused.
func TestSessionSendsReplayByIdempotencyKey(t *testing.T) {
	backing := newEmptyTestStore(t)
	ctx := context.Background()
	if err := backing.RegisterDaemon(ctx, store.DaemonRegistration{
		Device:    store.DeviceProjection{ID: "dev_idem", Label: "Idem Device", Status: "connected", LastSeenLabel: "online"},
		Workspace: store.WorkspaceProjection{ID: "ws_idem", Name: "Idem", LocalPath: t.TempDir(), Baseline: "main"},
		Agents: []store.AgentProjection{{
			ID: "agent_idem_claude", WorkspaceID: "ws_idem", DeviceID: "dev_idem", DeviceLabel: "Idem Device",
			Provider: "claude", Status: "healthy", AuthMode: "local_config", SecretStored: "local",
			ConfigScope: "workspace", ConfigLabel: "device local login", LastSeenLabel: "online",
		}},
	}); err != nil {
		t.Fatalf("register daemon seed: %v", err)
	}
	testServer := httptest.NewServer(NewServer(backing).Routes())
	defer testServer.Close()
	conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(testServer.URL, "http")+"/api/daemon/ws", nil)
	if err != nil {
		t.Fatalf("dial daemon websocket: %v", err)
	}
	defer conn.Close()
	if err := conn.SetReadDeadline(time.Now().Add(5 * time.Second)); err != nil {
		t.Fatal(err)
	}
	writeWSForTest(t, conn, "hello", map[string]any{
		"device":         map[string]any{"id": "dev_idem", "label": "Idem Device", "status": "connected", "lastSeenLabel": "online"},
		"workspace":      map[string]any{"id": "ws_idem", "name": "Idem", "localPath": t.TempDir(), "baseline": "main"},
		"providerHealth": []map[string]any{},
		"assets":         []map[string]any{},
		"agents": []map[string]any{{
			"id": "agent_idem_claude", "workspaceId": "ws_idem", "deviceId": "dev_idem", "deviceLabel": "Idem Device",
			"provider": "claude", "status": "healthy", "authMode": "local_config", "secretStored": "local",
			"configScope": "workspace", "configLabel": "device local login", "lastSeenLabel": "online",
		}},
	})
	readWSTypeForTest(t, conn, "registered")

	post := func(path, key, body string) (int, store.AgentSession) {
		t.Helper()
		request, _ := http.NewRequest(http.MethodPost, testServer.URL+path, strings.NewReader(body))
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("Idempotency-Key", key)
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			t.Fatalf("post %s: %v", path, err)
		}
		defer response.Body.Close()
		raw, _ := io.ReadAll(response.Body)
		var session store.AgentSession
		if response.StatusCode >= 400 && response.StatusCode != http.StatusConflict {
			t.Logf("%s: %d %s", path, response.StatusCode, raw)
		}
		if response.StatusCode < 300 {
			if err := json.Unmarshal(raw, &session); err != nil {
				t.Fatalf("decode %s: %v (%s)", path, err, raw)
			}
		}
		return response.StatusCode, session
	}

	createBody := `{"workspaceId":"ws_idem","agentId":"agent_idem_claude","provider":"claude","prompt":"start"}`
	status, created := post("/api/agent-sessions", "queued-create", createBody)
	if status != http.StatusCreated || created.ID == "" {
		t.Fatalf("create: status %d, %#v", status, created)
	}
	readWSTypeForTest(t, conn, "run_session")
	status, replayed := post("/api/agent-sessions", "queued-create", createBody)
	if status != http.StatusCreated || replayed.ID != created.ID {
		t.Fatalf("replayed create: status %d, id %q, want %q", status, replayed.ID, created.ID)
	}
	if sessions, err := backing.ListAgentSessionSummaries(ctx, "ws_idem"); err != nil || len(sessions) != 1 {
		t.Fatalf("a replay must not create a session: %d sessions, %v", len(sessions), err)
	}
	if status, _ := post("/api/agent-sessions", "queued-create", strings.Replace(createBody, "start", "other", 1)); status != http.StatusConflict {
		t.Fatalf("same key, different body: status %d, want 409", status)
	}

	if _, err := backing.CompleteAgentSession(ctx, created.ID, "done", ""); err != nil {
		t.Fatalf("complete session: %v", err)
	}
	messages := "/api/agent-sessions/" + created.ID + "/messages"
	status, sent := post(messages, "queued-message", `{"prompt":"follow up"}`)
	if status != http.StatusOK || sent.Input.ID == "" {
		t.Fatalf("message: status %d, %#v", status, sent.Input)
	}
	readWSTypeForTest(t, conn, "run_session")
	// Without the ledger this replay would steer the now-queued session.
	status, resent := post(messages, "queued-message", `{"prompt":"follow up"}`)
	if status != http.StatusOK || resent.Input.ID != sent.Input.ID {
		t.Fatalf("replayed message: status %d, input %q, want %q", status, resent.Input.ID, sent.Input.ID)
	}
	if status, _ := post(messages, "queued-message", `{"prompt":"something else"}`); status != http.StatusConflict {
		t.Fatalf("same key, different message: status %d, want 409", status)
	}
}
