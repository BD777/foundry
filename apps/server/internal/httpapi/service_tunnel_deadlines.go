package httpapi

import (
	"bufio"
	"net"
	"net/http"
	"time"
)

// A response may live for hours, but one stalled write must not occupy its
// buffers/connection slot forever. Refresh the deadline per write and clear it
// afterwards, so healthy idle SSE/WS connections have no whole-response timeout.
const tunnelWriteStall = 30 * time.Second

type tunnelResponseWriter struct{ http.ResponseWriter }

func (w tunnelResponseWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }
func (w tunnelResponseWriter) Write(p []byte) (int, error) {
	controller := http.NewResponseController(w.ResponseWriter)
	_ = controller.SetWriteDeadline(time.Now().Add(tunnelWriteStall))
	defer controller.SetWriteDeadline(time.Time{})
	return w.ResponseWriter.Write(p)
}
func (w tunnelResponseWriter) FlushError() error {
	controller := http.NewResponseController(w.ResponseWriter)
	_ = controller.SetWriteDeadline(time.Now().Add(tunnelWriteStall))
	defer controller.SetWriteDeadline(time.Time{})
	return controller.Flush()
}
func (w tunnelResponseWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	conn, buffer, err := http.NewResponseController(w.ResponseWriter).Hijack()
	if err != nil {
		return nil, nil, err
	}
	// This also bounds the initial buffered 101 response. Subsequent writes go
	// through the wrapped connection and refresh their own deadline.
	_ = conn.SetWriteDeadline(time.Now().Add(tunnelWriteStall))
	return tunnelDownstreamConn{Conn: conn}, buffer, nil
}

type tunnelDownstreamConn struct {
	net.Conn
	stall time.Duration
}

func (c tunnelDownstreamConn) Write(p []byte) (int, error) {
	_ = c.Conn.SetWriteDeadline(time.Now().Add(c.writeStall()))
	defer c.Conn.SetWriteDeadline(time.Time{})
	return c.Conn.Write(p)
}

func (c tunnelDownstreamConn) writeStall() time.Duration {
	if c.stall > 0 {
		return c.stall
	}
	return tunnelWriteStall
}
