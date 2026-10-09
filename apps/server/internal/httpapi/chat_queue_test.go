package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// queueDaemon plays a connected device: it records every input the server
// dispatches and ends turns on request.
type queueDaemon struct {
	t       *testing.T
	conn    *websocket.Conn
	mu      sync.Mutex
	runs    []store.AgentSession
	steered []wsSteerSessionPayload
	writeMu sync.Mutex
}

func (d *queueDaemon) write(id, messageType string, payload any) {
	d.writeMu.Lock()
	defer d.writeMu.Unlock()
	writeWSIDForTest(d.t, d.conn, id, messageType, payload)
}

func connectQueueDaemon(t *testing.T, serverURL, deviceID, workspaceID, provider string, active []string) *queueDaemon {
	t.Helper()
	conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(serverURL, "http")+"/api/daemon/ws", nil)
	if err != nil {
		t.Fatalf("dial daemon websocket: %v", err)
	}
	t.Cleanup(func() { conn.Close() })
	writeWSForTest(t, conn, "hello", map[string]any{
		"activeSessionIds": active,
		"device":           map[string]any{"id": deviceID, "label": "Queue Device", "status": "connected", "lastSeenLabel": "online"},
		"workspace":        map[string]any{"id": workspaceID, "name": "Queue", "localPath": t.TempDir(), "baseline": "main"},
		"providerHealth":   []map[string]any{},
		"assets":           []map[string]any{},
		"agents": []map[string]any{{
			"id": "agent_queue", "workspaceId": workspaceID, "deviceId": deviceID, "deviceLabel": "Queue Device",
			"provider": provider, "status": "healthy", "authMode": "local_config", "secretStored": "local",
			"configScope": "workspace", "configLabel": "device local login", "lastSeenLabel": "online",
		}},
	})
	daemon := &queueDaemon{t: t, conn: conn}
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
			switch envelope.Type {
			case wsRegisteredType:
				close(registered)
			case wsSteerSessionType:
				var payload wsSteerSessionPayload
				if err := json.Unmarshal(envelope.Payload, &payload); err == nil {
					daemon.mu.Lock()
					daemon.steered = append(daemon.steered, payload)
					daemon.mu.Unlock()
					daemon.write(envelope.ID, wsSessionSteeredType, map[string]any{"sessionId": payload.SessionID})
				}
			case wsRunSessionType:
				var payload wsRunSessionPayload
				// Automatic chat naming runs sessions of its own.
				if err := json.Unmarshal(envelope.Payload, &payload); err == nil && payload.Session.Source != "naming" {
					daemon.mu.Lock()
					daemon.runs = append(daemon.runs, payload.Session)
					daemon.mu.Unlock()
				}
			}
		}
	}()
	select {
	case <-registered:
	case <-time.After(5 * time.Second):
		t.Fatal("daemon never registered")
	}
	return daemon
}

func (d *queueDaemon) dispatched() []store.AgentSession {
	d.mu.Lock()
	defer d.mu.Unlock()
	return append([]store.AgentSession(nil), d.runs...)
}

// waitForRuns waits until the device was handed count inputs in all.
func (d *queueDaemon) waitForRuns(count int) []store.AgentSession {
	d.t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if runs := d.dispatched(); len(runs) >= count {
			return runs
		}
		time.Sleep(10 * time.Millisecond)
	}
	d.t.Fatalf("device got %d inputs, want %d", len(d.dispatched()), count)
	return nil
}

func (d *queueDaemon) complete(session store.AgentSession, response string) {
	d.t.Helper()
	d.write("test_"+wsSessionCompleteType, wsSessionCompleteType, map[string]any{
		"sessionId": session.ID, "inputId": session.Input.ID, "response": response, "nativeSessionId": "native_" + session.ID,
	})
}

type queueClient struct {
	t      *testing.T
	server *Server
	url    string
}

func (c queueClient) call(method, path, body, idempotencyKey string) (int, []byte) {
	c.t.Helper()
	request, err := http.NewRequest(method, c.url+path, bytes.NewBufferString(body))
	if err != nil {
		c.t.Fatal(err)
	}
	request.Header.Set("Content-Type", "application/json")
	if idempotencyKey != "" {
		request.Header.Set("Idempotency-Key", idempotencyKey)
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		c.t.Fatal(err)
	}
	defer response.Body.Close()
	raw, _ := io.ReadAll(response.Body)
	return response.StatusCode, raw
}

func (c queueClient) queue(method, path, body, key string, want int) store.ChatQueue {
	c.t.Helper()
	status, raw := c.call(method, path, body, key)
	if status != want {
		c.t.Fatalf("%s %s = %d %s, want %d", method, path, status, raw, want)
	}
	var queue store.ChatQueue
	if status == http.StatusConflict {
		var conflict chatQueueConflict
		if err := json.Unmarshal(raw, &conflict); err != nil {
			c.t.Fatal(err)
		}
		return conflict.Queue
	}
	if err := json.Unmarshal(raw, &queue); err != nil {
		c.t.Fatal(err)
	}
	return queue
}

func queueTextsOf(queue store.ChatQueue) []string {
	texts := []string{}
	for _, item := range queue.Items {
		texts = append(texts, item.Text)
	}
	return texts
}

func registerQueueDevice(t *testing.T, backing store.Store, provider string) {
	t.Helper()
	if err := backing.RegisterDaemon(context.Background(), store.DaemonRegistration{
		Device:    store.DeviceProjection{ID: "dev_queue", Label: "Queue Device", Status: "connected", LastSeenLabel: "online"},
		Workspace: store.WorkspaceProjection{ID: "ws_queue", Name: "Queue", LocalPath: t.TempDir(), Baseline: "main"},
		Agents: []store.AgentProjection{{
			ID: "agent_queue", WorkspaceID: "ws_queue", DeviceID: "dev_queue", DeviceLabel: "Queue Device",
			Provider: provider, Status: "healthy", AuthMode: "local_config", SecretStored: "local",
			ConfigScope: "workspace", ConfigLabel: "device local login", LastSeenLabel: "online",
		}},
	}); err != nil {
		t.Fatalf("register daemon: %v", err)
	}
}

// Messages queued during a turn wait on the server, in the order and words
// the person last gave them, and go out one per turn, each exactly once,
// with no browser involved.
func TestChatQueueSendsEachMessageOnceAfterTheTurn(t *testing.T) {
	backing := newEmptyTestStore(t)
	ctx := context.Background()
	registerQueueDevice(t, backing, "claude")
	session, err := backing.CreateAgentSession(ctx, store.CreateAgentSessionInput{
		WorkspaceID: "ws_queue", AgentID: "agent_queue", Provider: "claude", Prompt: "slow turn", Source: "chat",
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
	daemon := connectQueueDaemon(t, live.URL, "dev_queue", "ws_queue", "claude", []string{session.ID})
	client := queueClient{t: t, server: server, url: live.URL}
	path := "/api/chats/" + session.ID + "/queue"
	settings := `"runSettings":{"agentId":"agent_queue","provider":"claude","claudeEffort":"low"}`

	client.queue(http.MethodPost, path, `{"text":"first",`+settings+`}`, "key-1", http.StatusCreated)
	client.queue(http.MethodPost, path, `{"text":"second",`+settings+`}`, "key-2", http.StatusCreated)
	queue := client.queue(http.MethodPost, path, `{"text":"third",`+settings+`}`, "key-3", http.StatusCreated)
	// A repeated request (a reload, another tab migrating) adds nothing.
	client.queue(http.MethodPost, path, `{"text":"third",`+settings+`}`, "key-3", http.StatusCreated)
	if status, _ := client.call(http.MethodPost, path, `{"text":"different",`+settings+`}`, "key-3"); status != http.StatusConflict {
		t.Fatalf("key reused with other input = %d, want 409", status)
	}
	if got := queueTextsOf(client.queue(http.MethodGet, path, "", "", http.StatusOK)); strings.Join(got, ",") != "first,second,third" {
		t.Fatalf("queue = %v", got)
	}
	first, second, third := queue.Items[0], queue.Items[1], queue.Items[2]

	edited := client.queue(http.MethodPatch, path+"/"+second.ID, `{"text":"second, edited","expectedRevision":1}`, "", http.StatusOK)
	stale := client.queue(http.MethodPatch, path+"/"+second.ID, `{"text":"from another tab","expectedRevision":1}`, "", http.StatusConflict)
	if stale.Items[1].Text != "second, edited" {
		t.Fatalf("conflict answers with the current queue, got %v", queueTextsOf(stale))
	}
	reorder := `{"itemIds":["` + first.ID + `","` + third.ID + `","` + second.ID + `"],"expectedRevision":`
	client.queue(http.MethodPut, path+"/order", reorder+"1}", "", http.StatusConflict)
	client.queue(http.MethodPut, path+"/order", reorder+jsonNumber(edited.Revision)+"}", "", http.StatusOK)
	queue = client.queue(http.MethodDelete, path+"/"+first.ID, "", "", http.StatusOK)
	if got := strings.Join(queueTextsOf(queue), ","); got != "third,second, edited" {
		t.Fatalf("queue after edit, reorder, delete = %s", got)
	}

	server.chatQueueKicks.Wait()
	if runs := daemon.dispatched(); len(runs) != 0 {
		t.Fatalf("dispatched %d inputs during the running turn", len(runs))
	}

	daemon.complete(session, "slow answer")
	runs := daemon.waitForRuns(1)
	// Turn ends seen twice at once (a reconnect, a recovery) send nothing more.
	server.kickChatQueue("ws_queue", session.ID)
	server.kickChatQueue("ws_queue", session.ID)
	server.chatQueueKicks.Wait()
	if runs = daemon.dispatched(); len(runs) != 1 || runs[0].Input.ID != third.ID || runs[0].Input.Prompt != "third" || runs[0].ClaudeEffort != "low" {
		t.Fatalf("first dispatch = %d inputs %+v", len(runs), runs[0].Input)
	}
	if got := queueTextsOf(client.queue(http.MethodGet, path, "", "", http.StatusOK)); strings.Join(got, ",") != "second, edited" {
		t.Fatalf("queue after the first send = %v", got)
	}
	if status, raw := client.call(http.MethodDelete, path+"/"+third.ID, "", ""); status != http.StatusConflict || !strings.Contains(string(raw), "already sent") {
		t.Fatalf("delete of a sent message = %d %s", status, raw)
	}

	daemon.complete(runs[0], "third answer")
	runs = daemon.waitForRuns(2)
	if runs[1].Input.ID != second.ID || runs[1].Input.Prompt != "second, edited" {
		t.Fatalf("second dispatch = %+v", runs[1].Input)
	}
	daemon.complete(runs[1], "second answer")
	server.chatQueueKicks.Wait()
	time.Sleep(50 * time.Millisecond)
	server.chatQueueKicks.Wait()
	if runs = daemon.dispatched(); len(runs) != 2 {
		t.Fatalf("dispatched %d inputs, want 2", len(runs))
	}
	if remaining := client.queue(http.MethodGet, path, "", "", http.StatusOK); len(remaining.Items) != 0 {
		t.Fatalf("queue left %v", queueTextsOf(remaining))
	}
	thread, err := backing.ListAgentSessionThread(ctx, "ws_queue", session.ID)
	if err != nil {
		t.Fatal(err)
	}
	prompts := []string{}
	for _, event := range thread[0].Events {
		if event.Message != nil && event.Message.Kind == "user" {
			prompts = append(prompts, event.Message.Text)
		}
	}
	if strings.Join(prompts, "|") != "slow turn|third|second, edited" {
		t.Fatalf("transcript inputs = %v", prompts)
	}
}

func jsonNumber(value int64) string {
	raw, _ := json.Marshal(value)
	return string(raw)
}

// A direct follow-up that finds the turn already running (a queued message
// went first) is refused rather than steered, so it can be queued; steering
// a queued message is Claude's alone.
func TestChatQueueSteerAndRequireIdle(t *testing.T) {
	for _, provider := range []string{"claude", "codex"} {
		t.Run(provider, func(t *testing.T) {
			backing := newEmptyTestStore(t)
			ctx := context.Background()
			registerQueueDevice(t, backing, provider)
			session, err := backing.CreateAgentSession(ctx, store.CreateAgentSessionInput{
				WorkspaceID: "ws_queue", AgentID: "agent_queue", Provider: provider, Prompt: "running", Source: "chat",
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
			if status, raw := client.call(http.MethodPost, "/api/agent-sessions/"+session.ID+"/messages", `{"prompt":"next turn","requireIdle":true}`, ""); status != http.StatusConflict || !strings.Contains(string(raw), "still active") {
				t.Fatalf("requireIdle on a running turn = %d %s", status, raw)
			}
			path := "/api/chats/" + session.ID + "/queue"
			queue := client.queue(http.MethodPost, path, `{"text":"steer me"}`, "", http.StatusCreated)
			status, raw := client.call(http.MethodPost, path+"/"+queue.Items[0].ID+"/steer", "", "")
			if provider == "codex" {
				if status != http.StatusConflict || !strings.Contains(string(raw), "only Claude") {
					t.Fatalf("codex steer = %d %s", status, raw)
				}
				return
			}
			// No device is connected: the steer fails and the message keeps its place.
			if status != http.StatusConflict {
				t.Fatalf("steer without a device = %d %s", status, raw)
			}
			if after := client.queue(http.MethodGet, path, "", "", http.StatusOK); len(after.Items) != 1 || after.Items[0].State != store.ChatQueueStateQueued {
				t.Fatalf("after a failed steer = %+v", after.Items)
			}
			daemon := connectQueueDaemon(t, live.URL, "dev_queue", "ws_queue", provider, []string{session.ID})
			attachment := `{"id":"att_1","name":"a.png","path":"/ws/a.png","kind":"image"}`
			queue = client.queue(http.MethodPost, path, `{"text":"with a file","attachments":[`+attachment+`]}`, "", http.StatusCreated)
			steered := client.queue(http.MethodPost, path+"/"+queue.Items[1].ID+"/steer", "", "", http.StatusOK)
			if got := queueTextsOf(steered); len(got) != 1 || got[0] != "steer me" {
				t.Fatalf("queue after steering = %v", got)
			}
			daemon.mu.Lock()
			defer daemon.mu.Unlock()
			if len(daemon.steered) != 1 || daemon.steered[0].Message != "with a file" || len(daemon.steered[0].Attachments) != 1 {
				t.Fatalf("steered = %+v", daemon.steered)
			}
		})
	}
}

// After a restart, a message the server was handing over is settled from the
// session's own record: sent if the session has it, queued again if not.
func TestChatQueueRecoversDispatchesAfterARestart(t *testing.T) {
	backing := newEmptyTestStore(t)
	ctx := context.Background()
	registerQueueDevice(t, backing, "claude")
	session, err := backing.CreateAgentSession(ctx, store.CreateAgentSessionInput{
		WorkspaceID: "ws_queue", AgentID: "agent_queue", Provider: "claude", Prompt: "first", Source: "chat",
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := backing.CompleteAgentSession(ctx, session.ID, "answer", "native_q"); err != nil {
		t.Fatal(err)
	}
	queues := store.Store(backing).(store.ChatQueueStore)
	queue, err := queues.EnqueueChatMessage(ctx, "ws_queue", session.ID, "", store.EnqueueChatMessageInput{Text: "was mid-send"})
	if err != nil {
		t.Fatal(err)
	}
	item, _, err := queues.ClaimChatQueueItem(ctx, "ws_queue", session.ID, queue.Items[0].ID, true)
	if err != nil {
		t.Fatal(err)
	}
	// The previous server stopped right after claiming. The new one, with
	// the device connected, sends it exactly once.
	server := NewServer(backing)
	live := httptest.NewServer(server.Routes())
	defer live.Close()
	daemon := connectQueueDaemon(t, live.URL, "dev_queue", "ws_queue", "claude", []string{})
	server.chatQueueKicks.Wait()
	server.RecoverChatQueues(ctx)
	runs := daemon.waitForRuns(1)
	server.RecoverChatQueues(ctx)
	server.chatQueueKicks.Wait()
	if runs = daemon.dispatched(); len(runs) != 1 || runs[0].Input.ID != item.ID {
		t.Fatalf("recovered dispatches = %d %+v", len(runs), runs)
	}
	sentTo, sent, err := queues.ChatQueueInputSession(ctx, item.ID)
	if err != nil || !sent || sentTo != session.ID {
		t.Fatalf("input record = %q %v %v", sentTo, sent, err)
	}
}

func TestChatQueueRoutesDeclareTheirRules(t *testing.T) {
	server, _ := newAccountsTestServer(t)
	want := map[string]string{
		"GET /api/chats/{id}/queue":                 "workspace:" + store.WorkspaceRoleViewer,
		"POST /api/chats/{id}/queue":                "workspace:" + store.WorkspaceRoleMember,
		"PUT /api/chats/{id}/queue/order":           "workspace:" + store.WorkspaceRoleMember,
		"PATCH /api/chats/{id}/queue/{itemId}":      "workspace:" + store.WorkspaceRoleMember,
		"DELETE /api/chats/{id}/queue/{itemId}":     "workspace:" + store.WorkspaceRoleMember,
		"POST /api/chats/{id}/queue/{itemId}/steer": "workspace:" + store.WorkspaceRoleMember,
		"POST /api/chats/{id}/queue/{itemId}/retry": "workspace:" + store.WorkspaceRoleMember,
	}
	for _, route := range server.routeTable() {
		if rule, ok := want[route.pattern]; ok {
			if route.rule.kind != rule {
				t.Errorf("%s rule = %q, want %q", route.pattern, route.rule.kind, rule)
			}
			delete(want, route.pattern)
		}
	}
	for pattern := range want {
		t.Errorf("%s is not registered", pattern)
	}
}

// Reading a chat's queue is a viewer's; changing it takes control of the
// chat: the person who started it, or a maintainer.
func TestChatQueueFollowsChatControl(t *testing.T) {
	f := newIsolationFixture(t)
	ctx := context.Background()
	if err := f.server.store.RegisterDaemon(ctx, store.DaemonRegistration{
		Device:    store.DeviceProjection{ID: "dev_alice", Label: "Device", Status: "connected", LastSeenLabel: "online"},
		Workspace: store.WorkspaceProjection{ID: "ws_alice", Name: "W", LocalPath: "/tmp/w", Baseline: "main"},
		Agents: []store.AgentProjection{{
			ID: "agent_alice", WorkspaceID: "ws_alice", DeviceID: "dev_alice", Provider: "claude", Status: "healthy",
			AuthMode: "local_config", SecretStored: "local", ConfigScope: "workspace", ConfigLabel: "local", LastSeenLabel: "online",
		}},
	}); err != nil {
		t.Fatal(err)
	}
	session, err := f.server.store.CreateAgentSession(ctx, store.CreateAgentSessionInput{
		CreatedByUserID: f.aliceID, WorkspaceID: "ws_alice", AgentID: "agent_alice", Provider: "claude", Prompt: "alice's chat", Source: "chat",
	})
	if err != nil {
		t.Fatal(err)
	}
	ownership := f.server.store.(store.OwnershipStore)
	path := "/api/chats/" + session.ID + "/queue"
	status := func(cookie, method, route, body string) int {
		return doAuthCall(t, f.handler, f.as(cookie, method, route, body)).Code
	}
	if got := status(f.bob, http.MethodGet, path, ""); got != http.StatusNotFound {
		t.Fatalf("outsider reads the queue: %d, want 404", got)
	}
	enqueue := `{"text":"from bob"}`
	for _, step := range []struct {
		role       string
		read, send int
	}{
		{store.WorkspaceRoleViewer, http.StatusOK, http.StatusForbidden},
		{store.WorkspaceRoleMember, http.StatusOK, http.StatusForbidden},
		{store.WorkspaceRoleMaintainer, http.StatusOK, http.StatusCreated},
	} {
		if err := ownership.SetWorkspaceMember(ctx, "ws_alice", f.bobID, step.role, f.aliceID); err != nil {
			t.Fatal(err)
		}
		if got := status(f.bob, http.MethodGet, path, ""); got != step.read {
			t.Errorf("%s reads the queue: %d, want %d", step.role, got, step.read)
		}
		if got := status(f.bob, http.MethodPost, path, enqueue); got != step.send {
			t.Errorf("%s queues in another's chat: %d, want %d", step.role, got, step.send)
		}
	}
	if got := status(f.alice, http.MethodPost, path, `{"text":"from alice"}`); got != http.StatusCreated {
		t.Fatalf("the chat's starter queues: %d", got)
	}
	f.server.chatQueueKicks.Wait()
}
