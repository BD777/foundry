package httpapi

import (
	"compress/gzip"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

type browserEventEnvelope struct {
	Type    string `json:"type"`
	Payload any    `json:"payload"`
}

// Every stream message carries an SSE id "<epoch>-<seq>": seq rises with each
// published event and epoch names this server process. A browser reconnecting
// with Last-Event-ID (or ?lastEventId=) is replayed what it missed from a
// bounded ring; when the ring no longer reaches back that far, the server
// restarted, or its buffer overflowed, the stream says so with a resync
// message instead of dropping events silently, and the browser reloads.
const (
	eventRingEntries       = 2048
	eventRingBytes         = 8 << 20
	eventSubscriberBuffer  = 256
	resyncEventType        = "resync"
	resyncReasonOverflow   = "overflow"
	resyncReasonExpired    = "expired"
	resyncReasonRestarted  = "restarted"
	sessionEventStreamType = "agent_session_event"
)

// resyncReasonReauthorized: the account's access changed after the stream's
// last event, so what it may see changed too.
const resyncReasonReauthorized = "reauthorized"

// eventHeartbeatInterval keeps idle streams open through proxies; a
// variable so tests can see heartbeats arrive.
var eventHeartbeatInterval = 15 * time.Second

type resyncPayload struct {
	Reason string `json:"reason"`
}

type bufferedEvent struct {
	seq       uint64
	workspace string
	// everyone: the event reaches every stream (it carries no data).
	everyone bool
	frame    []byte
}

// eventSubscription carries the subscriber's reach. Session-scoped actors
// (CHAT-01 tokens) only receive events of their workspace; people and devices
// only those of workspaces they can view. Events that name no workspace are
// dropped (fail closed). The reach is fixed at subscribe time, so a change of
// an account's access ends its streams (Reauthorize) and the browser
// reconnects with the new reach and is told to resync: the replay alone
// would not show what the new reach adds or takes away.
type eventSubscription struct {
	ch        chan []byte
	workspace string
	scope     *accessScope
	ended     chan struct{}
	endOnce   sync.Once
	// lost is set when ch was full: later events skip the subscriber until
	// its writer has drained ch and sent a resync.
	lost atomic.Bool
}

func (s *eventSubscription) end() {
	s.endOnce.Do(func() { close(s.ended) })
}

// reauthorizedSince reports whether the subscriber's account had its access
// changed after the event seq was published (see Reauthorize).
func (s *eventSubscription) reauthorizedSince(reauthorized map[string]uint64, seq uint64) bool {
	if s.scope == nil || s.scope.userID == "" {
		return false
	}
	at, found := reauthorized[s.scope.userID]
	return found && at >= seq
}

func (s *eventSubscription) receives(workspaceID string) bool {
	if s.workspace != "" {
		return workspaceID == s.workspace
	}
	if s.scope == nil || s.scope.all {
		return s.scope != nil
	}
	return s.scope.can(workspaceID, store.WorkspaceRoleViewer)
}

type InternalEventSubscriber func(eventType string, payload any)

type browserEventHub struct {
	revision atomic.Uint64
	epoch    string
	// mu orders publishing: sequence numbers, the replay ring and delivery
	// to subscribers happen together, so every stream sees ascending ids.
	mu           sync.RWMutex
	seq          uint64
	ring         []bufferedEvent
	ringBytes    int
	closed       bool
	shutdown     chan struct{}
	subscribers  map[*eventSubscription]struct{}
	internalSubs []InternalEventSubscriber
	dataChanges  dataChangeThrottle
	chatPushes   chatPushes
	// reauthorized holds, per account, the newest event published before
	// its access last changed: a stream resuming from there or earlier was
	// authorized under the old access. One entry per account.
	reauthorized map[string]uint64
}

func newBrowserEventHub() *browserEventHub {
	return &browserEventHub{
		epoch:        strconv.FormatInt(time.Now().UnixNano(), 36),
		shutdown:     make(chan struct{}),
		subscribers:  make(map[*eventSubscription]struct{}),
		dataChanges:  dataChangeThrottle{sent: map[string]time.Time{}, pending: map[string]*pendingDataChange{}},
		reauthorized: make(map[string]uint64),
	}
}

func (h *browserEventHub) SubscribeInternal(fn InternalEventSubscriber) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.internalSubs = append(h.internalSubs, fn)
}

// Shutdown releases every live SSE handler. It is idempotent; subscriber
// channels are never closed here because Publish may be sending into them.
func (h *browserEventHub) Shutdown() {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.closed {
		return
	}
	h.closed = true
	close(h.shutdown)
}

// Reauthorize ends every stream acting as the account (including its agents'),
// so the next connection is authorized against its current access. Ended
// streams get no later event, so an id newer than this point comes only from
// a stream authorized afresh; one resuming from an older id gets a resync.
func (h *browserEventHub) Reauthorize(userID string) {
	if userID == "" {
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	h.reauthorized[userID] = h.seq
	for subscription := range h.subscribers {
		if subscription.scope != nil && subscription.scope.userID == userID {
			subscription.end()
			delete(h.subscribers, subscription)
		}
	}
}

// Publish delivers a payload whose WorkspaceID field names its workspace.
func (h *browserEventHub) Publish(eventType string, payload any) {
	payload = slimEventPayload(payload)
	h.publish(eventType, eventWorkspace(eventType, payload), payload)
}

// PublishIn delivers a payload that does not carry its workspace itself
// (run and session events).
func (h *browserEventHub) PublishIn(workspaceID, eventType string, payload any) {
	h.publish(eventType, workspaceID, slimEventPayload(payload))
}

// slimEventPayload keeps a session's transcript out of the stream: events
// travel one by one as agent_session_event, never as a session's array.
func slimEventPayload(payload any) any {
	switch session := payload.(type) {
	case store.AgentSession:
		return slimAgentSession(session)
	case *store.AgentSession:
		if session != nil {
			slim := slimAgentSession(*session)
			return &slim
		}
	}
	return payload
}

func (h *browserEventHub) publish(eventType, workspaceID string, payload any) {
	h.publishTo(eventType, workspaceID, false, payload)
}

func (h *browserEventHub) publishTo(eventType, workspaceID string, everyone bool, payload any) {
	// A transcript event changes no projection the snapshot serves beyond
	// activity times its short TTL covers; streaming answers would otherwise
	// defeat the snapshot cache many times a second. A subagent's update
	// changes nothing the snapshot serves.
	if eventType != sessionEventStreamType && eventType != subagentUpdatedEvent {
		h.revision.Add(1)
	}
	message, err := json.Marshal(browserEventEnvelope{Type: eventType, Payload: payload})
	if err != nil {
		return
	}

	h.mu.Lock()
	h.seq++
	frame := eventFrame(h.epoch, h.seq, message)
	h.remember(bufferedEvent{seq: h.seq, workspace: workspaceID, everyone: everyone, frame: frame})
	for subscription := range h.subscribers {
		if everyone || subscription.receives(workspaceID) {
			subscription.deliver(frame)
		}
	}
	internals := append([]InternalEventSubscriber(nil), h.internalSubs...)
	h.mu.Unlock()

	for _, fn := range internals {
		fn(eventType, payload)
	}
}

// foundryDataChangedEvent tells clients that what GET /api/foundry-data
// returns changed in a way no other event carries, so they read it again.
// Its payload is {"workspaceId": id, "resources": [field, …]}, routed like
// any workspace event, or {"workspaceId": ""} for what every workspace's
// view shows (devices, provider health and agent profiles, connections,
// the skill catalog), which reaches every stream: it carries no data.
// resources names the foundry-data fields the change touched (clients read
// only those); without it the change may touch any.
const foundryDataChangedEvent = "foundry_data_changed"

type foundryDataChange struct {
	WorkspaceID string   `json:"workspaceId"`
	Resources   []string `json:"resources,omitempty"`
}

// foundryDataChangeInterval is the most often foundry_data_changed goes out
// for one workspace (or globally): the first change of a burst is announced
// at once and the rest once at the end of the interval, with every field
// they touched, so the last change is never left unannounced.
var foundryDataChangeInterval = time.Second

type dataChangeThrottle struct {
	mu   sync.Mutex
	sent map[string]time.Time
	// pending holds the fields a trailing announcement will name; nil
	// stands for any field.
	pending map[string]*pendingDataChange
}

// pendingDataChange is a trailing announcement's fields; a nil set stands
// for any field.
type pendingDataChange struct {
	resources map[string]bool
}

func newPendingDataChange(resources []string) *pendingDataChange {
	pending := &pendingDataChange{resources: map[string]bool{}}
	pending.add(resources)
	return pending
}

func (p *pendingDataChange) add(resources []string) {
	if p.resources == nil {
		return
	}
	if len(resources) == 0 {
		p.resources = nil
		return
	}
	for _, resource := range resources {
		p.resources[resource] = true
	}
}

func (p *pendingDataChange) list() []string {
	if p.resources == nil {
		return nil
	}
	names := make([]string, 0, len(p.resources))
	for name := range p.resources {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

// dataChanged announces a committed change to the named foundry-data fields
// for workspaceID ("" for every workspace); no field names any. Cached
// snapshots are out of date at once; only the event is throttled.
func (h *browserEventHub) dataChanged(workspaceID string, resources ...string) {
	h.revision.Add(1)
	throttle := &h.dataChanges
	throttle.mu.Lock()
	if pending := throttle.pending[workspaceID]; pending != nil {
		pending.add(resources)
		throttle.mu.Unlock()
		return
	}
	wait := foundryDataChangeInterval - time.Since(throttle.sent[workspaceID])
	if wait <= 0 {
		throttle.sent[workspaceID] = time.Now()
		throttle.mu.Unlock()
		h.publishDataChange(workspaceID, newPendingDataChange(resources).list())
		return
	}
	pending := newPendingDataChange(resources)
	throttle.pending[workspaceID] = pending
	throttle.mu.Unlock()
	time.AfterFunc(wait, func() {
		throttle.mu.Lock()
		delete(throttle.pending, workspaceID)
		throttle.sent[workspaceID] = time.Now()
		resources := pending.list()
		throttle.mu.Unlock()
		h.publishDataChange(workspaceID, resources)
	})
}

func (h *browserEventHub) publishDataChange(workspaceID string, resources []string) {
	h.publishTo(foundryDataChangedEvent, workspaceID, workspaceID == "", foundryDataChange{WorkspaceID: workspaceID, Resources: resources})
}

// announce tells clients what a device's report changed.
func (h *browserEventHub) announce(changes store.DaemonChanges) {
	global, workspace := daemonChangeFields(changes.Parts)
	if changes.Global {
		h.dataChanged("", global...)
	}
	for _, workspaceID := range changes.Workspaces {
		if workspaceID != "" {
			h.dataChanged(workspaceID, workspace...)
		}
	}
}

// daemonChangeFields names the foundry-data fields a device report's
// global change and its workspace change touched; none names any.
func daemonChangeFields(parts store.DaemonChangedParts) (global, workspace []string) {
	if !parts.Known {
		return nil, nil
	}
	add := func(fields *[]string, changed bool, names ...string) {
		if changed {
			*fields = append(*fields, names...)
		}
	}
	// Workspaces show their device's name and the catalog the devices
	// skills came from; agents and agent profiles derive from the device,
	// its health and its profiles; a device's scan folders default until
	// set.
	add(&global, parts.Device, fieldDevices, fieldWorkspaces, fieldPromotedSkills, fieldAgentProfiles, fieldAgents, fieldDeviceSkillRoots)
	add(&global, parts.ProviderHealth, fieldProviderHealth, fieldAgentProfiles, fieldAgents)
	add(&global, parts.AgentProfiles, fieldAgentProfiles, fieldAgents)
	add(&global, parts.NewWorkspace, fieldWorkspaces)
	add(&workspace, parts.Workspace, fieldWorkspaces)
	add(&workspace, parts.Agents, fieldAgents, fieldAgentProfiles)
	add(&workspace, parts.Assets, fieldAssets)
	add(&workspace, parts.Skills, fieldSkills)
	add(&workspace, parts.WorkspaceFiles, fieldWorkspaceFiles)
	add(&workspace, parts.Chats, fieldChats)
	return global, workspace
}

// remember keeps the event for replay within the ring's bounds. Callers hold mu.
func (h *browserEventHub) remember(event bufferedEvent) {
	h.ring = append(h.ring, event)
	h.ringBytes += len(event.frame)
	drop := 0
	for drop < len(h.ring)-1 && (len(h.ring)-drop > eventRingEntries || h.ringBytes > eventRingBytes) {
		h.ringBytes -= len(h.ring[drop].frame)
		drop++
	}
	if drop > 0 {
		h.ring = append(h.ring[:0:0], h.ring[drop:]...)
	}
}

// deliver never blocks the publisher. A full buffer marks the subscriber
// lost; its writer sends a resync once it has written what it holds.
func (s *eventSubscription) deliver(frame []byte) {
	if s.lost.Load() {
		return
	}
	select {
	case s.ch <- frame:
	default:
		s.lost.Store(true)
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

// streamReadyEventType names the first message of a stream that resumes
// from nowhere; it carries only its id, the newest event's. Clients keep
// the id and ignore the message.
const streamReadyEventType = "stream_ready"

func (h *browserEventHub) readyFrame() []byte {
	message, _ := json.Marshal(browserEventEnvelope{Type: streamReadyEventType, Payload: struct{}{}})
	return eventFrame(h.epoch, h.seq, message)
}

// resyncFrame tells a stream it missed events; its id is the newest event,
// so a later reconnect resumes after the state the browser reloads.
func (h *browserEventHub) resyncFrame(reason string) []byte {
	message, _ := json.Marshal(browserEventEnvelope{Type: resyncEventType, Payload: resyncPayload{Reason: reason}})
	return eventFrame(h.epoch, h.seq, message)
}

// resume registers a subscriber and returns what it must write first: the
// events it missed since lastEventID, or a resync when they are gone.
// Registration and replay happen under mu, so nothing falls between them.
func (h *browserEventHub) resume(subscription *eventSubscription, lastEventID string) ([][]byte, bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.closed {
		return nil, false
	}
	h.subscribers[subscription] = struct{}{}
	lastEventID = strings.TrimSpace(lastEventID)
	if lastEventID == "" {
		// A place to resume from at once: a connection that drops before
		// any event arrives resumes instead of making the browser reload.
		return [][]byte{h.readyFrame()}, true
	}
	epoch, rawSeq, found := strings.Cut(lastEventID, "-")
	seq, err := strconv.ParseUint(rawSeq, 10, 64)
	switch {
	case !found || err != nil || epoch != h.epoch || seq > h.seq:
		return [][]byte{h.resyncFrame(resyncReasonRestarted)}, true
	case subscription.reauthorizedSince(h.reauthorized, seq):
		return [][]byte{h.resyncFrame(resyncReasonReauthorized)}, true
	case seq == h.seq:
		return nil, true
	case len(h.ring) == 0 || h.ring[0].seq > seq+1:
		return [][]byte{h.resyncFrame(resyncReasonExpired)}, true
	}
	var replay [][]byte
	for _, event := range h.ring {
		if event.seq > seq && (event.everyone || subscription.receives(event.workspace)) {
			replay = append(replay, event.frame)
		}
	}
	return replay, true
}

// recover ends a lost subscriber's gap: it is delivered events again from
// the resync on. Called by its writer once it has drained ch.
func (h *browserEventHub) recover(subscription *eventSubscription) []byte {
	h.mu.Lock()
	defer h.mu.Unlock()
	subscription.lost.Store(false)
	return h.resyncFrame(resyncReasonOverflow)
}

// eventWorkspace extracts a workspace id from a structured event payload via
// its WorkspaceID field. Payloads without such a field are invisible to
// workspace-scoped subscribers (fail closed).
func eventWorkspace(_ string, payload any) string {
	value := reflect.ValueOf(payload)
	if value.Kind() == reflect.Ptr {
		if value.IsNil() {
			return ""
		}
		value = value.Elem()
	}
	if value.Kind() != reflect.Struct {
		return ""
	}
	field := value.FieldByName("WorkspaceID")
	if !field.IsValid() || field.Kind() != reflect.String {
		return ""
	}
	return field.String()
}

func (h *browserEventHub) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming is not supported", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache, no-transform")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")

	subscription := &eventSubscription{ch: make(chan []byte, eventSubscriberBuffer), ended: make(chan struct{})}
	if scope, ok := r.Context().Value(scopeContextKey{}).(accessScope); ok {
		subscription.scope = &scope
	}
	if actor := actorFromContext(r.Context()); actor.Agent() {
		// An agent's stream follows one workspace: its own, or another it reaches.
		subscription.workspace = requestedWorkspace(actor, r.URL.Query().Get("workspaceId"))
		if subscription.workspace != actor.Identity.WorkspaceID &&
			(subscription.scope == nil || !subscription.scope.can(subscription.workspace, store.WorkspaceRoleViewer)) {
			http.Error(w, "workspace is outside the token's scope", http.StatusForbidden)
			return
		}
	}
	lastEventID := r.Header.Get("Last-Event-ID")
	if lastEventID == "" {
		lastEventID = r.URL.Query().Get("lastEventId")
	}
	backlog, open := h.resume(subscription, lastEventID)
	if !open {
		http.Error(w, "server is shutting down", http.StatusServiceUnavailable)
		return
	}
	defer func() {
		h.mu.Lock()
		delete(h.subscribers, subscription)
		h.mu.Unlock()
	}()

	// The stream is compressed here when the browser accepts it: proxies
	// (nginx) do not compress text/event-stream, and frames repeat a
	// streaming answer several times a second. Every flush ends a deflate
	// block, so each frame reaches the browser as it is written; the
	// dictionary carries across flushes, and the strongest level suits a
	// link where bytes cost more than the server's time.
	var stream io.Writer = w
	flush := flusher.Flush
	w.Header().Add("Vary", "Accept-Encoding")
	if acceptsGzip(r) {
		w.Header().Set("Content-Encoding", "gzip")
		compressed, _ := gzip.NewWriterLevel(w, gzip.BestCompression)
		defer compressed.Close()
		stream = compressed
		flush = func() {
			_ = compressed.Flush()
			flusher.Flush()
		}
	}

	_, _ = fmt.Fprint(stream, ": connected\nretry: 1000\n\n")
	for _, frame := range backlog {
		if _, err := stream.Write(frame); err != nil {
			return
		}
	}
	flush()

	heartbeat := time.NewTicker(eventHeartbeatInterval)
	defer heartbeat.Stop()
	for {
		select {
		case <-h.shutdown:
			return
		case <-subscription.ended:
			return
		case <-r.Context().Done():
			return
		case frame := <-subscription.ch:
			if _, err := stream.Write(frame); err != nil {
				return
			}
			if len(subscription.ch) == 0 && subscription.lost.Load() {
				if _, err := stream.Write(h.recover(subscription)); err != nil {
					return
				}
			}
			flush()
		case <-heartbeat.C:
			if _, err := fmt.Fprint(stream, ": keepalive\n\n"); err != nil {
				return
			}
			flush()
		}
	}
}

// acceptsGzip reports whether the request's Accept-Encoding lists gzip
// with a non-zero quality.
func acceptsGzip(r *http.Request) bool {
	for _, header := range r.Header.Values("Accept-Encoding") {
		for _, part := range strings.Split(header, ",") {
			coding, params, _ := strings.Cut(part, ";")
			if !strings.EqualFold(strings.TrimSpace(coding), "gzip") {
				continue
			}
			for _, param := range strings.Split(params, ";") {
				name, value, _ := strings.Cut(param, "=")
				if strings.EqualFold(strings.TrimSpace(name), "q") {
					if quality, err := strconv.ParseFloat(strings.TrimSpace(value), 64); err == nil && quality <= 0 {
						return false
					}
				}
			}
			return true
		}
	}
	return false
}
