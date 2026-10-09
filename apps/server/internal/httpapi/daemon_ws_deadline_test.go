package httpapi

import (
	"context"
	"encoding/binary"
	"errors"
	"net"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"github.com/gorilla/websocket"
)

// slowUplinkConn writes at most chunk bytes per pause while trickling, the
// way byte-dev's uplink delivers a large message.
type slowUplinkConn struct {
	net.Conn
	trickling atomic.Bool
	chunk     int
	pause     time.Duration
}

func (c *slowUplinkConn) Write(p []byte) (int, error) {
	if !c.trickling.Load() {
		return c.Conn.Write(p)
	}
	written := 0
	for written < len(p) {
		n, err := c.Conn.Write(p[written:min(written+c.chunk, len(p))])
		written += n
		if err != nil {
			return written, err
		}
		time.Sleep(c.pause)
	}
	return written, nil
}

// deadlineTestServer is a server whose daemon connections time out after
// readTimeout instead of 70s.
func deadlineTestServer(t *testing.T, readTimeout time.Duration) (*Server, string) {
	t.Helper()
	server := NewServer(newEmptyTestStore(t))
	server.hub.readTimeout = readTimeout
	httpServer := httptest.NewServer(server.Routes())
	t.Cleanup(httpServer.Close)
	return server, "ws" + strings.TrimPrefix(httpServer.URL, "http") + "/api/daemon/ws"
}

// connectDeviceForTest dials the daemon socket and registers deviceID.
func connectDeviceForTest(t *testing.T, dialer *websocket.Dialer, url, deviceID string) *websocket.Conn {
	t.Helper()
	conn, _, err := dialer.Dial(url, nil)
	if err != nil {
		t.Fatalf("dial daemon websocket: %v", err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	writeWSForTest(t, conn, "hello", map[string]any{
		"device": map[string]any{"id": deviceID, "label": deviceID, "status": "connected"},
	})
	readWSTypeForTest(t, conn, "registered")
	return conn
}

// readAckForTest reads until the ack of the message with id arrives.
func readAckForTest(t *testing.T, conn *websocket.Conn, id string) {
	t.Helper()
	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	for {
		var envelope wsEnvelope
		if err := conn.ReadJSON(&envelope); err != nil {
			t.Fatalf("waiting for the ack of %s: %v", id, err)
		}
		if envelope.Type == wsAckType && envelope.ID == id {
			return
		}
	}
}

// readCloseForTest reads until the server closes the connection and returns
// its close frame.
func readCloseForTest(t *testing.T, conn *websocket.Conn) *websocket.CloseError {
	t.Helper()
	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	for {
		_, _, err := conn.ReadMessage()
		if err == nil {
			continue
		}
		var closeError *websocket.CloseError
		if !errors.As(err, &closeError) {
			t.Fatalf("connection ended without a close frame: %v", err)
		}
		return closeError
	}
}

// A device sending one large message over a slow uplink keeps its connection
// for as long as the message keeps arriving, even past the read deadline.
func TestDaemonReadDeadlineFollowsProgressOfALargeMessage(t *testing.T) {
	const readTimeout = 500 * time.Millisecond
	_, url := deadlineTestServer(t, readTimeout)
	var uplink *slowUplinkConn
	dialer := &websocket.Dialer{
		// One frame for the whole message, like the worker's skill scan answer.
		WriteBufferSize: 1 << 20,
		NetDialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
			conn, err := (&net.Dialer{}).DialContext(ctx, network, address)
			if err != nil {
				return nil, err
			}
			uplink = &slowUplinkConn{Conn: conn, chunk: 1 << 10, pause: 50 * time.Millisecond}
			return uplink, nil
		},
	}
	conn := connectDeviceForTest(t, dialer, url, "dev_slow_uplink")

	// ~40 KB at 1 KB per 50ms: about 2s, four read deadlines, with a gap
	// between parts a tenth of the deadline.
	uplink.trickling.Store(true)
	started := time.Now()
	writeWSIDForTest(t, conn, "large", wsHeartbeatType, map[string]string{"pad": strings.Repeat("x", 40<<10)})
	took := time.Since(started)
	uplink.trickling.Store(false)
	if took < 2*readTimeout {
		t.Fatalf("the message took %s to send; it must outlast the %s read deadline", took, readTimeout)
	}

	readAckForTest(t, conn, "large")
	writeWSIDForTest(t, conn, "after", wsHeartbeatType, map[string]string{})
	readAckForTest(t, conn, "after")
}

// A device that stops sending, between messages or in the middle of one, is
// dropped after the read deadline and told so.
func TestDaemonSilentDeviceIsDroppedWithTimeoutReason(t *testing.T) {
	const readTimeout = 300 * time.Millisecond
	for _, tc := range []struct {
		name  string
		stall func(t *testing.T, conn *websocket.Conn)
	}{
		{"between messages", func(*testing.T, *websocket.Conn) {}},
		{"mid-frame", func(t *testing.T, conn *websocket.Conn) {
			// A masked text frame announcing 1000 bytes, of which 100 arrive.
			frame := []byte{0x81, 0x80 | 126, 0, 0, 0, 0, 0, 0}
			binary.BigEndian.PutUint16(frame[2:4], 1000)
			frame = append(frame, strings.Repeat(" ", 100)...)
			if _, err := conn.NetConn().Write(frame); err != nil {
				t.Fatalf("write partial frame: %v", err)
			}
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			server, url := deadlineTestServer(t, readTimeout)
			deviceID := "dev_silent_" + strings.ReplaceAll(tc.name, " ", "_")
			conn := connectDeviceForTest(t, websocket.DefaultDialer, url, deviceID)
			tc.stall(t, conn)

			closed := readCloseForTest(t, conn)
			if closed.Code != websocket.CloseGoingAway || closed.Text != "no data from device for 0.3s" {
				t.Fatalf("close = %d %q, want %d %q", closed.Code, closed.Text, websocket.CloseGoingAway, "no data from device for 0.3s")
			}
			last, ok := server.hub.disconnects.lookup(deviceID)
			if !ok || !strings.HasPrefix(last.ServerReason, "no data from device for 0.3s (") {
				t.Fatalf("recorded drop = %+v, want the timeout", last)
			}
		})
	}
}

// A connection replaced by a newer one from the same device is told so, not
// that the server is shutting down.
func TestDaemonReplacedConnectionIsToldWhy(t *testing.T) {
	_, url := deadlineTestServer(t, daemonReadTimeout)
	older := connectDeviceForTest(t, websocket.DefaultDialer, url, "dev_twice")
	connectDeviceForTest(t, websocket.DefaultDialer, url, "dev_twice")

	closed := readCloseForTest(t, older)
	if closed.Code != closeReplaced.code || closed.Text != closeReplaced.text {
		t.Fatalf("close = %d %q, want %d %q", closed.Code, closed.Text, closeReplaced.code, closeReplaced.text)
	}
}

// Only a real shutdown tells devices the server is shutting down.
func TestDaemonShutdownTellsDevicesTheServerIsShuttingDown(t *testing.T) {
	server, url := deadlineTestServer(t, daemonReadTimeout)
	conn := connectDeviceForTest(t, websocket.DefaultDialer, url, "dev_shutdown")

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := server.hub.Shutdown(ctx); err != nil {
		t.Fatalf("Shutdown() error = %v", err)
	}
	closed := readCloseForTest(t, conn)
	if closed.Code != websocket.CloseGoingAway || closed.Text != "server shutting down" {
		t.Fatalf("close = %d %q, want %d %q", closed.Code, closed.Text, websocket.CloseGoingAway, "server shutting down")
	}
}

// Every close text fits a close frame, and only removal mentions
// device_removed, which makes the worker stop reconnecting for good.
func TestDaemonCloseCausesFitACloseFrame(t *testing.T) {
	for _, cause := range []daemonCloseCause{
		closeServerShutdown, closeReplaced, closeDevicePairedAgain, closeRegistrationUnchecked,
		closeByDevice, closeConnectionLost, closeMessageTooBig, closeBinaryMessage,
		closeUndecodableMessage, closeInvalidEnvelope, closeByServer, closeReadTimeout(daemonReadTimeout),
	} {
		if len(cause.text) > 123 {
			t.Errorf("%q is longer than a close frame allows", cause.text)
		}
		if strings.Contains(cause.text, wsDeviceRemovedReason) || cause.code == wsDeviceRemovedCloseCode {
			t.Errorf("%d %q would make the worker stop reconnecting", cause.code, cause.text)
		}
	}
	if got := closeReadTimeout(daemonReadTimeout).text; got != "no data from device for 70s" {
		t.Errorf("default timeout text = %q", got)
	}
}

func TestConnectionReportLineCountsBytes(t *testing.T) {
	line := describeConnectionReport(store.WorkerConnectionReport{
		DurationMs: 80_000, ClosedBy: "server", BytesSent: 634_880, BytesReceived: 2_048,
	})
	if !strings.Contains(line, "worker sent 634880 bytes, received 2048 bytes") {
		t.Fatalf("report line = %q, want the byte counts", line)
	}
	if line := describeConnectionReport(store.WorkerConnectionReport{ClosedBy: "network"}); strings.Contains(line, "bytes") {
		t.Fatalf("report line without counts = %q, want no byte counts", line)
	}
}
