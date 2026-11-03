package httpapi

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/wirerecord"
	"github.com/gorilla/websocket"
)

// A server given a recording directory samples the daemon socket both ways
// and the device REST routes; the planted credential and tokens never reach
// the file, and the report finds the field no Go type declares.
func TestWireRecordingSamplesDeviceTrafficWithoutSecrets(t *testing.T) {
	const credential = "fdyd_Pl4nt3dCr3d3nt14lV4lu3XyZ0987"
	const pairingToken = "pair_Pl4nt3dP41r1ngT0k3nAbC123"
	dir := t.TempDir()
	options := DefaultServerOptions()
	options.WireRecordDir = dir
	server := withTestOwner(NewServerWithOptions(newEmptyTestStore(t), options))
	httpServer := serveForTest(t, server)
	url := "ws" + strings.TrimPrefix(httpServer.URL, "http") + "/api/daemon/ws"

	conn, _, err := websocket.DefaultDialer.Dial(url, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	writeWSForTest(t, conn, "hello", map[string]any{
		"device":     map[string]any{"id": "dev_wire", "label": "dev_wire"},
		"credential": credential,
	})
	readWSTypeForTest(t, conn, "registered")
	writeWSIDForTest(t, conn, "beat", wsHeartbeatType, map[string]any{})
	readAckForTest(t, conn, "beat")

	response, err := http.Post(httpServer.URL+"/api/daemon/pair", "application/json",
		strings.NewReader(`{"token":"`+pairingToken+`","deviceId":"dev_wire","workerFingerprint":"fp"}`))
	if err != nil {
		t.Fatal(err)
	}
	_ = response.Body.Close()
	_ = conn.Close()
	if err := server.Shutdown(t.Context()); err != nil {
		t.Fatal(err)
	}

	path := filepath.Join(dir, wirerecord.FileName)
	written, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	for _, secret := range []string{credential, pairingToken} {
		if strings.Contains(string(written), secret) {
			t.Fatalf("a planted secret was recorded:\n%s", written)
		}
	}
	report, err := wireDriftReport(path)
	if err != nil {
		t.Fatal(err)
	}
	kinds := map[string]wirerecord.KindReport{}
	for _, kind := range report.Kinds {
		kinds[kind.Channel+" "+kind.Dir+" "+kind.Kind] = kind
	}
	for _, want := range []string{"ws in hello", "ws out registered", "ws in heartbeat", "ws out ack", "rest  POST /api/daemon/pair"} {
		if kinds[want].Samples == 0 {
			t.Fatalf("no %s recorded; kinds: %v", want, kinds)
		}
	}
	hello := kinds["ws in hello"]
	found := false
	for _, issue := range hello.Issues {
		found = found || issue.Kind == "unknown" && issue.Path == "payload.credential"
	}
	if hello.Declared != "store.DaemonRegistration" || !found {
		t.Fatalf("hello report = %+v", hello)
	}
	if pair := kinds["rest  POST /api/daemon/pair"]; pair.Statuses["401"] != 1 {
		t.Fatalf("pair report = %+v", pair)
	}
}
