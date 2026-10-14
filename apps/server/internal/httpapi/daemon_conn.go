package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"slices"
	"sync"
	"sync/atomic"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"github.com/gorilla/websocket"
)

// daemonCloseCause is why the server ends a daemon connection. It goes out
// in the close frame, and the worker reports it back with its next hello, so
// it must say what really happened. The text has to fit a close frame (123
// bytes), and only a removed device may be told "device_removed": the
// worker stops reconnecting on that text.
type daemonCloseCause struct {
	code int
	text string
}

var (
	closeServerShutdown        = daemonCloseCause{websocket.CloseGoingAway, "server shutting down"}
	closeReplaced              = daemonCloseCause{websocket.CloseGoingAway, "replaced by a newer connection from this device"}
	closeDevicePairedAgain     = daemonCloseCause{websocket.CloseGoingAway, "device was paired again"}
	closeRegistrationUnchecked = daemonCloseCause{websocket.CloseInternalServerErr, "server could not check the device registration"}
	closeByDevice              = daemonCloseCause{websocket.CloseNormalClosure, "device closed the connection"}
	closeConnectionLost        = daemonCloseCause{websocket.CloseGoingAway, "connection lost"}
	closeMessageTooBig         = daemonCloseCause{websocket.CloseMessageTooBig, "message too big"}
	closeBinaryMessage         = daemonCloseCause{websocket.CloseUnsupportedData, "binary messages are not supported"}
	closeUndecodableMessage    = daemonCloseCause{websocket.CloseInvalidFramePayloadData, "undecodable message"}
	closeInvalidEnvelope       = daemonCloseCause{websocket.CloseProtocolError, "invalid message envelope"}
	closeByServer              = daemonCloseCause{websocket.CloseGoingAway, "closed by server"}
	closeRepliesBacklog        = daemonCloseCause{websocket.CloseGoingAway, "device sent faster than its connection took the answers"}
)

// closeReadTimeout is the cause for a device that sent nothing for timeout.
func closeReadTimeout(timeout time.Duration) daemonCloseCause {
	return daemonCloseCause{websocket.CloseGoingAway, fmt.Sprintf("no data from device for %gs", timeout.Seconds())}
}

// closeCauseOfReadError names why reading from the device failed.
func closeCauseOfReadError(err error, timeout time.Duration) daemonCloseCause {
	var closeError *websocket.CloseError
	var netError net.Error
	switch {
	case errors.As(err, &closeError):
		return closeByDevice
	case errors.Is(err, websocket.ErrReadLimit):
		return closeMessageTooBig
	case errors.As(err, &netError) && netError.Timeout():
		return closeReadTimeout(timeout)
	default:
		return closeConnectionLost
	}
}

// daemonDisconnectedReason is the deterministic error surfaced to callers
// whose daemon RPC never gets an answer because the socket went away.
const daemonDisconnectedReason = "local daemon disconnected"

// closeFrameGrace bounds how long a teardown waits for the write loop to emit
// a normal close frame before the socket is dropped underneath it.
const closeFrameGrace = 250 * time.Millisecond

// wsDeviceRemovedCloseCode is the permanent close sent to a daemon whose
// device was soft-removed. 4xxx is the application-defined range; the worker
// treats this code and the "device_removed" reason as "stop reconnecting and
// wait for an explicit re-pair", never as a transient network drop.
const wsDeviceRemovedCloseCode = 4001
const wsDeviceRemovedReason = "device_removed"

type daemonConnection struct {
	claimMu        sync.Mutex
	claimCursor    int
	activeSessions map[string]bool
	activeMu       sync.Mutex
	deviceID       string
	// actor is the device credential behind the socket; every registration
	// on it must name that device.
	actor Actor
	// sessionWorkspaces caches where streamed session events belong.
	sessionWorkspaces   map[string]sessionTarget
	sessionWorkspacesMu sync.Mutex
	done                chan struct{}
	finished            chan struct{}
	hub                 *DaemonHub
	rpc                 *daemonRPC
	registration        store.DaemonRegistration
	registrations       map[string]store.DaemonRegistration
	registrationMu      sync.Mutex
	// workspaceChoiceMu orders the person adding a folder against telling
	// the device to forget a deleted workspace (see forgetDeletedWorkspace);
	// it guards deletedWorkspacesForgotten.
	workspaceChoiceMu          sync.Mutex
	deletedWorkspacesForgotten map[string]bool
	// dispatchedSessions maps a session to the input this connection last
	// sent, guarding against sending the same input twice; it is
	// bookkeeping, not request correlation.
	dispatchedSessions map[string]string
	dispatchedMu       sync.Mutex
	send               chan wsEnvelope
	socket             *websocket.Conn
	closeOnce          sync.Once
	writeStarted       atomic.Bool
	writeFinished      chan struct{}
	// closeCause is the first reason given for ending the connection; it is
	// what the close frame tells the device.
	closeCause   daemonCloseCause
	closeCauseMu sync.Mutex
	// lifetime ends as soon as the connection starts closing, before any
	// pending request fails, so work tied to the connection sees it ended
	// by the time a request reports the disconnect.
	lifetime    context.Context
	endLifetime context.CancelFunc
	// connectedAt is when the device opened this connection.
	connectedAt time.Time
	// outbox is the worker's latest report of its session outbox.
	outbox workerOutboxReport
	// replies wait for the write loop: answers to the device's own
	// messages, never dropped (see reply).
	replyMu    sync.Mutex
	replies    []wsEnvelope
	replyReady chan struct{}

	// pieces holds envelopes the worker is sending in pieces (reply_chunk);
	// only the read loop uses it.
	pieces envelopePieces
}

func newDaemonConnection(hub *DaemonHub, socket *websocket.Conn) *daemonConnection {
	lifetime, endLifetime := context.WithCancel(context.Background())
	return &daemonConnection{
		activeSessions:             make(map[string]bool),
		connectedAt:                time.Now(),
		done:                       make(chan struct{}),
		dispatchedSessions:         make(map[string]string),
		endLifetime:                endLifetime,
		finished:                   make(chan struct{}),
		hub:                        hub,
		lifetime:                   lifetime,
		registrations:              make(map[string]store.DaemonRegistration),
		deletedWorkspacesForgotten: make(map[string]bool),
		rpc:                        newDaemonRPC(),
		send:                       make(chan wsEnvelope, 128),
		replyReady:                 make(chan struct{}, 1),
		socket:                     socket,
		writeFinished:              make(chan struct{}),
	}
}

func (c *daemonConnection) replaceActiveSessions(sessionIDs []string) {
	active := make(map[string]bool, len(sessionIDs))
	for _, sessionID := range sessionIDs {
		if sessionID != "" {
			active[sessionID] = true
		}
	}
	c.activeMu.Lock()
	c.activeSessions = active
	c.activeMu.Unlock()
}

func (c *daemonConnection) setActiveSession(sessionID string, active bool) {
	if sessionID == "" {
		return
	}
	c.activeMu.Lock()
	if active {
		if c.activeSessions == nil {
			c.activeSessions = make(map[string]bool)
		}
		c.activeSessions[sessionID] = true
	} else {
		delete(c.activeSessions, sessionID)
	}
	c.activeMu.Unlock()
}

func (c *daemonConnection) hasActiveSession(sessionID string) bool {
	c.activeMu.Lock()
	defer c.activeMu.Unlock()
	return c.activeSessions[sessionID]
}

// registrationSnapshot is the only read path for registration/device state.
// Workspace setup responses can update this state from an HTTP goroutine while
// the WebSocket read loop continues dispatching messages.
func (c *daemonConnection) registrationSnapshot() (string, store.DaemonRegistration) {
	c.registrationMu.Lock()
	defer c.registrationMu.Unlock()
	return c.deviceID, c.registration
}

// hasCapability reports whether the worker declared a protocol feature.
func (c *daemonConnection) hasCapability(capability string) bool {
	_, registration := c.registrationSnapshot()
	return slices.Contains(registration.Capabilities, capability)
}

func (c *daemonConnection) readLoop(ctx context.Context) {
	// Why the connection ended, so a dropped device can be explained later.
	var reason error
	var cause daemonCloseCause
	defer func() {
		// Shutdown, a newer connection or a removal may have closed the
		// socket under this read; that first cause is what really happened.
		cause = c.setCloseCause(cause)
		if reason != nil && !websocket.IsCloseError(reason, websocket.CloseNormalClosure, websocket.CloseGoingAway) {
			deviceID, _ := c.registrationSnapshot()
			log.Printf("daemon connection %s closed (%s): %v", deviceID, cause.text, reason)
			// A replaced connection's drop was already reported by the
			// worker on the connection that replaced it.
			if !c.hub.isShuttingDown() && cause != closeReplaced {
				c.hub.disconnects.serverSide(deviceID, fmt.Errorf("%s (%w)", cause.text, reason), time.Now())
			}
		}
		c.hub.unregister(c)
		c.hub.untrack(c)
		c.closeWith(cause)
		close(c.finished)
	}()

	c.socket.SetReadLimit(maxDaemonMessageBytes)
	_ = c.extendReadDeadline()
	c.socket.SetPongHandler(func(string) error {
		return c.extendReadDeadline()
	})

	for {
		messageType, message, err := c.readMessage()
		if err != nil {
			reason = err
			cause = closeCauseOfReadError(err, c.hub.readTimeout)
			return
		}
		if messageType != websocket.TextMessage {
			reason = fmt.Errorf("unexpected websocket message type %d", messageType)
			cause = closeBinaryMessage
			return
		}
		var envelope wsEnvelope
		if err := decodeWebSocketEnvelope(message, &envelope); err != nil {
			reason = fmt.Errorf("undecodable envelope: %w", err)
			cause = closeUndecodableMessage
			return
		}
		if err := validateWebSocketEnvelope(envelope); err != nil {
			reason = fmt.Errorf("invalid envelope %q: %w", envelope.Type, err)
			cause = closeInvalidEnvelope
			return
		}
		// Handling is inline with reading: a slow handler delays pongs and can
		// run the read deadline out, so slowness is worth a line.
		started := time.Now()
		if err := c.handleEnvelope(ctx, envelope); err != nil {
			if refusedForGood(envelope.Type, err) {
				// No later attempt could change it: the session is gone,
				// finished or another device's. Workers send a refused
				// session message again; acknowledged, they stop.
				deviceID, _ := c.registrationSnapshot()
				log.Printf("daemon %s: %s %s dropped: %v", deviceID, envelope.Type, envelope.ID, err)
				c.reply(wsEnvelope{Type: wsAckType, ID: envelope.ID})
			} else {
				c.reply(wsEnvelope{Type: wsErrorType, ID: envelope.ID, Error: err.Error()})
			}
		}
		if elapsed := time.Since(started); elapsed > 10*time.Second {
			log.Printf("daemon message %s took %s", envelope.Type, elapsed.Round(time.Millisecond))
		}
	}
}

// readMessage reads one whole message, as websocket.Conn.ReadMessage does,
// but every part of it that arrives moves the read deadline on. A large
// message over a slow uplink (byte-dev's ~620 KB skill scan answer at
// 5-20 KB/s) takes longer than the deadline to arrive, and the device's
// pongs and heartbeats queue behind it in the same stream. A deadline
// refreshed only by pongs and whole messages expired mid-message and dropped
// a device that was busy sending. A device that sends nothing still times out.
//
// The read limit counts the bytes on the wire; a compressed message is held
// to the same bound once inflated.
func (c *daemonConnection) readMessage() (int, []byte, error) {
	messageType, reader, err := c.socket.NextReader()
	if err != nil {
		return messageType, nil, err
	}
	_ = c.extendReadDeadline()
	limited := io.LimitReader(progressReader{reader: reader, progress: c.extendReadDeadline}, maxDaemonMessageBytes+1)
	message, err := io.ReadAll(limited)
	if err == nil && len(message) > maxDaemonMessageBytes {
		return messageType, nil, websocket.ErrReadLimit
	}
	return messageType, message, err
}

// maxDaemonMessageBytes bounds one message from a device. A compressed
// skill package can be 64 MiB; base64 + JSON needs up to 86 MiB.
const maxDaemonMessageBytes = 96 << 20

// compressMinBytes is the smallest message written compressed when the
// device negotiated permessage-deflate: deflate saves next to nothing on an
// ack or a ping-sized request.
const compressMinBytes = 1024

// writeEnvelope writes one envelope, compressed when the connection
// negotiated permessage-deflate and the envelope is large enough. Only the
// write loop calls it.
func (c *daemonConnection) writeEnvelope(envelope wsEnvelope) error {
	data, err := json.Marshal(envelope)
	if err != nil {
		return err
	}
	c.socket.EnableWriteCompression(len(data) >= compressMinBytes)
	return c.socket.WriteMessage(websocket.TextMessage, data)
}

func (c *daemonConnection) extendReadDeadline() error {
	return c.socket.SetReadDeadline(time.Now().Add(c.hub.readTimeout))
}

// progressReader calls progress after every read that returned data. A read
// returns as soon as any bytes arrive, so progress follows the network
// however large the reader's buffer.
type progressReader struct {
	reader   io.Reader
	progress func() error
}

func (r progressReader) Read(p []byte) (int, error) {
	n, err := r.reader.Read(p)
	if n > 0 {
		_ = r.progress()
	}
	return n, err
}

func (c *daemonConnection) writeLoop() {
	ticker := time.NewTicker(30 * time.Second)
	defer func() {
		ticker.Stop()
		close(c.writeFinished)
		_ = c.socket.Close()
	}()

	for {
		select {
		case <-c.done:
			// Best effort normal close: close() force-drops the socket once
			// closeFrameGrace expires, so a stalled peer cannot hold teardown.
			cause := c.setCloseCause(closeByServer)
			_ = c.socket.SetWriteDeadline(time.Now().Add(closeFrameGrace))
			_ = c.socket.WriteMessage(
				websocket.CloseMessage,
				websocket.FormatCloseMessage(cause.code, cause.text),
			)
			return
		case <-c.replyReady:
			if !c.writeReplies() {
				return
			}
		case envelope := <-c.send:
			// Answers the device waits for go ahead of the server's requests.
			if !c.writeReplies() {
				return
			}
			if err := c.writeEnvelope(envelope); err != nil {
				log.Printf("daemon websocket write failed type=%s id=%s connection=%p: %v", envelope.Type, envelope.ID, c, err)
				return
			}
		case <-ticker.C:
			if err := c.socket.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}

func (c *daemonConnection) queue(envelope wsEnvelope) bool {
	select {
	case <-c.done:
		// A caller can register its pending result between close() and this
		// send; sweep again so it fails fast instead of waiting on ctx.
		c.failAllPending()
		return false
	default:
	}

	// c.send is deliberately never closed: queue and close race by design, and
	// closing it would turn that race into a send-on-closed-channel panic.
	select {
	case <-c.done:
		c.failAllPending()
		return false
	case c.send <- envelope:
		return true
	default:
		// Backpressure on server-to-daemon traffic must not tear down a live
		// agent session. Callers can retry request/response RPC; answers to
		// the device's own messages never come here (see reply).
		return false
	}
}

// maxPendingReplies bounds the answers waiting for a device whose link does
// not take them: past it the connection is ended, and the device sends again
// what was not acknowledged once it reconnects.
const maxPendingReplies = 4096

// reply queues an answer to one of the device's own messages: an ack, an
// error or a registration. Unlike queue it never drops one. A device that
// never hears whether its message was taken keeps it, and lags by it.
func (c *daemonConnection) reply(envelope wsEnvelope) bool {
	select {
	case <-c.done:
		return false
	default:
	}
	c.replyMu.Lock()
	if len(c.replies) >= maxPendingReplies {
		c.replyMu.Unlock()
		go c.closeWith(closeRepliesBacklog)
		return false
	}
	c.replies = append(c.replies, envelope)
	c.replyMu.Unlock()
	select {
	case c.replyReady <- struct{}{}:
	default:
	}
	return true
}

// writeReplies writes every waiting reply, in order; false once the socket
// fails.
func (c *daemonConnection) writeReplies() bool {
	c.replyMu.Lock()
	replies := c.replies
	c.replies = nil
	c.replyMu.Unlock()
	for _, envelope := range replies {
		if err := c.writeEnvelope(envelope); err != nil {
			log.Printf("daemon websocket write failed type=%s id=%s connection=%p: %v", envelope.Type, envelope.ID, c, err)
			return false
		}
	}
	return true
}

// close ends the connection for no more specific reason than closeByServer.
func (c *daemonConnection) close() {
	c.closeWith(closeByServer)
}

// setCloseCause keeps the first reason given for ending the connection and
// returns the one that stands.
func (c *daemonConnection) setCloseCause(cause daemonCloseCause) daemonCloseCause {
	c.closeCauseMu.Lock()
	defer c.closeCauseMu.Unlock()
	if c.closeCause == (daemonCloseCause{}) {
		c.closeCause = cause
	}
	return c.closeCause
}

// closeWith ends the connection, telling the device cause unless an earlier
// cause already stands.
func (c *daemonConnection) closeWith(cause daemonCloseCause) {
	c.setCloseCause(cause)
	c.closeOnce.Do(func() {
		if c.endLifetime != nil {
			c.endLifetime()
		}
		c.failAllPending()
		close(c.done)
		if c.writeStarted.Load() {
			// Let writeLoop emit a close frame before the socket disappears.
			timer := time.NewTimer(closeFrameGrace)
			select {
			case <-c.writeFinished:
			case <-timer.C:
			}
			timer.Stop()
		}
		if c.socket != nil {
			_ = c.socket.Close()
		}
	})
}

// closePermanent sends an application-defined close frame (used for the
// device_removed refusal) and then runs the ordinary teardown. The control
// message is written directly, whatever cause stands, rather than left to
// writeLoop: it can go out between the frames of a message being written, and
// a worker that misses it keeps reconnecting.
func (c *daemonConnection) closePermanent(code int, text string) {
	cause := daemonCloseCause{code, text}
	if c.socket != nil {
		deadline := time.Now().Add(closeFrameGrace)
		_ = c.socket.WriteControl(
			websocket.CloseMessage,
			websocket.FormatCloseMessage(cause.code, cause.text),
			deadline,
		)
	}
	c.closeWith(cause)
}

// closeRemoved detaches the connection from the device lookup and sends the
// permanent device_removed close frame so the worker stops reconnecting.
func (c *daemonConnection) closeRemoved() {
	deviceID, _ := c.registrationSnapshot()
	if deviceID != "" {
		c.hub.mu.Lock()
		if c.hub.connections[deviceID] == c {
			delete(c.hub.connections, deviceID)
		}
		c.hub.mu.Unlock()
	}
	c.closePermanent(wsDeviceRemovedCloseCode, wsDeviceRemovedReason)
}

// failAllPending resolves every waiting daemon RPC with the disconnect error
// and latches the registry closed, so late registrations resolve too.
func (c *daemonConnection) failAllPending() {
	c.rpc.failAll()
}
