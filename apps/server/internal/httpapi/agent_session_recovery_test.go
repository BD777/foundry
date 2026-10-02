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
	"github.com/foundry-dev/foundry/apps/server/internal/testfixture"
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

// A daemon serves several workspaces but its hello names one: reconnecting
// settles orphans and dispatches queued sessions in all of them.
func TestReconnectCoversEveryWorkspaceOfTheDevice(t *testing.T) {
	db := newEmptyTestStore(t)
	ctx := context.Background()
	register := func(workspaceID string) store.DaemonRegistration {
		registration := store.DaemonRegistration{
			Device:    store.DeviceProjection{ID: "dev_multi", Label: "Device", Status: "connected", LastSeenLabel: "online"},
			Workspace: store.WorkspaceProjection{ID: workspaceID, Name: workspaceID, LocalPath: t.TempDir(), Baseline: "main"},
			Agents: []store.AgentProjection{{
				ID: "agent_" + workspaceID, WorkspaceID: workspaceID, DeviceID: "dev_multi", Provider: "claude", Status: "healthy",
				AuthMode: "local_config", SecretStored: "local", ConfigScope: "workspace", ConfigLabel: "local", LastSeenLabel: "online",
			}},
		}
		if err := db.RegisterDaemon(ctx, registration); err != nil {
			t.Fatal(err)
		}
		return registration
	}
	primary := register("ws_primary")
	register("ws_secondary")
	create := func(prompt string) store.AgentSession {
		session, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{
			WorkspaceID: "ws_secondary", AgentID: "agent_ws_secondary", Provider: "claude", Prompt: prompt,
		})
		if err != nil {
			t.Fatal(err)
		}
		return session
	}
	orphan := create("orphaned in the second workspace")
	if _, err := db.StartAgentSession(ctx, orphan.ID); err != nil {
		t.Fatal(err)
	}
	queued := create("queued in the second workspace")

	live := httptest.NewServer(NewServer(db).Routes())
	defer live.Close()
	conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(live.URL, "http")+"/api/daemon/ws", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_ = conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	hello, _ := json.Marshal(primary)
	var body map[string]any
	_ = json.Unmarshal(hello, &body)
	body["activeSessionIds"] = []string{}
	writeWSForTest(t, conn, "hello", body)
	readWSTypeForTest(t, conn, "registered")

	asked, dispatched := false, false
	for !asked || !dispatched {
		var envelope struct {
			Type    string          `json:"type"`
			Payload json.RawMessage `json:"payload"`
		}
		if err := conn.ReadJSON(&envelope); err != nil {
			t.Fatalf("asked=%v dispatched=%v: %v", asked, dispatched, err)
		}
		switch envelope.Type {
		case "recover_session":
			var payload wsRecoverSessionPayload
			_ = json.Unmarshal(envelope.Payload, &payload)
			asked = asked || payload.SessionID == orphan.ID
		case "run_session":
			var payload struct {
				Session store.AgentSession `json:"session"`
			}
			_ = json.Unmarshal(envelope.Payload, &payload)
			dispatched = dispatched || payload.Session.ID == queued.ID
		}
	}
}

// Refreshing resources asks the device, which may first ask its person for
// access, and stores what it reports with the device.
func TestRefreshDeviceResourcesRoundTrip(t *testing.T) {
	db := newEmptyTestStore(t)
	ctx := context.Background()
	registration := store.DaemonRegistration{
		Device:    store.DeviceProjection{ID: "dev_res", Label: "Mac", Status: "connected", LastSeenLabel: "online"},
		Workspace: store.WorkspaceProjection{ID: "ws_res", Name: "W", LocalPath: t.TempDir(), Baseline: "main"},
	}
	server := NewServer(db)
	live := httptest.NewServer(server.Routes())
	defer live.Close()
	conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(live.URL, "http")+"/api/daemon/ws", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	writeWSForTest(t, conn, "hello", registration)
	readWSTypeForTest(t, conn, "registered")

	type outcome struct {
		value wsResourcesRefreshedPayload
		err   error
	}
	done := make(chan outcome, 1)
	go func() {
		value, err := server.hub.RefreshDeviceResources(ctx, "dev_res", "computer_use:macos")
		done <- outcome{value, err}
	}()
	var request wsRefreshResourcesPayload
	id := readWSPayloadEnvelopeForTest(t, conn, "refresh_resources", &request)
	if request.RequestAccess != "computer_use:macos" {
		t.Fatalf("request = %+v", request)
	}
	granted := store.DeviceResource{ID: "computer_use:macos", Kind: "computer_use", Name: "macOS screen control", Available: true}
	registration.Device.Resources = []store.DeviceResource{granted}
	writeWSIDForTest(t, conn, id, "resources_refreshed", map[string]any{
		"registration": registration, "resources": []store.DeviceResource{granted}, "opened": []string{"Accessibility"},
	})
	result := <-done
	if result.err != nil || len(result.value.Resources) != 1 || !result.value.Resources[0].Available ||
		len(result.value.Opened) != 1 {
		t.Fatalf("refresh = %+v, %v", result.value, result.err)
	}
	devices, err := db.ListDevices(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(devices) != 1 || len(devices[0].Resources) != 1 || !devices[0].Resources[0].Available {
		t.Fatalf("stored device = %+v", devices)
	}
	if _, err := server.hub.RefreshDeviceResources(ctx, "dev_missing", ""); err != store.ErrNotFound {
		t.Fatalf("offline device: %v, want ErrNotFound", err)
	}
}

// Re-checking a native login also refreshes the device's agents: a row that
// said the CLI was missing turns healthy once it has been installed.
func TestInspectNativeAccountRefreshesAgents(t *testing.T) {
	db := newEmptyTestStore(t)
	ctx := context.Background()
	agent := func(status string) []store.AgentProjection {
		return []store.AgentProjection{{
			ID: "agent_cli", WorkspaceID: "ws_cli", DeviceID: "dev_cli", Provider: "claude", Status: status,
			AuthMode: "local_config", SecretStored: "local", ConfigScope: "workspace", ConfigLabel: "local", LastSeenLabel: "online",
		}}
	}
	registration := store.DaemonRegistration{
		Device:    store.DeviceProjection{ID: "dev_cli", Label: "Linux", Status: "connected", LastSeenLabel: "online"},
		Workspace: store.WorkspaceProjection{ID: "ws_cli", Name: "W", LocalPath: t.TempDir(), Baseline: "main"},
		Agents:    agent("unavailable"),
	}
	server := NewServer(db)
	live := httptest.NewServer(server.Routes())
	defer live.Close()
	conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(live.URL, "http")+"/api/daemon/ws", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	writeWSForTest(t, conn, "hello", registration)
	readWSTypeForTest(t, conn, "registered")

	type outcome struct {
		value store.NativeAccountInspection
		err   error
	}
	done := make(chan outcome, 1)
	go func() {
		value, err := server.hub.InspectNativeAccount(ctx, "dev_cli", "claude", "")
		done <- outcome{value, err}
	}()
	var request struct {
		Runtime string `json:"runtime"`
	}
	id := readWSPayloadEnvelopeForTest(t, conn, "inspect_native_account", &request)
	if request.Runtime != "claude" {
		t.Fatalf("request = %+v", request)
	}
	registration.Agents = agent("healthy")
	writeWSIDForTest(t, conn, id, "native_account_inspected", map[string]any{
		"registration": registration, "result": map[string]any{"runtime": "claude", "status": "local_login"},
	})
	if result := <-done; result.err != nil || result.value.Runtime != "claude" {
		t.Fatalf("inspect = %+v, %v", result.value, result.err)
	}
	agents, err := db.ListAgents(ctx, "ws_cli", "")
	if err != nil {
		t.Fatal(err)
	}
	if len(agents) != 1 || agents[0].Status != "healthy" {
		t.Fatalf("stored agents = %+v", agents)
	}
	if _, err := server.hub.InspectNativeAccount(ctx, "dev_missing", "claude", ""); err != store.ErrNotFound {
		t.Fatalf("offline device: %v, want ErrNotFound", err)
	}
}

// An Issue execution orphaned by a worker restart recovers like any session:
// the device is asked, and its recorded Issue result completes the Issue.
func TestReconnectRecoversAnOrphanedIssueExecution(t *testing.T) {
	db := newEmptyTestStore(t)
	ctx := context.Background()
	registration := store.DaemonRegistration{
		Capabilities: []string{store.DaemonCapabilityIssueSessions},
		Device:       store.DeviceProjection{ID: "dev_issue_recover", Label: "Device", Status: "connected", LastSeenLabel: "online"},
		Workspace:    store.WorkspaceProjection{ID: "ws_issue_recover", Name: "W", LocalPath: t.TempDir(), Baseline: "main"},
	}
	if err := db.RegisterDaemon(ctx, registration); err != nil {
		t.Fatal(err)
	}
	created, err := db.CreateIssue(ctx, store.CreateIssueInput{WorkspaceID: "ws_issue_recover", Title: "orphaned", Runtime: "mock"})
	if err != nil {
		t.Fatal(err)
	}
	testfixture.ConfirmContract(t, db, created.ID)
	server := NewServer(db)
	_, session, err := db.ClaimIssueExecution(ctx, "dev_issue_recover", "ws_issue_recover")
	if err != nil {
		t.Fatal(err)
	}
	started, err := db.StartAgentSession(ctx, session.ID)
	if err != nil {
		t.Fatal(err)
	}
	server.hub.startIssueExecution(ctx, started)

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
	body["activeSessionIds"] = []string{}
	writeWSForTest(t, conn, "hello", body)
	readWSTypeForTest(t, conn, "registered")

	var asked wsRecoverSessionPayload
	readWSPayloadForTest(t, conn, "recover_session", &asked)
	if asked.SessionID != session.ID || asked.IssueID != created.ID {
		t.Fatalf("recover_session = %+v, want the execution of %s", asked, created.ID)
	}
	writeWSForTest(t, conn, "session_completed", map[string]any{
		"sessionId": session.ID,
		"inputId":   session.Input.ID,
		"response":  "finished while the worker was down",
		"issueResult": map[string]any{
			"runId":    session.ID,
			"response": "finished while the worker was down",
			"artifact": map[string]any{"id": "art_recovered", "issueId": created.ID, "kind": "text", "title": "Report", "summary": "done"},
			"checks":   []string{"Recovered"},
		},
	})
	readWSTypeForTest(t, conn, "ack")
	issue, err := db.GetIssue(ctx, created.ID)
	if err != nil {
		t.Fatal(err)
	}
	if issue.Status != "verifying" || issue.Artifact == nil || issue.Artifact.ID != "art_recovered" || issue.Run == nil || issue.Run.ID != session.ID {
		t.Fatalf("recovered Issue = %s %#v %#v", issue.Status, issue.Artifact, issue.Run)
	}
}
