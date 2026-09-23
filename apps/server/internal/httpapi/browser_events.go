package httpapi

import (
	"encoding/json"
	"fmt"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"net/http"
	"reflect"
	"sync"
	"sync/atomic"
	"time"
)

type browserEventEnvelope struct {
	Type    string `json:"type"`
	Payload any    `json:"payload"`
}

// eventSubscription carries the subscriber's reach. Session-scoped actors
// (CHAT-01 tokens) only receive events of their workspace; people and devices
// only those of workspaces they can view. Events that name no workspace are
// dropped (fail closed). The reach is fixed at subscribe time, so a change of
// an account's access ends its streams (Reauthorize) and the browser
// reconnects with the new reach.
type eventSubscription struct {
	ch        chan []byte
	workspace string
	scope     *accessScope
	ended     chan struct{}
	endOnce   sync.Once
}

func (s *eventSubscription) end() {
	s.endOnce.Do(func() { close(s.ended) })
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
	revision     atomic.Uint64
	mu           sync.RWMutex
	closed       bool
	shutdown     chan struct{}
	subscribers  map[*eventSubscription]struct{}
	internalSubs []InternalEventSubscriber
}

func newBrowserEventHub() *browserEventHub {
	return &browserEventHub{
		shutdown:    make(chan struct{}),
		subscribers: make(map[*eventSubscription]struct{}),
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
// so the next connection is authorized against its current access.
func (h *browserEventHub) Reauthorize(userID string) {
	if userID == "" {
		return
	}
	h.mu.RLock()
	defer h.mu.RUnlock()
	for subscription := range h.subscribers {
		if subscription.scope != nil && subscription.scope.userID == userID {
			subscription.end()
		}
	}
}

// Publish delivers a payload whose WorkspaceID field names its workspace.
func (h *browserEventHub) Publish(eventType string, payload any) {
	h.publish(eventType, eventWorkspace(eventType, payload), payload)
}

// PublishIn delivers a payload that does not carry its workspace itself
// (run and session events).
func (h *browserEventHub) PublishIn(workspaceID, eventType string, payload any) {
	h.publish(eventType, workspaceID, payload)
}

func (h *browserEventHub) publish(eventType, workspaceID string, payload any) {
	h.revision.Add(1)
	message, err := json.Marshal(browserEventEnvelope{Type: eventType, Payload: payload})
	if err != nil {
		return
	}

	h.mu.RLock()
	subs := make([]*eventSubscription, 0, len(h.subscribers))
	for subscription := range h.subscribers {
		subs = append(subs, subscription)
	}
	internals := append([]InternalEventSubscriber(nil), h.internalSubs...)
	h.mu.RUnlock()

	for _, subscription := range subs {
		if !subscription.receives(workspaceID) {
			continue
		}
		select {
		case subscription.ch <- message:
		default:
			// The persisted session remains authoritative; polling repairs a slow client.
		}
	}

	for _, fn := range internals {
		fn(eventType, payload)
	}
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

	subscription := &eventSubscription{ch: make(chan []byte, 64), ended: make(chan struct{})}
	if scope, ok := r.Context().Value(scopeContextKey{}).(accessScope); ok {
		subscription.scope = &scope
	}
	if actor := actorFromContext(r.Context()); actor.Agent() {
		subscription.workspace = actor.Identity.WorkspaceID
		if requested := r.URL.Query().Get("workspaceId"); requested != "" && requested != subscription.workspace {
			http.Error(w, "workspace is outside the token's scope", http.StatusForbidden)
			return
		}
	}
	h.mu.Lock()
	if h.closed {
		h.mu.Unlock()
		http.Error(w, "server is shutting down", http.StatusServiceUnavailable)
		return
	}
	h.subscribers[subscription] = struct{}{}
	h.mu.Unlock()
	defer func() {
		h.mu.Lock()
		delete(h.subscribers, subscription)
		h.mu.Unlock()
	}()

	_, _ = fmt.Fprint(w, ": connected\nretry: 1000\n\n")
	flusher.Flush()

	heartbeat := time.NewTicker(15 * time.Second)
	defer heartbeat.Stop()
	for {
		select {
		case <-h.shutdown:
			return
		case <-subscription.ended:
			return
		case <-r.Context().Done():
			return
		case message := <-subscription.ch:
			if _, err := fmt.Fprintf(w, "data: %s\n\n", message); err != nil {
				return
			}
			flusher.Flush()
		case <-heartbeat.C:
			if _, err := fmt.Fprint(w, ": keepalive\n\n"); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}
