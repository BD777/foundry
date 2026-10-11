package httpapi

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"github.com/foundry-dev/foundry/apps/server/internal/browserevent"
	"github.com/foundry-dev/foundry/apps/server/internal/eventstream"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// subscribeForTest opens a stream that receives every workspace's events.
func subscribeForTest(stream *eventstream.Hub) *eventstream.Subscription {
	return subscribeReachForTest(stream, streamReach{scope: &accessScope{all: true}})
}

// subscribeReachForTest opens a stream of reach; its frames arrive on C as
// they are published.
func subscribeReachForTest(stream *eventstream.Hub, reach streamReach) *eventstream.Subscription {
	subscription, open := stream.Subscribe(reach, "")
	if !open {
		panic("the event stream shut down")
	}
	return subscription
}

// notifiersForTest are the domains' notifiers over one stream as a server
// wires them, without a server; its devices carry no device in their events.
type notifiersForTest struct {
	stream   *eventstream.Hub
	data     *dataChanges
	sessions *sessionEvents
	issues   *issueEvents
	chatList *chatListEvents
	devices  *deviceEvents
}

func newNotifiersForTest(db store.Store) *notifiersForTest {
	stream := newBrowserStream()
	data := newDataChanges(stream)
	return &notifiersForTest{
		stream:   stream,
		data:     data,
		sessions: newSessionEvents(stream),
		issues:   &issueEvents{stream: stream},
		chatList: newChatListEvents(stream, db, data),
		devices:  newDeviceEvents(stream, db, data, noDevicesForTest{}),
	}
}

// daemon is what a device hub tells over these notifiers.
func (n *notifiersForTest) daemon() daemonNotifiers {
	return daemonNotifiers{sessions: n.sessions, issues: n.issues, devices: n.devices, chats: n.chatList, dataChanges: n.data}
}

// noDevicesForTest projects no device.
type noDevicesForTest struct{}

func (noDevicesForTest) deviceForEvent(context.Context, string) (store.DeviceProjection, bool) {
	return store.DeviceProjection{}, false
}

// sessionEventsForTest is the server's session notifier, to observe.
func sessionEventsForTest(server *Server) *sessionEvents {
	return server.sessions.(*sessionEvents)
}

// chatListNotifierForTest is the server's chat list notifier.
func chatListNotifierForTest(server *Server) *chatListEvents {
	return server.chats.(*chatListEvents)
}

// nextStreamedForTest waits for the next frame on the stream of one of the
// given types.
func nextStreamedForTest(t *testing.T, viewer *eventstream.Subscription, types ...browserevent.Type) streamedForTest {
	t.Helper()
	deadline := time.After(10 * time.Second)
	for {
		select {
		case frame := <-viewer.C:
			streamed := decodeStreamedForTest(t, frame)
			for _, eventType := range types {
				if streamed.kind == eventType {
					return streamed
				}
			}
		case <-deadline:
			t.Fatalf("no %v event", types)
			return streamedForTest{}
		}
	}
}

// decodeStreamedForTest reads one SSE frame's envelope.
func decodeStreamedForTest(t *testing.T, frame []byte) streamedForTest {
	t.Helper()
	data := ""
	for _, line := range strings.Split(string(frame), "\n") {
		if value, ok := strings.CutPrefix(line, "data: "); ok {
			data = value
		}
	}
	var envelope struct {
		Type    browserevent.Type `json:"type"`
		Payload json.RawMessage   `json:"payload"`
	}
	if err := json.Unmarshal([]byte(data), &envelope); err != nil {
		t.Fatalf("frame %q: %v", frame, err)
	}
	return streamedForTest{envelope.Type, envelope.Payload}
}

// payloadForTest decodes a streamed payload.
func payloadForTest[P any](t *testing.T, streamed streamedForTest) P {
	t.Helper()
	var payload P
	if err := json.Unmarshal(streamed.payload, &payload); err != nil {
		t.Fatalf("decode %s payload %s: %v", streamed.kind, streamed.payload, err)
	}
	return payload
}

// browserEventEnvelope is one streamed message as a browser reads it.
type browserEventEnvelope struct {
	Type    browserevent.Type `json:"type"`
	Payload any               `json:"payload"`
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
	events := newNotifiersForTest(nil)
	viewer := subscribeForTest(events.stream)
	observer := &sessionObserverForTest{}
	events.sessions.observe(observer)
	session := sessionWithTranscriptForTest()

	events.sessions.changed(context.Background(), sessionCompleted, session)
	events.sessions.changed(context.Background(), sessionStarted, session)

	for range 2 {
		_, envelope := frameForTest(t, <-viewer.C)
		payload := envelope["payload"].(map[string]any)
		if _, ok := payload["events"]; ok {
			t.Fatalf("published session carries events: %v", payload)
		}
		input := payload["input"].(map[string]any)
		if _, ok := input["importedContext"]; ok || payload["response"] != "the answer" || input["prompt"] != "hello" {
			t.Fatalf("published session = %v, want the answer and input without imported context", payload)
		}
	}
	for _, observed := range observer.sessions {
		if len(observed.Events) != 0 || observed.Input.ImportedContext != "" {
			t.Fatalf("an observer got the transcript: %+v", observed)
		}
	}
	if len(observer.sessions) != 2 {
		t.Fatalf("observers were told %d changes, want 2", len(observer.sessions))
	}
	if len(session.Events) != 1 {
		t.Fatal("publishing changed the caller's session")
	}
}

// Transcript events do not invalidate the foundry-data snapshot; every other
// published change does.
func TestTranscriptEventsKeepTheSnapshotRevision(t *testing.T) {
	events := newNotifiersForTest(nil)
	ctx := context.Background()
	events.sessions.recorded(ctx, "ws_1", store.AgentSessionEvent{ID: "evt_1", Label: "Response stream"})
	if events.stream.Revision() != 0 {
		t.Fatal("a transcript event invalidated the snapshot")
	}
	events.sessions.changed(ctx, sessionCompleted, store.AgentSession{ID: "sess_1", WorkspaceID: "ws_1"})
	if events.stream.Revision() != 1 {
		t.Fatal("a session change kept the snapshot")
	}
}

type streamReaderForTest struct {
	response *http.Response
	frames   chan string
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

// The stream's own messages are the browser events stream_ready and
// resync: a fresh stream starts with stream_ready, and one that resumes
// from an id it cannot continue is told to resync, with the reason.
func TestStreamControlMessagesAreBrowserEvents(t *testing.T) {
	events := newNotifiersForTest(nil)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		events.stream.Serve(w, r, streamReach{scope: &accessScope{all: true}})
	}))
	defer server.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	events.data.changed("")
	if _, envelope := openStreamForTest(t, ctx, server.URL, "").next(t); envelope["type"] != string(browserevent.StreamReady) {
		t.Fatalf("a fresh stream began with %v", envelope)
	}
	_, envelope := openStreamForTest(t, ctx, server.URL, "garbage").next(t)
	if envelope["type"] != string(browserevent.Resync) || envelope["payload"].(map[string]any)["reason"] != string(browserevent.ResyncRestarted) {
		t.Fatalf("a stream resuming from nowhere it knows began with %v", envelope)
	}
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

func TestSubagentListCacheSharesOneDeviceRead(t *testing.T) {
	cache := newSubagentListCache()
	var calls atomic.Int32
	release := make(chan struct{})
	fetch := func(context.Context) (subagentList, error) {
		calls.Add(1)
		<-release
		return subagentSummaries{{TaskID: "task_1", Status: "running"}}, nil
	}
	var wait sync.WaitGroup
	bodies := make([][]byte, 8)
	for index := range bodies {
		wait.Add(1)
		go func() {
			defer wait.Done()
			body, err := cache.load(context.Background(), "sess_1", subagentListFull, false, fetch)
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
	if _, err := cache.load(context.Background(), "sess_1", subagentListFull, false, fetch); err != nil || calls.Load() != 1 {
		t.Fatalf("cached read went to the device (%d calls, %v)", calls.Load(), err)
	}
	cache.invalidate("sess_1")
	if _, err := cache.load(context.Background(), "sess_1", subagentListFull, false, fetch); err != nil || calls.Load() != 2 {
		t.Fatalf("invalidated read did not reach the device (%d calls, %v)", calls.Load(), err)
	}
}

func TestSubagentListCacheKeepsNoErrorsAndOutlivesAGoneReader(t *testing.T) {
	cache := newSubagentListCache()
	failing := func(context.Context) (subagentList, error) { return nil, errors.New("device busy") }
	if _, err := cache.load(context.Background(), "sess_1", subagentListFull, false, failing); err == nil {
		t.Fatal("want the device error")
	}
	release := make(chan struct{})
	var calls atomic.Int32
	slow := func(context.Context) (subagentList, error) {
		calls.Add(1)
		<-release
		return subagentSummaries{}, nil
	}
	gone, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := cache.load(gone, "sess_1", subagentListFull, false, slow); !errors.Is(err, context.Canceled) {
		t.Fatalf("gone reader err = %v", err)
	}
	close(release)
	body, err := cache.load(context.Background(), "sess_1", subagentListFull, false, slow)
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

// Over HTTP: create, follow-up and cancel replies and every streamed session
// leave the transcript out; ?events=none reads a session without it.
func TestSessionRepliesCarryNoTranscript(t *testing.T) {
	db := newTestStore(t)
	server := NewServer(db)
	viewer := subscribeForTest(server.stream)
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
	// A chat's read asks the device for digests, which it sends as they are.
	digested := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		digested <- requestForTest(t, server, http.MethodGet, "/api/agent-sessions/"+sessionID+"/subagents?view=digest", "", http.StatusOK)
	}()
	var digestRequest struct {
		View string `json:"view"`
	}
	digestID := readWSUntilForTest(t, conn, "list_subagents", &digestRequest)
	if digestRequest.View != "digest" {
		t.Fatalf("digest read asked view %q", digestRequest.View)
	}
	digest := map[string]any{"sessionId": sessionID, "taskId": "task_1", "toolUseId": "tool_1", "title": "Look", "status": "running", "responseFingerprints": []string{"85944171f73967e8"}}
	writeWSIDForTest(t, conn, digestID, "subagents_listed", map[string]any{"sessionId": sessionID, "view": "digest", "subagents": []map[string]any{digest}})
	var digests []map[string]any
	if body := (<-digested).Body.Bytes(); json.Unmarshal(body, &digests) != nil || len(digests) != 1 ||
		!reflect.DeepEqual(digests[0]["responseFingerprints"], []any{"85944171f73967e8"}) || digests[0]["prompt"] != nil || digests[0]["responseTexts"] != nil {
		t.Fatalf("digest list = %s", body)
	}

	for len(viewer.C) > 0 {
		_, envelope := frameForTest(t, <-viewer.C)
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
