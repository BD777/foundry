package httpapi

import (
	"context"
	"encoding/json"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestWorkspaceInspectionUsesRegisteredDeviceAndExplicitRescan(t *testing.T) {
	db := newTestStore(t)
	reg := store.DaemonRegistration{Device: store.DeviceProjection{ID: "inspection-device"}, Workspace: store.WorkspaceProjection{ID: "ws_inspection", LocalPath: "/only-on-device"}}
	if err := db.RegisterDaemon(context.Background(), reg); err != nil {
		t.Fatal(err)
	}
	server := NewServer(db)
	request := func(method, path string) *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		server.Routes().ServeHTTP(w, httptest.NewRequest(method, path, nil))
		return w
	}
	path := "/api/workspaces/ws_inspection/inspection"
	if response := request(http.MethodGet, path); response.Code != http.StatusServiceUnavailable {
		t.Fatalf("offline status %d", response.Code)
	}
	connection := &daemonConnection{hub: server.hub, done: make(chan struct{}), send: make(chan wsEnvelope, 4), rpc: newDaemonRPC()}
	server.hub.connections[reg.Device.ID] = connection
	for _, rescan := range []bool{false, true} {
		method, url := http.MethodGet, path
		if rescan {
			method = http.MethodPost
			url += "/rescan"
		}
		done := make(chan *httptest.ResponseRecorder, 1)
		go func() { done <- request(method, url) }()
		var envelope wsEnvelope
		select {
		case envelope = <-connection.send:
		case <-time.After(time.Second):
			t.Fatal("no workspace inspection request")
		}
		var payload struct {
			WorkspaceID string `json:"workspaceId"`
			Rescan      bool   `json:"rescan"`
		}
		if err := json.Unmarshal(envelope.Payload, &payload); err != nil {
			t.Fatal(err)
		}
		if envelope.Type != wsInspectWorkspaceType || payload.WorkspaceID != reg.Workspace.ID || payload.Rescan != rescan {
			t.Fatalf("wrong inspection request: %s", envelope.Payload)
		}
		connection.rpc.resolve(envelope.ID, json.RawMessage(`{"inspection":{"workspaceId":"ws_inspection","gitState":"not_git","repositories":[]}}`))
		response := <-done
		if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"gitState":"not_git"`) {
			t.Fatalf("invalid inspection response: %s", response.Body.String())
		}
	}
}
