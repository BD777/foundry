package httpapi

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// DEV-144: a session waited 31 minutes on its own background task, sending
// no events, while its worker still ran it. The socket dropped for a few
// seconds and the sweep failed the session in that gap. The worker's
// heartbeat claims keep such a session alive between connections; a session
// no worker claims still goes stale, and so does the silent one once its
// device stops claiming it.
func TestHeartbeatClaimKeepsSilentSessionAliveAcrossReconnect(t *testing.T) {
	db := newEmptyTestStore(t)
	ctx := context.Background()
	registration := store.DaemonRegistration{
		Device:    store.DeviceProjection{ID: "dev_claims", Label: "Device", Status: "connected", LastSeenLabel: "online"},
		Workspace: store.WorkspaceProjection{ID: "ws_claims", Name: "W", LocalPath: t.TempDir(), Baseline: "main"},
		Agents: []store.AgentProjection{{
			ID: "agent_claims", WorkspaceID: "ws_claims", DeviceID: "dev_claims", Provider: "claude", Status: "healthy",
			AuthMode: "local_config", SecretStored: "local", ConfigScope: "workspace", ConfigLabel: "local", LastSeenLabel: "online",
		}},
	}
	if err := db.RegisterDaemon(ctx, registration); err != nil {
		t.Fatal(err)
	}
	start := func(prompt string) store.AgentSession {
		t.Helper()
		session, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{
			WorkspaceID: "ws_claims", AgentID: "agent_claims", Provider: "claude", Prompt: prompt,
		})
		if err != nil {
			t.Fatal(err)
		}
		if session, err = db.StartAgentSession(ctx, session.ID); err != nil {
			t.Fatal(err)
		}
		return session
	}
	waiting := start("waits on a long background build")
	lost := start("no worker runs this any more")

	const staleAfter = 2 * time.Second
	server := NewServer(db)
	server.options.AgentSessionStaleAfter = staleAfter
	// No grace for a freshly started server: only claims count.
	server.hub.claims = newSessionClaims(time.Time{})
	live := serveForTest(t, server)
	url := "ws" + strings.TrimPrefix(live.URL, "http") + "/api/daemon/ws"
	conn, _, err := websocket.DefaultDialer.Dial(url, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	hello, _ := json.Marshal(registration)
	var body map[string]any
	_ = json.Unmarshal(hello, &body)
	body["activeSessionIds"] = []string{waiting.ID}
	writeWSForTest(t, conn, "hello", body)
	readWSTypeForTest(t, conn, "registered")
	var asked wsRecoverSessionPayload
	readWSPayloadForTest(t, conn, "recover_session", &asked)
	if asked.SessionID != lost.ID {
		t.Fatalf("recover_session = %+v, want the unclaimed %s", asked, lost.ID)
	}

	// Both sessions stay silent for longer than staleAfter; the worker's
	// heartbeat goes on claiming the one it runs.
	time.Sleep(staleAfter + 200*time.Millisecond)
	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	writeWSForTest(t, conn, "heartbeat", map[string]any{"activeSessionIds": []string{waiting.ID}})
	readWSTypeForTest(t, conn, "ack")
	conn.Close()
	deadline := time.Now().Add(5 * time.Second)
	for server.hub.HasConnection("dev_claims") {
		if time.Now().After(deadline) {
			t.Fatal("the closed socket still counts as the device's connection")
		}
		time.Sleep(10 * time.Millisecond)
	}

	if err := server.reconcileStaleSessions(ctx); err != nil {
		t.Fatal(err)
	}
	if got, _ := db.GetAgentSessionSummary(ctx, waiting.ID); got.Status != "running" {
		t.Fatalf("claimed silent session between connections = %s %q, want running", got.Status, got.Error)
	}
	if got, _ := db.GetAgentSessionSummary(ctx, lost.ID); got.Status != "failed" || !strings.Contains(got.Error, "stopped reporting session activity") {
		t.Fatalf("unclaimed session = %s %q, want failed as stale", got.Status, got.Error)
	}

	// The device never comes back: once its last claim is older than
	// staleAfter, the silent session fails too.
	server.hub.claims.confirm("dev_claims", []string{waiting.ID}, time.Now().Add(-staleAfter-time.Second))
	if err := server.reconcileStaleSessions(ctx); err != nil {
		t.Fatal(err)
	}
	if got, _ := db.GetAgentSessionSummary(ctx, waiting.ID); got.Status != "failed" {
		t.Fatalf("session its device stopped claiming = %s, want failed", got.Status)
	}
}

// A heartbeat that names the daemon's sessions replaces what the connection
// holds; one from an older worker that names none still confirms the claims
// the connection already holds.
func TestHeartbeatConfirmsAndReplacesSessionClaims(t *testing.T) {
	hub := NewDaemonHub(newTestStore(t), newNotifiersForTest(nil).daemon(), "")
	hub.claims = newSessionClaims(time.Time{})
	connection := &daemonConnection{
		activeSessions: map[string]bool{"running": true},
		deviceID:       "device",
		done:           make(chan struct{}),
		hub:            hub,
	}
	hub.connections["device"] = connection

	before := time.Now()
	connection.noteHeartbeat(json.RawMessage(`{"outbox":{"queued":0}}`))
	confirmed := hub.SessionClaim("device", "running")
	if !confirmed.Held || confirmed.ConfirmedAt.Before(before) {
		t.Fatalf("claim after an older worker's heartbeat = %+v, want held and confirmed now", confirmed)
	}

	connection.noteHeartbeat(json.RawMessage(`{"activeSessionIds":["started"]}`))
	if hub.HasActiveSession("device", "running") || !hub.HasActiveSession("device", "started") {
		t.Fatal("a heartbeat's session list did not replace the connection's claims")
	}
	if dropped := hub.SessionClaim("device", "running"); dropped.Held || !dropped.ConfirmedAt.Equal(confirmed.ConfirmedAt) {
		t.Fatalf("claim the worker dropped = %+v, want unheld and last confirmed at %s", dropped, confirmed.ConfirmedAt)
	}

	connection.setActiveSession("started", false)
	if ended := hub.SessionClaim("device", "started"); ended.Held || !ended.ConfirmedAt.IsZero() {
		t.Fatalf("claim of an ended session = %+v, want forgotten", ended)
	}
}

// A server that just started has heard no claims yet: it gives every
// device until staleAfter after its start to claim its sessions again.
func TestRestartedServerWaitsForDevicesToClaimAgain(t *testing.T) {
	started := time.Now().Add(-time.Minute)
	claims := newSessionClaims(started)
	if at := claims.confirmedAt("device", "session"); !at.Equal(started) {
		t.Fatalf("confirmedAt before any claim = %s, want the server's start %s", at, started)
	}
	claims.confirm("device", []string{"session"}, started.Add(-time.Hour))
	if at := claims.confirmedAt("device", "session"); !at.Equal(started) {
		t.Fatalf("confirmedAt of a claim older than the start = %s, want %s", at, started)
	}
	later := started.Add(30 * time.Second)
	claims.confirm("device", []string{"session"}, later)
	if at := claims.confirmedAt("device", "session"); !at.Equal(later) {
		t.Fatalf("confirmedAt = %s, want the latest claim %s", at, later)
	}
	if at := claims.confirmedAt("other-device", "session"); !at.Equal(started) {
		t.Fatalf("another device's confirmedAt = %s, want only the start", at)
	}
}
