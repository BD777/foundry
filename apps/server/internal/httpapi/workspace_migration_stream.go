package httpapi

import (
	"context"
	"errors"
	"io"
	"log"
	"net"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// The data channel of a workspace move (DEV-146): the source and the target
// worker each dial GET /api/daemon/migration-streams/{streamId} with the id
// their workspace_migration_transfer named, and the server joins the two
// sockets, relaying each message as it comes, both ways. Nothing is kept:
// a message streams from one socket to the other through copy buffers.

const (
	// migrationFrameLimit is the largest message a worker sends: a frame of
	// at most 1 MiB with its header.
	migrationFrameLimit = 1<<20 + 64<<10
	// migrationStreamJoinTimeout bounds the wait for both workers to dial.
	migrationStreamJoinTimeout = time.Minute
	// migrationStreamIdle is how long a socket may stay silent, pongs
	// included, before the pair is dropped.
	migrationStreamIdle = 2 * time.Minute
)

// migrationStreamEnd is one worker's side of a pair.
type migrationStreamEnd struct {
	pair     *migrationStreamPair
	role     string
	deviceID string
	control  *daemonConnection
	claimed  bool
	socket   *websocket.Conn
}

// migrationStreamPair joins the two sides of one transfer attempt.
type migrationStreamPair struct {
	migrationID string
	ends        [2]*migrationStreamEnd
	ctx         context.Context
	cancel      context.CancelFunc
	// joined is closed once both sides dialed.
	joined chan struct{}
	// done is closed once the relay ended (or never began).
	done     chan struct{}
	mu       sync.Mutex
	dialed   int
	closing  sync.Once
	finished sync.Once
	relaying sync.WaitGroup
}

func (p *migrationStreamPair) partner(end *migrationStreamEnd) *migrationStreamEnd {
	if p.ends[0] == end {
		return p.ends[1]
	}
	return p.ends[0]
}

// close ends the pair: both sockets close, and done closes once both
// relays returned.
func (p *migrationStreamPair) close() {
	p.closing.Do(func() {
		p.cancel()
		p.mu.Lock()
		for _, end := range p.ends {
			if end.socket != nil {
				_ = end.socket.WriteControl(websocket.CloseMessage,
					websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""), time.Now().Add(time.Second))
				_ = end.socket.Close()
			}
		}
		p.mu.Unlock()
		go func() {
			p.relaying.Wait()
			p.finished.Do(func() { close(p.done) })
		}()
	})
}

// ended is done, or a closed channel when no worker ever dialed.
func (p *migrationStreamPair) ended() <-chan struct{} {
	p.mu.Lock()
	dialed := p.dialed
	p.mu.Unlock()
	if dialed == 0 {
		closed := make(chan struct{})
		close(closed)
		return closed
	}
	return p.done
}

// migrationStreams is every pair a driver opened, by stream id.
type migrationStreams struct {
	mu    sync.Mutex
	byID  map[string]*migrationStreamEnd
	pairs map[*migrationStreamPair]bool
}

// open registers a pair for migrationID between the source and target
// connections and returns its stream ids; the pair ends when ctx does.
func (m *migrationStreams) open(ctx context.Context, migrationID string, source, target *daemonConnection) (*migrationStreamPair, string, string) {
	ctx, cancel := context.WithCancel(ctx)
	pair := &migrationStreamPair{migrationID: migrationID, ctx: ctx, cancel: cancel, joined: make(chan struct{}), done: make(chan struct{})}
	sourceID, targetID := tunnelRandom(), tunnelRandom()
	sourceDevice, _ := source.registrationSnapshot()
	targetDevice, _ := target.registrationSnapshot()
	pair.ends[0] = &migrationStreamEnd{pair: pair, role: "source", deviceID: sourceDevice, control: source}
	pair.ends[1] = &migrationStreamEnd{pair: pair, role: "target", deviceID: targetDevice, control: target}
	m.mu.Lock()
	if m.byID == nil {
		m.byID, m.pairs = map[string]*migrationStreamEnd{}, map[*migrationStreamPair]bool{}
	}
	m.byID[sourceID], m.byID[targetID] = pair.ends[0], pair.ends[1]
	m.pairs[pair] = true
	m.mu.Unlock()
	go func() {
		<-ctx.Done()
		pair.close()
		m.mu.Lock()
		delete(m.byID, sourceID)
		delete(m.byID, targetID)
		delete(m.pairs, pair)
		m.mu.Unlock()
	}()
	return pair, sourceID, targetID
}

// claim takes the side streamID names for deviceID, once.
func (m *migrationStreams) claim(streamID, deviceID, credentialHash string, current *daemonConnection) (*migrationStreamEnd, string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	end := m.byID[streamID]
	switch {
	case end == nil || end.pair.ctx.Err() != nil:
		return nil, "unknown or expired stream"
	case end.deviceID != deviceID:
		return nil, "another device"
	case end.claimed:
		return nil, "already claimed"
	case end.control != current || end.control.actor.DeviceCredentialHash != credentialHash:
		return nil, "device reconnected since the request"
	}
	end.claimed = true
	return end, ""
}

func (m *migrationStreams) closeAll() {
	m.mu.Lock()
	pairs := make([]*migrationStreamPair, 0, len(m.pairs))
	for pair := range m.pairs {
		pairs = append(pairs, pair)
	}
	m.mu.Unlock()
	for _, pair := range pairs {
		pair.close()
	}
}

func (s *Server) handleWorkspaceMigrationStream(w http.ResponseWriter, r *http.Request) {
	actor := actorFromContext(r.Context())
	if actor.Kind != ActorDaemon || r.Header.Get("Origin") != "" {
		writeError(w, http.StatusForbidden, "device-only data channel")
		return
	}
	end, refused := s.hub.migrations.streams.claim(r.PathValue("streamId"), actor.DeviceID, actor.DeviceCredentialHash, s.hub.connectionFor(actor.DeviceID))
	if end == nil {
		log.Printf("workspace migration stream refused: device=%s reason=%s", actor.DeviceID, refused)
		writeError(w, http.StatusNotFound, "stream unavailable")
		return
	}
	pair := end.pair
	upgrader := websocket.Upgrader{ReadBufferSize: 64 << 10, WriteBufferSize: 64 << 10, CheckOrigin: func(r *http.Request) bool { return r.Header.Get("Origin") == "" }}
	socket, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		pair.close()
		return
	}
	socket.SetReadLimit(migrationFrameLimit)
	_ = socket.SetReadDeadline(time.Now().Add(migrationStreamIdle))
	socket.SetPongHandler(func(string) error { return socket.SetReadDeadline(time.Now().Add(migrationStreamIdle)) })
	pair.relaying.Add(1)
	defer pair.relaying.Done()
	pair.mu.Lock()
	if pair.ctx.Err() != nil {
		pair.mu.Unlock()
		_ = socket.Close()
		return
	}
	end.socket = socket
	pair.dialed++
	if pair.dialed == 2 {
		close(pair.joined)
	}
	pair.mu.Unlock()
	go keepMigrationSocketAlive(pair, socket)

	timer := time.NewTimer(migrationStreamJoinTimeout)
	defer timer.Stop()
	select {
	case <-pair.joined:
	case <-pair.ctx.Done():
		return
	case <-end.control.done:
		pair.close()
		return
	case <-timer.C:
		log.Printf("workspace migration %s: the other worker did not dial within %s", pair.migrationID, migrationStreamJoinTimeout)
		pair.close()
		return
	}
	// This side reads its socket and writes the partner's: each socket has
	// one writer, the other side's relay.
	err = relayMigrationMessages(socket, pair.partner(end).socket)
	if err != nil && !isClosedMigrationStream(err) {
		log.Printf("workspace migration %s: %s side relay ended: %v", pair.migrationID, end.role, err)
	}
	pair.close()
}

// relayMigrationMessages copies each message from one socket to the other,
// message by message, until from ends.
func relayMigrationMessages(from, to *websocket.Conn) error {
	for {
		kind, reader, err := from.NextReader()
		if err != nil {
			return err
		}
		_ = from.SetReadDeadline(time.Now().Add(migrationStreamIdle))
		_ = to.SetWriteDeadline(time.Now().Add(migrationStreamIdle))
		writer, err := to.NextWriter(kind)
		if err != nil {
			return err
		}
		if _, err := io.Copy(writer, reader); err != nil {
			_ = writer.Close()
			return err
		}
		if err := writer.Close(); err != nil {
			return err
		}
	}
}

func isClosedMigrationStream(err error) bool {
	return websocket.IsCloseError(err, websocket.CloseNormalClosure, websocket.CloseGoingAway) || errors.Is(err, net.ErrClosed)
}

func keepMigrationSocketAlive(pair *migrationStreamPair, socket *websocket.Conn) {
	ticker := time.NewTicker(25 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-pair.ctx.Done():
			return
		case <-ticker.C:
			if socket.WriteControl(websocket.PingMessage, nil, time.Now().Add(10*time.Second)) != nil {
				pair.close()
				return
			}
		}
	}
}
