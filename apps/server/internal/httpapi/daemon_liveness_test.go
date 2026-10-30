package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"github.com/gorilla/websocket"
)

// livenessDevice is alice's device on a raw socket the test drives: after
// hello it reads only when told to, so pings go unanswered (the client
// answers a ping only while reading), and it writes what the test writes.
type livenessDevice struct {
	t    *testing.T
	conn *websocket.Conn
}

func connectLivenessDevice(t *testing.T, f isolationFixture, serverURL string) *livenessDevice {
	t.Helper()
	headers := http.Header{}
	headers.Set(deviceCredentialHeader, f.aliceDevice)
	conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(serverURL, "http")+"/api/daemon/ws", headers)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	writeWSForTest(t, conn, "hello", map[string]any{
		"capabilities": []string{store.DaemonCapabilityDeviceConnectors},
		"device":       map[string]any{"id": "dev_alice", "label": "alice-mac", "status": "connected", "lastSeenLabel": "online"},
		"workspace":    map[string]any{"id": "ws_alice", "name": "W", "localPath": "/tmp/w", "baseline": "main"},
	})
	waitFor(t, "the device to connect", func() bool { return f.server.hub.HasConnection("dev_alice") })
	return &livenessDevice{t: t, conn: conn}
}

// answerNext reads until the next connector request and answers it.
func (d *livenessDevice) answerNext() {
	d.t.Helper()
	_ = d.conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	for {
		var envelope wsEnvelope
		if err := d.conn.ReadJSON(&envelope); err != nil {
			d.t.Fatalf("device read: %v", err)
		}
		if envelope.Type != wsConnectorRequestType {
			continue
		}
		state := &store.DeviceConnectorState{Kind: "aws", Status: store.DeviceConnectorNotInstalled}
		if err := d.conn.WriteJSON(map[string]any{"id": envelope.ID, "type": wsConnectorReplyType, "payload": store.ConnectorReplyPayload{State: state}}); err != nil {
			d.t.Fatalf("device write: %v", err)
		}
		return
	}
}

// ask sends a status request to the device, as the Connectors page does.
func askStatus(ctx context.Context, f isolationFixture) (store.ConnectorReplyPayload, error) {
	descriptor, _ := f.server.connectors.Devices.Connector("aws")
	payload, _ := json.Marshal(store.ConnectorRequestPayload{Action: "status", Connector: descriptor})
	return daemonRequest[store.ConnectorReplyPayload](ctx, f.server.hub.connectionFor("dev_alice"), wsConnectorRequestType, payload)
}

func livenessFixture(t *testing.T) (isolationFixture, *httptest.Server) {
	f := newIsolationFixture(t)
	f.server.hub.probeAfter = 300 * time.Millisecond
	f.server.hub.probeWindow = 300 * time.Millisecond
	httpServer := httptest.NewServer(f.handler)
	t.Cleanup(httpServer.Close)
	return f, httpServer
}

// The link stops carrying anything either way (the evidence of the hang:
// "no data from device for 70s" on the server, "last data from server 75s
// before" on the device). A request waiting on it does not wait out its own
// timeout: the server pings, hears nothing, and ends the connection, which
// fails the request at once with the reason.
func TestRequestOnADeadLinkFailsOnceAPingGoesUnanswered(t *testing.T) {
	f, httpServer := livenessFixture(t)
	device := connectLivenessDevice(t, f, httpServer.URL)
	defer device.conn.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	started := time.Now()
	_, err := askStatus(ctx, f)
	elapsed := time.Since(started)
	if err == nil || !strings.Contains(err.Error(), "did not answer a ping") {
		t.Fatalf("err = %v", err)
	}
	if elapsed > 5*time.Second {
		t.Fatalf("the request waited %s on a dead link", elapsed)
	}
	waitFor(t, "the device to be offline", func() bool { return !f.server.hub.HasConnection("dev_alice") })
	// A new request fails fast instead of being sent into the dead socket.
	if _, err := askStatus(ctx, f); err == nil {
		t.Fatal("a request to the dropped device succeeded")
	}
}

// A slow but working uplink: the device is busy sending one large message,
// bytes trickle in for longer than the probe, and its pong waits behind them
// (here the device does not read at all meanwhile). Arriving bytes are proof
// of life, so the connection stays and the request gets its answer.
func TestSlowUplinkIsNotMistakenForADeadLink(t *testing.T) {
	f, httpServer := livenessFixture(t)
	device := connectLivenessDevice(t, f, httpServer.URL)
	defer device.conn.Close()

	type result struct {
		reply store.ConnectorReplyPayload
		err   error
	}
	done := make(chan result, 1)
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		reply, err := askStatus(ctx, f)
		done <- result{reply, err}
	}()

	// One heartbeat, sent a chunk every 100 ms for 2 s: well past the 300 ms
	// probe and its 300 ms window.
	writer, err := device.conn.NextWriter(websocket.TextMessage)
	if err != nil {
		t.Fatalf("writer: %v", err)
	}
	_, _ = writer.Write([]byte(`{"id":"slow","type":"heartbeat","payload":{"pad":"`))
	chunk := []byte(strings.Repeat("x", 4096))
	for i := 0; i < 20; i++ {
		if _, err := writer.Write(chunk); err != nil {
			t.Fatalf("slow write: %v", err)
		}
		time.Sleep(100 * time.Millisecond)
	}
	_, _ = writer.Write([]byte(`"}}`))
	if err := writer.Close(); err != nil {
		t.Fatalf("close message: %v", err)
	}
	if !f.server.hub.HasConnection("dev_alice") {
		t.Fatal("a device sending slowly was dropped")
	}
	device.answerNext()
	got := <-done
	if got.err != nil || got.reply.State == nil {
		t.Fatalf("reply = %+v, err = %v", got.reply, got.err)
	}
}

// Heartbeats keep arriving but no pong does: the device still talks, so the
// server does not end the connection on a missing pong alone. A pong can sit
// behind queued messages on a congested uplink (DEV-084/085), and ending
// such a connection would make slow devices flap. If what the device lost is
// the server's direction, the device hears nothing and its own silence watch
// reconnects; the request here meets its own deadline.
func TestMissingPongAloneDoesNotEndATalkingDevice(t *testing.T) {
	f, httpServer := livenessFixture(t)
	device := connectLivenessDevice(t, f, httpServer.URL)
	defer device.conn.Close()

	stop := make(chan struct{})
	defer close(stop)
	go func() {
		ticker := time.NewTicker(100 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-stop:
				return
			case <-ticker.C:
				if device.conn.WriteJSON(map[string]any{"id": "hb", "type": "heartbeat", "payload": map[string]any{}}) != nil {
					return
				}
			}
		}
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 1500*time.Millisecond)
	defer cancel()
	if _, err := askStatus(ctx, f); err == nil || strings.Contains(err.Error(), "did not answer a ping") {
		t.Fatalf("err = %v, want the request's own deadline", err)
	}
	if !f.server.hub.HasConnection("dev_alice") {
		t.Fatal("a device still sending heartbeats was dropped")
	}
}
