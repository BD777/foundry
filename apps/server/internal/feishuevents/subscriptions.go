package feishuevents

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"slices"
	"strings"
	"sync"
	"time"
)

// Limits of agent subscriptions; the Foundry tool's limits name them.
const (
	// MaxSubscriptions per session (or per person outside a session),
	// event sockets included.
	MaxSubscriptions = 8
	// SubscriptionBuffer is how many undelivered events a subscription
	// keeps; beyond it the oldest are dropped and counted.
	SubscriptionBuffer = 500
	// SubscriptionIdle: a subscription nobody polled for this long ends.
	SubscriptionIdle = 30 * time.Minute
	// MaxEventsPerPoll bounds one poll's answer.
	MaxEventsPerPoll = 100
)

// Subscriber is who a subscription serves: an agent session (SessionID set)
// or a person, and the person whose Connectors decide which apps it may
// receive. The caller (MCP tool, Feishu gateway) fills it from the
// authenticated request.
type Subscriber struct {
	SessionID   string
	UserID      string
	WorkspaceID string
}

func (s Subscriber) owner() string {
	if s.SessionID != "" {
		return "session:" + s.SessionID
	}
	return "user:" + s.UserID
}

// SubscribeInput asks for an app's events. AppID is the Feishu app id
// (cli_…) or the Connectors app id (xapp_…); empty when the person has
// connected exactly one Feishu app. No EventTypes means every type; ChatID
// narrows to one chat.
type SubscribeInput struct {
	Who        Subscriber
	AppID      string
	EventTypes []string
	ChatID     string
}

// Subscription buffers the events it asked for until they are polled (or
// written to its socket).
type Subscription struct {
	ID         string
	AppID      string
	EventTypes []string
	ChatID     string
	who        Subscriber
	types      map[string]bool

	mu      sync.Mutex
	events  []Delivered
	last    uint64 // cursor of the newest event pushed
	read    uint64 // cursor the last poll answered up to
	acked   uint64 // events up to this cursor left the buffer
	dropped uint64
	wake    chan struct{}
	idle    *time.Timer
	closed  bool
}

// Delivered is an event with its place in a subscription.
type Delivered struct {
	// Cursor numbers the subscription's events from 1.
	Cursor uint64 `json:"cursor"`
	Event
}

// Batch is one poll's answer.
type Batch struct {
	SubscriptionID string      `json:"subscriptionId"`
	AppID          string      `json:"appId"`
	EventTypes     []string    `json:"eventTypes,omitempty"`
	ChatID         string      `json:"chatId,omitempty"`
	Events         []Delivered `json:"events"`
	// Cursor is where the next poll continues from.
	Cursor uint64 `json:"cursor"`
	// Missed counts events after the asked-for cursor that the full
	// buffer dropped before this poll.
	Missed uint64 `json:"missed,omitempty"`
	// Dropped counts every event the subscription dropped so far.
	Dropped uint64 `json:"dropped"`
	// More: further events wait already; poll again without waiting.
	More bool `json:"more,omitempty"`
	// Connection is how the app's connection stands now.
	Connection string `json:"connection"`
}

var (
	// ErrUnknownSubscription: no such subscription for this caller (never
	// existed, someone else's, unsubscribed, or idle too long).
	ErrUnknownSubscription = errors.New("no such Feishu event subscription for you: it ended (unsubscribed or idle for 30 minutes) or never existed; subscribe again")
	// ErrNoPerson: the caller acts for nobody whose Connectors could say
	// which apps it may receive.
	ErrNoPerson = errors.New("Feishu events are received for a person's connected apps, and this caller acts for no person")
)

func newID(prefix string) string {
	raw := make([]byte, 16)
	_, _ = rand.Read(raw)
	return prefix + hex.EncodeToString(raw)
}

// resolveApp names the Feishu app who may receive events of: requested
// as a Feishu or Connectors app id, or the only one they connected.
func (h *Hub) resolveApp(ctx context.Context, who Subscriber, requested string) (string, error) {
	if who.UserID == "" {
		return "", ErrNoPerson
	}
	if h.access == nil {
		return "", errors.New("this server cannot tell which Feishu apps are connected")
	}
	apps, err := h.access.ConnectedApps(ctx, who.UserID)
	if err != nil {
		return "", err
	}
	if len(apps) == 0 {
		return "", errors.New("no Feishu app is connected for this person: connect one in Connectors first")
	}
	requested = strings.TrimSpace(requested)
	if requested == "" && len(apps) == 1 {
		return apps[0].AppID, nil
	}
	names := make([]string, 0, len(apps))
	for _, app := range apps {
		if requested != "" && (app.AppID == requested || app.ConnectorAppID == requested) {
			return app.AppID, nil
		}
		names = append(names, app.String())
	}
	if requested == "" {
		return "", fmt.Errorf("several Feishu apps are connected; name one with appId: %s", strings.Join(names, ", "))
	}
	return "", fmt.Errorf("Feishu app %s is not connected for this person in Connectors; connected: %s", requested, strings.Join(names, ", "))
}

// Subscribe starts buffering the app's events for in.Who, from now on.
func (h *Hub) Subscribe(ctx context.Context, in SubscribeInput) (*Subscription, error) {
	if err := h.Integrations.Err(); err != nil {
		return nil, err
	}
	appID, err := h.resolveApp(ctx, in.Who, in.AppID)
	if err != nil {
		return nil, err
	}
	subscription, err := h.addSubscription(in.Who, appID, in.EventTypes, strings.TrimSpace(in.ChatID))
	if err != nil {
		return nil, err
	}
	subscription.mu.Lock()
	subscription.idle = time.AfterFunc(SubscriptionIdle, func() { h.endSubscription(subscription) })
	subscription.mu.Unlock()
	return subscription, nil
}

// addSubscription registers a subscription and holds its app.
func (h *Hub) addSubscription(who Subscriber, appID string, eventTypes []string, chatID string) (*Subscription, error) {
	subscription := &Subscription{ID: newID("fsub_"), AppID: appID, ChatID: chatID, who: who, wake: make(chan struct{})}
	for _, eventType := range eventTypes {
		if eventType = strings.TrimSpace(eventType); eventType != "" && !slices.Contains(subscription.EventTypes, eventType) {
			subscription.EventTypes = append(subscription.EventTypes, eventType)
		}
	}
	if len(subscription.EventTypes) > 0 {
		subscription.types = map[string]bool{}
		for _, eventType := range subscription.EventTypes {
			subscription.types[eventType] = true
		}
	}
	h.mu.Lock()
	owned := 0
	for _, existing := range h.subscriptions {
		if existing.who.owner() == who.owner() {
			owned++
		}
	}
	if owned >= MaxSubscriptions {
		h.mu.Unlock()
		return nil, fmt.Errorf("at most %d Feishu event subscriptions at a time: unsubscribe one first", MaxSubscriptions)
	}
	h.subscriptions[subscription.ID] = subscription
	h.mu.Unlock()
	if err := h.Hold(appID, subscription.holder()); err != nil {
		h.mu.Lock()
		delete(h.subscriptions, subscription.ID)
		h.mu.Unlock()
		return nil, err
	}
	return subscription, nil
}

func (s *Subscription) holder() string { return "subscription:" + s.ID }

// wants says whether event is one the subscription asked for.
func (s *Subscription) wants(event Event) bool {
	if event.AppID != s.AppID {
		return false
	}
	if s.types != nil && !s.types[event.Type] {
		return false
	}
	return s.ChatID == "" || s.ChatID == event.ChatID
}

func (s *Subscription) push(event Event) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return
	}
	s.last++
	s.events = append(s.events, Delivered{Cursor: s.last, Event: event})
	if overflow := len(s.events) - SubscriptionBuffer; overflow > 0 {
		// Events already answered go first and are not counted lost.
		for _, gone := range s.events[:overflow] {
			if gone.Cursor > s.read {
				s.dropped++
			}
		}
		s.events = slices.Delete(s.events, 0, overflow)
	}
	close(s.wake)
	s.wake = make(chan struct{})
}

// close ends the subscription for its readers; the hub forgets it.
func (s *Subscription) close() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return
	}
	s.closed = true
	if s.idle != nil {
		s.idle.Stop()
	}
	close(s.wake)
}

// endSubscription removes a subscription and releases its app.
func (h *Hub) endSubscription(subscription *Subscription) {
	h.mu.Lock()
	if h.subscriptions[subscription.ID] == subscription {
		delete(h.subscriptions, subscription.ID)
	}
	h.mu.Unlock()
	subscription.close()
	h.Release(subscription.AppID, subscription.holder())
}

// subscriptionFor finds who's subscription id.
func (h *Hub) subscriptionFor(who Subscriber, id string) (*Subscription, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	subscription := h.subscriptions[strings.TrimSpace(id)]
	if subscription == nil || subscription.who.owner() != who.owner() {
		return nil, ErrUnknownSubscription
	}
	return subscription, nil
}

// Unsubscribe ends who's subscription id.
func (h *Hub) Unsubscribe(who Subscriber, id string) error {
	subscription, err := h.subscriptionFor(who, id)
	if err != nil {
		return err
	}
	h.endSubscription(subscription)
	return nil
}

// Poll answers the events of who's subscription id after cursor (nil:
// after what the last poll answered), at most limit, waiting up to wait for
// the first one. Events up to the cursor are acknowledged and leave the
// buffer. A poll keeps the subscription from idling out.
func (h *Hub) Poll(ctx context.Context, who Subscriber, id string, cursor *uint64, limit int, wait time.Duration) (Batch, error) {
	subscription, err := h.subscriptionFor(who, id)
	if err != nil {
		return Batch{}, err
	}
	if limit <= 0 || limit > MaxEventsPerPoll {
		limit = MaxEventsPerPoll
	}
	subscription.touch()
	timer := time.NewTimer(max(wait, 0))
	defer timer.Stop()
	for {
		batch, wake, closed := subscription.take(cursor, limit)
		if len(batch.Events) > 0 || wait <= 0 || closed {
			status := h.Status(subscription.AppID)
			batch.Connection = "connected"
			if !status.Connected {
				batch.Connection = status.Detail
			}
			if closed && len(batch.Events) == 0 {
				return batch, ErrUnknownSubscription
			}
			return batch, nil
		}
		select {
		case <-ctx.Done():
			return Batch{}, ctx.Err()
		case <-wake:
		case <-timer.C:
			wait = 0
		}
	}
}

func (s *Subscription) touch() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.idle != nil && !s.closed {
		s.idle.Reset(SubscriptionIdle)
	}
}

// take answers the buffered events after cursor (nil: after the last
// answer), at most limit. Reading after a cursor acknowledges every event
// up to it, which leaves the buffer; until then a lost answer can be read
// again by passing its starting cursor.
func (s *Subscription) take(cursor *uint64, limit int) (Batch, <-chan struct{}, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	from := s.read
	if cursor != nil {
		from = max(*cursor, s.acked)
	}
	acknowledged := 0
	for acknowledged < len(s.events) && s.events[acknowledged].Cursor <= from {
		acknowledged++
	}
	s.events = slices.Delete(s.events, 0, acknowledged)
	batch := Batch{SubscriptionID: s.ID, AppID: s.AppID, EventTypes: s.EventTypes, ChatID: s.ChatID, Events: []Delivered{}, Cursor: from, Dropped: s.dropped}
	switch {
	case len(s.events) > 0 && s.events[0].Cursor > from+1:
		batch.Missed = s.events[0].Cursor - from - 1
	case len(s.events) == 0 && s.last > from:
		batch.Missed = s.last - from
	}
	end := min(limit, len(s.events))
	batch.Events = append(batch.Events, s.events[:end]...)
	batch.More = end < len(s.events)
	if len(batch.Events) > 0 {
		batch.Cursor = batch.Events[len(batch.Events)-1].Cursor
	} else {
		batch.Cursor = from + batch.Missed
	}
	s.acked, s.read = from, batch.Cursor
	return batch, s.wake, s.closed
}
