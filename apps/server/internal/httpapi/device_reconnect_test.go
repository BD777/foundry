package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/browserevent"
	"github.com/foundry-dev/foundry/apps/server/internal/resources"
	"github.com/foundry-dev/foundry/apps/server/internal/sqlitestore"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"github.com/gorilla/websocket"
)

func shortenDeviceReconnectGrace(t *testing.T, grace time.Duration) {
	t.Helper()
	previous := deviceReconnectGrace
	deviceReconnectGrace = grace
	t.Cleanup(func() { deviceReconnectGrace = previous })
}

func shortenDeviceReconnectWait(t *testing.T, wait time.Duration) {
	t.Helper()
	previous := deviceReconnectWait
	deviceReconnectWait = wait
	t.Cleanup(func() { deviceReconnectWait = previous })
}

func deviceStatusForTest(t *testing.T, db *sqlitestore.Store, deviceID string) store.DeviceProjection {
	t.Helper()
	devices, err := db.ListDevices(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	for _, device := range devices {
		if device.ID == deviceID {
			return device
		}
	}
	t.Fatalf("device %s is not listed", deviceID)
	return store.DeviceProjection{}
}

func connectMacForReconnectTest(t *testing.T, server *Server, live *httptest.Server) *websocket.Conn {
	t.Helper()
	conn := dialDaemonForTest(t, live)
	writeWSForTest(t, conn, "hello", macHello([]string{}, nil))
	readWSTypeForTest(t, conn, "registered")
	writeWSIDForTest(t, conn, "resources", wsResourcesReportType, store.ResourcesReport{
		ScannerVersion: 1,
		Instances: []store.DetectedResource{{
			Key: "toolchain/git", Type: "toolchain", Platform: "macos", Name: "git", Detector: "toolchain@1",
			Readiness: store.ResourceReadiness{Ready: true, Level: "installed"},
		}},
	})
	readUntilForTest(t, conn, wsAckType)
	waitFor(t, "the Mac to connect", func() bool { return server.hub.HasConnection("dev_mac") })
	return conn
}

type mcpDeviceResourcesForTest struct {
	DeviceID   string                `json:"deviceId"`
	Online     bool                  `json:"online"`
	Connection string                `json:"connection"`
	Instances  []mcpResourceInstance `json:"instances"`
}

func listMCPDevicesForTest(t *testing.T, server *Server) []mcpDeviceResourcesForTest {
	t.Helper()
	request := httptest.NewRequest(http.MethodPost, "/api/mcp", nil)
	request = request.WithContext(context.WithValue(request.Context(), scopeContextKey{}, accessScope{all: true}))
	actor := Actor{}
	if server.testActor != nil {
		actor = *server.testActor
	}
	text, err := server.listResourcesForMCP(mcpCall{r: request, actor: actor, args: map[string]json.RawMessage{}})
	if err != nil {
		t.Fatal(err)
	}
	var devices []mcpDeviceResourcesForTest
	if err := json.Unmarshal([]byte(text), &devices); err != nil {
		t.Fatalf("list_resources = %s: %v", text, err)
	}
	return devices
}

func deviceViewForTest(t *testing.T, server *Server, deviceID string) mcpDeviceResourcesForTest {
	t.Helper()
	for _, device := range listMCPDevicesForTest(t, server) {
		if device.DeviceID == deviceID {
			return device
		}
	}
	t.Fatalf("list_resources does not include %s", deviceID)
	return mcpDeviceResourcesForTest{}
}

func deviceStatusesForTest(t *testing.T, events []streamedForTest) []string {
	t.Helper()
	statuses := []string{}
	for _, event := range events {
		if event.kind != browserevent.DeviceStatusChanged {
			continue
		}
		var payload browserevent.DeviceStatusChangedPayload
		if err := json.Unmarshal(event.payload, &payload); err != nil {
			t.Fatal(err)
		}
		statuses = append(statuses, payload.Status)
	}
	return statuses
}

func TestDeviceDisconnectIsReconnectingDuringGrace(t *testing.T) {
	shortenDeviceReconnectGrace(t, 250*time.Millisecond)
	db := newTestStore(t)
	registerMacWorkspaces(t, db)
	server := NewServer(db)
	live := serveForTest(t, server)
	conn := connectMacForReconnectTest(t, server, live)

	conn.Close()
	waitFor(t, "the device to enter reconnect grace", func() bool {
		return server.hub.deviceConnection("dev_mac").State == resources.ConnectionReconnecting
	})
	device := deviceStatusForTest(t, db, "dev_mac")
	if device.Status != deviceStatusReconnecting || device.LastSeenLabel != deviceStatusLabelReconnect {
		t.Fatalf("device while reconnecting = %+v", device)
	}
	list := listResourcesForTest(t, server, "")
	if len(list.Instances) != 1 || list.Sources[0].Online ||
		list.Instances[0].State != store.ResourceReconnecting ||
		!strings.Contains(list.Instances[0].StateReason, "grace remain") {
		t.Fatalf("resources during grace = %+v", list)
	}
	deviceView := deviceViewForTest(t, server, "dev_mac")
	if deviceView.Online || deviceView.Connection != resources.ConnectionReconnecting ||
		len(deviceView.Instances) != 1 || deviceView.Instances[0].State != store.ResourceReconnecting {
		t.Fatalf("list_resources during grace = %+v", deviceView)
	}
}

func TestDeviceReconnectWithinGraceDoesNotGoOffline(t *testing.T) {
	shortenDeviceReconnectGrace(t, 2*time.Second)
	db := newTestStore(t)
	registerMacWorkspaces(t, db)
	server := NewServer(db)
	live := serveForTest(t, server)
	first := connectMacForReconnectTest(t, server, live)
	viewer := subscribeForTest(server.stream)

	first.Close()
	waitFor(t, "the device to enter reconnect grace", func() bool {
		return server.hub.deviceConnection("dev_mac").State == resources.ConnectionReconnecting
	})
	second := dialDaemonForTest(t, live)
	defer second.Close()
	writeWSForTest(t, second, "hello", macHello([]string{}, nil))
	readWSTypeForTest(t, second, "registered")
	waitFor(t, "the device to be online", func() bool { return server.hub.HasConnection("dev_mac") })
	time.Sleep(deviceReconnectGrace + 100*time.Millisecond)

	statuses := deviceStatusesForTest(t, drainForTest(t, viewer))
	for _, status := range statuses {
		if status == deviceStatusDisconnected {
			t.Fatalf("status after reconnecting within grace = %v", statuses)
		}
	}
	if device := deviceStatusForTest(t, db, "dev_mac"); device.Status != deviceStatusConnected {
		t.Fatalf("device after reconnecting = %+v", device)
	}
	list := listResourcesForTest(t, server, "")
	if !list.Sources[0].Online || list.Instances[0].State != store.ResourceAvailable {
		t.Fatalf("resources after reconnecting = %+v", list)
	}
	if deviceView := deviceViewForTest(t, server, "dev_mac"); !deviceView.Online || deviceView.Connection != resources.ConnectionOnline {
		t.Fatalf("list_resources after reconnecting = %+v", deviceView)
	}
}

func TestDeviceReconnectGraceExpiryRunsOfflineActions(t *testing.T) {
	shortenDeviceReconnectGrace(t, 80*time.Millisecond)
	db := newTestStore(t)
	registerMacWorkspaces(t, db)
	server := NewServer(db)
	live := serveForTest(t, server)
	conn := connectMacForReconnectTest(t, server, live)

	now := time.Now().UTC().Format(time.RFC3339)
	resourceID := resources.InstanceID("dev_mac", "toolchain/git")
	if err := db.SaveResourceLeaseChanges(context.Background(), store.ResourceLeaseChanges{
		Leases: []store.ResourceLease{{
			ID: "lease_reconnect", ResourceID: resourceID, SourceID: "dev_mac", Generation: 1,
			HolderSessionID: "session_reconnect", HolderDeviceID: "dev_mac",
			State: store.LeaseActive, AcquiredAt: now, UpdatedAt: now,
		}},
	}); err != nil {
		t.Fatal(err)
	}

	conn.Close()
	waitFor(t, "the grace to expire", func() bool {
		return deviceStatusForTest(t, db, "dev_mac").Status == deviceStatusDisconnected
	})
	waitForResources(t, server, "", func(list store.ResourceList) bool {
		return len(list.Instances) == 1 && list.Instances[0].State == store.ResourceOffline && !list.Sources[0].Online
	})
	leases, err := db.ListResourceLeases(context.Background(), store.ResourceLeaseFilter{ID: "lease_reconnect"})
	if err != nil {
		t.Fatal(err)
	}
	if len(leases) != 1 || leases[0].HolderOfflineSince == "" {
		t.Fatalf("lease after the device went offline = %+v", leases)
	}
	if deviceView := deviceViewForTest(t, server, "dev_mac"); deviceView.Connection != resources.ConnectionOffline ||
		deviceView.Online || deviceView.Instances[0].State != store.ResourceOffline {
		t.Fatalf("list_resources after grace = %+v", deviceView)
	}
}

func TestServerStartupGivesPreviouslyConnectedDevicesGrace(t *testing.T) {
	shortenDeviceReconnectGrace(t, 100*time.Millisecond)
	db := newTestStore(t)
	registerMacWorkspaces(t, db)
	server := NewServer(db)
	shutDownAtCleanup(t, server)
	server.ResumeDeviceReconnects(context.Background())

	if device := deviceStatusForTest(t, db, "dev_mac"); device.Status != deviceStatusReconnecting {
		t.Fatalf("device at startup = %+v", device)
	}
	if connection := server.hub.deviceConnection("dev_mac"); connection.State != resources.ConnectionReconnecting {
		t.Fatalf("connection at startup = %+v", connection)
	}
	if _, err := server.resources.Report(context.Background(), store.ResourceSource{Kind: "device", ID: "dev_mac", Label: "mac-desktop"}, store.ResourcesReport{
		Instances: []store.DetectedResource{{
			Key: "toolchain/git", Type: "toolchain", Platform: "macos", Name: "git", Detector: "toolchain@1",
			Readiness: store.ResourceReadiness{Ready: true, Level: "installed"},
		}},
	}); err != nil {
		t.Fatal(err)
	}
	if deviceView := deviceViewForTest(t, server, "dev_mac"); deviceView.Connection != resources.ConnectionReconnecting ||
		deviceView.Instances[0].State != store.ResourceReconnecting {
		t.Fatalf("list_resources at startup = %+v", deviceView)
	}

	waitFor(t, "the startup grace to expire", func() bool {
		return deviceStatusForTest(t, db, "dev_mac").Status == deviceStatusDisconnected
	})
	list := listResourcesForTest(t, server, "")
	if list.Sources[0].Online || list.Instances[0].State != store.ResourceOffline {
		t.Fatalf("resources after startup grace = %+v", list)
	}
}

func TestReplacingADeviceConnectionDoesNotFlashOffline(t *testing.T) {
	shortenDeviceReconnectGrace(t, 120*time.Millisecond)
	db := newTestStore(t)
	registerMacWorkspaces(t, db)
	server := NewServer(db)
	live := serveForTest(t, server)
	first := connectMacForReconnectTest(t, server, live)
	originalConnection := server.hub.connectionFor("dev_mac")
	viewer := subscribeForTest(server.stream)

	second := dialDaemonForTest(t, live)
	defer second.Close()
	writeWSForTest(t, second, "hello", macHello([]string{}, nil))
	readWSTypeForTest(t, second, "registered")
	waitFor(t, "the replacement connection", func() bool {
		connection := server.hub.connectionFor("dev_mac")
		return connection != nil && connection != originalConnection && server.hub.HasConnection("dev_mac")
	})
	first.Close()
	time.Sleep(2 * deviceReconnectGrace)

	for _, status := range deviceStatusesForTest(t, drainForTest(t, viewer)) {
		if status != deviceStatusConnected {
			t.Fatalf("replacement emitted device status %q", status)
		}
	}
	if !server.hub.HasConnection("dev_mac") {
		t.Fatal("the replacement connection was lost")
	}
	if device := deviceStatusForTest(t, db, "dev_mac"); device.Status != deviceStatusConnected {
		t.Fatalf("device after replacement = %+v", device)
	}
}

type reconnectLeaseFixture struct {
	server     *Server
	live       *httptest.Server
	connection *websocket.Conn
	session    store.AgentSession
	resourceID string
}

func newReconnectLeaseFixture(t *testing.T) reconnectLeaseFixture {
	t.Helper()
	db := newTestStore(t)
	registerMacWorkspaces(t, db)
	server := NewServer(db)
	live := serveForTest(t, server)
	connection := connectMacForReconnectTest(t, server, live)

	readiness := store.ResourceReadiness{Ready: true, Level: "configured"}
	if _, err := server.resources.Report(context.Background(), store.ResourceSource{
		Kind: "device", ID: "dev_mac", Label: "mac-desktop",
	}, store.ResourcesReport{
		ScannerVersion: 1,
		Instances: []store.DetectedResource{{
			Key: "compute", Type: "compute", Platform: "macos", Name: "Compute",
			Detector: "compute@1", Readiness: readiness,
			Backends: []store.ResourceBackend{{ID: "foundry-compute", Mode: "remote_ops", Readiness: readiness}},
		}},
	}); err != nil {
		t.Fatal(err)
	}
	session, err := db.CreateAgentSession(context.Background(), store.CreateAgentSessionInput{
		WorkspaceID: "ws_mac_b", AgentID: "agent_ws_mac_b", Provider: "claude", Prompt: "lease compute",
	})
	if err != nil {
		t.Fatal(err)
	}
	return reconnectLeaseFixture{
		server: server, live: live, connection: connection, session: session,
		resourceID: resources.InstanceID("dev_mac", "compute"),
	}
}

func (f reconnectLeaseFixture) acquire(ctx context.Context) error {
	_, err := f.server.leases.Acquire(ctx, resources.AcquireRequest{
		SessionID: f.session.ID, ResourceIDs: []string{f.resourceID}, Reason: "reconnect test",
	})
	return err
}

func TestLeaseAcquireWaitsForReconnectingDevice(t *testing.T) {
	shortenDeviceReconnectGrace(t, 2*time.Second)
	shortenDeviceReconnectWait(t, 2*time.Second)
	f := newReconnectLeaseFixture(t)
	f.connection.Close()
	waitFor(t, "the device to enter reconnect grace", func() bool {
		return f.server.hub.deviceConnection("dev_mac").State == resources.ConnectionReconnecting
	})

	result := make(chan error, 1)
	go func() { result <- f.acquire(context.Background()) }()
	select {
	case err := <-result:
		t.Fatalf("acquire returned before reconnect: %v", err)
	case <-time.After(40 * time.Millisecond):
	}

	second := dialDaemonForTest(t, f.live)
	writeWSForTest(t, second, "hello", macHello([]string{}, nil))
	readWSTypeForTest(t, second, "registered")
	select {
	case err := <-result:
		if err != nil {
			t.Fatalf("acquire after reconnect: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("acquire did not continue after reconnect")
	}
}

func TestLeaseOperationWaitsForReconnectingDevice(t *testing.T) {
	shortenDeviceReconnectGrace(t, 2*time.Second)
	shortenDeviceReconnectWait(t, 2*time.Second)
	f := newReconnectLeaseFixture(t)
	if err := f.acquire(context.Background()); err != nil {
		t.Fatal(err)
	}
	leases, err := f.server.store.ListResourceLeases(context.Background(), store.ResourceLeaseFilter{SessionID: f.session.ID, Live: true})
	if err != nil || len(leases) != 1 {
		t.Fatalf("leases before disconnect = %+v, %v", leases, err)
	}
	f.connection.Close()
	waitFor(t, "the device to enter reconnect grace", func() bool {
		return f.server.hub.deviceConnection("dev_mac").State == resources.ConnectionReconnecting
	})

	result := make(chan error, 1)
	go func() {
		ticket, err := f.server.leases.Begin(context.Background(), leases[0].ID, f.session.ID)
		if err == nil {
			err = f.server.leases.Finish(context.Background(), ticket, nil)
		}
		result <- err
	}()
	select {
	case err := <-result:
		t.Fatalf("operation returned before reconnect: %v", err)
	case <-time.After(40 * time.Millisecond):
	}

	second := dialDaemonForTest(t, f.live)
	writeWSForTest(t, second, "hello", macHello([]string{}, nil))
	readWSTypeForTest(t, second, "registered")
	select {
	case err := <-result:
		if err != nil {
			t.Fatalf("operation after reconnect: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("operation did not continue after reconnect")
	}
}

func TestLeaseAcquireReconnectWaitTimeout(t *testing.T) {
	shortenDeviceReconnectGrace(t, 2*time.Second)
	shortenDeviceReconnectWait(t, 60*time.Millisecond)
	f := newReconnectLeaseFixture(t)
	f.connection.Close()
	waitFor(t, "the device to enter reconnect grace", func() bool {
		return f.server.hub.deviceConnection("dev_mac").State == resources.ConnectionReconnecting
	})

	err := f.acquire(context.Background())
	var reconnecting *resources.DeviceReconnectingError
	if !errors.As(err, &reconnecting) || err.Error() != "mac-desktop is reconnecting; try again shortly" {
		t.Fatalf("acquire timeout = %v", err)
	}
}

func TestLeaseAcquireRefusesOfflineDeviceImmediately(t *testing.T) {
	shortenDeviceReconnectGrace(t, 60*time.Millisecond)
	shortenDeviceReconnectWait(t, 2*time.Second)
	f := newReconnectLeaseFixture(t)
	f.connection.Close()
	waitFor(t, "the grace to expire", func() bool {
		return f.server.hub.deviceConnection("dev_mac").State == resources.ConnectionOffline
	})

	started := time.Now()
	err := f.acquire(context.Background())
	if elapsed := time.Since(started); elapsed > 500*time.Millisecond {
		t.Fatalf("offline acquire took %s", elapsed)
	}
	if err == nil || !strings.Contains(err.Error(), "which is offline") || strings.Contains(err.Error(), "is reconnecting") {
		t.Fatalf("offline acquire = %v", err)
	}
}

func TestLeaseAcquireReconnectWaitEndsWithContext(t *testing.T) {
	shortenDeviceReconnectGrace(t, 2*time.Second)
	shortenDeviceReconnectWait(t, 2*time.Second)
	f := newReconnectLeaseFixture(t)
	f.connection.Close()
	waitFor(t, "the device to enter reconnect grace", func() bool {
		return f.server.hub.deviceConnection("dev_mac").State == resources.ConnectionReconnecting
	})

	ctx, cancel := context.WithCancel(context.Background())
	result := make(chan error, 1)
	go func() { result <- f.acquire(ctx) }()
	time.Sleep(40 * time.Millisecond)
	cancel()
	select {
	case err := <-result:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("canceled acquire = %v", err)
		}
	case <-time.After(500 * time.Millisecond):
		t.Fatal("context cancellation did not end acquire")
	}
}

type reconnectControlFixture struct {
	server     *Server
	live       *httptest.Server
	connection *fakeDevice
	session    store.AgentSession
}

func newReconnectControlFixture(t *testing.T, answers map[string]fakeAnswer) reconnectControlFixture {
	t.Helper()
	db := newEmptyTestStore(t)
	registerQueueDevice(t, db, "claude")
	session, err := db.CreateAgentSession(context.Background(), store.CreateAgentSessionInput{
		WorkspaceID: "ws_queue", AgentID: "agent_queue", Provider: "claude", Prompt: "run",
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.StartAgentSession(context.Background(), session.ID); err != nil {
		t.Fatal(err)
	}
	server := NewServer(db)
	live := serveForTest(t, server)
	connection := connectReconnectControlDevice(t, live, session.ID, answers)
	return reconnectControlFixture{server: server, live: live, connection: connection, session: session}
}

func connectReconnectControlDevice(t *testing.T, live *httptest.Server, sessionID string, answers map[string]fakeAnswer) *fakeDevice {
	t.Helper()
	return connectFakeDevice(t, live, "", map[string]any{
		"activeSessionIds": []string{sessionID},
		"device":           map[string]any{"id": "dev_queue", "label": "Queue Device", "status": "connected", "lastSeenLabel": "online"},
		"workspace":        map[string]any{"id": "ws_queue", "name": "Queue", "localPath": t.TempDir(), "baseline": "main"},
		"providerHealth":   []map[string]any{},
		"assets":           []map[string]any{},
		"agents": []map[string]any{{
			"id": "agent_queue", "workspaceId": "ws_queue", "deviceId": "dev_queue", "deviceLabel": "Queue Device",
			"provider": "claude", "status": "healthy", "authMode": "local_config", "secretStored": "local",
			"configScope": "workspace", "configLabel": "device local login", "lastSeenLabel": "online",
		}},
	}, answers)
}

func TestSteerWaitsForReconnectingDevice(t *testing.T) {
	shortenDeviceReconnectGrace(t, 2*time.Second)
	shortenDeviceReconnectWait(t, 2*time.Second)
	f := newReconnectControlFixture(t, map[string]fakeAnswer{
		wsSteerSessionType: func(payload json.RawMessage) (string, any) {
			var steer wsSteerSessionPayload
			_ = json.Unmarshal(payload, &steer)
			return wsSessionSteeredType, map[string]any{"sessionId": steer.SessionID, "inputId": steer.InputID}
		},
	})
	f.connection.conn.Close()
	waitFor(t, "the device to enter reconnect grace", func() bool {
		return f.server.hub.deviceConnection("dev_queue").State == resources.ConnectionReconnecting
	})

	result := make(chan error, 1)
	go func() {
		_, err := f.server.sessionService.Send(context.Background(), f.session.ID, store.SendAgentSessionInput{Prompt: "steer after reconnect"}, nil)
		result <- err
	}()
	select {
	case err := <-result:
		t.Fatalf("steer returned before reconnect: %v", err)
	case <-time.After(40 * time.Millisecond):
	}

	second := connectReconnectControlDevice(t, f.live, f.session.ID, map[string]fakeAnswer{
		wsSteerSessionType: func(payload json.RawMessage) (string, any) {
			var steer wsSteerSessionPayload
			_ = json.Unmarshal(payload, &steer)
			return wsSessionSteeredType, map[string]any{"sessionId": steer.SessionID, "inputId": steer.InputID}
		},
	})
	select {
	case err := <-result:
		if err != nil {
			t.Fatalf("steer after reconnect: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("steer did not continue after reconnect")
	}
	if received := second.received(wsSteerSessionType); len(received) != 1 {
		t.Fatalf("device received %d steers, want 1", len(received))
	}
}

func TestCancelWaitsForReconnectingDevice(t *testing.T) {
	shortenDeviceReconnectGrace(t, 2*time.Second)
	shortenDeviceReconnectWait(t, 2*time.Second)
	f := newReconnectControlFixture(t, map[string]fakeAnswer{
		wsCancelSessionType: func(payload json.RawMessage) (string, any) {
			var cancel wsCancelSessionPayload
			_ = json.Unmarshal(payload, &cancel)
			return wsSessionCanceledType, map[string]any{"sessionId": cancel.SessionID, "inputId": cancel.InputID}
		},
	})
	f.connection.conn.Close()
	waitFor(t, "the device to enter reconnect grace", func() bool {
		return f.server.hub.deviceConnection("dev_queue").State == resources.ConnectionReconnecting
	})

	result := make(chan error, 1)
	go func() {
		_, err := f.server.sessionService.Cancel(context.Background(), f.session.ID, "")
		result <- err
	}()
	select {
	case err := <-result:
		t.Fatalf("cancel returned before reconnect: %v", err)
	case <-time.After(40 * time.Millisecond):
	}

	second := connectReconnectControlDevice(t, f.live, f.session.ID, map[string]fakeAnswer{
		wsCancelSessionType: func(payload json.RawMessage) (string, any) {
			var cancel wsCancelSessionPayload
			_ = json.Unmarshal(payload, &cancel)
			return wsSessionCanceledType, map[string]any{"sessionId": cancel.SessionID, "inputId": cancel.InputID}
		},
	})
	select {
	case err := <-result:
		if err != nil {
			t.Fatalf("cancel after reconnect: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("cancel did not continue after reconnect")
	}
	if received := second.received(wsCancelSessionType); len(received) != 1 {
		t.Fatalf("device received %d cancels, want 1", len(received))
	}
}
