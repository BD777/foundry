package feishuevents

import (
	"context"
	"errors"
	"log"
	"net/http"
	"sort"
	"sync"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/integrations"
	"github.com/gorilla/websocket"
)

// Credentials is a Feishu app's id and secret, unsealed for one connection
// attempt, and the open-platform base it belongs to ("" is Feishu's).
type Credentials struct {
	AppID     string
	AppSecret string
	BaseURL   string
}

// CredentialSource reads a Feishu app's credentials wherever the server
// holds them (ServerApps).
type CredentialSource interface {
	AppCredentials(ctx context.Context, appID string) (Credentials, error)
}

// Status is where an app's connection stands.
type Status struct {
	Connected bool
	// Detail says why it is not connected.
	Detail string
	// LastEventAt is when the app's connection last delivered an event
	// (zero: none since the server started).
	LastEventAt time.Time
}

// EventReceipts remembers the event ids routed across restarts, so a
// redelivery inside Feishu's window after a restart is acked but not routed
// again (store.FeishuBotStore).
type EventReceipts interface {
	RecordFeishuEvent(ctx context.Context, appID, eventID string, at time.Time, ttl time.Duration) (bool, error)
}

// BotRoute is the Workspace Bot side of the router (feishu.WSManager): it is
// handed every event of every app connected here, finds the workspace
// whose bot owns the chat or thread, and drops the rest. It is told how
// each app's connection stands.
type BotRoute interface {
	HandleEvent(ctx context.Context, event Event)
	ConnectionChanged(appID string, status Status)
}

// Hub holds the server's single long connection per Feishu app and routes
// what arrives on it. A connection is open while anyone holds its app (a
// workspace bot, an agent subscription, an emulated socket) and closes
// when the last one lets go.
type Hub struct {
	// Integrations off: no connection opens; Hold and Subscribe answer
	// integrations.ErrOff. Nil is on.
	Integrations *integrations.Switch
	// Domain, when set, replaces every app's open-platform base (tests
	// point it at a fake).
	Domain string
	// HTTPClient negotiates endpoints; Dialer dials them. Nil: defaults.
	HTTPClient *http.Client
	Dialer     *websocket.Dialer
	// ReconnectMin and ReconnectMax bound the backoff between attempts.
	ReconnectMin time.Duration
	ReconnectMax time.Duration
	// DedupeWindow is how long an event id is remembered per app.
	DedupeWindow time.Duration
	// Bots is the Workspace Bot route; nil drops what no subscription takes.
	Bots BotRoute
	// Receipts, when set, keeps the dedupe window across restarts.
	Receipts EventReceipts
	Logf     func(format string, args ...any)

	credentials CredentialSource
	access      Access

	mu            sync.Mutex
	apps          map[string]*appEvents
	subscriptions map[string]*Subscription
	stopped       bool
}

type appEvents struct {
	holders   map[string]bool
	conn      *connection
	status    Status
	seen      *seenEvents
	lastEvent time.Time
}

// dedupeCapacity bounds the ids remembered per app.
const dedupeCapacity = 20_000

// NewHub builds a hub that connects with credentials and lets people (and
// their sessions) subscribe to the apps access says they connected.
func NewHub(credentials CredentialSource, access Access) *Hub {
	return &Hub{
		ReconnectMin:  time.Second,
		ReconnectMax:  2 * time.Minute,
		DedupeWindow:  24 * time.Hour,
		Logf:          log.Printf,
		credentials:   credentials,
		access:        access,
		apps:          map[string]*appEvents{},
		subscriptions: map[string]*Subscription{},
	}
}

func (h *Hub) logf(format string, args ...any) {
	if h.Logf != nil {
		h.Logf(format, args...)
	}
}

func (h *Hub) httpClient() *http.Client {
	if h.HTTPClient != nil {
		return h.HTTPClient
	}
	return &http.Client{Timeout: 10 * time.Second}
}

func (h *Hub) dialer() *websocket.Dialer {
	if h.Dialer != nil {
		return h.Dialer
	}
	dialer := *websocket.DefaultDialer
	return &dialer
}

// ErrStopped: the hub was shut down.
var ErrStopped = errors.New("feishu events: the server is shutting down")

// Hold opens appID's connection for holder, or keeps it open; holding an
// app twice under one name is one hold.
func (h *Hub) Hold(appID, holder string) error {
	if err := h.Integrations.Err(); err != nil {
		return err
	}
	if appID == "" {
		return errors.New("feishu events: no app id")
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.stopped {
		return ErrStopped
	}
	app := h.appLocked(appID)
	app.holders[holder] = true
	switch {
	case app.conn == nil:
		app.status = Status{Detail: "connecting"}
		app.conn = h.startConnection(appID)
	case !app.status.Connected:
		app.conn.retryNow()
	}
	return nil
}

// Release lets go of holder's hold; the last release closes the connection.
func (h *Hub) Release(appID, holder string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	app := h.apps[appID]
	if app == nil {
		return
	}
	delete(app.holders, holder)
	if len(app.holders) == 0 && app.conn != nil {
		app.conn.cancel()
		app.conn = nil
		app.status = Status{Detail: "not connected: nothing needs this app's events"}
	}
}

func (h *Hub) appLocked(appID string) *appEvents {
	app := h.apps[appID]
	if app == nil {
		app = &appEvents{holders: map[string]bool{}, seen: newSeenEvents(h.DedupeWindow, dedupeCapacity)}
		h.apps[appID] = app
	}
	return app
}

// Status is where appID's connection stands.
func (h *Hub) Status(appID string) Status {
	h.mu.Lock()
	defer h.mu.Unlock()
	if app := h.apps[appID]; app != nil {
		status := app.status
		status.LastEventAt = app.lastEvent
		return status
	}
	return Status{Detail: "not connected"}
}

// Subscriptions counts the agent subscriptions (event sockets included)
// open on appID.
func (h *Hub) Subscriptions(appID string) int {
	h.mu.Lock()
	defer h.mu.Unlock()
	count := 0
	for _, subscription := range h.subscriptions {
		if subscription.AppID == appID {
			count++
		}
	}
	return count
}

// Connections lists the apps with an open (or opening) connection.
func (h *Hub) Connections() []string {
	h.mu.Lock()
	defer h.mu.Unlock()
	apps := []string{}
	for id, app := range h.apps {
		if app.conn != nil {
			apps = append(apps, id)
		}
	}
	sort.Strings(apps)
	return apps
}

// Stop closes every connection, subscription and socket and waits for the
// connections to end. Nothing opens afterwards.
func (h *Hub) Stop() {
	h.mu.Lock()
	h.stopped = true
	var closing []*connection
	for _, app := range h.apps {
		if app.conn != nil {
			app.conn.cancel()
			closing = append(closing, app.conn)
			app.conn = nil
		}
	}
	subscriptions := make([]*Subscription, 0, len(h.subscriptions))
	for _, subscription := range h.subscriptions {
		subscriptions = append(subscriptions, subscription)
	}
	h.subscriptions = map[string]*Subscription{}
	h.mu.Unlock()
	for _, subscription := range subscriptions {
		subscription.close()
	}
	for _, conn := range closing {
		<-conn.done
	}
}

// connectionChanged records how c stands, unless c was replaced or closed,
// and tells the bot route.
func (h *Hub) connectionChanged(c *connection, status Status) {
	h.mu.Lock()
	app := h.apps[c.appID]
	if app == nil || app.conn != c {
		h.mu.Unlock()
		return
	}
	app.status = status
	bots := h.Bots
	h.mu.Unlock()
	if bots != nil {
		bots.ConnectionChanged(c.appID, status)
	}
}

// receive routes one event that arrived on c, once per event id (in
// memory, and through Receipts across restarts): into every matching
// subscription's buffer before it returns (the ack follows right after),
// and to the bot route in the background, so a slow bot reply never delays
// the ack past Feishu's 3 s.
func (h *Hub) receive(c *connection, event Event) {
	h.mu.Lock()
	app := h.apps[c.appID]
	if app == nil || !app.seen.firstTime(event.ID, event.Received) {
		h.mu.Unlock()
		if app != nil {
			h.logf("feishu events: app %s: event %s delivered again; acked, not routed again", c.appID, event.ID)
		}
		return
	}
	app.lastEvent = event.Received
	receipts := h.Receipts
	h.mu.Unlock()
	if receipts != nil && event.ID != "" {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		first, err := receipts.RecordFeishuEvent(ctx, c.appID, event.ID, event.Received, h.DedupeWindow)
		cancel()
		switch {
		case err != nil:
			h.logf("feishu events: app %s: remember event %s: %v; routed anyway", c.appID, event.ID, err)
		case !first:
			h.logf("feishu events: app %s: event %s was routed before a restart; acked, not routed again", c.appID, event.ID)
			return
		}
	}
	h.mu.Lock()
	var targets []*Subscription
	for _, subscription := range h.subscriptions {
		if subscription.wants(event) {
			targets = append(targets, subscription)
		}
	}
	bots := h.Bots
	h.mu.Unlock()
	for _, subscription := range targets {
		subscription.push(event)
	}
	if bots != nil {
		go func() {
			defer func() {
				if recovered := recover(); recovered != nil {
					h.logf("feishu events: the bot route panicked on event %s: %v", event.ID, recovered)
				}
			}()
			bots.HandleEvent(context.Background(), event)
		}()
	}
}
