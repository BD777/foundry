package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"github.com/foundry-dev/foundry/apps/server/internal/sqlitestore"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// inboxFixture is a running Codex session whose device the test plays.
type inboxFixture struct {
	t       *testing.T
	backing *sqlitestore.Store
	server  *Server
	session store.AgentSession
	conn    *websocket.Conn
	writeMu sync.Mutex
	// answer decides the device's reply to each steer it receives.
	answer func(payload wsSteerSessionPayload) map[string]any
	steers chan wsSteerSessionPayload
}

func newInboxFixture(t *testing.T, start bool) *inboxFixture {
	t.Helper()
	backing := newEmptyTestStore(t)
	ctx := context.Background()
	if err := backing.RegisterDaemon(ctx, store.DaemonRegistration{
		Device:    store.DeviceProjection{ID: "dev_inbox", Label: "Inbox Device", Status: "connected", LastSeenLabel: "online"},
		Workspace: store.WorkspaceProjection{ID: "ws_inbox", Name: "Inbox", LocalPath: t.TempDir(), Baseline: "main"},
		Agents: []store.AgentProjection{{
			ID: "agent_inbox_codex", WorkspaceID: "ws_inbox", DeviceID: "dev_inbox", DeviceLabel: "Inbox Device",
			Provider: "codex", Status: "healthy", AuthMode: "local_config", SecretStored: "local",
			ConfigScope: "workspace", ConfigLabel: "device local login", LastSeenLabel: "online",
		}},
	}); err != nil {
		t.Fatalf("register daemon seed: %v", err)
	}
	session, err := backing.CreateAgentSession(ctx, store.CreateAgentSessionInput{
		WorkspaceID: "ws_inbox", AgentID: "agent_inbox_codex", Provider: "codex", Prompt: "orchestrate", Source: "chat",
	})
	if err != nil {
		t.Fatalf("create session: %v", err)
	}
	if start {
		if session, err = backing.StartAgentSession(ctx, session.ID); err != nil {
			t.Fatalf("start session: %v", err)
		}
	}
	fixture := &inboxFixture{t: t, backing: backing, server: NewServer(backing), session: session, steers: make(chan wsSteerSessionPayload, 16)}
	fixture.answer = func(wsSteerSessionPayload) map[string]any { return map[string]any{"sessionId": session.ID} }
	testServer := httptest.NewServer(fixture.server.Routes())
	t.Cleanup(testServer.Close)
	conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(testServer.URL, "http")+"/api/daemon/ws", nil)
	if err != nil {
		t.Fatalf("dial daemon websocket: %v", err)
	}
	t.Cleanup(func() { conn.Close() })
	fixture.conn = conn
	active := []string{}
	if start {
		active = []string{session.ID}
	}
	writeWSForTest(t, conn, "hello", map[string]any{
		"activeSessionIds": active,
		"device":           map[string]any{"id": "dev_inbox", "label": "Inbox Device", "status": "connected", "lastSeenLabel": "online"},
		"workspace":        map[string]any{"id": "ws_inbox", "name": "Inbox", "localPath": t.TempDir(), "baseline": "main"},
		"providerHealth":   []map[string]any{},
		"assets":           []map[string]any{},
	})
	readWSTypeForTest(t, conn, "registered")
	go fixture.playDevice()
	return fixture
}

func (f *inboxFixture) playDevice() {
	for {
		var envelope struct {
			ID      string          `json:"id"`
			Type    string          `json:"type"`
			Payload json.RawMessage `json:"payload"`
		}
		if err := f.conn.ReadJSON(&envelope); err != nil {
			return
		}
		if envelope.Type != wsSteerSessionType {
			continue
		}
		var payload wsSteerSessionPayload
		if err := json.Unmarshal(envelope.Payload, &payload); err != nil {
			return
		}
		reply := f.answer(payload)
		f.writeMu.Lock()
		_ = f.conn.WriteJSON(map[string]any{"id": envelope.ID, "type": wsSessionSteeredType, "payload": reply})
		f.writeMu.Unlock()
		f.steers <- payload
	}
}

func (f *inboxFixture) reportEvent(event store.AgentSessionEvent) {
	f.t.Helper()
	event.SessionID = f.session.ID
	f.writeMu.Lock()
	err := f.conn.WriteJSON(map[string]any{"id": "evt-" + event.ID, "type": wsSessionEventType, "payload": wsSessionEventPayload{Event: event}})
	f.writeMu.Unlock()
	if err != nil {
		f.t.Fatalf("report event: %v", err)
	}
}

func (f *inboxFixture) item(inputID string) store.SessionInboxItem {
	f.t.Helper()
	item, ok, err := f.backing.SessionInboxItem(context.Background(), f.session.ID, inputID)
	if err != nil || !ok {
		f.t.Fatalf("read inbox item %s: ok=%v err=%v", inputID, ok, err)
	}
	return item
}

func (f *inboxFixture) waitState(inputID, state string) store.SessionInboxItem {
	f.t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		item := f.item(inputID)
		if item.State == state {
			return item
		}
		if time.Now().After(deadline) {
			f.t.Fatalf("inbox item %s state = %s (%s), want %s", inputID, item.State, item.Reason, state)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func (f *inboxFixture) nextSteer() wsSteerSessionPayload {
	f.t.Helper()
	select {
	case payload := <-f.steers:
		return payload
	case <-time.After(5 * time.Second):
		f.t.Fatal("no steer reached the device")
		return wsSteerSessionPayload{}
	}
}

// The refusal an orchestrator hit (DEV-057): a session that is not taking
// input now no longer loses the message. It is held, steered once the turn
// takes it, delivered when its event arrives and consumed when its worker
// reports the model read it; that report is not transcript.
func TestInboxHoldsAMessageTheTurnCannotTakeYet(t *testing.T) {
	fixture := newInboxFixture(t, true)
	ctx := context.Background()
	refuse := true
	var mu sync.Mutex
	fixture.answer = func(payload wsSteerSessionPayload) map[string]any {
		mu.Lock()
		defer mu.Unlock()
		if refuse {
			return map[string]any{"sessionId": payload.SessionID, "error": "This session is not accepting active steer input.", "notSteerable": true}
		}
		return map[string]any{"sessionId": payload.SessionID, "inputId": payload.InputID}
	}
	_, receipt, err := fixture.server.sendInboxMessage(ctx, fixture.session, "", "sess_sender", store.DeliveryBoundary, "the contract is ready", nil, nil)
	if err != nil {
		t.Fatalf("send: %v", err)
	}
	first := fixture.nextSteer()
	if first.Delivery != store.DeliveryBoundary || first.BoundaryLimitMs != inboxBoundaryLimitMs || first.SentBySessionID != "sess_sender" {
		t.Fatalf("steer = %+v, want a boundary steer from sess_sender", first)
	}
	if receipt.State != store.InboxHeld || receipt.Reason != "not_steerable" || receipt.DeliverAt != "when_steerable" {
		t.Fatalf("receipt = %+v, want held, not steerable", receipt)
	}
	mu.Lock()
	refuse = false
	mu.Unlock()
	fixture.server.pumpSessionInbox(ctx)
	if again := fixture.nextSteer(); again.InputID != receipt.InputID {
		t.Fatalf("retried steer input = %s, want %s", again.InputID, receipt.InputID)
	}
	fixture.waitState(receipt.InputID, store.InboxAccepted)

	fixture.reportEvent(store.AgentSessionEvent{ID: "evt_" + receipt.InputID, Label: steeredIntoTurnLabel, Level: "info", Detail: "the contract is ready"})
	delivered := fixture.waitState(receipt.InputID, store.InboxDelivered)
	if delivered.DeliveredAs != "steer" || delivered.DeliveredAt == nil {
		t.Fatalf("delivered = %+v", delivered)
	}
	fixture.reportEvent(store.AgentSessionEvent{ID: "read-" + receipt.InputID, Label: inboxConsumedLabel, Level: "info", Detail: receipt.InputID})
	fixture.waitState(receipt.InputID, store.InboxConsumed)
	events, _, err := fixture.backing.AgentSessionEventWindow(ctx, fixture.session.ID, "", 1000)
	if err != nil {
		t.Fatal(err)
	}
	for _, event := range events {
		if event.Label == inboxConsumedLabel {
			t.Fatalf("the read report was recorded as transcript: %+v", event)
		}
	}

	// A device that does not answer in time may hold the message: it is
	// unknown, not resent, and its event settles it.
	fixture.answer = func(wsSteerSessionPayload) map[string]any {
		time.Sleep(sessionControlTimeout + 200*time.Millisecond)
		return map[string]any{}
	}
	previous := sessionControlTimeout
	sessionControlTimeout = 300 * time.Millisecond
	t.Cleanup(func() { sessionControlTimeout = previous })
	_, slow, err := fixture.server.sendInboxMessage(ctx, fixture.session, "", "sess_sender", store.DeliveryInterrupt, "stop: the base changed", nil, nil)
	if err != nil {
		t.Fatalf("send slow: %v", err)
	}
	if slow.State != store.InboxUnknown || slow.DeliverAt != "unconfirmed" {
		t.Fatalf("slow receipt = %+v, want unknown", slow)
	}
	fixture.nextSteer()
	fixture.server.pumpSessionInbox(ctx)
	select {
	case resent := <-fixture.steers:
		t.Fatalf("an unconfirmed message was steered again: %+v", resent)
	case <-time.After(200 * time.Millisecond):
	}
	fixture.reportEvent(store.AgentSessionEvent{ID: "evt_" + slow.InputID, Label: steeredIntoTurnLabel, Level: "info", Detail: "stop: the base changed"})
	fixture.waitState(slow.InputID, store.InboxDelivered)
}

// A turn_end message waits for the turn, and goes in at the next boundary
// once it has waited past the flush limit.
func TestInboxTurnEndWaitsThenFlushes(t *testing.T) {
	fixture := newInboxFixture(t, true)
	ctx := context.Background()
	_, receipt, err := fixture.server.sendInboxMessage(ctx, fixture.session, "", "sess_sender", store.DeliveryTurnEnd, "status: tests pass", nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if receipt.State != store.InboxHeld || receipt.DeliverAt != "turn_end" {
		t.Fatalf("receipt = %+v, want held for the turn's end", receipt)
	}
	old, err := fixture.backing.AdmitSessionInboxItem(ctx, store.SessionInboxItem{
		SessionID: fixture.session.ID, InputID: "0b1c2d3e-0000-4000-8000-000000000001", SenderSessionID: "sess_sender",
		Prompt: "status: an old one", RequestedDelivery: store.DeliveryTurnEnd,
	}, store.SessionInboxRules{Now: time.Now().Add(-inboxTurnEndFlush - time.Minute)})
	if err != nil {
		t.Fatal(err)
	}
	fixture.server.pumpSessionInbox(ctx)
	steer := fixture.nextSteer()
	if steer.InputID != old.Item.InputID || steer.Delivery != store.DeliveryBoundary {
		t.Fatalf("flushed steer = %+v, want the old message at a boundary", steer)
	}
	if fixture.item(receipt.InputID).State != store.InboxHeld {
		t.Fatal("a fresh turn_end message did not wait")
	}
}

// Held messages for a session between turns start its next turn together;
// repeats are the earlier message; interrupts past the allowance wait for
// a boundary.
func TestInboxStartsTheNextTurnAndAdmitsOnce(t *testing.T) {
	fixture := newInboxFixture(t, false)
	ctx := context.Background()
	_, first, err := fixture.server.sendInboxMessage(ctx, fixture.session, "", "sess_a", store.DeliveryInterrupt, "blocker one", nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if first.State != store.InboxHeld || first.DeliverAt != "turn_start" {
		t.Fatalf("queued session receipt = %+v, want held until its turn starts", first)
	}
	_, repeat, err := fixture.server.sendInboxMessage(ctx, fixture.session, "", "sess_a", store.DeliveryInterrupt, "blocker one", nil, nil)
	if err != nil || !repeat.Duplicate || repeat.InputID != first.InputID {
		t.Fatalf("repeat = %+v, %v; want the first message again", repeat, err)
	}
	_, sameID, err := fixture.server.sendInboxMessage(ctx, fixture.session, first.InputID, "sess_a", store.DeliveryBoundary, "different text", nil, nil)
	if err != nil || !sameID.Duplicate {
		t.Fatalf("same inputId = %+v, %v; want a duplicate", sameID, err)
	}
	if _, _, err := fixture.server.sendInboxMessage(ctx, fixture.session, "", "sess_a", store.DeliveryInterrupt, "blocker two", nil, nil); err != nil {
		t.Fatal(err)
	}
	_, third, err := fixture.server.sendInboxMessage(ctx, fixture.session, "", "sess_a", store.DeliveryInterrupt, "blocker three", nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if third.Delivery != store.DeliveryBoundary || third.RequestedDelivery != store.DeliveryInterrupt || third.Downgraded == "" {
		t.Fatalf("third interrupt = %+v, want a boundary past the allowance", third)
	}

	if _, err := fixture.backing.StartAgentSession(ctx, fixture.session.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.backing.CompleteAgentSession(ctx, fixture.session.ID, "done", ""); err != nil {
		t.Fatal(err)
	}
	fixture.server.pumpSessionInbox(ctx)
	one := fixture.item(first.InputID)
	if one.State != store.InboxDelivered || one.DeliveredAs != "turn" || one.DeliveredInputID == "" {
		t.Fatalf("first after the turn ended = %+v, want delivered in a new turn", one)
	}
	if three := fixture.item(third.InputID); three.DeliveredInputID != one.DeliveredInputID {
		t.Fatalf("held messages started separate turns: %s and %s", one.DeliveredInputID, three.DeliveredInputID)
	}
	session, err := fixture.backing.GetAgentSessionRecord(ctx, fixture.session.ID)
	if err != nil {
		t.Fatal(err)
	}
	if session.Input.ID != one.DeliveredInputID || !strings.Contains(session.Input.Prompt, "Message 3 of 3") {
		t.Fatalf("next turn input = %s %q, want the three held messages", session.Input.ID, session.Input.Prompt)
	}
	fixture.server.markInboxTurnConsumed(ctx, session)
	if got := fixture.item(first.InputID).State; got != store.InboxConsumed {
		t.Fatalf("state after the turn started = %s, want consumed", got)
	}
}

// A person's queued message can ask to enter the running turn at its next
// boundary (DEV-063's answers to an Agent's question): the steer carries
// the delivery; a body without one steers as before; another is refused.
func TestChatQueueSteerTakesABoundaryDelivery(t *testing.T) {
	backing := newEmptyTestStore(t)
	ctx := context.Background()
	registerQueueDevice(t, backing, "codex")
	session, err := backing.CreateAgentSession(ctx, store.CreateAgentSessionInput{
		WorkspaceID: "ws_queue", AgentID: "agent_queue", Provider: "codex", Prompt: "running", Source: "chat",
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := backing.StartAgentSession(ctx, session.ID); err != nil {
		t.Fatal(err)
	}
	server := NewServer(backing)
	live := httptest.NewServer(server.Routes())
	defer live.Close()
	client := queueClient{t: t, server: server, url: live.URL}
	daemon := connectQueueDaemon(t, live.URL, "dev_queue", "ws_queue", "codex", []string{session.ID}, "codex_active_steer")
	path := "/api/chats/" + session.ID + "/queue"
	queue := client.queue(http.MethodPost, path, `{"text":"option B"}`, "", http.StatusCreated)
	if status, raw := client.call(http.MethodPost, path+"/"+queue.Items[0].ID+"/steer", `{"delivery":"turn_end"}`, ""); status != http.StatusBadRequest {
		t.Fatalf("turn_end steer = %d %s, want refused", status, raw)
	}
	client.queue(http.MethodPost, path+"/"+queue.Items[0].ID+"/steer", `{"delivery":"boundary"}`, "", http.StatusOK)
	queue = client.queue(http.MethodPost, path, `{"text":"plain"}`, "", http.StatusCreated)
	client.queue(http.MethodPost, path+"/"+queue.Items[0].ID+"/steer", "", "", http.StatusOK)
	daemon.mu.Lock()
	defer daemon.mu.Unlock()
	if len(daemon.steered) != 2 {
		t.Fatalf("steered = %+v", daemon.steered)
	}
	if first := daemon.steered[0]; first.Message != "option B" || first.Delivery != store.DeliveryBoundary || first.BoundaryLimitMs != inboxBoundaryLimitMs {
		t.Fatalf("boundary steer = %+v", first)
	}
	if second := daemon.steered[1]; second.Delivery != "" || second.BoundaryLimitMs != 0 {
		t.Fatalf("plain steer = %+v, want the runtime's own way", second)
	}
}
