package httpapi

import (
	"context"
	"net/http/httptest"
	"testing"
	"time"
)

// A device with no workspace yet (one just paired) registers itself alone.
// When its connection ends it reads offline, not Online forever, and keeps
// what it reported about its login service (DEV-088).
func TestWorkspacelessDeviceGoesOfflineWhenItsConnectionEnds(t *testing.T) {
	db := newTestStore(t)
	server := NewServer(db)
	httpServer := httptest.NewServer(server.Routes())
	defer httpServer.Close()

	conn := dialDaemonForTest(t, httpServer)
	writeWSForTest(t, conn, "hello", map[string]any{
		"capabilities":     []string{},
		"activeSessionIds": []string{},
		"device": map[string]any{
			"id": "dev_new", "label": "new-box", "status": "connected",
			"system": map[string]any{
				"hostname": "new-box", "os": "Debian GNU/Linux", "arch": "x64",
				"memoryBytes": 2 << 30, "swapBytes": 0,
				"service": map[string]any{"manager": "systemd", "unit": "foundry-worker.service", "installed": true, "linger": false},
			},
		},
	})
	readWSTypeForTest(t, conn, "registered")

	status := func() (string, string, bool) {
		devices, err := db.ListDevices(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		for _, device := range devices {
			if device.ID == "dev_new" {
				linger := device.System != nil && device.System.Service != nil &&
					device.System.Service.Linger != nil && !*device.System.Service.Linger
				return device.Status, device.LastSeenAt, linger
			}
		}
		t.Fatal("paired device not listed")
		return "", "", false
	}
	if got, _, linger := status(); got != deviceStatusConnected || !linger {
		t.Fatalf("after hello: status %q, linger-off kept %v", got, linger)
	}

	conn.Close()
	deadline := time.Now().Add(3 * time.Second)
	for {
		got, seen, linger := status()
		if got == "disconnected" {
			if seen == "" {
				t.Fatal("offline device has no lastSeenAt")
			}
			if !linger {
				t.Fatal("going offline dropped the reported service state")
			}
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("workspace-less device still %q after its connection ended", got)
		}
		time.Sleep(20 * time.Millisecond)
	}
}
