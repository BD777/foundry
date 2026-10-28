package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"github.com/foundry-dev/foundry/apps/server/internal/browserevent"
	"github.com/foundry-dev/foundry/apps/server/internal/eventstream"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"github.com/foundry-dev/foundry/apps/server/internal/testfixture"
)

// backlogDaemon plays a device whose link is slow: it answers nothing it
// is asked (steers, lists) unless told to, and reports what it was sent.
type backlogDaemon struct {
	t       *testing.T
	conn    *websocket.Conn
	writeMu sync.Mutex
	mu      sync.Mutex
	acks    map[string]bool
	errs    map[string]string
	steered []wsSteerSessionPayload
	runs    []store.AgentSession
}

func connectBacklogDaemon(t *testing.T, serverURL string, active []string) *backlogDaemon {
	t.Helper()
	conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(serverURL, "http")+"/api/daemon/ws", nil)
	if err != nil {
		t.Fatalf("dial daemon websocket: %v", err)
	}
	t.Cleanup(func() { conn.Close() })
	daemon := &backlogDaemon{t: t, conn: conn, acks: map[string]bool{}, errs: map[string]string{}}
	daemon.write("hello_1", "hello", map[string]any{
		"activeSessionIds": active,
		"device":           map[string]any{"id": "dev_queue", "label": "Queue Device", "status": "connected", "lastSeenLabel": "online"},
		"workspace":        map[string]any{"id": "ws_queue", "name": "Queue", "localPath": t.TempDir(), "baseline": "main"},
		"providerHealth":   []map[string]any{},
		"assets":           []map[string]any{},
		"agents": []map[string]any{{
			"id": "agent_queue", "workspaceId": "ws_queue", "deviceId": "dev_queue", "deviceLabel": "Queue Device",
			"provider": "claude", "status": "healthy", "authMode": "local_config", "secretStored": "local",
			"configScope": "workspace", "configLabel": "device local login", "lastSeenLabel": "online",
		}},
	})
	registered := make(chan struct{})
	go func() {
		for {
			var envelope struct {
				ID      string          `json:"id"`
				Type    string          `json:"type"`
				Payload json.RawMessage `json:"payload"`
			}
			if err := conn.ReadJSON(&envelope); err != nil {
				return
			}
			daemon.mu.Lock()
			switch envelope.Type {
			case wsRegisteredType:
				if envelope.ID == "hello_1" {
					close(registered)
				}
			case wsAckType:
				daemon.acks[envelope.ID] = true
			case wsErrorType:
				daemon.errs[envelope.ID] = string(envelope.Payload)
			case wsSteerSessionType:
				var payload wsSteerSessionPayload
				if json.Unmarshal(envelope.Payload, &payload) == nil {
					daemon.steered = append(daemon.steered, payload)
				}
			case wsRunSessionType:
				var payload wsRunSessionPayload
				if json.Unmarshal(envelope.Payload, &payload) == nil && payload.Session.Source != "naming" {
					daemon.runs = append(daemon.runs, payload.Session)
				}
			}
			daemon.mu.Unlock()
		}
	}()
	select {
	case <-registered:
	case <-time.After(5 * time.Second):
		t.Fatal("daemon never registered")
	}
	return daemon
}

func (d *backlogDaemon) write(id, messageType string, payload any) {
	d.writeMu.Lock()
	defer d.writeMu.Unlock()
	writeWSIDForTest(d.t, d.conn, id, messageType, payload)
}

// send writes a session message and waits for the server's acknowledgement.
func (d *backlogDaemon) send(id, messageType string, payload any) {
	d.t.Helper()
	d.write(id, messageType, payload)
	waitForTest(d.t, "ack of "+id, func() bool {
		d.mu.Lock()
		defer d.mu.Unlock()
		return d.acks[id]
	})
}

// answer writes a message and waits for the server's answer to it: "ack"
// or "error".
func (d *backlogDaemon) answer(id, messageType string, payload any) string {
	d.t.Helper()
	d.write(id, messageType, payload)
	answer := ""
	waitForTest(d.t, "an answer to "+id, func() bool {
		d.mu.Lock()
		defer d.mu.Unlock()
		if d.acks[id] {
			answer = "ack"
		} else if _, refused := d.errs[id]; refused {
			answer = "error"
		}
		return answer != ""
	})
	return answer
}

func (d *backlogDaemon) snapshot() ([]wsSteerSessionPayload, []store.AgentSession) {
	d.mu.Lock()
	defer d.mu.Unlock()
	return append([]wsSteerSessionPayload(nil), d.steered...), append([]store.AgentSession(nil), d.runs...)
}

func waitForTest(t *testing.T, what string, done func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !done() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// publishedEvents counts what the server streams, by type: a session as
// "type id status", a transcript event as "type id".
type publishedEvents struct {
	t      *testing.T
	viewer *eventstream.Subscription
	events []string
}

func publishedEventsOf(t *testing.T, server *Server) *publishedEvents {
	return &publishedEvents{t: t, viewer: subscribeForTest(server.stream)}
}

// read records what the stream holds: everything published so far.
func (p *publishedEvents) read() {
	for _, streamed := range drainForTest(p.t, p.viewer) {
		switch streamed.kind {
		case browserevent.AgentSessionEvent:
			event := payloadForTest[store.AgentSessionEvent](p.t, streamed)
			p.events = append(p.events, string(streamed.kind)+" "+event.ID)
		case browserevent.AgentSessionCreated, browserevent.AgentSessionStarted, browserevent.AgentSessionBlocked,
			browserevent.AgentSessionResumed, browserevent.AgentSessionNativeSessionID, browserevent.AgentSessionCompleted:
			session := payloadForTest[store.AgentSession](p.t, streamed)
			p.events = append(p.events, string(streamed.kind)+" "+session.ID+" "+session.Status)
		default:
			p.events = append(p.events, string(streamed.kind))
		}
	}
}

func (p *publishedEvents) count(prefix string) int {
	p.read()
	count := 0
	for _, event := range p.events {
		if strings.HasPrefix(event, prefix) {
			count++
		}
	}
	return count
}

func startedQueueSession(t *testing.T, backing store.Store) store.AgentSession {
	t.Helper()
	ctx := context.Background()
	registerQueueDevice(t, backing, "claude")
	session, err := backing.CreateAgentSession(ctx, store.CreateAgentSessionInput{
		WorkspaceID: "ws_queue", AgentID: "agent_queue", Provider: "claude", Prompt: "running", Source: "chat",
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := backing.StartAgentSession(ctx, session.ID); err != nil {
		t.Fatal(err)
	}
	return session
}

// An event a device sends again (its acknowledgement was late) is
// acknowledged again and nothing else: it is not streamed again and does not
// make viewers re-read the session's subagents.
func TestDaemonEventSentAgainIsOnlyAcknowledged(t *testing.T) {
	backing := newEmptyTestStore(t)
	session := startedQueueSession(t, backing)
	server := NewServer(backing)
	published := publishedEventsOf(t, server)
	live := httptest.NewServer(server.Routes())
	defer live.Close()
	daemon := connectBacklogDaemon(t, live.URL, []string{session.ID})

	start := map[string]any{"event": map[string]any{
		"id": "evt_subagent_start", "sessionId": session.ID, "label": "Starting subtask", "detail": "Look around", "level": "info",
		"metadata": map[string]any{"taskId": "task_1", "taskType": "local_agent", "toolUseId": "tool_1"},
	}}
	for attempt := range 3 {
		daemon.send(fmt.Sprintf("session_start_%d", attempt), wsSessionEventType, start)
	}
	if got := published.count("agent_session_event evt_subagent_start"); got != 1 {
		t.Fatalf("streamed the start %d times, want once", got)
	}
	if got := published.count(string(browserevent.AgentSubagentUpdated)); got != 1 {
		t.Fatalf("announced the subagent %d times, want once", got)
	}
	server.hub.subagents.mu.Lock()
	revision := server.hub.subagents.entries[session.ID].revision
	server.hub.subagents.mu.Unlock()
	if revision != 1 {
		t.Fatalf("subagent list revision = %d, want 1", revision)
	}

	// The same id with new content is an update: stored and streamed.
	start["event"].(map[string]any)["detail"] = "Look around more"
	daemon.send("session_start_changed", wsSessionEventType, start)
	if got := published.count("agent_session_event evt_subagent_start"); got != 2 {
		t.Fatalf("streamed a changed event %d times in all, want 2", got)
	}
}

// Repeated subagent starts and ends change the list's revision once each.
func TestSubagentLifecycleSentAgainChangesNothing(t *testing.T) {
	cache := newSubagentListCache()
	event := func(label string) store.AgentSessionEvent {
		metadata := &store.AgentSessionEventMetadata{TaskID: "task_1"}
		if label == "Starting subtask" {
			metadata.TaskType = subagentTaskType
		}
		return store.AgentSessionEvent{SessionID: "sess_1", Label: label, Metadata: metadata}
	}
	for _, step := range []struct {
		label string
		want  subagentChange
	}{
		{"Starting subtask", subagentStarted},
		{"Starting subtask", subagentUnchanged},
		{"Subtask completed", subagentEnded},
		{"Subtask completed", subagentUnchanged},
		{"Starting subtask", subagentUnchanged},
	} {
		if got := cache.observe(event(step.label)); got != step.want {
			t.Fatalf("%s: change %d, want %d", step.label, got, step.want)
		}
	}
	if revision := cache.entries["sess_1"].revision; revision != 2 {
		t.Fatalf("revision = %d, want 2", revision)
	}
}

// A device that did not answer a list read in time is not asked again for
// a while, however many viewers ask; other failures are not remembered.
func TestSubagentListRemembersADeviceThatDidNotAnswer(t *testing.T) {
	cache := newSubagentListCache()
	var reads atomic.Int32
	timeout := &deviceNoAnswerError{device: "linux-dev", wait: subagentListTimeout, cause: context.DeadlineExceeded}
	fetch := func(context.Context) (subagentList, error) {
		reads.Add(1)
		return nil, timeout
	}
	for range 5 {
		if _, err := cache.load(context.Background(), "sess_slow", subagentListFull, true, fetch); !errors.Is(err, context.DeadlineExceeded) || !strings.Contains(err.Error(), "linux-dev did not answer within 15 s") {
			t.Fatalf("load error = %v", err)
		}
		// A subagent ending on the slow device does not bring a new read.
		cache.observe(store.AgentSessionEvent{SessionID: "sess_slow", Label: "Subtask completed", Metadata: &store.AgentSessionEventMetadata{TaskID: fmt.Sprintf("task_%d", reads.Load())}})
	}
	if reads.Load() != 1 {
		t.Fatalf("%d device reads, want 1", reads.Load())
	}
	cache.mu.Lock()
	cache.entries["sess_slow"].failedAt = time.Now().Add(-subagentFailureMemory)
	cache.mu.Unlock()
	if _, err := cache.load(context.Background(), "sess_slow", subagentListFull, true, fetch); err == nil || reads.Load() != 2 {
		t.Fatalf("after the wait: err %v, %d reads", err, reads.Load())
	}

	refused := func(context.Context) (subagentList, error) {
		reads.Add(1)
		return nil, errors.New("session is not on this device")
	}
	before := reads.Load()
	for range 2 {
		if _, err := cache.load(context.Background(), "sess_refused", subagentListFull, true, refused); err == nil {
			t.Fatal("refusal not reported")
		}
	}
	if reads.Load() != before+2 {
		t.Fatalf("a refusal was remembered: %d reads", reads.Load()-before)
	}
}

// A device request that ran out of time says which device and how long,
// as a 504, never "context deadline exceeded".
func TestDeviceTimeoutsAreReadable504s(t *testing.T) {
	err := fmt.Errorf("list: %w", &deviceNoAnswerError{device: "linux-dev", wait: 8 * time.Second, cause: context.DeadlineExceeded})
	recorder := httptest.NewRecorder()
	writeResult(recorder, nil, err)
	if recorder.Code != http.StatusGatewayTimeout || !strings.Contains(recorder.Body.String(), "linux-dev did not answer within 8 s") || strings.Contains(recorder.Body.String(), "deadline") {
		t.Fatalf("%d %s", recorder.Code, recorder.Body.String())
	}
	if !errors.Is(err, context.DeadlineExceeded) || deviceErrorStatus(err) != http.StatusGatewayTimeout {
		t.Fatal("a device timeout is still a deadline, answered 504")
	}
	if deviceErrorStatus(errors.New("refused")) != 0 {
		t.Fatal("a refusal is not a device error")
	}
}

// A steer its device never answers is a readable 504; the message is not
// put back to go out again as the next turn: it waits, marked maybe sent.
// When the device's late steer shows in the transcript (evt_<message id>),
// the message is settled sent and the queue moves on without it.
func TestUnansweredSteerLeavesTheMessageMaybeSent(t *testing.T) {
	previous := sessionControlTimeout
	sessionControlTimeout = 300 * time.Millisecond
	t.Cleanup(func() { sessionControlTimeout = previous })
	backing := newEmptyTestStore(t)
	session := startedQueueSession(t, backing)
	server := NewServer(backing)
	live := httptest.NewServer(server.Routes())
	defer live.Close()
	client := queueClient{t: t, server: server, url: live.URL}
	daemon := connectBacklogDaemon(t, live.URL, []string{session.ID})
	path := "/api/chats/" + session.ID + "/queue"
	client.queue(http.MethodPost, path, `{"text":"steer me"}`, "", http.StatusCreated)
	queue := client.queue(http.MethodPost, path, `{"text":"after it"}`, "", http.StatusCreated)
	steerItem, afterItem := queue.Items[0], queue.Items[1]

	status, raw := client.call(http.MethodPost, path+"/"+steerItem.ID+"/steer", "", "")
	if status != http.StatusGatewayTimeout || !strings.Contains(string(raw), "Queue Device did not answer within 300 ms") {
		t.Fatalf("unanswered steer = %d %s", status, raw)
	}
	steered, _ := daemon.snapshot()
	if len(steered) != 1 || steered[0].InputID != steerItem.ID || steered[0].Message != "steer me" {
		t.Fatalf("steer sent = %+v", steered)
	}
	queue = client.queue(http.MethodGet, path, "", "", http.StatusOK)
	if got := queue.Items[0]; got.ID != steerItem.ID || got.State != store.ChatQueueStateFailed || !got.MaybeSent || !strings.Contains(got.Error, "Queue Device did not answer") {
		t.Fatalf("message after the unanswered steer = %+v", got)
	}

	// The device applies it late; its transcript event names the message.
	daemon.send("late_steer", wsSessionEventType, map[string]any{"event": map[string]any{
		"id": "evt_" + steerItem.ID, "sessionId": session.ID, "label": steeredIntoTurnLabel, "detail": "steer me", "level": "info",
	}})
	waitForTest(t, "the late steer to settle the message", func() bool {
		current := client.queue(http.MethodGet, path, "", "", http.StatusOK)
		return len(current.Items) == 1 && current.Items[0].ID == afterItem.ID
	})

	// The turn ends: the next message goes out, the steered one never does.
	daemon.send("turn_end", wsSessionCompleteType, map[string]any{
		"sessionId": session.ID, "inputId": session.Input.ID, "response": "done",
	})
	waitForTest(t, "the next message to go out", func() bool {
		_, runs := daemon.snapshot()
		return len(runs) > 0
	})
	time.Sleep(100 * time.Millisecond)
	_, runs := daemon.snapshot()
	if len(runs) != 1 || runs[0].Input.ID != afterItem.ID {
		t.Fatalf("inputs sent after the turn = %+v", runs)
	}
}

// Retried after an unanswered steer, a message the device did apply goes
// out once: the transcript names it, so the turn-end drain does not send it
// again as an input of its own.
func TestRetriedMaybeSentMessageIsNotSentTwice(t *testing.T) {
	previous := sessionControlTimeout
	sessionControlTimeout = 200 * time.Millisecond
	t.Cleanup(func() { sessionControlTimeout = previous })
	backing := newEmptyTestStore(t)
	session := startedQueueSession(t, backing)
	server := NewServer(backing)
	live := httptest.NewServer(server.Routes())
	defer live.Close()
	client := queueClient{t: t, server: server, url: live.URL}
	daemon := connectBacklogDaemon(t, live.URL, []string{session.ID})
	path := "/api/chats/" + session.ID + "/queue"
	item := client.queue(http.MethodPost, path, `{"text":"steer me"}`, "", http.StatusCreated).Items[0]
	if status, raw := client.call(http.MethodPost, path+"/"+item.ID+"/steer", "", ""); status != http.StatusGatewayTimeout {
		t.Fatalf("unanswered steer = %d %s", status, raw)
	}
	if retried := client.queue(http.MethodPost, path+"/"+item.ID+"/retry", "", "", http.StatusOK); retried.Items[0].State != store.ChatQueueStateQueued || retried.Items[0].MaybeSent {
		t.Fatalf("retried = %+v", retried.Items)
	}
	// The late steer is recorded while the retried message waits for the
	// turn to end, and the turn then ends.
	daemon.send("late_steer", wsSessionEventType, map[string]any{"event": map[string]any{
		"id": "evt_" + item.ID, "sessionId": session.ID, "label": steeredIntoTurnLabel, "detail": "steer me", "level": "info",
	}})
	daemon.send("turn_end", wsSessionCompleteType, map[string]any{
		"sessionId": session.ID, "inputId": session.Input.ID, "response": "done",
	})
	waitForTest(t, "the queue to empty", func() bool {
		return len(client.queue(http.MethodGet, path, "", "", http.StatusOK).Items) == 0
	})
	time.Sleep(100 * time.Millisecond)
	if _, runs := daemon.snapshot(); len(runs) != 0 {
		t.Fatalf("the steered message went out again: %+v", runs)
	}
}

// A queued session a connected device has not started says so in its
// transcript, once per input, with how far behind the device is; it stays
// queued. Without the device connected, nothing is said.
func TestUnstartedSessionSaysWhatItWaitsFor(t *testing.T) {
	previous := unstartedSessionNoticeAfter
	unstartedSessionNoticeAfter = 0
	t.Cleanup(func() { unstartedSessionNoticeAfter = previous })
	backing := newEmptyTestStore(t)
	ctx := context.Background()
	registerQueueDevice(t, backing, "claude")
	session, err := backing.CreateAgentSession(ctx, store.CreateAgentSessionInput{
		WorkspaceID: "ws_queue", AgentID: "agent_queue", Provider: "claude", Prompt: "hello", Source: "chat",
	})
	if err != nil {
		t.Fatal(err)
	}
	server := NewServer(backing)
	published := publishedEventsOf(t, server)
	live := httptest.NewServer(server.Routes())
	defer live.Close()
	notices := func() []store.AgentSessionEvent {
		t.Helper()
		full, err := backing.GetAgentSession(ctx, session.ID)
		if err != nil {
			t.Fatal(err)
		}
		found := []store.AgentSessionEvent{}
		for _, event := range full.Events {
			if event.Label == waitingForDeviceLabel {
				found = append(found, event)
			}
		}
		return found
	}

	if err := server.noticeUnstartedSessions(ctx); err != nil {
		t.Fatal(err)
	}
	if got := notices(); len(got) != 0 {
		t.Fatalf("notice without the device connected: %+v", got)
	}

	daemon := connectBacklogDaemon(t, live.URL, []string{})
	// It reports a backlog: its messages arrive about an hour late.
	daemon.send("heartbeat_1", wsHeartbeatType, map[string]any{"outbox": map[string]any{
		"queued": 40, "oldestQueuedMs": 3_000, "unacknowledged": 900, "ackLatencyMs": 65 * 60 * 1000, "bufferedBytes": 65536,
	}})
	for range 2 {
		if err := server.noticeUnstartedSessions(ctx); err != nil {
			t.Fatal(err)
		}
	}
	got := notices()
	if len(got) != 1 || got[0].Detail != "Waiting for Queue Device to start this message… What it sends reaches Foundry about 1 h 5 min late." || got[0].Level != "warning" {
		t.Fatalf("notices = %+v", got)
	}
	if current, err := backing.GetAgentSessionSummary(ctx, session.ID); err != nil || current.Status != "queued" {
		t.Fatalf("session after the notice: %s %v", current.Status, err)
	}
	if published.count("agent_session_event "+got[0].ID) != 1 || published.count("agent_session_created "+session.ID+" queued") != 1 {
		t.Fatalf("published = %v", published.events)
	}
}

// A heartbeat from an older worker carries no report; one that cannot be
// read is still acknowledged.
func TestHeartbeatsWithoutAnOutboxReport(t *testing.T) {
	backing := newEmptyTestStore(t)
	registerQueueDevice(t, backing, "claude")
	server := NewServer(backing)
	live := httptest.NewServer(server.Routes())
	defer live.Close()
	daemon := connectBacklogDaemon(t, live.URL, []string{})
	daemon.send("heartbeat_old", wsHeartbeatType, map[string]any{})
	daemon.send("heartbeat_odd", wsHeartbeatType, map[string]any{"outbox": "full"})
	if _, lag, _, ok := server.hub.connectedDevice("dev_queue"); !ok || lag != 0 {
		t.Fatalf("lag = %s connected %v", lag, ok)
	}
}

// Answers to the device's own messages are never dropped, however full the
// queue of the server's requests to it; a device that floods its answers
// beyond any reason is disconnected (it then sends again what it misses).
func TestRepliesToTheDeviceAreNeverDropped(t *testing.T) {
	hub := NewDaemonHub(newTestStore(t), newNotifiersForTest(nil).daemon(), "")
	connection := trackedConnection(t, hub)
	for len(connection.send) < cap(connection.send) {
		connection.send <- wsEnvelope{Type: wsRunSessionType}
	}
	if connection.queue(wsEnvelope{Type: wsAckType, ID: "dropped"}) {
		t.Fatal("the request queue took a message beyond its room")
	}
	for index := range maxPendingReplies {
		if !connection.reply(wsEnvelope{Type: wsAckType, ID: fmt.Sprint(index)}) {
			t.Fatalf("reply %d dropped", index)
		}
	}
	connection.replyMu.Lock()
	first, count := connection.replies[0].ID, len(connection.replies)
	connection.replyMu.Unlock()
	if first != "0" || count != maxPendingReplies {
		t.Fatalf("replies held %d, first %q", count, first)
	}
	if connection.reply(wsEnvelope{Type: wsAckType, ID: "beyond"}) {
		t.Fatal("a reply beyond the bound was taken")
	}
	select {
	case <-connection.done:
	case <-time.After(2 * time.Second):
		t.Fatal("the connection stayed open with its answers backed up")
	}
}

// A session message no retry can change (its session is gone, finished or
// another device's) is acknowledged, so the device stops sending it; one
// the server could not read is still refused.
func TestSessionMessagesRefusedForGoodAreAcknowledged(t *testing.T) {
	backing := newEmptyTestStore(t)
	session := startedQueueSession(t, backing)
	if _, err := backing.CompleteAgentSession(context.Background(), session.ID, "done", ""); err != nil {
		t.Fatal(err)
	}
	live := httptest.NewServer(NewServer(backing).Routes())
	defer live.Close()
	daemon := connectBacklogDaemon(t, live.URL, []string{})
	if got := daemon.answer("resume_finished", wsSessionResumedType, map[string]any{"sessionId": session.ID}); got != "ack" {
		t.Fatalf("resuming a finished session: %s", got)
	}
	if got := daemon.answer("event_missing", wsSessionEventType, map[string]any{"event": map[string]any{
		"id": "evt_gone", "sessionId": "sess_gone", "label": "Ran", "detail": "x", "level": "info",
	}}); got != "ack" {
		t.Fatalf("an event of a session that does not exist: %s", got)
	}
	if got := daemon.answer("event_unreadable", wsSessionEventType, map[string]any{"event": "not an event"}); got != "error" {
		t.Fatalf("an unreadable event: %s", got)
	}
}

// A steer whose answer is late but whose transcript event already arrived
// was steered: the message is sent, and the person told so.
func TestSteerRecordedBeforeItsAnswerIsSent(t *testing.T) {
	previous := sessionControlTimeout
	sessionControlTimeout = 600 * time.Millisecond
	t.Cleanup(func() { sessionControlTimeout = previous })
	backing := newEmptyTestStore(t)
	session := startedQueueSession(t, backing)
	server := NewServer(backing)
	live := httptest.NewServer(server.Routes())
	defer live.Close()
	client := queueClient{t: t, server: server, url: live.URL}
	daemon := connectBacklogDaemon(t, live.URL, []string{session.ID})
	path := "/api/chats/" + session.ID + "/queue"
	item := client.queue(http.MethodPost, path, `{"text":"steer me"}`, "", http.StatusCreated).Items[0]
	type reply struct {
		status int
		body   []byte
	}
	replies := make(chan reply, 1)
	go func() {
		status, body := client.call(http.MethodPost, path+"/"+item.ID+"/steer", "", "")
		replies <- reply{status, body}
	}()
	waitForTest(t, "the steer to reach the device", func() bool {
		steered, _ := daemon.snapshot()
		return len(steered) == 1
	})
	daemon.send("steered_event", wsSessionEventType, map[string]any{"event": map[string]any{
		"id": "evt_" + item.ID, "sessionId": session.ID, "label": steeredIntoTurnLabel, "detail": "steer me", "level": "info",
	}})
	got := <-replies
	if got.status != http.StatusOK {
		t.Fatalf("steer = %d %s", got.status, got.body)
	}
	if queue := client.queue(http.MethodGet, path, "", "", http.StatusOK); len(queue.Items) != 0 {
		t.Fatalf("queue after the steer = %+v", queue.Items)
	}
}

// Only a steer handed to the device can have reached it: a request that
// ended before that leaves nothing maybe sent.
func TestOnlyASteerHandedToTheDeviceIsMaybeSent(t *testing.T) {
	hub := NewDaemonHub(newTestStore(t), newNotifiersForTest(nil).daemon(), "")
	connection := trackedConnection(t, hub)
	canceled, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := daemonRequest[wsSessionSteeredPayload](canceled, connection, wsSteerSessionType, json.RawMessage(`{"sessionId":"s"}`))
	if !handedToDevice(err) || isDeviceTimeout(err) || !errors.Is(err, context.Canceled) {
		t.Fatalf("a request handed over, then abandoned: %v", err)
	}
	if !strings.Contains(err.Error(), "ended before") || strings.Contains(err.Error(), "canceled") {
		t.Fatalf("message = %q", err)
	}
	if handedToDevice(context.Canceled) || handedToDevice(errors.New(daemonDisconnectedReason)) {
		t.Fatal("a request that never reached the device counts as handed over")
	}
}

// An event the session already holds is added to the Issue's run all the
// same: the attempt that stored it may have failed before the run had it.
func TestIssueRunGetsAnEventSentAgain(t *testing.T) {
	db := newTestStore(t)
	server := NewServer(db)
	created := postJSONForTest(t, server, "/api/issues", `{"workspaceId":"ws_ws","sourceInput":"Run events","runtime":"mock"}`, http.StatusCreated)
	issueID := created["id"].(string)
	testfixture.ConfirmContract(t, db, issueID)
	live := httptest.NewServer(server.Routes())
	defer live.Close()
	conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(live.URL, "http")+"/api/daemon/ws", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	writeWSForTest(t, conn, "hello", map[string]any{
		"capabilities":   []string{"issue_sessions"},
		"device":         map[string]any{"id": "dev_ws", "label": "WS Device", "status": "connected", "lastSeenLabel": "online"},
		"workspace":      map[string]any{"id": "ws_ws", "name": "WS Workspace", "localPath": "/tmp/ws", "baseline": "main"},
		"providerHealth": []map[string]any{},
		"assets":         []map[string]any{},
	})
	readWSTypeForTest(t, conn, "registered")
	var dispatched struct {
		Session store.AgentSession `json:"session"`
	}
	readWSPayloadForTest(t, conn, "run_session", &dispatched)
	sessionID := dispatched.Session.ID
	writeWSForTest(t, conn, "session_started", map[string]any{"sessionId": sessionID, "inputId": dispatched.Session.Input.ID})
	skipToAckForTest(t, conn)

	event := store.AgentSessionEvent{ID: "evt_retried", SessionID: sessionID, Label: "Ran tests", Detail: "ok", Level: "info"}
	if stored, err := db.RecordAgentSessionEvent(context.Background(), event); err != nil || !stored {
		t.Fatalf("stored=%v err=%v", stored, err)
	}
	for range 2 {
		writeWSForTest(t, conn, "session_event", map[string]any{"event": event})
		skipToAckForTest(t, conn)
	}
	issue, err := db.GetIssue(context.Background(), issueID)
	if err != nil {
		t.Fatal(err)
	}
	count := 0
	for _, runEvent := range issue.Run.Events {
		if runEvent.ID == event.ID {
			count++
		}
	}
	if count != 1 {
		t.Fatalf("the run holds the event %d times: %+v", count, issue.Run.Events)
	}
}

// A session queued while its device was away waits from when the device
// connects again, not from when it was queued.
func TestUnstartedSessionNoticeCountsFromTheConnection(t *testing.T) {
	previous := unstartedSessionNoticeAfter
	unstartedSessionNoticeAfter = 400 * time.Millisecond
	t.Cleanup(func() { unstartedSessionNoticeAfter = previous })
	backing := newEmptyTestStore(t)
	ctx := context.Background()
	registerQueueDevice(t, backing, "claude")
	session, err := backing.CreateAgentSession(ctx, store.CreateAgentSessionInput{
		WorkspaceID: "ws_queue", AgentID: "agent_queue", Provider: "claude", Prompt: "hello", Source: "chat",
	})
	if err != nil {
		t.Fatal(err)
	}
	server := NewServer(backing)
	live := httptest.NewServer(server.Routes())
	defer live.Close()
	notices := func() int {
		t.Helper()
		full, err := backing.GetAgentSession(ctx, session.ID)
		if err != nil {
			t.Fatal(err)
		}
		count := 0
		for _, event := range full.Events {
			if event.Label == waitingForDeviceLabel {
				count++
			}
		}
		return count
	}
	time.Sleep(500 * time.Millisecond)
	connectBacklogDaemon(t, live.URL, []string{})
	if err := server.noticeUnstartedSessions(ctx); err != nil {
		t.Fatal(err)
	}
	if got := notices(); got != 0 {
		t.Fatalf("%d notices right after the device connected", got)
	}
	time.Sleep(500 * time.Millisecond)
	if err := server.noticeUnstartedSessions(ctx); err != nil {
		t.Fatal(err)
	}
	if got := notices(); got != 1 {
		t.Fatalf("%d notices once the device had it a while, want 1", got)
	}
}

// DEV-072: a message held for a device's updated session runner says so at
// once, not later as a device that does not start it.
func TestMessageHeldForAnUpdatedRunnerSaysWhy(t *testing.T) {
	previous := runnerSwitchNoticeAfter
	runnerSwitchNoticeAfter = 0
	t.Cleanup(func() { runnerSwitchNoticeAfter = previous })
	backing := newEmptyTestStore(t)
	ctx := context.Background()
	registerQueueDevice(t, backing, "claude")
	session, err := backing.CreateAgentSession(ctx, store.CreateAgentSessionInput{
		WorkspaceID: "ws_queue", AgentID: "agent_queue", Provider: "claude", Prompt: "hello", Source: "chat",
	})
	if err != nil {
		t.Fatal(err)
	}
	server := NewServer(backing)
	live := httptest.NewServer(server.Routes())
	defer live.Close()
	connectBacklogDaemon(t, live.URL, []string{})
	deviceID := session.DeviceID
	connection := server.hub.connectionFor(deviceID)
	if connection == nil {
		t.Fatal("device not connected")
	}
	labels := func() []store.AgentSessionEvent {
		t.Helper()
		full, err := backing.GetAgentSession(ctx, session.ID)
		if err != nil {
			t.Fatal(err)
		}
		found := []store.AgentSessionEvent{}
		for _, event := range full.Events {
			if event.Label == workerUpdateLabel || event.Label == waitingForDeviceLabel {
				found = append(found, event)
			}
		}
		return found
	}
	// No runner holds it: nothing yet, the device notice waits its 3 min.
	if err := server.noticeUnstartedSessions(ctx); err != nil {
		t.Fatal(err)
	}
	if got := labels(); len(got) != 0 {
		t.Fatalf("notices before the runner holds it: %+v", got)
	}
	server.deviceRunners.set(deviceID, connection, store.DeviceRunner{State: "pending", HeldTurns: 1})
	for range 2 {
		if err := server.noticeUnstartedSessions(ctx); err != nil {
			t.Fatal(err)
		}
	}
	got := labels()
	if len(got) != 1 || got[0].Label != workerUpdateLabel || !strings.Contains(got[0].Detail, "switching to an updated session runner") {
		t.Fatalf("notices = %+v", got)
	}
}
