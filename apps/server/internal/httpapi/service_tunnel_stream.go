package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"sync"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"github.com/gorilla/websocket"
)

// One bounded data connection per upstream HTTP connection. Bulk traffic never
// enters the daemon's JSON RPC queue. The worker opens this outbound socket only
// after a request on its current authenticated control connection.
type wsServiceTunnelOpenPayload struct {
	StreamID    string `json:"streamId"`
	WorkspaceID string `json:"workspaceId"`
	Port        int    `json:"port"`
	Protocol    string `json:"protocol"`
}
type serviceTunnelStream struct {
	tunnel  store.ServiceTunnel
	control *daemonConnection
	ready   chan *tunnelNetConn
	ctx     context.Context
	cancel  context.CancelFunc
	claimed bool
}

func (s *Server) openServiceStream(ctx context.Context, t store.ServiceTunnel, c *daemonConnection) (*tunnelNetConn, func(), error) {
	runtime := &s.tunnels
	ctx, cancel := context.WithCancel(ctx)
	stream := &serviceTunnelStream{tunnel: t, control: c, ready: make(chan *tunnelNetConn, 1), ctx: ctx, cancel: cancel}
	id := tunnelRandom()
	runtime.mu.Lock()
	runtime.pruneLocked()
	perDevice, perTunnel := 0, 0
	for _, entry := range runtime.streams {
		if entry.tunnel.DeviceID == t.DeviceID {
			perDevice++
		}
		if entry.tunnel.ID == t.ID {
			perTunnel++
		}
	}
	if runtime.stopped || len(runtime.streams) >= 128 || perDevice >= 32 || perTunnel >= 16 {
		runtime.mu.Unlock()
		cancel()
		return nil, nil, errors.New("service connection limit reached")
	}
	runtime.streams[id] = stream
	runtime.mu.Unlock()
	cleanup := func() { cancel(); runtime.mu.Lock(); delete(runtime.streams, id); runtime.mu.Unlock() }
	raw, _ := json.Marshal(wsServiceTunnelOpenPayload{StreamID: id, WorkspaceID: t.TargetWorkspaceID, Port: t.Port, Protocol: t.Protocol})
	if !c.queue(wsEnvelope{Type: wsServiceTunnelOpenType, Payload: raw}) {
		cleanup()
		return nil, nil, errors.New("device connection unavailable")
	}
	timer := time.NewTimer(10 * time.Second)
	defer timer.Stop()
	select {
	case conn := <-stream.ready:
		go func() {
			select {
			case <-ctx.Done():
			case <-c.done:
			}
			_ = conn.Close()
		}()
		return conn, cleanup, nil
	case <-ctx.Done():
		cleanup()
		return nil, nil, ctx.Err()
	case <-c.done:
		cleanup()
		return nil, nil, errors.New("device disconnected")
	case <-timer.C:
		cleanup()
		return nil, nil, errors.New("service connection timed out")
	}
}
func (s *Server) handleServiceTunnelStream(w http.ResponseWriter, r *http.Request) {
	actor := actorFromContext(r.Context())
	if actor.Kind != ActorDaemon || r.Header.Get("Origin") != "" {
		writeError(w, 403, "device-only data channel")
		return
	}
	runtime := &s.tunnels
	runtime.mu.Lock()
	runtime.pruneLocked()
	entry := runtime.streams[r.PathValue("streamId")]
	if entry == nil || entry.claimed || entry.tunnel.DeviceID != actor.DeviceID || entry.control.actor.DeviceCredentialHash != actor.DeviceCredentialHash || entry.ctx.Err() != nil || entry.control != s.hub.connectionFor(actor.DeviceID) {
		runtime.mu.Unlock()
		writeError(w, 404, "stream unavailable")
		return
	}
	entry.claimed = true
	runtime.mu.Unlock()
	upgrader := websocket.Upgrader{ReadBufferSize: 32 * 1024, WriteBufferSize: 32 * 1024, CheckOrigin: func(r *http.Request) bool { return r.Header.Get("Origin") == "" }}
	socket, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		entry.cancel()
		return
	}
	conn := newTunnelNetConn(socket)
	select {
	case entry.ready <- conn:
	case <-entry.ctx.Done():
		_ = conn.Close()
		return
	}
	// Keep this handler alive: its request context must not cancel the data
	// channel as soon as Upgrade succeeds. Transport close ends it too.
	select {
	case <-entry.ctx.Done():
	case <-entry.control.done:
	case <-conn.done:
	}
	_ = conn.Close()
}

type tunnelNetConn struct {
	socket    *websocket.Conn
	reader    io.Reader
	writeMu   sync.Mutex
	closeOnce sync.Once
	done      chan struct{}
}

func newTunnelNetConn(socket *websocket.Conn) *tunnelNetConn {
	c := &tunnelNetConn{socket: socket, done: make(chan struct{})}
	socket.SetReadLimit(64 * 1024)
	_ = socket.SetReadDeadline(time.Now().Add(75 * time.Second))
	socket.SetPongHandler(func(string) error { return socket.SetReadDeadline(time.Now().Add(75 * time.Second)) })
	go func() {
		ticker := time.NewTicker(25 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-c.done:
				return
			case <-ticker.C:
				if socket.WriteControl(websocket.PingMessage, nil, time.Now().Add(10*time.Second)) != nil {
					_ = c.Close()
					return
				}
			}
		}
	}()
	return c
}
func (c *tunnelNetConn) Read(p []byte) (int, error) {
	for {
		if c.reader == nil {
			kind, reader, err := c.socket.NextReader()
			if err != nil {
				return 0, err
			}
			if kind != websocket.BinaryMessage {
				return 0, errors.New("binary tunnel frame required")
			}
			c.reader = reader
		}
		n, err := c.reader.Read(p)
		if err == io.EOF {
			c.reader = nil
			if n > 0 {
				return n, nil
			}
			continue
		}
		return n, err
	}
}
func (c *tunnelNetConn) Write(p []byte) (int, error) {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	written := 0
	for len(p) > 0 {
		n := min(len(p), 32*1024)
		_ = c.socket.SetWriteDeadline(time.Now().Add(30 * time.Second))
		if err := c.socket.WriteMessage(websocket.BinaryMessage, p[:n]); err != nil {
			return written, err
		}
		written += n
		p = p[n:]
	}
	return written, nil
}
func (c *tunnelNetConn) Close() error {
	var err error
	c.closeOnce.Do(func() { close(c.done); err = c.socket.Close() })
	return err
}
func (c *tunnelNetConn) LocalAddr() net.Addr  { return c.socket.LocalAddr() }
func (c *tunnelNetConn) RemoteAddr() net.Addr { return c.socket.RemoteAddr() }

// net/http's transport owns deadlines; the framed data channel owns its
// liveness and bounded writes. Request cancellation closes the socket instead.
func (c *tunnelNetConn) SetDeadline(time.Time) error      { return nil }
func (c *tunnelNetConn) SetReadDeadline(time.Time) error  { return nil }
func (c *tunnelNetConn) SetWriteDeadline(time.Time) error { return nil }
