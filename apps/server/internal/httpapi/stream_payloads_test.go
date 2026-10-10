package httpapi

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/base64"
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

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func subscribeForTest(hub *browserEventHub, buffer int) *eventSubscription {
	subscription := &eventSubscription{ch: make(chan []byte, buffer), scope: &accessScope{all: true}, ended: make(chan struct{})}
	hub.mu.Lock()
	hub.subscribers[subscription] = struct{}{}
	hub.mu.Unlock()
	return subscription
}

// frameForTest splits one SSE frame into its id and decoded envelope.
func frameForTest(t *testing.T, frame []byte) (string, map[string]any) {
	t.Helper()
	id, data := "", ""
	for _, line := range strings.Split(strings.TrimSpace(string(frame)), "\n") {
		if value, ok := strings.CutPrefix(line, "id: "); ok {
			id = value
		}
		if value, ok := strings.CutPrefix(line, "data: "); ok {
			data = value
		}
	}
	var envelope map[string]any
	if err := json.Unmarshal([]byte(data), &envelope); err != nil {
		t.Fatalf("decode frame %q: %v", frame, err)
	}
	return id, envelope
}

func sessionWithTranscriptForTest() store.AgentSession {
	return store.AgentSession{
		ID: "sess_big", WorkspaceID: "ws_1", Status: "completed", Response: "the answer",
		Input:  store.SessionInput{ID: "in_1", Prompt: "hello", ImportedContext: strings.Repeat("earlier turn ", 100)},
		Events: []store.AgentSessionEvent{{ID: "evt_1", SessionID: "sess_big", Label: "Thinking"}},
	}
}

// A session published on the stream never carries its transcript: a long
// chat's events ran to megabytes per lifecycle change.
func TestPublishedSessionsCarryNoEvents(t *testing.T) {
	hub := newBrowserEventHub()
	viewer := subscribeForTest(hub, 4)
	var internal []any
	hub.SubscribeInternal(func(_ string, payload any) { internal = append(internal, payload) })
	session := sessionWithTranscriptForTest()

	hub.Publish("agent_session_completed", session)
	hub.Publish("agent_session_started", &session)

	for range 2 {
		_, envelope := frameForTest(t, <-viewer.ch)
		payload := envelope["payload"].(map[string]any)
		if _, ok := payload["events"]; ok {
			t.Fatalf("published session carries events: %v", payload)
		}
		input := payload["input"].(map[string]any)
		if _, ok := input["importedContext"]; ok || payload["response"] != "the answer" || input["prompt"] != "hello" {
			t.Fatalf("published session = %v, want the answer and input without imported context", payload)
		}
	}
	for _, payload := range internal {
		var events []store.AgentSessionEvent
		switch value := payload.(type) {
		case store.AgentSession:
			events = value.Events
		case *store.AgentSession:
			events = value.Events
		}
		if len(events) != 0 {
			t.Fatalf("internal subscriber got the transcript: %+v", payload)
		}
	}
	if len(session.Events) != 1 {
		t.Fatal("publishing changed the caller's session")
	}
}

func TestStreamFramesCarryRisingIDs(t *testing.T) {
	hub := newBrowserEventHub()
	viewer := subscribeForTest(hub, 4)
	hub.Publish("issue_updated", store.Issue{ID: "iss_1", WorkspaceID: "ws_1"})
	hub.PublishIn("ws_1", "agent_session_event", store.AgentSessionEvent{ID: "evt_1"})
	first, _ := frameForTest(t, <-viewer.ch)
	second, _ := frameForTest(t, <-viewer.ch)
	if first != hub.epoch+"-1" || second != hub.epoch+"-2" {
		t.Fatalf("ids = %q, %q; want %s-1, %s-2", first, second, hub.epoch, hub.epoch)
	}
}

// Transcript events do not invalidate the foundry-data snapshot; every other
// published change does.
func TestTranscriptEventsKeepTheSnapshotRevision(t *testing.T) {
	hub := newBrowserEventHub()
	hub.PublishIn("ws_1", "agent_session_event", store.AgentSessionEvent{ID: "evt_1", Label: "Response stream"})
	if hub.revision.Load() != 0 {
		t.Fatal("a transcript event invalidated the snapshot")
	}
	hub.Publish("agent_session_completed", store.AgentSession{ID: "sess_1", WorkspaceID: "ws_1"})
	if hub.revision.Load() != 1 {
		t.Fatal("a session change kept the snapshot")
	}
}

type streamReaderForTest struct {
	response *http.Response
	frames   chan string
}

func openStreamForTest(t *testing.T, ctx context.Context, url string, lastEventID string) *streamReaderForTest {
	t.Helper()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		t.Fatal(err)
	}
	if lastEventID != "" {
		request.Header.Set("Last-Event-ID", lastEventID)
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatalf("open stream: %v", err)
	}
	t.Cleanup(func() { response.Body.Close() })
	reader := &streamReaderForTest{response: response, frames: make(chan string, 512)}
	go func() {
		scanner := bufio.NewScanner(response.Body)
		scanner.Buffer(make([]byte, 0, 1<<16), 1<<22)
		var frame strings.Builder
		for scanner.Scan() {
			line := scanner.Text()
			if line == "" {
				if frame.Len() > 0 {
					reader.frames <- frame.String()
					frame.Reset()
				}
				continue
			}
			if strings.HasPrefix(line, ":") || strings.HasPrefix(line, "retry:") {
				continue
			}
			frame.WriteString(line + "\n")
		}
		close(reader.frames)
	}()
	return reader
}

func (r *streamReaderForTest) next(t *testing.T) (string, map[string]any) {
	t.Helper()
	select {
	case frame, ok := <-r.frames:
		if !ok {
			t.Fatal("stream ended")
		}
		return frameForTest(t, []byte(frame))
	case <-time.After(3 * time.Second):
		t.Fatal("timed out waiting for a stream frame")
	}
	return "", nil
}

func streamServerForTest(hub *browserEventHub) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hub.ServeHTTP(w, r.WithContext(contextWithScope(r.Context(), accessScope{all: true})))
	}))
}

// A browser reconnecting with Last-Event-ID gets exactly what it missed.
func TestStreamResumesFromLastEventID(t *testing.T) {
	hub := newBrowserEventHub()
	server := streamServerForTest(hub)
	defer server.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	for index := 1; index <= 5; index++ {
		hub.PublishIn("ws_1", "agent_session_event", store.AgentSessionEvent{ID: fmt.Sprintf("evt_%d", index)})
	}
	stream := openStreamForTest(t, ctx, server.URL, hub.epoch+"-2")
	for _, want := range []string{"evt_3", "evt_4", "evt_5"} {
		id, envelope := stream.next(t)
		payload := envelope["payload"].(map[string]any)
		if payload["id"] != want || !strings.HasPrefix(id, hub.epoch+"-") {
			t.Fatalf("replayed %s %v, want %s", id, payload, want)
		}
	}
	// Live events follow the replay.
	hub.PublishIn("ws_1", "agent_session_event", store.AgentSessionEvent{ID: "evt_6"})
	if id, envelope := stream.next(t); envelope["payload"].(map[string]any)["id"] != "evt_6" || id != hub.epoch+"-6" {
		t.Fatalf("live event = %s %v, want evt_6", id, envelope)
	}
}

// When the missed events are gone (another server process, or older than
// the ring), the stream says so instead of resuming with a gap.
func TestStreamAsksForResyncWhenItCannotResume(t *testing.T) {
	hub := newBrowserEventHub()
	server := streamServerForTest(hub)
	defer server.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	for index := 0; index < eventRingEntries+10; index++ {
		hub.PublishIn("ws_1", "agent_session_event", store.AgentSessionEvent{ID: fmt.Sprintf("evt_%d", index)})
	}
	for _, test := range []struct{ lastEventID, reason string }{
		{"otherprocess-3", resyncReasonRestarted},
		{hub.epoch + "-3", resyncReasonExpired},
		{"garbage", resyncReasonRestarted},
	} {
		stream := openStreamForTest(t, ctx, server.URL, test.lastEventID)
		id, envelope := stream.next(t)
		payload, _ := envelope["payload"].(map[string]any)
		if envelope["type"] != resyncEventType || payload["reason"] != test.reason {
			t.Fatalf("resume from %s = %v, want resync %s", test.lastEventID, envelope, test.reason)
		}
		if id != fmt.Sprintf("%s-%d", hub.epoch, eventRingEntries+10) {
			t.Fatalf("resync id = %s, want the newest event", id)
		}
	}
	// Up to date: nothing to replay and no resync.
	stream := openStreamForTest(t, ctx, server.URL, fmt.Sprintf("%s-%d", hub.epoch, eventRingEntries+10))
	hub.PublishIn("ws_1", "agent_session_event", store.AgentSessionEvent{ID: "evt_live"})
	if _, envelope := stream.next(t); envelope["type"] != "agent_session_event" {
		t.Fatalf("up-to-date resume = %v, want the live event", envelope)
	}
}

// A change of an account's access ends its streams; one resuming from an
// event before the change is told to resync (the replay would not show what
// the new access adds or takes away), and after that resumes normally.
// Other accounts resume as before.
func TestStreamResumingAcrossAnAccessChangeResyncs(t *testing.T) {
	hub := newBrowserEventHub()
	bobScope := func() *accessScope {
		return &accessScope{userID: "usr_bob", roles: map[string]string{"ws_a": store.WorkspaceRoleViewer}}
	}
	subscription := func(scope *accessScope) *eventSubscription {
		return &eventSubscription{ch: make(chan []byte, 8), scope: scope, ended: make(chan struct{})}
	}
	bob := subscription(bobScope())
	if _, open := hub.resume(bob, ""); !open {
		t.Fatal("hub closed")
	}
	carol := subscription(&accessScope{userID: "usr_carol", roles: map[string]string{"ws_a": store.WorkspaceRoleViewer}})
	if _, open := hub.resume(carol, ""); !open {
		t.Fatal("hub closed")
	}
	hub.Publish(chatTitlesChangedEvent, chatListChange{WorkspaceID: "ws_a"})
	seen, _ := frameForTest(t, <-bob.ch)
	<-carol.ch

	hub.Reauthorize("usr_bob")
	select {
	case <-bob.ended:
	default:
		t.Fatal("bob's stream did not end")
	}
	hub.Publish(chatTitlesChangedEvent, chatListChange{WorkspaceID: "ws_a"})
	if len(bob.ch) != 0 {
		t.Fatal("an ended stream was delivered an event published after the access change")
	}
	if len(carol.ch) != 1 {
		t.Fatalf("carol holds %d events, want the live one", len(carol.ch))
	}

	resumed := subscription(bobScope())
	backlog, _ := hub.resume(resumed, seen)
	if len(backlog) != 1 {
		t.Fatalf("bob resumed with %d frames, want one resync", len(backlog))
	}
	id, envelope := frameForTest(t, backlog[0])
	if envelope["type"] != resyncEventType || envelope["payload"].(map[string]any)["reason"] != resyncReasonReauthorized {
		t.Fatalf("bob resumed with %v, want resync %s", envelope, resyncReasonReauthorized)
	}
	if id != fmt.Sprintf("%s-%d", hub.epoch, hub.seq) {
		t.Fatalf("resync id = %s, want the newest event", id)
	}
	if again, _ := hub.resume(subscription(bobScope()), id); len(again) != 0 {
		t.Fatalf("resuming after the resync = %d frames, want none", len(again))
	}
	if replay, _ := hub.resume(subscription(&accessScope{userID: "usr_carol", roles: map[string]string{"ws_a": store.WorkspaceRoleViewer}}), seen); len(replay) != 1 {
		t.Fatalf("carol resumed with %d frames, want the one event she missed", len(replay))
	} else if _, envelope := frameForTest(t, replay[0]); envelope["type"] != chatTitlesChangedEvent {
		t.Fatalf("carol resumed with %v", envelope)
	}
}

// A subscriber whose buffer overflows is told to resync once it has written
// what it holds, and receives events again afterwards.
func TestOverflowingSubscriberGetsResync(t *testing.T) {
	hub := newBrowserEventHub()
	viewer := subscribeForTest(hub, 2)
	for index := 0; index < 5; index++ {
		hub.PublishIn("ws_1", "agent_session_event", store.AgentSessionEvent{ID: fmt.Sprintf("evt_%d", index)})
	}
	if !viewer.lost.Load() || len(viewer.ch) != 2 {
		t.Fatalf("lost=%v buffered=%d, want a lost subscriber holding 2", viewer.lost.Load(), len(viewer.ch))
	}
	<-viewer.ch
	<-viewer.ch
	id, envelope := frameForTest(t, hub.recover(viewer))
	if envelope["type"] != resyncEventType || envelope["payload"].(map[string]any)["reason"] != resyncReasonOverflow || id != hub.epoch+"-5" {
		t.Fatalf("resync = %s %v", id, envelope)
	}
	hub.PublishIn("ws_1", "agent_session_event", store.AgentSessionEvent{ID: "evt_after"})
	if _, envelope := frameForTest(t, <-viewer.ch); envelope["payload"].(map[string]any)["id"] != "evt_after" {
		t.Fatalf("after resync = %v", envelope)
	}
}

// End to end over HTTP: a stream that cannot keep up sees resync on the wire.
func TestSlowStreamSeesResync(t *testing.T) {
	hub := newBrowserEventHub()
	server := streamServerForTest(hub)
	defer server.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	stream := openStreamForTest(t, ctx, server.URL, "")
	// Publish far more than the subscriber buffer at once; large payloads
	// fill the socket so the writer falls behind. They are random: the
	// stream is compressed, and a repeated letter would not fill it.
	random := make([]byte, 48<<10)
	if _, err := rand.Read(random); err != nil {
		t.Fatal(err)
	}
	detail := base64.StdEncoding.EncodeToString(random)
	for index := 0; index < eventSubscriberBuffer*4; index++ {
		hub.PublishIn("ws_1", "agent_session_event", store.AgentSessionEvent{ID: fmt.Sprintf("evt_%d", index), Detail: detail})
	}
	deadline := time.After(10 * time.Second)
	for {
		select {
		case frame, ok := <-stream.frames:
			if !ok {
				t.Fatal("stream ended before a resync")
			}
			if _, envelope := frameForTest(t, []byte(frame)); envelope["type"] == resyncEventType {
				return
			}
		case <-deadline:
			t.Fatal("no resync after overflowing the subscriber")
		}
	}
}

func TestRingStaysWithinItsBounds(t *testing.T) {
	hub := newBrowserEventHub()
	detail := strings.Repeat("y", 1<<20)
	for index := 0; index < 20; index++ {
		hub.PublishIn("ws_1", "agent_session_event", store.AgentSessionEvent{ID: fmt.Sprintf("evt_%d", index), Detail: detail})
	}
	if hub.ringBytes > eventRingBytes || len(hub.ring) == 0 || hub.ring[len(hub.ring)-1].seq != 20 {
		t.Fatalf("ring holds %d bytes in %d events", hub.ringBytes, len(hub.ring))
	}
}

func TestSubagentListCacheSharesOneDeviceRead(t *testing.T) {
	cache := newSubagentListCache()
	var calls atomic.Int32
	release := make(chan struct{})
	fetch := func(context.Context) ([]store.AgentSubagentSummary, error) {
		calls.Add(1)
		<-release
		return []store.AgentSubagentSummary{{TaskID: "task_1", Status: "running"}}, nil
	}
	var wait sync.WaitGroup
	bodies := make([][]byte, 8)
	for index := range bodies {
		wait.Add(1)
		go func() {
			defer wait.Done()
			body, err := cache.load(context.Background(), "sess_1", false, fetch)
			if err != nil {
				t.Error(err)
			}
			bodies[index] = body
		}()
	}
	time.Sleep(50 * time.Millisecond)
	close(release)
	wait.Wait()
	if calls.Load() != 1 {
		t.Fatalf("device read %d times for concurrent readers, want once", calls.Load())
	}
	for _, body := range bodies {
		if !strings.Contains(string(body), "task_1") {
			t.Fatalf("reader got %s", body)
		}
	}
	// Cached until a subagent event arrives.
	if _, err := cache.load(context.Background(), "sess_1", false, fetch); err != nil || calls.Load() != 1 {
		t.Fatalf("cached read went to the device (%d calls, %v)", calls.Load(), err)
	}
	cache.invalidate("sess_1")
	if _, err := cache.load(context.Background(), "sess_1", false, fetch); err != nil || calls.Load() != 2 {
		t.Fatalf("invalidated read did not reach the device (%d calls, %v)", calls.Load(), err)
	}
}

func TestSubagentListCacheKeepsNoErrorsAndOutlivesAGoneReader(t *testing.T) {
	cache := newSubagentListCache()
	failing := func(context.Context) ([]store.AgentSubagentSummary, error) { return nil, errors.New("device busy") }
	if _, err := cache.load(context.Background(), "sess_1", false, failing); err == nil {
		t.Fatal("want the device error")
	}
	release := make(chan struct{})
	var calls atomic.Int32
	slow := func(context.Context) ([]store.AgentSubagentSummary, error) {
		calls.Add(1)
		<-release
		return []store.AgentSubagentSummary{}, nil
	}
	gone, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := cache.load(gone, "sess_1", false, slow); !errors.Is(err, context.Canceled) {
		t.Fatalf("gone reader err = %v", err)
	}
	close(release)
	body, err := cache.load(context.Background(), "sess_1", false, slow)
	if err != nil || string(body) != "[]" || calls.Load() != 1 {
		t.Fatalf("after a gone reader: %s %v (%d reads), want the shared read's result", body, err, calls.Load())
	}
}

func TestSubagentEventsAreLifecycleEventsWithATask(t *testing.T) {
	task := &store.AgentSessionEventMetadata{TaskID: "task_1"}
	for _, test := range []struct {
		event store.AgentSessionEvent
		want  bool
	}{
		{store.AgentSessionEvent{Label: "Subtask running", Metadata: task}, true},
		{store.AgentSessionEvent{Label: "Starting subtask", Metadata: task}, true},
		{store.AgentSessionEvent{Label: "子任务完成", Metadata: task}, true},
		{store.AgentSessionEvent{Label: "Response stream", Metadata: task}, false},
		{store.AgentSessionEvent{Label: "Subtask running"}, false},
	} {
		if subagentEvent(test.event) != test.want {
			t.Errorf("subagentEvent(%+v) != %v", test.event, test.want)
		}
	}
}

// Completions are never lost to a slow stream: a subscriber that overflowed
// is told to resync, and a reconnect with Last-Event-ID replays them.
func TestCompletionSurvivesAnOverflowingStream(t *testing.T) {
	hub := newBrowserEventHub()
	viewer := subscribeForTest(hub, 1)
	hub.PublishIn("ws_1", "agent_session_event", store.AgentSessionEvent{ID: "evt_seen"})
	seenID, _ := frameForTest(t, <-viewer.ch)
	hub.PublishIn("ws_1", "agent_session_event", store.AgentSessionEvent{ID: "evt_buffered"})
	hub.Publish("agent_session_completed", store.AgentSession{ID: "sess_1", WorkspaceID: "ws_1", Status: "completed", Response: "done"})
	if !viewer.lost.Load() {
		t.Fatal("the completion fit a full buffer")
	}
	<-viewer.ch
	if _, envelope := frameForTest(t, hub.recover(viewer)); envelope["type"] != resyncEventType {
		t.Fatalf("overflowed stream got %v, want resync", envelope)
	}

	server := streamServerForTest(hub)
	defer server.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	stream := openStreamForTest(t, ctx, server.URL, seenID)
	stream.next(t)
	if _, envelope := stream.next(t); envelope["type"] != "agent_session_completed" {
		t.Fatalf("resume replayed %v, want the completion", envelope)
	}
}

// Over HTTP: create, follow-up and cancel replies and every streamed session
// leave the transcript out; ?events=none reads a session without it.
func TestSessionRepliesCarryNoTranscript(t *testing.T) {
	db := newTestStore(t)
	server := NewServer(db)
	viewer := subscribeForTest(server.events, 256)
	testServer := httptest.NewServer(server.Routes())
	defer testServer.Close()
	conn := dialDaemonForTest(t, testServer)
	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	writeWSForTest(t, conn, "hello", map[string]any{
		"device":    map[string]any{"id": "dev_slim", "label": "Slim", "status": "connected", "lastSeenLabel": "online"},
		"workspace": map[string]any{"id": "ws_slim", "name": "Slim", "localPath": t.TempDir()},
		"agents": []map[string]any{{
			"id": "agent_slim", "workspaceId": "ws_slim", "deviceId": "dev_slim", "provider": "codex", "status": "healthy",
			"authMode": "local_config", "secretStored": "local", "configScope": "workspace", "configLabel": "local", "lastSeenLabel": "online",
		}},
	})
	readWSTypeForTest(t, conn, "registered")

	assertNoTranscript := func(where string, session map[string]any) {
		t.Helper()
		if _, ok := session["events"]; ok {
			t.Fatalf("%s carries the transcript: %v", where, session["events"])
		}
	}
	created := postJSONForTest(t, server, "/api/agent-sessions", `{"workspaceId":"ws_slim","agentId":"agent_slim","provider":"codex","prompt":"first"}`, http.StatusCreated)
	assertNoTranscript("create reply", created)
	sessionID := created["id"].(string)
	var run struct {
		Session store.AgentSession `json:"session"`
	}
	readWSUntilForTest(t, conn, "run_session", &run)
	writeWSForTest(t, conn, "session_started", map[string]any{"sessionId": sessionID, "inputId": run.Session.Input.ID})
	skipToAckForTest(t, conn)
	for index := 0; index < 3; index++ {
		writeWSForTest(t, conn, "session_event", map[string]any{"event": map[string]any{
			"id": fmt.Sprintf("evt_slim_%d", index), "sessionId": sessionID, "label": "Thinking", "detail": "…", "level": "info",
		}})
		skipToAckForTest(t, conn)
	}
	writeWSForTest(t, conn, "session_completed", map[string]any{"sessionId": sessionID, "inputId": run.Session.Input.ID, "response": "first answer"})
	skipToAckForTest(t, conn)

	slim := getJSONObjectForTest(t, server, "/api/agent-sessions/"+sessionID+"?events=none", http.StatusOK)
	assertNoTranscript("?events=none read", slim)
	if slim["response"] != "first answer" || slim["status"] != "completed" {
		t.Fatalf("slim read = %v, want the completed answer", slim)
	}
	full := getJSONObjectForTest(t, server, "/api/agent-sessions/"+sessionID, http.StatusOK)
	if events, _ := full["events"].([]any); len(events) < 4 {
		t.Fatalf("full read has %d events, want the transcript", len(events))
	}

	followUp := postJSONForTest(t, server, "/api/agent-sessions/"+sessionID+"/messages", `{"prompt":"second"}`, http.StatusOK)
	assertNoTranscript("follow-up reply", followUp)
	if followUp["response"] != nil && followUp["response"] != "" {
		t.Fatalf("follow-up reply carries the previous answer %q", followUp["response"])
	}

	// Subagents: one device read, then the cache answers; a matching ETag
	// answers 304.
	listed := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		listed <- requestForTest(t, server, http.MethodGet, "/api/agent-sessions/"+sessionID+"/subagents", "", http.StatusOK)
	}()
	var listRequest struct {
		SessionID string `json:"sessionId"`
	}
	listID := readWSUntilForTest(t, conn, "list_subagents", &listRequest)
	writeWSIDForTest(t, conn, listID, "subagents_listed", map[string]any{"sessionId": sessionID, "subagents": []map[string]any{{
		"sessionId": sessionID, "taskId": "task_1", "toolUseId": "tool_1", "title": "Look", "status": "running", "responseTexts": []string{},
	}}})
	first := <-listed
	etag := first.Header().Get("ETag")
	if etag == "" || !strings.Contains(first.Body.String(), "task_1") {
		t.Fatalf("subagents = %q etag %q", first.Body.String(), etag)
	}
	request := httptest.NewRequest(http.MethodGet, "/api/agent-sessions/"+sessionID+"/subagents", nil)
	request.Header.Set("If-None-Match", etag)
	cached := httptest.NewRecorder()
	server.Routes().ServeHTTP(cached, request)
	if cached.Code != http.StatusNotModified {
		t.Fatalf("revalidation = %d %s, want 304 from the cache", cached.Code, cached.Body.String())
	}

	for len(viewer.ch) > 0 {
		_, envelope := frameForTest(t, <-viewer.ch)
		if payload, ok := envelope["payload"].(map[string]any); ok && strings.HasPrefix(envelope["type"].(string), "agent_session_") && envelope["type"] != "agent_session_event" {
			assertNoTranscript("streamed "+envelope["type"].(string), payload)
		}
	}
}

// skipToAckForTest reads past envelopes the test does not answer (dispatches,
// pings) to the next ack.
func skipToAckForTest(t *testing.T, conn *websocket.Conn) {
	t.Helper()
	for {
		var envelope struct {
			Type string `json:"type"`
		}
		if err := conn.ReadJSON(&envelope); err != nil {
			t.Fatalf("read websocket ack: %v", err)
		}
		if envelope.Type == "ack" {
			return
		}
	}
}
