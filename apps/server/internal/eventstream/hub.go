package eventstream

import (
	"encoding/json"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// Every stream message carries an SSE id "<epoch>-<seq>": seq rises with each
// published event and epoch names this server process. A browser reconnecting
// with Last-Event-ID (or ?lastEventId=) is replayed what it missed from a
// bounded ring; when the ring no longer reaches back that far, the server
// restarted, or its buffer overflowed, the stream says so with a resync
// message instead of dropping events silently, and the browser reloads.
const (
	ringEntries      = 2048
	ringBytes        = 8 << 20
	subscriberBuffer = 256
)

// Reach is what one stream may receive. It is fixed when the stream opens,
// so a change of an account's access ends the account's streams
// (Hub.Reauthorize), and they open again with the new reach.
type Reach interface {
	// Receives reports whether the stream may receive a message of the
	// workspace ("" for one of no workspace).
	Receives(workspaceID string) bool
	// Account is the account the stream acts as; "" for none.
	Account() string
}

// Gap is why a stream missed messages.
type Gap int

const (
	// GapOverflow: the stream fell behind and its buffer overflowed.
	GapOverflow Gap = iota + 1
	// GapExpired: what it missed is no longer kept for replay.
	GapExpired
	// GapRestarted: the server restarted since the stream's last message,
	// or the stream resumed from an id it did not send.
	GapRestarted
	// GapReauthorized: the account's access changed after the stream's last
	// message, so what it may see changed too.
	GapReauthorized
)

// Control is what a hub tells a stream about the stream itself.
type Control struct {
	// Ready starts a stream that resumes from nowhere; its id is the
	// newest message's, a place to resume from.
	Ready Message
	// Resync tells a stream it missed messages, and why; its id is the
	// newest message's, so a later reconnect resumes after what it reloads.
	Resync func(Gap) Message
}

// Hub delivers published messages to its streams, synchronously and in
// publishing order, and keeps the latest for streams that resume.
type Hub struct {
	control  Control
	revision atomic.Uint64
	epoch    string
	// mu orders publishing: sequence numbers, the replay ring and delivery
	// to subscribers happen together, so every stream sees ascending ids.
	mu          sync.RWMutex
	seq         uint64
	ring        []bufferedEvent
	ringBytes   int
	closed      bool
	subscribers map[*subscriber]struct{}
	// reauthorized holds, per account, the newest message published before
	// its access last changed: a stream resuming from there or earlier was
	// authorized under the old access. One entry per account.
	reauthorized map[string]uint64
}

// New is a hub that tells its streams about themselves with control.
func New(control Control) *Hub {
	return &Hub{
		control:      control,
		epoch:        strconv.FormatInt(time.Now().UnixNano(), 36),
		subscribers:  make(map[*subscriber]struct{}),
		reauthorized: make(map[string]uint64),
	}
}

type bufferedEvent struct {
	seq       uint64
	workspace string
	// everyone: the message reaches every stream (it carries no data).
	everyone bool
	frame    []byte
}

type subscriber struct {
	ch      chan []byte
	reach   Reach
	ended   chan struct{}
	endOnce sync.Once
	// lost is set when ch was full: later messages skip the subscriber until
	// its writer has drained ch and sent a resync.
	lost atomic.Bool
}

func newSubscriber(reach Reach, buffer int) *subscriber {
	return &subscriber{ch: make(chan []byte, buffer), reach: reach, ended: make(chan struct{})}
}

func (s *subscriber) end() {
	s.endOnce.Do(func() { close(s.ended) })
}

func (s *subscriber) account() string {
	if s.reach == nil {
		return ""
	}
	return s.reach.Account()
}

// receives reports whether a message of route reaches the subscriber. A
// stream without a reach receives only what reaches everyone.
func (s *subscriber) receives(route Route) bool {
	return route.Everyone || (s.reach != nil && s.reach.Receives(route.Workspace))
}

// reauthorizedSince reports whether the subscriber's account had its access
// changed after the message seq was published (see Reauthorize).
func (s *subscriber) reauthorizedSince(reauthorized map[string]uint64, seq uint64) bool {
	account := s.account()
	if account == "" {
		return false
	}
	at, found := reauthorized[account]
	return found && at >= seq
}

// deliver never blocks the publisher. A full buffer marks the subscriber
// lost; its writer sends a resync once it has written what it holds.
func (s *subscriber) deliver(frame []byte) {
	if s.lost.Load() {
		return
	}
	select {
	case s.ch <- frame:
	default:
		s.lost.Store(true)
	}
}

// Revision rises with every published message that may change data a
// snapshot serves, and with every Invalidate: a snapshot cached at one
// revision is current while it stays.
func (h *Hub) Revision() uint64 {
	return h.revision.Load()
}

// Invalidate makes cached snapshots out of date without a message (one
// that is announced later, or not at all).
func (h *Hub) Invalidate() {
	h.revision.Add(1)
}

func (h *Hub) publish(message publication) {
	if !message.keepsSnapshot {
		h.revision.Add(1)
	}
	encoded, err := json.Marshal(Message{Type: message.kind, Payload: message.payload})
	if err != nil {
		return
	}

	h.mu.Lock()
	defer h.mu.Unlock()
	h.seq++
	frame := eventFrame(h.epoch, h.seq, encoded)
	h.remember(bufferedEvent{seq: h.seq, workspace: message.route.Workspace, everyone: message.route.Everyone, frame: frame})
	for subscriber := range h.subscribers {
		if subscriber.receives(message.route) {
			subscriber.deliver(frame)
		}
	}
}

// remember keeps the message for replay within the ring's bounds. Callers
// hold mu.
func (h *Hub) remember(event bufferedEvent) {
	h.ring = append(h.ring, event)
	h.ringBytes += len(event.frame)
	drop := 0
	for drop < len(h.ring)-1 && (len(h.ring)-drop > ringEntries || h.ringBytes > ringBytes) {
		h.ringBytes -= len(h.ring[drop].frame)
		drop++
	}
	if drop > 0 {
		h.ring = append(h.ring[:0:0], h.ring[drop:]...)
	}
}

func eventFrame(epoch string, seq uint64, message []byte) []byte {
	frame := make([]byte, 0, len(message)+len(epoch)+32)
	frame = append(frame, "id: "...)
	frame = append(frame, epoch...)
	frame = append(frame, '-')
	frame = strconv.AppendUint(frame, seq, 10)
	frame = append(frame, "\ndata: "...)
	frame = append(frame, message...)
	frame = append(frame, "\n\n"...)
	return frame
}

// controlFrame is a message about the stream itself under the newest
// message's id. Callers hold mu.
func (h *Hub) controlFrame(message Message) []byte {
	encoded, _ := json.Marshal(message)
	return eventFrame(h.epoch, h.seq, encoded)
}

// Shutdown ends every open stream and refuses new ones. It is idempotent;
// subscriber channels are never closed here because publishing may be
// sending into them.
func (h *Hub) Shutdown() {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.closed = true
	for subscriber := range h.subscribers {
		subscriber.end()
		delete(h.subscribers, subscriber)
	}
}

// Reauthorize ends every stream acting as the account (including its
// agents'), so the next connection is authorized against its current
// access. Ended streams get no later message, so an id newer than this
// point comes only from a stream authorized afresh; one resuming from an
// older id gets a resync.
func (h *Hub) Reauthorize(account string) {
	if account == "" {
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	h.reauthorized[account] = h.seq
	for subscriber := range h.subscribers {
		if subscriber.account() == account {
			subscriber.end()
			delete(h.subscribers, subscriber)
		}
	}
}

// Subscription is one open stream: what it writes first (Backlog), then
// the frames delivered to it (C), in publishing order, until it is closed
// or the hub ends it (Done).
type Subscription struct {
	// C holds the frames delivered to the stream, as written on the wire.
	C          <-chan []byte
	hub        *Hub
	subscriber *subscriber
	backlog    [][]byte
}

// Subscribe opens a stream of reach that resumes from lastEventID, the id
// of the last frame it wrote ("" for none); false once the hub shut down.
func (h *Hub) Subscribe(reach Reach, lastEventID string) (*Subscription, bool) {
	return h.subscribe(reach, lastEventID, subscriberBuffer)
}

func (h *Hub) subscribe(reach Reach, lastEventID string, buffer int) (*Subscription, bool) {
	subscriber := newSubscriber(reach, buffer)
	backlog, open := h.resume(subscriber, lastEventID)
	if !open {
		return nil, false
	}
	return &Subscription{C: subscriber.ch, hub: h, subscriber: subscriber, backlog: backlog}, true
}

// Backlog is what the stream writes before the frames delivered to it: the
// messages it missed since lastEventID, or a resync when they are gone, or
// the ready message of a stream that resumes from nowhere.
func (s *Subscription) Backlog() [][]byte {
	return s.backlog
}

// Done is closed once the hub ended the stream: it shut down, or the
// stream's account had its access changed (Reauthorize).
func (s *Subscription) Done() <-chan struct{} {
	return s.subscriber.ended
}

// Resync is what a stream that fell behind writes once it has written what
// it holds: a resync, from which on it is delivered messages again. False
// while it has not fallen behind, or still holds frames to write.
func (s *Subscription) Resync() ([]byte, bool) {
	if len(s.subscriber.ch) > 0 || !s.subscriber.lost.Load() {
		return nil, false
	}
	return s.hub.recover(s.subscriber), true
}

// Close ends the stream; it is delivered nothing more.
func (s *Subscription) Close() {
	s.hub.unsubscribe(s.subscriber)
}

// resume registers a subscriber and returns what it must write first: the
// messages it missed since lastEventID, or a resync when they are gone.
// Registration and replay happen under mu, so nothing falls between them.
func (h *Hub) resume(subscriber *subscriber, lastEventID string) ([][]byte, bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.closed {
		return nil, false
	}
	h.subscribers[subscriber] = struct{}{}
	lastEventID = strings.TrimSpace(lastEventID)
	if lastEventID == "" {
		// A place to resume from at once: a connection that drops before
		// any message arrives resumes instead of making the browser reload.
		return [][]byte{h.controlFrame(h.control.Ready)}, true
	}
	epoch, rawSeq, found := strings.Cut(lastEventID, "-")
	seq, err := strconv.ParseUint(rawSeq, 10, 64)
	switch {
	case !found || err != nil || epoch != h.epoch || seq > h.seq:
		return [][]byte{h.controlFrame(h.control.Resync(GapRestarted))}, true
	case subscriber.reauthorizedSince(h.reauthorized, seq):
		return [][]byte{h.controlFrame(h.control.Resync(GapReauthorized))}, true
	case seq == h.seq:
		return nil, true
	case len(h.ring) == 0 || h.ring[0].seq > seq+1:
		return [][]byte{h.controlFrame(h.control.Resync(GapExpired))}, true
	}
	var replay [][]byte
	for _, event := range h.ring {
		if event.seq > seq && subscriber.receives(Route{Workspace: event.workspace, Everyone: event.everyone}) {
			replay = append(replay, event.frame)
		}
	}
	return replay, true
}

// unsubscribe forgets a subscriber whose stream ended.
func (h *Hub) unsubscribe(subscriber *subscriber) {
	h.mu.Lock()
	delete(h.subscribers, subscriber)
	h.mu.Unlock()
}

// recover ends a lost subscriber's gap: it is delivered messages again from
// the resync on. Called by its writer once it has drained ch.
func (h *Hub) recover(subscriber *subscriber) []byte {
	h.mu.Lock()
	defer h.mu.Unlock()
	subscriber.lost.Store(false)
	return h.controlFrame(h.control.Resync(GapOverflow))
}
