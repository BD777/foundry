package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"github.com/foundry-dev/foundry/apps/server/internal/gateway"
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

// DEV-155: a turn whose agent goes on working on its own (a background
// command, a timer) says so when it completes, and the heartbeats after it
// repeat the claim. The claim is recorded before the session counts as
// completed, so its connector grants stay live without a gap; a heartbeat
// that no longer names the session lets the claim age out.
func TestCompletedTurnAndHeartbeatsClaimTheAgentsNativeWork(t *testing.T) {
	db := newEmptyTestStore(t)
	ctx := context.Background()
	registration := store.DaemonRegistration{
		Device:    store.DeviceProjection{ID: "dev_native", Label: "Device", Status: "connected", LastSeenLabel: "online"},
		Workspace: store.WorkspaceProjection{ID: "ws_native", Name: "W", LocalPath: t.TempDir(), Baseline: "main"},
		Agents: []store.AgentProjection{{
			ID: "agent_native", WorkspaceID: "ws_native", DeviceID: "dev_native", Provider: "claude", Status: "healthy",
			AuthMode: "local_config", SecretStored: "local", ConfigScope: "workspace", ConfigLabel: "local", LastSeenLabel: "online",
		}},
	}
	if err := db.RegisterDaemon(ctx, registration); err != nil {
		t.Fatal(err)
	}
	start := func(prompt string) store.AgentSession {
		t.Helper()
		session, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{WorkspaceID: "ws_native", AgentID: "agent_native", Provider: "claude", Prompt: prompt})
		if err != nil {
			t.Fatal(err)
		}
		if session, err = db.StartAgentSession(ctx, session.ID); err != nil {
			t.Fatal(err)
		}
		return session
	}
	working := start("starts a background loop and answers")
	done := start("answers and is done")

	server := NewServer(db)
	live := serveForTest(t, server)
	conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(live.URL, "http")+"/api/daemon/ws", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	hello, _ := json.Marshal(registration)
	var body map[string]any
	_ = json.Unmarshal(hello, &body)
	body["activeSessionIds"] = []string{working.ID, done.ID}
	writeWSForTest(t, conn, "hello", body)
	readWSTypeForTest(t, conn, "registered")

	expectNamingDispatch := func(envelope wsEnvelope) {
		if connectedWorkerNews[envelope.Type] {
			return
		}
		if envelope.Type != wsRunSessionType {
			t.Fatalf("unexpected %q while waiting for an ack", envelope.Type)
		}
		var run wsRunSessionPayload
		if err := json.Unmarshal(envelope.Payload, &run); err != nil {
			t.Fatalf("decode interleaved %s: %v", wsRunSessionType, err)
		}
		if run.Session.Source != store.SessionSourceNaming || run.Session.WorkspaceID != "ws_native" ||
			(!strings.Contains(run.Session.Input.Prompt, working.Input.Prompt) &&
				!strings.Contains(run.Session.Input.Prompt, done.Input.Prompt)) {
			t.Fatalf("interleaved run_session = source %q workspace %q prompt %q, want automatic naming of a completed session in ws_native",
				run.Session.Source, run.Session.WorkspaceID, run.Session.Input.Prompt)
		}
	}

	before := time.Now()
	writeWSIDForTest(t, conn, "working_completed", "session_completed", map[string]any{"sessionId": working.ID, "inputId": working.Input.ID, "response": "started it", "nativeWork": true})
	readAckForTest(t, conn, "working_completed", expectNamingDispatch)
	writeWSIDForTest(t, conn, "done_completed", "session_completed", map[string]any{"sessionId": done.ID, "inputId": done.Input.ID, "response": "done"})
	readAckForTest(t, conn, "done_completed", expectNamingDispatch)
	summary := func(id string) store.AgentSession {
		got, err := db.GetAgentSessionSummary(ctx, id)
		if err != nil || got.Status != "completed" {
			t.Fatalf("%s = %s %v, want completed", id, got.Status, err)
		}
		return got
	}
	if at := server.hub.NativeWorkClaimedAt("dev_native", working.ID); at.Before(before) {
		t.Fatalf("native claim of the turn that left work = %s, want now", at)
	}
	if err := gateway.SessionLive(summary(working.ID), server.hub, time.Now()); err != nil {
		t.Fatalf("completed session with native work: %v, want live", err)
	}
	if err := gateway.SessionLive(summary(done.ID), server.hub, time.Now()); !errors.Is(err, gateway.ErrSessionIdle) {
		t.Fatalf("completed session without native work: %v, want idle", err)
	}

	// Heartbeats repeat the claim while the work goes on.
	server.hub.claims.confirmNative("dev_native", []string{working.ID}, time.Now().Add(-time.Hour))
	writeWSIDForTest(t, conn, "native_work_heartbeat", "heartbeat", map[string]any{"activeSessionIds": []string{}, "nativeWorkSessionIds": []string{working.ID}})
	readAckForTest(t, conn, "native_work_heartbeat", expectNamingDispatch)
	if err := gateway.SessionLive(summary(working.ID), server.hub, time.Now()); err != nil {
		t.Fatalf("after a heartbeat that claims it: %v, want live", err)
	}
	// The work ends: heartbeats stop naming it and the claim ages out.
	writeWSIDForTest(t, conn, "work_ended_heartbeat", "heartbeat", map[string]any{"activeSessionIds": []string{}})
	readAckForTest(t, conn, "work_ended_heartbeat", expectNamingDispatch)
	if err := gateway.SessionLive(summary(working.ID), server.hub, time.Now().Add(gateway.NativeWorkClaimWindow+time.Second)); !errors.Is(err, gateway.ErrSessionIdle) {
		t.Fatalf("after the claim window: %v, want idle", err)
	}
}
