package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// A subagent's start is pushed from its event alone; its end asks nothing of
// the device but tells viewers to read the list again, once for ends close
// together; progress and tasks that are not subagents push nothing; only the
// workspace's viewers get the updates; the list read afterwards says how
// each subagent ended, as its event did.
func TestSubagentUpdatesArePushedOnePerSubagent(t *testing.T) {
	previous := subagentEndCoalesce
	subagentEndCoalesce = 200 * time.Millisecond
	t.Cleanup(func() { subagentEndCoalesce = previous })
	db := newTestStore(t)
	server := NewServer(db)
	viewer := subscribeForTest(server.events, 256)
	outsider := &eventSubscription{ch: make(chan []byte, 256), scope: &accessScope{roles: map[string]string{"ws_other": store.WorkspaceRoleViewer}}, ended: make(chan struct{})}
	server.events.mu.Lock()
	server.events.subscribers[outsider] = struct{}{}
	server.events.mu.Unlock()
	testServer := httptest.NewServer(server.Routes())
	defer testServer.Close()
	conn := dialDaemonForTest(t, testServer)
	_ = conn.SetReadDeadline(time.Now().Add(10 * time.Second))
	writeWSForTest(t, conn, "hello", map[string]any{
		"device":    map[string]any{"id": "dev_sub", "label": "Sub", "status": "connected", "lastSeenLabel": "online"},
		"workspace": map[string]any{"id": "ws_sub", "name": "Sub", "localPath": t.TempDir()},
		"agents": []map[string]any{{
			"id": "agent_sub", "workspaceId": "ws_sub", "deviceId": "dev_sub", "provider": "claude", "status": "healthy",
			"authMode": "local_config", "secretStored": "local", "configScope": "workspace", "configLabel": "local", "lastSeenLabel": "online",
		}},
	})
	readWSTypeForTest(t, conn, "registered")
	created := postJSONForTest(t, server, "/api/agent-sessions", `{"workspaceId":"ws_sub","agentId":"agent_sub","provider":"claude","prompt":"survey"}`, http.StatusCreated)
	sessionID := created["id"].(string)
	var run struct {
		Session store.AgentSession `json:"session"`
	}
	readWSUntilForTest(t, conn, "run_session", &run)
	writeWSForTest(t, conn, "session_started", map[string]any{"sessionId": sessionID, "inputId": run.Session.Input.ID})
	skipToAckForTest(t, conn)

	updates := func(subscription *eventSubscription) []map[string]any {
		var found []map[string]any
		for len(subscription.ch) > 0 {
			_, envelope := frameForTest(t, <-subscription.ch)
			if envelope["type"] == subagentUpdatedEvent {
				found = append(found, envelope["payload"].(map[string]any))
			}
		}
		return found
	}
	awaitUpdate := func() map[string]any {
		t.Helper()
		for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); time.Sleep(5 * time.Millisecond) {
			if found := updates(viewer); len(found) > 0 {
				if len(found) != 1 {
					t.Fatalf("pushed %v, want one update", found)
				}
				return found[0]
			}
		}
		t.Fatal("no subagent update was pushed")
		return nil
	}
	event := func(id, label, detail string, metadata map[string]any) map[string]any {
		return map[string]any{"event": map[string]any{
			"id": id, "sessionId": sessionID, "label": label, "detail": detail, "level": "info", "metadata": metadata,
		}}
	}
	send := func(id, label, detail string, metadata map[string]any) {
		t.Helper()
		writeWSForTest(t, conn, "session_event", event(id, label, detail, metadata))
		skipToAckForTest(t, conn)
	}
	updates(viewer)

	send("evt_start", "Starting subtask", "Survey the repo", map[string]any{
		"taskId": "task_1", "taskType": "local_agent", "toolUseId": "tool_1", "prompt": "List the packages", "subagentType": "Explore",
	})
	started := updates(viewer)
	want := map[string]any{"workspaceId": "ws_sub", "sessionId": sessionID, "subagent": map[string]any{
		"prompt": "List the packages", "responseTexts": []any{}, "sessionId": sessionID, "status": "running",
		"subagentType": "Explore", "taskId": "task_1", "title": "Survey the repo", "toolUseId": "tool_1",
	}}
	if len(started) != 1 || !reflect.DeepEqual(started[0], want) {
		t.Fatalf("a start pushed %v, want %v", started, want)
	}

	usage := map[string]any{"totalTokens": float64(1200), "toolUses": float64(3), "durationMs": float64(4000)}
	send("evt_progress", "Subtask running", "Reading", map[string]any{"taskId": "task_1", "subagentUsage": usage})
	send("evt_bash_start", "Starting subtask", "npm test", map[string]any{"taskId": "bash_1", "taskType": "local_bash", "toolUseId": "tool_bash"})
	send("evt_bash_end", "Subtask completed", "Tests passed", map[string]any{"taskId": "bash_1"})
	if got := updates(viewer); len(got) != 0 {
		t.Fatalf("progress and a background command pushed %v", got)
	}

	send("evt_untyped", "Starting subtask", "From an older worker", map[string]any{"taskId": "task_old", "toolUseId": "tool_old"})
	if got := updates(viewer); len(got) != 1 || got[0]["subagent"] != nil || got[0]["sessionId"] != sessionID {
		t.Fatalf("a start of no stated type pushed %v, want one update without a subagent", got)
	}

	// The ends: nothing is asked of the device. Its viewers are told, once
	// for ends close together, to read the list again.
	send("evt_start_2", "Starting subtask", "Check the docs", map[string]any{"taskId": "task_2", "taskType": "local_agent", "toolUseId": "tool_2"})
	updates(viewer)
	send("evt_end", "Subtask completed", "Three packages", map[string]any{"taskId": "task_1", "subagentUsage": usage})
	send("evt_end_2", "Subtask failed", "Stopped", map[string]any{"taskId": "task_2"})
	if ended := awaitUpdate(); ended["subagent"] != nil || ended["sessionId"] != sessionID {
		t.Fatalf("the ends pushed %v, want one update without a subagent", ended)
	}
	if got := updates(outsider); len(got) != 0 {
		t.Fatalf("a viewer of another workspace got %v", got)
	}

	// A viewer reads the list: the device is asked once (it lags: still
	// running); each ended subagent reads as its event said, with its
	// answer from the device.
	read := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		recorder := httptest.NewRecorder()
		server.Routes().ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/agent-sessions/"+sessionID+"/subagents", nil))
		read <- recorder
	}()
	var listRequest struct {
		SessionID string `json:"sessionId"`
	}
	listID := readWSUntilForTest(t, conn, "list_subagents", &listRequest)
	if listRequest.SessionID != sessionID {
		t.Fatalf("listed session %q, want %q", listRequest.SessionID, sessionID)
	}
	writeWSIDForTest(t, conn, listID, "subagents_listed", map[string]any{"sessionId": sessionID, "subagents": []map[string]any{
		{"sessionId": sessionID, "taskId": "task_0", "toolUseId": "tool_0", "title": "Earlier", "status": "completed", "responseTexts": []string{"Earlier answer"}},
		{"sessionId": sessionID, "taskId": "task_1", "toolUseId": "tool_1", "title": "Survey the repo", "prompt": "List the packages", "subagentType": "Explore", "status": "running", "responseTexts": []string{"Three packages."}},
		{"sessionId": sessionID, "taskId": "task_2", "toolUseId": "tool_2", "title": "Check the docs", "status": "running", "responseTexts": []string{}},
	}})
	listed := <-read
	if listed.Code != http.StatusOK {
		t.Fatalf("list = %d %s", listed.Code, listed.Body.String())
	}
	var subagents []map[string]any
	if err := json.Unmarshal(listed.Body.Bytes(), &subagents); err != nil {
		t.Fatal(err)
	}
	wantEnded := map[string]any{
		"prompt": "List the packages", "responseTexts": []any{"Three packages."}, "sessionId": sessionID, "status": "completed",
		"subagentType": "Explore", "taskId": "task_1", "title": "Survey the repo", "toolUseId": "tool_1", "usage": usage,
	}
	if len(subagents) != 3 || !reflect.DeepEqual(subagents[1], wantEnded) || subagents[2]["status"] != "failed" {
		t.Fatalf("the list read after the ends = %v", subagents)
	}

	// A read now answers from the cache; its ETag, 304.
	request := httptest.NewRequest(http.MethodGet, "/api/agent-sessions/"+sessionID+"/subagents", nil)
	request.Header.Set("If-None-Match", listed.Header().Get("ETag"))
	revalidated := httptest.NewRecorder()
	server.Routes().ServeHTTP(revalidated, request)
	if revalidated.Code != http.StatusNotModified {
		t.Fatalf("revalidation = %d, want 304", revalidated.Code)
	}

	// Nothing else was asked of the device.
	_ = conn.SetReadDeadline(time.Now().Add(300 * time.Millisecond))
	var stray struct {
		Type string `json:"type"`
	}
	if err := conn.ReadJSON(&stray); err == nil {
		t.Fatalf("the device was sent %q", stray.Type)
	}
}
