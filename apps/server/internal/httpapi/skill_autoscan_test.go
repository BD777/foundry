package httpapi

import (
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// A worker's skills are scanned as soon as it connects.
func TestConnectedWorkerSkillsAreScanned(t *testing.T) {
	server := NewServer(newEmptyTestStore(t))
	httpServer := httptest.NewServer(server.Routes())
	defer httpServer.Close()
	conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(httpServer.URL, "http")+"/api/daemon/ws", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	writeWSForTest(t, conn, "hello", map[string]any{
		"device":    map[string]any{"id": "dev_scan", "label": "Scan test", "status": "connected"},
		"workspace": map[string]any{"id": "ws_scan", "name": "Scan test", "localPath": "/tmp/scan", "baseline": "main"},
	})
	readWSTypeForTest(t, conn, "registered")
	_ = conn.SetReadDeadline(time.Now().Add(time.Second))
	for {
		var request wsEnvelope
		if err := conn.ReadJSON(&request); err != nil {
			t.Fatalf("no scan on connect: %v", err)
		}
		if request.Type == wsScanSkillsType {
			var payload wsScanSkillsPayload
			_ = json.Unmarshal(request.Payload, &payload)
			if len(payload.Roots) == 0 {
				t.Fatal("scan request named no folders")
			}
			return
		}
	}
}
