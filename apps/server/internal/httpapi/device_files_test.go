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

// connectDeviceFilesWorkerForTest opens alice's device socket as a worker
// that serves device files.
func connectDeviceFilesWorkerForTest(t *testing.T, f isolationFixture, live *httptest.Server) *websocket.Conn {
	t.Helper()
	headers := http.Header{}
	headers.Set(deviceCredentialHeader, f.aliceDevice)
	conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(live.URL, "http")+"/api/daemon/ws", headers)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	t.Cleanup(func() { conn.Close() })
	_ = conn.SetReadDeadline(time.Now().Add(10 * time.Second))
	writeWSForTest(t, conn, "hello", map[string]any{
		"capabilities":   []string{deviceFilesCapability, fileDownloadCapability},
		"device":         map[string]any{"id": "dev_alice", "label": "Alice's laptop", "status": "connected", "lastSeenLabel": "online"},
		"workspace":      map[string]any{"id": "ws_alice", "name": "W", "localPath": "/tmp/w", "baseline": "main"},
		"providerHealth": []map[string]any{},
		"assets":         []map[string]any{},
		"agents": []map[string]any{{
			"id": "agent_alice", "workspaceId": "ws_alice", "deviceId": "dev_alice", "deviceLabel": "Alice's laptop",
			"provider": "claude", "status": "healthy", "authMode": "local_config", "secretStored": "local",
			"configScope": "workspace", "configLabel": "device local login", "lastSeenLabel": "online",
		}},
	})
	readWSTypeForTest(t, conn, "registered")
	return conn
}

func TestDeviceFilesOpenOnlyForTheDevicesOwner(t *testing.T) {
	f := newIsolationFixture(t)
	live := httptest.NewServer(f.handler)
	defer live.Close()
	conn := connectDeviceFilesWorkerForTest(t, f, live)
	// bob works in alice's workspace, but the device is not his.
	expectStatus(t, doAuthCall(t, f.handler, f.as(f.alice, http.MethodPost, "/api/workspaces/ws_alice/members", `{"username":"bob","role":"member"}`)),
		http.StatusNoContent, "share the workspace with bob")

	key := "~/.local/share/app/app.key"
	files := "/api/devices/dev_alice/files?path=" + url.QueryEscape(key)
	call := func(session, path string, intent bool) *httptest.ResponseRecorder {
		c := f.as(session, http.MethodGet, path, "")
		if intent {
			c.headers[deviceFileIntentHeader] = deviceFileIntent
		}
		return doAuthCall(t, f.handler, c)
	}
	// relay answers the device's side of one request and returns the response.
	relay := func(session, path string, answer map[string]any, check func(map[string]any)) *httptest.ResponseRecorder {
		done := make(chan *httptest.ResponseRecorder, 1)
		go func() { done <- call(session, path, true) }()
		var request map[string]any
		id := readWSUntilForTest(t, conn, wsReadDeviceFileType, &request)
		if check != nil {
			check(request)
		}
		writeWSIDForTest(t, conn, id, wsDeviceFileReadType, answer)
		return <-done
	}

	// Refused before the device is asked.
	if got := call(f.alice, files, false); got.Code != http.StatusForbidden || !strings.Contains(got.Body.String(), "intent_required") {
		t.Fatalf("without the app's header: %d %s", got.Code, got.Body.String())
	}
	if got := call(f.bob, files, true).Code; got != http.StatusNotFound {
		t.Fatalf("a member who does not own the device: %d, want 404", got)
	}
	session, err := f.server.store.CreateAgentSession(context.Background(), store.CreateAgentSessionInput{
		AgentID: "agent_alice", WorkspaceID: "ws_alice", Provider: "claude", Prompt: "read my key", Source: "chat", CreatedByUserID: f.aliceID,
	})
	if err != nil {
		t.Fatal(err)
	}
	token, err := f.server.store.MintAgentSessionToken(context.Background(), session.ID)
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodGet, files, nil)
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set(deviceFileIntentHeader, deviceFileIntent)
	tokenCall := httptest.NewRecorder()
	f.handler.ServeHTTP(tokenCall, request)
	if tokenCall.Code != http.StatusForbidden {
		t.Fatalf("a session token: %d, want 403", tokenCall.Code)
	}

	// The owner: a secret comes masked, then revealed on request.
	masked := relay(f.alice, files, map[string]any{"path": key, "kind": "file", "bytes": 12, "sensitive": true}, func(request map[string]any) {
		if request["path"] != key || request["mode"] != "read" {
			t.Fatalf("relayed request = %v", request)
		}
	})
	expectStatus(t, masked, http.StatusOK, "masked read")
	if masked.Header().Get("Cache-Control") != "no-store" || strings.Contains(masked.Body.String(), "content") {
		t.Fatalf("masked read: %v %s", masked.Header(), masked.Body.String())
	}
	revealed := relay(f.alice, files+"&mode=reveal&purpose=copy", map[string]any{"path": key, "kind": "file", "sensitive": true, "content": "sk-live-123\n"}, func(request map[string]any) {
		if request["mode"] != "reveal" {
			t.Fatalf("reveal request = %v", request)
		}
	})
	expectStatus(t, revealed, http.StatusOK, "reveal")
	if !strings.Contains(revealed.Body.String(), "sk-live-123") {
		t.Fatalf("revealed: %s", revealed.Body.String())
	}
	denied := relay(f.alice, "/api/devices/dev_alice/files?path="+url.QueryEscape("~/.ssh/id_ed25519"), map[string]any{"path": "~/.ssh/id_ed25519", "kind": "denied"}, nil)
	if denied.Code != http.StatusForbidden || !strings.Contains(denied.Body.String(), "file_denied") {
		t.Fatalf("credential store: %d %s", denied.Code, denied.Body.String())
	}
	missing := relay(f.alice, "/api/devices/dev_alice/files?path=%2Fnope", map[string]any{"path": "/nope", "kind": "missing"}, nil)
	expectStatus(t, missing, http.StatusNotFound, "missing file")
	download := relay(f.alice, "/api/devices/dev_alice/files/download?path="+url.QueryEscape(key),
		map[string]any{"path": key, "kind": "file", "sensitive": true, "code": "sensitive", "error": "a file that looks like a secret is not downloaded"}, func(request map[string]any) {
			if request["download"] == nil {
				t.Fatalf("download request = %v", request)
			}
		})
	if download.Code != http.StatusForbidden || !strings.Contains(download.Body.String(), "file_sensitive") {
		t.Fatalf("secret download: %d %s", download.Code, download.Body.String())
	}

	// The record keeps who opened what, never contents.
	records, err := f.server.store.ListDeviceFileAccess(context.Background(), "dev_alice", 10)
	if err != nil {
		t.Fatal(err)
	}
	actions := []string{}
	for _, record := range records {
		actions = append(actions, record.Action+":"+record.Result)
		if record.UserID != f.aliceID {
			t.Fatalf("record user = %q", record.UserID)
		}
	}
	if strings.Join(actions, ",") != "download:requested,read:missing,read:denied,copy:file,read:file" {
		t.Fatalf("records = %v", actions)
	}
	encoded, _ := json.Marshal(records)
	if strings.Contains(string(encoded), "sk-live") {
		t.Fatalf("a record holds contents: %s", encoded)
	}

	// The owner's switch: only the owner turns it; off refuses before the device.
	switchPath := "/api/devices/dev_alice/outside-files"
	if got := doAuthCall(t, f.handler, f.as(f.bob, http.MethodPut, switchPath, `{"enabled":false}`)).Code; got != http.StatusNotFound {
		t.Fatalf("bob turns alice's switch: %d, want 404", got)
	}
	expectStatus(t, doAuthCall(t, f.handler, f.as(f.alice, http.MethodPut, switchPath, `{"enabled":false}`)), http.StatusOK, "turn off")
	if got := call(f.alice, files, true); got.Code != http.StatusForbidden || !strings.Contains(got.Body.String(), "device_files_off") {
		t.Fatalf("switched off: %d %s", got.Code, got.Body.String())
	}
	var devices []store.DeviceProjection
	_ = json.Unmarshal(doAuthCall(t, f.handler, f.as(f.alice, http.MethodGet, "/api/devices", "")).Body.Bytes(), &devices)
	for _, device := range devices {
		if device.ID == "dev_alice" && !device.OutsideFilesOff {
			t.Fatalf("alice's device projection = %+v", device)
		}
	}
	expectStatus(t, doAuthCall(t, f.handler, f.as(f.alice, http.MethodPut, switchPath, `{"enabled":true}`)), http.StatusOK, "turn on")
}
