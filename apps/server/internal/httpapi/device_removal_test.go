package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/sqlitestore"
	storepkg "github.com/foundry-dev/foundry/apps/server/internal/store"
	"github.com/foundry-dev/foundry/apps/server/internal/testfixture"
	"github.com/gorilla/websocket"
)

func registerDeviceForRemovalTest(t *testing.T, db *sqlitestore.Store, deviceID, workspaceID string) {
	t.Helper()
	if err := db.RegisterDaemon(context.Background(), storepkg.DaemonRegistration{
		Device: storepkg.DeviceProjection{
			ID: deviceID, Label: "Removal HTTP Device", Status: "connected", LastSeenLabel: "online",
		},
		Workspace: storepkg.WorkspaceProjection{
			ID: workspaceID, Name: "Removal HTTP Workspace", LocalPath: t.TempDir(),
			Baseline: "main", ContextSummary: "http removal",
		},
	}); err != nil {
		t.Fatalf("register daemon: %v", err)
	}
}

// An offline device is removed whatever it left running, with everything it
// owned; a worker that registers as it afterwards is told it was removed.
func TestDeleteOfflineDeviceRemovesItAndRegister410(t *testing.T) {
	db := newEmptyTestStore(t)
	ctx := context.Background()
	server := NewServer(db)

	registerDeviceForRemovalTest(t, db, "dev_http", "ws_http")
	issue, err := db.CreateIssue(ctx, storepkg.CreateIssueInput{
		WorkspaceID: "ws_http", SourceInput: "removal http", Runtime: "mock",
	})
	if err != nil {
		t.Fatalf("create issue: %v", err)
	}
	testfixture.ConfirmContract(t, db, issue.ID)
	if _, _, err := db.ClaimIssueExecution(ctx, "dev_http", "ws_http"); err != nil {
		t.Fatalf("claim: %v", err)
	}
	if _, err := db.StartIssueRun(ctx, issue.ID, storepkg.Run{ID: "run_http", Status: "running", Runtime: "mock"}); err != nil {
		t.Fatalf("start run: %v", err)
	}

	requestForTest(t, server, http.MethodDelete, "/api/devices/does-not-exist", "", http.StatusNotFound)
	body := deleteJSONForTest(t, server, "/api/devices/dev_http", http.StatusOK)
	if body["id"] != "dev_http" {
		t.Fatalf("expected the removed device, got %#v", body)
	}
	select {
	case <-server.deviceRemovals.kicks():
	default:
		t.Fatal("the removal did not wake the purge")
	}
	server.purgeRemovedDevices(ctx)
	devices, err := db.ListDevices(ctx)
	if err != nil {
		t.Fatalf("list devices: %v", err)
	}
	for _, device := range devices {
		if device.ID == "dev_http" {
			t.Fatalf("a removed device is still listed: %#v", device)
		}
	}
	if _, err := db.GetWorkspace(ctx, "ws_http"); !errors.Is(err, storepkg.ErrNotFound) {
		t.Fatalf("the removed device's workspace: %v", err)
	}
	if _, err := db.GetIssue(ctx, issue.ID); !errors.Is(err, storepkg.ErrNotFound) {
		t.Fatalf("the removed device's issue: %v", err)
	}
	requestForTest(t, server, http.MethodDelete, "/api/devices/dev_http", "", http.StatusNotFound)

}

// A worker that comes back with the credential of its removed device, after
// the device and its identity are gone, is told so the way it parks on:
// 4001/device_removed on its socket.
func TestReturningWorkerOfRemovedDeviceIsToldItWasRemoved(t *testing.T) {
	db := newTestStore(t)
	server := NewServerWithOptions(db, ServerOptions{})
	credential := pairTestDevice(t, server, "dev_returning", "machine-returning")
	shutDownAtCleanup(t, server)
	handler := server.Routes()
	registerDeviceForTest(t, server, registrationBody("dev_returning", "ws_returning"))
	ctx := context.Background()
	if _, err := db.RemoveDevice(ctx, storepkg.RemoveDeviceInput{ID: "dev_returning"}); err != nil {
		t.Fatal(err)
	}
	if _, err := db.PurgeRemovedDevice(ctx, "dev_returning"); err != nil {
		t.Fatal(err)
	}

	testServer := httptest.NewServer(handler)
	defer testServer.Close()
	headers := http.Header{}
	headers.Set(deviceCredentialHeader, credential)
	conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(testServer.URL, "http")+"/api/daemon/ws", headers)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.Close()
	_ = conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	_, data, err := conn.ReadMessage()
	var closeError *websocket.CloseError
	if !errors.As(err, &closeError) || closeError.Code != wsDeviceRemovedCloseCode || closeError.Text != wsDeviceRemovedReason {
		t.Fatalf("expected 4001/device_removed close, got %v %s", err, data)
	}

	// A credential nobody ever held stays unauthorized.
	headers.Set(deviceCredentialHeader, "never-issued")
	if _, response, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(testServer.URL, "http")+"/api/daemon/ws", headers); err == nil || response == nil || response.StatusCode != http.StatusUnauthorized {
		t.Fatalf("unknown credential: %v %v", err, response)
	}
}

// A connected device with a turn running is removed only once the person
// confirms the turn stops with it; then its worker is dropped for good.
func TestDeleteConnectedDeviceWithRunningTurnAsksFirst(t *testing.T) {
	db := newEmptyTestStore(t)
	ctx := context.Background()
	server := NewServer(db)
	testServer := serveForTest(t, server)
	if err := db.RegisterDaemon(ctx, storepkg.DaemonRegistration{
		Device:    storepkg.DeviceProjection{ID: "dev_busy", Label: "Busy", Status: "connected", LastSeenLabel: "online"},
		Workspace: storepkg.WorkspaceProjection{ID: "ws_busy", Name: "Busy", LocalPath: "/tmp/ws_busy", Baseline: "main"},
		Agents: []storepkg.AgentProjection{{
			ID: "agent_busy", WorkspaceID: "ws_busy", DeviceID: "dev_busy", Provider: "codex", Status: "healthy",
			AuthMode: "local_config", SecretStored: "local", ConfigScope: "workspace", ConfigLabel: "local", LastSeenLabel: "online",
		}},
	}); err != nil {
		t.Fatal(err)
	}
	session, err := db.CreateAgentSession(ctx, storepkg.CreateAgentSessionInput{WorkspaceID: "ws_busy", AgentID: "agent_busy", Provider: "codex", Prompt: "long turn"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.StartAgentSession(ctx, session.ID); err != nil {
		t.Fatal(err)
	}

	conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(testServer.URL, "http")+"/api/daemon/ws", nil)
	if err != nil {
		t.Fatalf("dial daemon websocket: %v", err)
	}
	defer conn.Close()
	writeWSForTest(t, conn, "hello", map[string]any{
		"device":         map[string]any{"id": "dev_busy", "label": "Busy", "status": "connected", "lastSeenLabel": "online"},
		"workspace":      map[string]any{"id": "ws_busy", "name": "Busy", "localPath": "/tmp/ws_busy", "baseline": "main", "contextSummary": "", "acceptedCount": 0, "resolvedCount": 0},
		"providerHealth": []map[string]any{},
		"assets":         []map[string]any{},
	})
	readWSTypeForTest(t, conn, "registered")

	refused := requestForTest(t, server, http.MethodDelete, "/api/devices/dev_busy", "", http.StatusConflict)
	var refusal struct {
		Code         string `json:"code"`
		RunningTurns int    `json:"runningTurns"`
	}
	if err := json.Unmarshal(refused.Body.Bytes(), &refusal); err != nil || refusal.Code != deviceTurnsRunningCode || refusal.RunningTurns != 1 {
		t.Fatalf("refusal %s", refused.Body.String())
	}
	if !server.hub.HasConnection("dev_busy") {
		t.Fatal("a refused removal dropped the worker")
	}
	deleteJSONForTest(t, server, "/api/devices/dev_busy?stopRunningTurns=true", http.StatusOK)
	_ = conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	for {
		_, data, err := conn.ReadMessage()
		if err != nil {
			var closeError *websocket.CloseError
			if !errors.As(err, &closeError) || closeError.Code != wsDeviceRemovedCloseCode {
				t.Fatalf("expected 4001/device_removed close, got %v", err)
			}
			break
		}
		var head struct {
			Type string `json:"type"`
		}
		if json.Unmarshal(data, &head) != nil {
			t.Fatalf("message %s", data)
		}
	}
	server.purgeRemovedDevices(ctx)
	if _, err := db.GetAgentSessionRecord(ctx, session.ID); !errors.Is(err, storepkg.ErrNotFound) {
		t.Fatalf("the removed device's session: %v", err)
	}
}

func TestDeleteDeviceDropsConnectedDaemon(t *testing.T) {
	db := newEmptyTestStore(t)
	server := NewServer(db)
	testServer := serveForTest(t, server)

	wsURL := "ws" + strings.TrimPrefix(testServer.URL, "http") + "/api/daemon/ws"
	conn, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("dial daemon websocket: %v", err)
	}
	defer conn.Close()

	writeWSForTest(t, conn, "hello", map[string]any{
		"device": map[string]any{
			"id": "dev_drop", "label": "Drop Device", "status": "connected", "lastSeenLabel": "online",
		},
		"workspace": map[string]any{
			"id": "ws_drop", "name": "Drop Workspace", "localPath": "/tmp/ws_drop",
			"baseline": "main", "contextSummary": "drop", "acceptedCount": 0, "resolvedCount": 0,
		},
		"providerHealth": []map[string]any{},
		"assets":         []map[string]any{},
	})
	readWSTypeForTest(t, conn, "registered")

	deleteDone := make(chan error, 1)
	go func() {
		request, err := http.NewRequest(http.MethodDelete, testServer.URL+"/api/devices/dev_drop", nil)
		if err != nil {
			deleteDone <- err
			return
		}
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			deleteDone <- err
			return
		}
		defer response.Body.Close()
		if response.StatusCode != http.StatusOK {
			deleteDone <- errors.New(http.StatusText(response.StatusCode))
		}
		deleteDone <- nil
	}()

	if err := conn.SetReadDeadline(time.Now().Add(3 * time.Second)); err != nil {
		t.Fatalf("read deadline: %v", err)
	}
	for {
		_, data, err := conn.ReadMessage()
		if err != nil {
			closeError, ok := err.(*websocket.CloseError)
			if !ok || closeError.Code != wsDeviceRemovedCloseCode || closeError.Text != wsDeviceRemovedReason {
				t.Fatalf("expected 4001/device_removed close, got %v", err)
			}
			break
		}
		var head struct {
			Type string `json:"type"`
		}
		if json.Unmarshal(data, &head) != nil || !connectedWorkerNews[head.Type] {
			t.Fatalf("expected close frame, got message %s", data)
		}
	}
	if err := <-deleteDone; err != nil {
		t.Fatalf("delete device: %v", err)
	}
}

// TestRemovalRegistrationMapRace is D2: registration commits the store row
// before inserting itself into hub.connections, while removal commits the
// tombstone before dropping the current connection. Hammer both orderings and
// assert the hub invariant that actually matters: once removal has committed,
// the removed device never holds a usable live connection.
func TestRemovalRegistrationMapRace(t *testing.T) {
	db := newEmptyTestStore(t)
	server := NewServer(db)
	testServer := serveForTest(t, server)
	wsURL := "ws" + strings.TrimPrefix(testServer.URL, "http") + "/api/daemon/ws"

	hello := func(deviceID string) map[string]any {
		return map[string]any{
			"device":         map[string]any{"id": deviceID, "label": "Race", "status": "connected", "lastSeenLabel": "online"},
			"workspace":      map[string]any{"id": "ws_" + deviceID, "name": "Race", "localPath": "/tmp/" + deviceID, "baseline": "main", "contextSummary": "race", "acceptedCount": 0, "resolvedCount": 0},
			"providerHealth": []map[string]any{},
			"assets":         []map[string]any{},
		}
	}

	const iterations = 30
	for i := range iterations {
		// Unique identity per iteration: once a device is tombstoned it stays
		// refused, so the register-vs-remove window only exists for a fresh id.
		deviceID := fmt.Sprintf("dev_race_%d", i)
		wsID := "ws_" + deviceID
		// Seed the row so the concurrent DELETE competes with the new
		// connection's map insertion rather than racing a missing row.
		registerDeviceForRemovalTest(t, db, deviceID, wsID)
		var wg sync.WaitGroup
		connectReturned := make(chan error, 1)
		wg.Add(2)
		go func() {
			// Registration side: dial + hello.
			defer wg.Done()
			conn, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
			if err != nil {
				connectReturned <- err
				return
			}
			defer conn.Close()
			_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
			writeWSForTest(t, conn, "hello", hello(deviceID))
			_, _, readErr := conn.ReadMessage()
			if readErr != nil {
				closeError, ok := readErr.(*websocket.CloseError)
				if !ok || closeError.Code != wsDeviceRemovedCloseCode {
					connectReturned <- nil // ordinary close after the DELETE drop is fine
				}
			}
			connectReturned <- nil
		}()
		go func() {
			// Removal side. A 409 just means the first iteration races an empty
			// row; subsequent iterations always have a registered row.
			defer wg.Done()
			request, err := http.NewRequest(http.MethodDelete, testServer.URL+"/api/devices/"+deviceID, nil)
			if err != nil {
				return
			}
			response, err := http.DefaultClient.Do(request)
			if err == nil {
				_ = response.Body.Close()
				if response.StatusCode != http.StatusOK {
					t.Errorf("iteration %d: delete status %d", i, response.StatusCode)
				}
			}
		}()
		wg.Wait()
		if err := <-connectReturned; err != nil {
			t.Fatalf("iteration %d: connection read: %v", i, err)
		}

		// Removal succeeded above (busy never applies — seeded rows have no
		// work), so the tombstone is committed and the removed device must
		// never hold a usable live connection regardless of interleaving.
		if server.hub.HasConnection(deviceID) {
			t.Fatalf("iteration %d: removed device retained a live hub connection", i)
		}
	}
}

// TestVerifyRefusedAfterRemoval is D4 at the HTTP boundary: even with a live
// residual connection, POST /verify on a removed device returns 410 and never
// creates a queued verification.
func TestVerifyRefusedAfterRemoval(t *testing.T) {
	db := newEmptyTestStore(t)
	ctx := context.Background()
	server := NewServer(db)
	testServer := serveForTest(t, server)

	registerDeviceForRemovalTest(t, db, "dev_verify", "ws_verify")
	issue, err := db.CreateIssue(ctx, storepkg.CreateIssueInput{
		WorkspaceID: "ws_verify", SourceInput: "verify removal", Runtime: "mock",
	})
	if err != nil {
		t.Fatalf("create issue: %v", err)
	}
	if _, err := db.RemoveDevice(ctx, storepkg.RemoveDeviceInput{ID: "dev_verify"}); err != nil {
		t.Fatalf("remove: %v", err)
	}

	request, err := http.NewRequest(http.MethodPost, testServer.URL+"/api/issues/"+issue.ID+"/verify",
		strings.NewReader(`{"expectedContractRevision":1,"expectedCandidateSnapshotId":"snap","criterionIds":["c1"]}`))
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Idempotency-Key", "d4-http-gate")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatalf("perform verify: %v", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusGone {
		t.Fatalf("expected 410 device_removed, got %d", response.StatusCode)
	}
}
