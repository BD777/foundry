package feishuevents

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/feishugateway"
	"github.com/foundry-dev/foundry/apps/server/internal/integrations"
)

const (
	testApp    = "cli_shared"
	testSecret = "secret_shared"
)

// fixedApps holds one app's credentials and who connected which apps.
type fixedApps struct {
	credentials map[string]Credentials
	connected   map[string][]ConnectedApp
}

func (f fixedApps) AppCredentials(_ context.Context, appID string) (Credentials, error) {
	if credentials, ok := f.credentials[appID]; ok {
		return credentials, nil
	}
	return Credentials{}, errors.New("no secret for " + appID)
}

func (f fixedApps) ConnectedApps(_ context.Context, userID string) ([]ConnectedApp, error) {
	return f.connected[userID], nil
}

// recordingBots is a bot route that records events, optionally stalling.
type recordingBots struct {
	mu     sync.Mutex
	events []Event
	stall  chan struct{}
}

func (b *recordingBots) HandleEvent(_ context.Context, event Event) {
	if b.stall != nil {
		<-b.stall
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	b.events = append(b.events, event)
}

func (b *recordingBots) ConnectionChanged(string, Status) {}

func (b *recordingBots) ids() []string {
	b.mu.Lock()
	defer b.mu.Unlock()
	ids := []string{}
	for _, event := range b.events {
		ids = append(ids, event.ID)
	}
	return ids
}

func newTestHub(t *testing.T, fake *FakeSource, secret string) *Hub {
	t.Helper()
	apps := fixedApps{
		credentials: map[string]Credentials{testApp: {AppID: testApp, AppSecret: secret}},
		connected: map[string][]ConnectedApp{
			"u_alice": {{AppID: testApp, ConnectorAppID: "xapp_shared", Label: "Shared"}},
		},
	}
	hub := NewHub(apps, apps)
	hub.Domain = fake.URL()
	hub.ReconnectMin, hub.ReconnectMax = 10*time.Millisecond, 50*time.Millisecond
	hub.Logf = t.Logf
	t.Cleanup(hub.Stop)
	return hub
}

func newFake(t *testing.T) *FakeSource {
	t.Helper()
	fake := NewFakeSource(testApp, testSecret)
	t.Cleanup(fake.Close)
	return fake
}

var alice = Subscriber{SessionID: "sess_alice", UserID: "u_alice", WorkspaceID: "ws_alice"}

func pollNow(t *testing.T, hub *Hub, who Subscriber, id string, wait time.Duration) Batch {
	t.Helper()
	batch, err := hub.Poll(context.Background(), who, id, nil, 0, wait)
	if err != nil {
		t.Fatal(err)
	}
	return batch
}

func eventIDs(batch Batch) []string {
	ids := []string{}
	for _, event := range batch.Events {
		ids = append(ids, event.ID)
	}
	return ids
}

// However many need an app's events, the server holds one connection to
// it; it closes when the last one lets go.
func TestOneConnectionPerAppWhateverNeedsIt(t *testing.T) {
	fake := newFake(t)
	hub := newTestHub(t, fake, testSecret)
	for _, holder := range []string{"bot:ws_a", "bot:ws_b", "bot:ws_a"} {
		if err := hub.Hold(testApp, holder); err != nil {
			t.Fatal(err)
		}
	}
	subscription, err := hub.Subscribe(context.Background(), SubscribeInput{Who: alice})
	if err != nil {
		t.Fatal(err)
	}
	if !fake.WaitOpen(1, 5*time.Second) {
		t.Fatal("no connection opened")
	}
	time.Sleep(100 * time.Millisecond)
	if fake.Accepted() != 1 || fake.EndpointRequests() != 1 {
		t.Fatalf("%d connections, %d endpoint requests; want one of each", fake.Accepted(), fake.EndpointRequests())
	}
	if status := hub.Status(testApp); !status.Connected {
		t.Fatalf("status = %+v", status)
	}
	hub.Release(testApp, "bot:ws_a")
	hub.Release(testApp, "bot:ws_b")
	if err := hub.Unsubscribe(alice, subscription.ID); err != nil {
		t.Fatal(err)
	}
	if !fake.WaitOpen(0, 5*time.Second) {
		t.Fatal("the connection stayed open with nobody holding the app")
	}
	if len(hub.Connections()) != 0 {
		t.Fatalf("connections = %v", hub.Connections())
	}
}

// Events are acked within Feishu's 3 s even when the bot route takes
// longer; subscriptions already hold them when the ack goes out.
func TestEventsAreAckedBeforeTheBotFinishes(t *testing.T) {
	fake := newFake(t)
	hub := newTestHub(t, fake, testSecret)
	bots := &recordingBots{stall: make(chan struct{})}
	hub.Bots = bots
	subscription, err := hub.Subscribe(context.Background(), SubscribeInput{Who: alice, EventTypes: []string{"im.message.receive_v1"}})
	if err != nil {
		t.Fatal(err)
	}
	if !fake.WaitOpen(1, 5*time.Second) {
		t.Fatal("no connection opened")
	}
	if _, err := fake.Push(MessagePayload(testApp, "ev_1", "oc_1", "om_1", "", "hello", true), 1); err != nil {
		t.Fatal(err)
	}
	acks := fake.WaitAcks(1, 5*time.Second)
	if len(acks) != 1 || acks[0].Code != 200 || acks[0].After > time.Second {
		t.Fatalf("acks = %+v, want one 200 well within 3 s while the bot is still busy", acks)
	}
	if ids := eventIDs(pollNow(t, hub, alice, subscription.ID, 0)); len(ids) != 1 || ids[0] != "ev_1" {
		t.Fatalf("subscription got %v at ack time", ids)
	}
	close(bots.stall)
	deadline := time.Now().Add(3 * time.Second)
	for len(bots.ids()) == 0 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if ids := bots.ids(); len(ids) != 1 || ids[0] != "ev_1" {
		t.Fatalf("bot route got %v", ids)
	}
}

// A redelivered event (same event id) is acked again but routed once; an
// event Feishu split into parts arrives whole.
func TestRedeliveriesAreRoutedOnceAndPartsJoined(t *testing.T) {
	fake := newFake(t)
	hub := newTestHub(t, fake, testSecret)
	bots := &recordingBots{}
	hub.Bots = bots
	subscription, err := hub.Subscribe(context.Background(), SubscribeInput{Who: alice})
	if err != nil {
		t.Fatal(err)
	}
	if !fake.WaitOpen(1, 5*time.Second) {
		t.Fatal("no connection opened")
	}
	first := MessagePayload(testApp, "ev_dup", "oc_1", "om_1", "", "once", false)
	split := MessagePayload(testApp, "ev_split", "oc_1", "om_2", "", strings.Repeat("long ", 400), false)
	for _, push := range []struct {
		payload []byte
		parts   int
	}{{first, 1}, {first, 1}, {split, 3}, {first, 2}} {
		if _, err := fake.Push(push.payload, push.parts); err != nil {
			t.Fatal(err)
		}
	}
	acks := fake.WaitAcks(4, 5*time.Second)
	if len(acks) != 4 {
		t.Fatalf("acks = %+v, want every delivery acked", acks)
	}
	batch := pollNow(t, hub, alice, subscription.ID, 0)
	if ids := eventIDs(batch); strings.Join(ids, ",") != "ev_dup,ev_split" {
		t.Fatalf("subscription got %v, want each event once", ids)
	}
	var whole struct {
		Event struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"event"`
	}
	if err := json.Unmarshal(batch.Events[1].Payload, &whole); err != nil || !strings.Contains(whole.Event.Message.Content, strings.Repeat("long ", 400)) {
		t.Fatalf("split event not reassembled: %v", err)
	}
	time.Sleep(50 * time.Millisecond)
	if ids := bots.ids(); len(ids) != 2 {
		t.Fatalf("bot route got %v, want each event once", ids)
	}
}

// A dropped connection is re-established; events after it arrive.
func TestTheConnectionComesBack(t *testing.T) {
	fake := newFake(t)
	hub := newTestHub(t, fake, testSecret)
	subscription, err := hub.Subscribe(context.Background(), SubscribeInput{Who: alice})
	if err != nil {
		t.Fatal(err)
	}
	if !fake.WaitOpen(1, 5*time.Second) {
		t.Fatal("no connection opened")
	}
	fake.DropAll()
	if !fake.waitFor(5*time.Second, func() bool { return fake.accepted == 2 && len(fake.open) == 1 }) {
		t.Fatalf("not reconnected: %d accepted, %d open", fake.Accepted(), fake.Open())
	}
	if _, err := fake.Push(MessagePayload(testApp, "ev_after", "oc_1", "om_1", "", "back", false), 1); err != nil {
		t.Fatal(err)
	}
	if ids := eventIDs(pollNow(t, hub, alice, subscription.ID, 5*time.Second)); len(ids) != 1 || ids[0] != "ev_after" {
		t.Fatalf("after reconnecting got %v", ids)
	}
}

// A wrong secret leaves the app not connected, saying why, and retrying.
func TestARefusedConnectionSaysWhy(t *testing.T) {
	fake := newFake(t)
	hub := newTestHub(t, fake, "wrong")
	if err := hub.Hold(testApp, "bot:ws_a"); err != nil {
		t.Fatal(err)
	}
	if !fake.waitFor(5*time.Second, func() bool { return fake.endpoints >= 2 }) {
		t.Fatal("no retry after a refusal")
	}
	if status := hub.Status(testApp); status.Connected || !strings.Contains(status.Detail, "app id or secret is wrong") {
		t.Fatalf("status = %+v", status)
	}
}

// Subscriptions take only what they asked for, only for apps their person
// connected, only for their owner.
func TestSubscriptionsFilterAndBelongToTheirOwner(t *testing.T) {
	fake := newFake(t)
	hub := newTestHub(t, fake, testSecret)
	ctx := context.Background()
	bob := Subscriber{SessionID: "sess_bob", UserID: "u_bob"}
	if _, err := hub.Subscribe(ctx, SubscribeInput{Who: bob}); err == nil || !strings.Contains(err.Error(), "connect one in Connectors") {
		t.Fatalf("bob subscribed to an app he never connected: %v", err)
	}
	if _, err := hub.Subscribe(ctx, SubscribeInput{Who: alice, AppID: "cli_other"}); err == nil || !strings.Contains(err.Error(), "cli_shared (Shared)") {
		t.Fatalf("subscribing to an unconnected app: %v", err)
	}
	if _, err := hub.Subscribe(ctx, SubscribeInput{Who: Subscriber{SessionID: "sess_x"}}); !errors.Is(err, ErrNoPerson) {
		t.Fatalf("a caller acting for nobody: %v", err)
	}
	messages, err := hub.Subscribe(ctx, SubscribeInput{Who: alice, AppID: "xapp_shared", EventTypes: []string{"im.message.receive_v1"}, ChatID: "oc_1"})
	if err != nil {
		t.Fatal(err)
	}
	everything, err := hub.Subscribe(ctx, SubscribeInput{Who: alice, AppID: testApp})
	if err != nil {
		t.Fatal(err)
	}
	if !fake.WaitOpen(1, 5*time.Second) {
		t.Fatal("no connection opened")
	}
	for _, payload := range [][]byte{
		MessagePayload(testApp, "ev_in_chat", "oc_1", "om_1", "", "hi", false),
		MessagePayload(testApp, "ev_other_chat", "oc_2", "om_2", "", "hi", false),
		EventPayload(testApp, "ev_card", "card.action.trigger", map[string]any{"context": map[string]string{"open_chat_id": "oc_1"}}),
	} {
		if _, err := fake.Push(payload, 1); err != nil {
			t.Fatal(err)
		}
	}
	fake.WaitAcks(3, 5*time.Second)
	if ids := eventIDs(pollNow(t, hub, alice, messages.ID, 0)); strings.Join(ids, ",") != "ev_in_chat" {
		t.Fatalf("filtered subscription got %v", ids)
	}
	batch := pollNow(t, hub, alice, everything.ID, 0)
	if ids := eventIDs(batch); strings.Join(ids, ",") != "ev_in_chat,ev_other_chat,ev_card" || batch.Events[2].ChatID != "oc_1" {
		t.Fatalf("unfiltered subscription got %v", batch.Events)
	}
	if _, err := hub.Poll(ctx, bob, everything.ID, nil, 0, 0); !errors.Is(err, ErrUnknownSubscription) {
		t.Fatalf("bob read alice's subscription: %v", err)
	}
	if err := hub.Unsubscribe(bob, everything.ID); !errors.Is(err, ErrUnknownSubscription) {
		t.Fatalf("bob ended alice's subscription: %v", err)
	}
	for range MaxSubscriptions - 2 {
		if _, err := hub.Subscribe(ctx, SubscribeInput{Who: alice}); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := hub.Subscribe(ctx, SubscribeInput{Who: alice}); err == nil || !strings.Contains(err.Error(), "at most 8") {
		t.Fatalf("a ninth subscription: %v", err)
	}
}

// A poll waits for the first event; cursors continue, acknowledge and
// re-read; a full buffer drops the oldest unread events and counts them.
func TestPollingCursorsAndDrops(t *testing.T) {
	fake := newFake(t)
	hub := newTestHub(t, fake, testSecret)
	ctx := context.Background()
	subscription, err := hub.Subscribe(ctx, SubscribeInput{Who: alice})
	if err != nil {
		t.Fatal(err)
	}
	if !fake.WaitOpen(1, 5*time.Second) {
		t.Fatal("no connection opened")
	}
	started := time.Now()
	if batch := pollNow(t, hub, alice, subscription.ID, 150*time.Millisecond); len(batch.Events) != 0 || time.Since(started) < 150*time.Millisecond || batch.Connection != "connected" {
		t.Fatalf("an empty poll answered %+v after %s", batch, time.Since(started))
	}
	go func() {
		time.Sleep(100 * time.Millisecond)
		_, _ = fake.Push(MessagePayload(testApp, "ev_waited", "oc_1", "om_1", "", "hi", false), 1)
	}()
	batch := pollNow(t, hub, alice, subscription.ID, 5*time.Second)
	if ids := eventIDs(batch); len(ids) != 1 || ids[0] != "ev_waited" || batch.Cursor != 1 {
		t.Fatalf("waiting poll got %+v", batch)
	}
	// The answer was lost: read it again from its starting cursor.
	zero := uint64(0)
	if again, err := hub.Poll(ctx, alice, subscription.ID, &zero, 0, 0); err != nil || len(again.Events) != 1 {
		t.Fatalf("re-read = %+v, %v", again, err)
	}

	for index := range SubscriptionBuffer + 10 {
		subscription.push(Event{AppID: testApp, ID: "ev_" + string(rune('a'+index%26)), Type: "im.message.receive_v1"})
	}
	batch = pollNow(t, hub, alice, subscription.ID, 0)
	if batch.Missed != 10 || batch.Dropped != 10 || len(batch.Events) != MaxEventsPerPoll || !batch.More || batch.Events[0].Cursor != 12 {
		t.Fatalf("after overflowing: missed %d dropped %d, %d events from %d, more %v", batch.Missed, batch.Dropped, len(batch.Events), batch.Events[0].Cursor, batch.More)
	}
	next := pollNow(t, hub, alice, subscription.ID, 0)
	if next.Missed != 0 || next.Events[0].Cursor != batch.Cursor+1 {
		t.Fatalf("next poll continues at %d (missed %d), want %d", next.Events[0].Cursor, next.Missed, batch.Cursor+1)
	}
}

// Integrations off: nothing connects, and asking says why.
func TestIntegrationsOffConnectsNothing(t *testing.T) {
	fake := newFake(t)
	hub := newTestHub(t, fake, testSecret)
	hub.Integrations = integrations.New(false)
	if err := hub.Hold(testApp, "bot:ws_a"); !errors.Is(err, integrations.ErrOff) {
		t.Fatalf("hold: %v", err)
	}
	if _, err := hub.Subscribe(context.Background(), SubscribeInput{Who: alice}); !errors.Is(err, integrations.ErrOff) {
		t.Fatalf("subscribe: %v", err)
	}
	if answer := (GatewayEvents{Hub: hub}).endpoint(feishugateway.Caller{SessionID: "sess_alice", UserID: "u_alice", ClientID: testApp}, "ws://127.0.0.1:1/socket?t=1"); answer.Code == 0 || !strings.Contains(answer.Msg, "integrations are off") {
		t.Fatalf("endpoint: %+v", answer)
	}
	time.Sleep(100 * time.Millisecond)
	if fake.EndpointRequests() != 0 || fake.Accepted() != 0 {
		t.Fatal("feishu was reached with integrations off")
	}
}

func (h *Hub) subscriptionCount(who Subscriber) int {
	h.mu.Lock()
	defer h.mu.Unlock()
	count := 0
	for _, subscription := range h.subscriptions {
		if subscription.who.owner() == who.owner() {
			count++
		}
	}
	return count
}

// memoryReceipts is the store's event receipts, outliving a hub.
type memoryReceipts struct {
	mu   sync.Mutex
	seen map[string]time.Time
}

func (r *memoryReceipts) RecordFeishuEvent(_ context.Context, appID, eventID string, at time.Time, ttl time.Duration) (bool, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	key := appID + "/" + eventID
	if previous, ok := r.seen[key]; ok && at.Sub(previous) < ttl {
		return false, nil
	}
	r.seen[key] = at
	return true, nil
}

// A redelivery that arrives after a restart (a new hub, the same store) is
// acked but not routed again; the app's status says when an event came.
func TestARedeliveryAfterARestartIsNotRoutedAgain(t *testing.T) {
	fake := newFake(t)
	receipts := &memoryReceipts{seen: map[string]time.Time{}}
	payload := MessagePayload(testApp, "ev_restart", "oc_1", "om_1", "", "once", false)
	routed := 0
	for run := range 2 {
		hub := newTestHub(t, fake, testSecret)
		hub.Receipts = receipts
		bots := &recordingBots{}
		hub.Bots = bots
		if err := hub.Hold(testApp, "bots"); err != nil {
			t.Fatal(err)
		}
		if !fake.WaitOpen(1, 5*time.Second) {
			t.Fatal("no connection opened")
		}
		if !hub.Status(testApp).LastEventAt.IsZero() {
			t.Fatal("a fresh hub reports an event it never received")
		}
		if _, err := fake.Push(payload, 1); err != nil {
			t.Fatal(err)
		}
		if acks := fake.WaitAcks(run+1, 5*time.Second); len(acks) != run+1 {
			t.Fatalf("run %d: acks = %+v, want every delivery acked", run, acks)
		}
		time.Sleep(50 * time.Millisecond)
		routed += len(bots.ids())
		if hub.Status(testApp).LastEventAt.IsZero() {
			t.Fatalf("run %d: the status does not say an event arrived", run)
		}
		hub.Stop()
		if !fake.WaitOpen(0, 5*time.Second) {
			t.Fatal("the stopped hub's connection stayed open")
		}
	}
	if routed != 1 {
		t.Fatalf("the event was routed %d times across a restart, want once", routed)
	}
}
