package httpapi

import (
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// A worker that scans off its main thread is scanned as soon as it connects;
// an older one is left alone, since an unrequested scan could drop it.
func TestConnectedWorkerSkillsAreScannedOnlyWhenItScansInBackground(t *testing.T) {
	for _, tc := range []struct {
		name         string
		capabilities []string
		wantScan     bool
	}{
		{"background scanner", []string{backgroundSkillScanCapability}, true},
		{"older worker", nil, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			server := NewServer(newEmptyTestStore(t))
			httpServer := httptest.NewServer(server.Routes())
			defer httpServer.Close()
			conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(httpServer.URL, "http")+"/api/daemon/ws", nil)
			if err != nil {
				t.Fatal(err)
			}
			defer conn.Close()
			writeWSForTest(t, conn, "hello", map[string]any{
				"capabilities": tc.capabilities,
				"device":       map[string]any{"id": "dev_scan", "label": "Scan test", "status": "connected"},
				"workspace":    map[string]any{"id": "ws_scan", "name": "Scan test", "localPath": "/tmp/scan", "baseline": "main"},
			})
			readWSTypeForTest(t, conn, "registered")
			_ = conn.SetReadDeadline(time.Now().Add(time.Second))
			scanned := false
			for {
				var request wsEnvelope
				if conn.ReadJSON(&request) != nil {
					break
				}
				if request.Type == wsScanSkillsType {
					var payload wsScanSkillsPayload
					_ = json.Unmarshal(request.Payload, &payload)
					if len(payload.Roots) == 0 {
						t.Fatal("scan request named no folders")
					}
					scanned = true
					break
				}
			}
			if scanned != tc.wantScan {
				t.Fatalf("scanned on connect = %v, want %v", scanned, tc.wantScan)
			}
		})
	}
}
