package httpapi

import (
	"context"
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

func TestDeleteDeviceSoftRemovalAndRegister410(t *testing.T) {
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
	if _, err := db.ClaimNextIssue(ctx, "dev_http", "ws_http"); err != nil {
		t.Fatalf("claim: %v", err)
	}
	run := storepkg.Run{
		ID: "run_http", IssueID: issue.ID, WorkspaceID: "ws_http",
		Status: "running", Runtime: "mock", StartedLabel: "now",
	}
	if _, err := db.StartIssueRun(ctx, issue.ID, run); err != nil {
		t.Fatalf("start run: %v", err)
	}

	// Missing device → 404; busy device → 409.
	requestForTest(t, server, http.MethodDelete, "/api/devices/does-not-exist", "", http.StatusNotFound)
	requestForTest(t, server, http.MethodDelete, "/api/devices/dev_http", "", http.StatusConflict)

	// Finish the work, then removal succeeds.
	if _, err := db.CompleteIssue(ctx, issue.ID, storepkg.CompleteIssueInput{
		RunID: run.ID,
		Artifact: storepkg.AcceptanceArtifact{
			ID: "art_http", IssueID: issue.ID, Kind: "text", Title: "a", Summary: "s",
		},
	}); err != nil {
		t.Fatalf("complete: %v", err)
	}
	body := deleteJSONForTest(t, server, "/api/devices/dev_http", http.StatusOK)
	if body["status"] != "removed" {
		t.Fatalf("expected removed status, got %#v", body)
	}

	// History survives and is still served.
	devices, err := db.ListDevices(ctx)
	if err != nil {
		t.Fatalf("list devices: %v", err)
	}
	found := false
	for _, device := range devices {
		if device.ID == "dev_http" {
			found = true
			if device.Status != "removed" {
				t.Fatalf("removed device projected wrong: %#v", device)
			}
		}
	}
	if !found {
		t.Fatalf("removed device must remain readable for history views")
	}

	// HTTP registration is permanently refused with 410 device_removed.
	recorder := requestForTest(t, server, http.MethodPost, "/api/daemon/register",
		`{"device":{"id":"dev_http","label":"Ghost","status":"connected","lastSeenLabel":"online"},`+
			`"workspace":{"id":"ws_http_ghost","name":"Ghost","localPath":"/tmp/x","baseline":"main","contextSummary":"","acceptedCount":0,"resolvedCount":0}}`,
		http.StatusGone)
	if !strings.Contains(recorder.Body.String(), "device_removed") {
		t.Fatalf("expected device_removed body, got %q", recorder.Body.String())
	}
}

func TestDeleteDeviceDropsConnectedDaemon(t *testing.T) {
	db := newEmptyTestStore(t)
	server := NewServer(db)
	testServer := httptest.NewServer(server.Routes())
	defer testServer.Close()

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
			deleteDone <- &statusError{response.StatusCode}
		}
		deleteDone <- nil
	}()

	if err := conn.SetReadDeadline(time.Now().Add(3 * time.Second)); err != nil {
		t.Fatalf("read deadline: %v", err)
	}
	_, data, err := conn.ReadMessage()
	if err != nil {
		closeError, ok := err.(*websocket.CloseError)
		if !ok || closeError.Code != wsDeviceRemovedCloseCode || closeError.Text != wsDeviceRemovedReason {
			t.Fatalf("expected 4001/device_removed close, got %v", err)
		}
	} else {
		t.Fatalf("expected close frame, got message %s", data)
	}
	if err := <-deleteDone; err != nil {
		t.Fatalf("delete device: %v", err)
	}
}

type statusError struct{ status int }

func (e *statusError) Error() string { return http.StatusText(e.status) }

// TestRemovalRegistrationMapRace is D2: registration commits the store row
// before inserting itself into hub.connections, while removal commits the
// tombstone before dropping the current connection. Hammer both orderings and
// assert the hub invariant that actually matters: once removal has committed,
// the removed device never holds a usable live connection.
func TestRemovalRegistrationMapRace(t *testing.T) {
	db := newEmptyTestStore(t)
	server := NewServer(db)
	testServer := httptest.NewServer(server.Routes())
	defer testServer.Close()
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
	testServer := httptest.NewServer(server.Routes())
	defer testServer.Close()

	registerDeviceForRemovalTest(t, db, "dev_verify", "ws_verify")
	issue, err := db.CreateIssue(ctx, storepkg.CreateIssueInput{
		WorkspaceID: "ws_verify", SourceInput: "verify removal", Runtime: "mock",
	})
	if err != nil {
		t.Fatalf("create issue: %v", err)
	}
	if _, err := db.SoftRemoveDevice(ctx, "dev_verify"); err != nil {
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
