package httpapi

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func TestStaleAgentSessionIsNotKeptAliveByUnrelatedDeviceConnection(t *testing.T) {
	now := time.Date(2026, 9, 3, 5, 0, 0, 0, time.UTC)
	session := store.AgentSession{
		DeviceID:       "device",
		ID:             "session",
		LastActivityAt: now.Add(-31 * time.Minute).Format(time.RFC3339Nano),
		Status:         "running",
	}

	message, stale := staleAgentSessionMessage(
		session,
		now,
		30*time.Minute,
		func(_, sessionID string) bool { return sessionID == "other-session" },
	)
	if !stale {
		t.Fatal("staleAgentSessionMessage() stale = false, want true")
	}
	if message == "" {
		t.Fatal("staleAgentSessionMessage() returned an empty explanation")
	}
}

func TestRecentAgentSessionHeartbeatKeepsRunAlive(t *testing.T) {
	now := time.Date(2026, 9, 3, 5, 0, 0, 0, time.UTC)
	session := store.AgentSession{
		DeviceID:       "device",
		ID:             "session",
		LastActivityAt: now.Add(-time.Minute).Format(time.RFC3339Nano),
		Status:         "running",
	}

	if _, stale := staleAgentSessionMessage(
		session,
		now,
		30*time.Minute,
		nil,
	); stale {
		t.Fatal("recent session heartbeat was marked stale")
	}
}

func TestActiveSessionClaimSurvivesStaleHeartbeatAcrossReconnect(t *testing.T) {
	now := time.Date(2026, 9, 3, 5, 0, 0, 0, time.UTC)
	session := store.AgentSession{
		DeviceID:       "device",
		ID:             "session",
		LastActivityAt: now.Add(-time.Hour).Format(time.RFC3339Nano),
		Status:         "running",
	}

	if _, stale := staleAgentSessionMessage(
		session,
		now,
		30*time.Minute,
		func(deviceID string, sessionID string) bool {
			return deviceID == "device" && sessionID == "session"
		},
	); stale {
		t.Fatal("same-process reconnect claim was marked stale")
	}
}

// A reconnecting daemon is asked about each input the server still counts as
// running but the new process does not claim; its answer settles the input.
func TestReconnectAsksTheDeviceAboutOrphanedInputs(t *testing.T) {
	db := newEmptyTestStore(t)
	ctx := context.Background()
	registration := store.DaemonRegistration{
		Device:    store.DeviceProjection{ID: "dev_recover", Label: "Device", Status: "connected", LastSeenLabel: "online"},
		Workspace: store.WorkspaceProjection{ID: "ws_recover", Name: "W", LocalPath: t.TempDir(), Baseline: "main"},
		Agents: []store.AgentProjection{{
			ID: "agent_recover", WorkspaceID: "ws_recover", DeviceID: "dev_recover", Provider: "claude", Status: "healthy",
			AuthMode: "local_config", SecretStored: "local", ConfigScope: "workspace", ConfigLabel: "local", LastSeenLabel: "online",
		}},
	}
	if err := db.RegisterDaemon(ctx, registration); err != nil {
		t.Fatal(err)
	}
	start := func(prompt string) store.AgentSession {
		session, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{
			WorkspaceID: "ws_recover", AgentID: "agent_recover", Provider: "claude", Prompt: prompt,
		})
		if err != nil {
			t.Fatal(err)
		}
		if session, err = db.StartAgentSession(ctx, session.ID); err != nil {
			t.Fatal(err)
		}
		return session
	}
	orphan := start("finished while the worker was down")
	claimed := start("still running in the new process")

	server := NewServer(db)
	live := httptest.NewServer(server.Routes())
	defer live.Close()
	conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(live.URL, "http")+"/api/daemon/ws", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_ = conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	hello, _ := json.Marshal(registration)
	var body map[string]any
	_ = json.Unmarshal(hello, &body)
	body["activeSessionIds"] = []string{claimed.ID}
	writeWSForTest(t, conn, "hello", body)
	readWSTypeForTest(t, conn, "registered")

	var asked wsRecoverSessionPayload
	readWSPayloadForTest(t, conn, "recover_session", &asked)
	if asked.SessionID != orphan.ID || asked.InputID != orphan.Input.ID {
		t.Fatalf("recover_session = %+v, want %s / %s", asked, orphan.ID, orphan.Input.ID)
	}
	// Only the unclaimed input is asked about.
	_ = conn.SetReadDeadline(time.Now().Add(300 * time.Millisecond))
	var extra struct {
		Type string `json:"type"`
	}
	if err := conn.ReadJSON(&extra); err == nil {
		t.Fatalf("unexpected %s after the orphan's question", extra.Type)
	}
	conn.Close()

	conn, _, err = websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(live.URL, "http")+"/api/daemon/ws", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_ = conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	writeWSForTest(t, conn, "hello", body)
	readWSTypeForTest(t, conn, "registered")
	readWSPayloadForTest(t, conn, "recover_session", &asked)
	writeWSForTest(t, conn, "session_completed", map[string]any{
		"sessionId": orphan.ID, "inputId": orphan.Input.ID, "response": "done offline", "nativeSessionId": "native_offline",
	})
	readWSTypeForTest(t, conn, "ack")
	settled, err := db.GetAgentSession(ctx, orphan.ID)
	if err != nil {
		t.Fatal(err)
	}
	if settled.Status != "completed" || settled.Response != "done offline" {
		t.Fatalf("orphan after the device's answer = %s %q", settled.Status, settled.Response)
	}
	if still, _ := db.GetAgentSession(ctx, claimed.ID); still.Status != "running" {
		t.Fatalf("claimed input = %s, want running", still.Status)
	}
}

// A daemon that reports no execution claims predates recover_session and is
// never asked.
func TestReconnectDoesNotAskDaemonsWithoutClaims(t *testing.T) {
	db := newEmptyTestStore(t)
	ctx := context.Background()
	registration := store.DaemonRegistration{
		Device:    store.DeviceProjection{ID: "dev_old", Label: "Device", Status: "connected", LastSeenLabel: "online"},
		Workspace: store.WorkspaceProjection{ID: "ws_old", Name: "W", LocalPath: t.TempDir(), Baseline: "main"},
		Agents: []store.AgentProjection{{
			ID: "agent_old", WorkspaceID: "ws_old", DeviceID: "dev_old", Provider: "claude", Status: "healthy",
			AuthMode: "local_config", SecretStored: "local", ConfigScope: "workspace", ConfigLabel: "local", LastSeenLabel: "online",
		}},
	}
	if err := db.RegisterDaemon(ctx, registration); err != nil {
		t.Fatal(err)
	}
	session, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{
		WorkspaceID: "ws_old", AgentID: "agent_old", Provider: "claude", Prompt: "work",
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.StartAgentSession(ctx, session.ID); err != nil {
		t.Fatal(err)
	}
	live := httptest.NewServer(NewServer(db).Routes())
	defer live.Close()
	conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(live.URL, "http")+"/api/daemon/ws", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_ = conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	writeWSForTest(t, conn, "hello", registration)
	readWSTypeForTest(t, conn, "registered")
	_ = conn.SetReadDeadline(time.Now().Add(300 * time.Millisecond))
	var extra struct {
		Type string `json:"type"`
	}
	if err := conn.ReadJSON(&extra); err == nil {
		t.Fatalf("a daemon without claims got %s", extra.Type)
	}
}
