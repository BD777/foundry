package httpapi

import (
	"context"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gorilla/websocket"
)

// A new device connects before it has any workspace: it is online, reports
// its runtimes, and no workspace is invented for it.
func TestDeviceConnectsWithoutAWorkspace(t *testing.T) {
	db := newEmptyTestStore(t)
	server := NewServer(db)
	httpServer := httptest.NewServer(server.Routes())
	defer httpServer.Close()
	conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(httpServer.URL, "http")+"/api/daemon/ws", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	writeWSForTest(t, conn, "hello", map[string]any{
		"device":         map[string]any{"id": "dev_new", "label": "New laptop", "status": "connected"},
		"providerHealth": []map[string]any{{"provider": "codex", "status": "healthy", "authMode": "local_config", "secretStored": "local"}},
	})
	readWSTypeForTest(t, conn, "registered")

	devices, err := db.ListDevices(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(devices) != 1 || devices[0].ID != "dev_new" || devices[0].Status != "connected" {
		t.Fatalf("devices = %+v, want dev_new connected", devices)
	}
	workspaces, err := db.ListWorkspaces(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(workspaces) != 0 {
		t.Fatalf("workspaces = %+v, want none", workspaces)
	}
	health, err := db.ListProviderHealth(context.Background(), "dev_new")
	if err != nil {
		t.Fatal(err)
	}
	if len(health) != 1 || health[0].DeviceID != "dev_new" {
		t.Fatalf("provider health = %+v, want the device's codex", health)
	}
}
