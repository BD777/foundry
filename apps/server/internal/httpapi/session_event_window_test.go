package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func getRawForTest(t *testing.T, server *Server, path string, expectedStatus int) []byte {
	t.Helper()
	response := httptest.NewRecorder()
	server.Routes().ServeHTTP(response, httptest.NewRequest(http.MethodGet, path, nil))
	if response.Code != expectedStatus {
		t.Fatalf("GET %s: status %d, want %d: %s", path, response.Code, expectedStatus, response.Body.String())
	}
	return response.Body.Bytes()
}

type windowedSessionForTest struct {
	ID           string                    `json:"id"`
	Events       []store.AgentSessionEvent `json:"events"`
	EventsBefore *string                   `json:"eventsBefore"`
}

func windowEventIDs(events []store.AgentSessionEvent) []string {
	ids := make([]string, len(events))
	for index, event := range events {
		ids[index] = event.ID
	}
	return ids
}

// A chat opens on its newest events: ?eventsLimit= returns each session's
// newest N with the cursor of the older ones, and paging the session with
// ?eventsBefore= yields the rest of the transcript exactly once. Without
// the parameters both reads return every event, as before.
func TestWindowedTranscriptReads(t *testing.T) {
	db := newEmptyTestStore(t)
	ctx := context.Background()
	if err := db.RegisterDaemon(ctx, store.DaemonRegistration{
		Device:    store.DeviceProjection{ID: "dev_window", Label: "Window Device", Status: "connected", LastSeenLabel: "online"},
		Workspace: store.WorkspaceProjection{ID: "ws_window", Name: "Window", LocalPath: t.TempDir()},
		Agents: []store.AgentProjection{{
			ID: "agent_window", WorkspaceID: "ws_window", DeviceID: "dev_window", DeviceLabel: "Window Device",
			Provider: "codex", Status: "healthy", AuthMode: "local_config", SecretStored: "local",
			ConfigScope: "workspace", ConfigLabel: "local", LastSeenLabel: "online",
		}},
	}); err != nil {
		t.Fatal(err)
	}
	session, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{WorkspaceID: "ws_window", AgentID: "agent_window", Provider: "codex", Prompt: "first"})
	if err != nil {
		t.Fatal(err)
	}
	for index := range 7 {
		if err := db.AppendAgentSessionEvent(ctx, store.AgentSessionEvent{
			ID: fmt.Sprintf("evt_window_api_%d", index), SessionID: session.ID, Label: "Response stream", Detail: fmt.Sprint(index), Level: "info",
		}); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := db.CompleteAgentSession(ctx, session.ID, "6", "native_window"); err != nil {
		t.Fatal(err)
	}
	server := NewServer(db)

	threadPath := "/api/agent-session-threads/" + session.ID + "?workspaceId=ws_window"
	var whole []windowedSessionForTest
	if err := json.Unmarshal(getRawForTest(t, server, threadPath, http.StatusOK), &whole); err != nil {
		t.Fatal(err)
	}
	if len(whole) != 1 || whole[0].EventsBefore != nil || len(whole[0].Events) != 8 {
		t.Fatalf("unwindowed thread = %+v; want the input and 7 events, no cursor", whole)
	}
	want := windowEventIDs(whole[0].Events)
	var direct windowedSessionForTest
	if err := json.Unmarshal(getRawForTest(t, server, "/api/agent-sessions/"+session.ID, http.StatusOK), &direct); err != nil {
		t.Fatal(err)
	}
	if direct.EventsBefore != nil || !slices.Equal(windowEventIDs(direct.Events), want) {
		t.Fatalf("unwindowed session read = %v; want %v", windowEventIDs(direct.Events), want)
	}

	var recent []windowedSessionForTest
	if err := json.Unmarshal(getRawForTest(t, server, threadPath+"&eventsLimit=3", http.StatusOK), &recent); err != nil {
		t.Fatal(err)
	}
	if len(recent) != 1 || recent[0].EventsBefore == nil || *recent[0].EventsBefore == "" {
		t.Fatalf("windowed thread = %+v; want one session with a cursor", recent)
	}
	paged := windowEventIDs(recent[0].Events)
	if !slices.Equal(paged, want[len(want)-3:]) {
		t.Fatalf("windowed thread events = %v; want the newest 3 of %v", paged, want)
	}
	before := *recent[0].EventsBefore
	for pages := 0; ; pages++ {
		if pages > len(want) {
			t.Fatal("paging does not end")
		}
		var page windowedSessionForTest
		path := "/api/agent-sessions/" + session.ID + "?eventsLimit=3&eventsBefore=" + url.QueryEscape(before)
		if err := json.Unmarshal(getRawForTest(t, server, path, http.StatusOK), &page); err != nil {
			t.Fatal(err)
		}
		if page.ID != session.ID || len(page.Events) == 0 || len(page.Events) > 3 {
			t.Fatalf("page = %+v; want 1-3 events of the session", page)
		}
		paged = append(windowEventIDs(page.Events), paged...)
		if page.EventsBefore == nil {
			break
		}
		before = *page.EventsBefore
	}
	if !slices.Equal(paged, want) {
		t.Fatalf("paged transcript = %v; want %v", paged, want)
	}

	// A window larger than the transcript is the whole of it, without a cursor.
	var all []windowedSessionForTest
	if err := json.Unmarshal(getRawForTest(t, server, threadPath+"&eventsLimit=5000", http.StatusOK), &all); err != nil {
		t.Fatal(err)
	}
	if len(all) != 1 || all[0].EventsBefore != nil || !slices.Equal(windowEventIDs(all[0].Events), want) {
		t.Fatalf("large window = %+v; want every event without a cursor", all)
	}
	for _, path := range []string{
		threadPath + "&eventsLimit=0",
		threadPath + "&eventsLimit=many",
		threadPath + "&eventsLimit=3&eventsBefore=" + url.QueryEscape(before),
		"/api/agent-sessions/" + session.ID + "?eventsLimit=3&eventsBefore=not-a-cursor",
		"/api/agent-sessions/" + session.ID + "?eventsLimit=-1",
	} {
		getRawForTest(t, server, path, http.StatusBadRequest)
	}
}

func TestRequestedEventWindowCapsTheLimit(t *testing.T) {
	window, windowed, err := requestedEventWindow(httptest.NewRequest(http.MethodGet, "/x?eventsLimit=999999", nil))
	if err != nil || !windowed || window.limit != maxEventsWindow {
		t.Fatalf("window = %+v, %v, %v; want the limit capped at %d", window, windowed, err, maxEventsWindow)
	}
	window, windowed, err = requestedEventWindow(httptest.NewRequest(http.MethodGet, "/x?eventsBefore=abc", nil))
	if err != nil || !windowed || window.limit != maxEventsWindow || window.before != "abc" {
		t.Fatalf("cursor without a limit = %+v, %v, %v", window, windowed, err)
	}
	if _, windowed, err := requestedEventWindow(httptest.NewRequest(http.MethodGet, "/x", nil)); windowed || err != nil {
		t.Fatalf("no parameters must read every event: %v, %v", windowed, err)
	}
}

// A direct send names its input: a retry with the same id (a lost
// response, a reload) answers with the session that took it and starts no
// second turn, even once that turn is running. The id is a lowercase UUID
// and cannot reach another session.
func TestDirectSendsAreIdempotentByInputID(t *testing.T) {
	backing := newEmptyTestStore(t)
	ctx := context.Background()
	agent := map[string]any{
		"id": "agent_input_claude", "workspaceId": "ws_input", "deviceId": "dev_input", "deviceLabel": "Input Device",
		"provider": "claude", "status": "healthy", "authMode": "local_config", "secretStored": "local",
		"configScope": "workspace", "configLabel": "device local login", "lastSeenLabel": "online",
	}
	if err := backing.RegisterDaemon(ctx, store.DaemonRegistration{
		Device:    store.DeviceProjection{ID: "dev_input", Label: "Input Device", Status: "connected", LastSeenLabel: "online"},
		Workspace: store.WorkspaceProjection{ID: "ws_input", Name: "Input", LocalPath: t.TempDir(), Baseline: "main"},
		Agents: []store.AgentProjection{{
			ID: "agent_input_claude", WorkspaceID: "ws_input", DeviceID: "dev_input", DeviceLabel: "Input Device",
			Provider: "claude", Status: "healthy", AuthMode: "local_config", SecretStored: "local",
			ConfigScope: "workspace", ConfigLabel: "device local login", LastSeenLabel: "online",
		}},
	}); err != nil {
		t.Fatal(err)
	}
	testServer := httptest.NewServer(NewServer(backing).Routes())
	defer testServer.Close()
	conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(testServer.URL, "http")+"/api/daemon/ws", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if err := conn.SetReadDeadline(time.Now().Add(5 * time.Second)); err != nil {
		t.Fatal(err)
	}
	writeWSForTest(t, conn, "hello", map[string]any{
		"device":         map[string]any{"id": "dev_input", "label": "Input Device", "status": "connected", "lastSeenLabel": "online"},
		"workspace":      map[string]any{"id": "ws_input", "name": "Input", "localPath": t.TempDir(), "baseline": "main"},
		"providerHealth": []map[string]any{},
		"assets":         []map[string]any{},
		"agents":         []map[string]any{agent},
	})
	readWSTypeForTest(t, conn, "registered")

	post := func(path, key, body string) (int, store.AgentSession) {
		t.Helper()
		request, _ := http.NewRequest(http.MethodPost, testServer.URL+path, strings.NewReader(body))
		request.Header.Set("Content-Type", "application/json")
		if key != "" {
			request.Header.Set("Idempotency-Key", key)
		}
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		raw, _ := io.ReadAll(response.Body)
		var session store.AgentSession
		if response.StatusCode < 300 {
			if err := json.Unmarshal(raw, &session); err != nil {
				t.Fatalf("decode %s: %v (%s)", path, err, raw)
			}
		}
		return response.StatusCode, session
	}
	userMessages := func(sessionID string) []string {
		t.Helper()
		full, err := backing.GetAgentSession(ctx, sessionID)
		if err != nil {
			t.Fatal(err)
		}
		var texts []string
		for _, event := range full.Events {
			if event.Message != nil && event.Message.Kind == "user" {
				texts = append(texts, event.Message.Text)
			}
		}
		return texts
	}

	const first = "0192a0b4-0000-7000-8000-000000000001"
	const second = "0192a0b4-0000-7000-8000-000000000002"
	createBody := `{"workspaceId":"ws_input","agentId":"agent_input_claude","provider":"claude","prompt":"start","source":"chat","inputId":"` + first + `"}`
	status, created := post("/api/agent-sessions", "", createBody)
	if status != http.StatusCreated || created.Input.ID != first {
		t.Fatalf("create: status %d, input %q; want 201 with input %s", status, created.Input.ID, first)
	}
	readWSTypeForTest(t, conn, "run_session")
	status, retried := post("/api/agent-sessions", "", createBody)
	if status != http.StatusCreated || retried.ID != created.ID || retried.Input.ID != first {
		t.Fatalf("retried create: status %d, %s/%s; want %s/%s", status, retried.ID, retried.Input.ID, created.ID, first)
	}
	if sessions, err := backing.ListAgentSessionSummaries(ctx, "ws_input"); err != nil || len(sessions) != 1 {
		t.Fatalf("a retried create must not start a session: %d sessions, %v", len(sessions), err)
	}

	if _, err := backing.CompleteAgentSession(ctx, created.ID, "done", ""); err != nil {
		t.Fatal(err)
	}
	messages := "/api/agent-sessions/" + created.ID + "/messages"
	sendBody := `{"prompt":"follow up","requireIdle":true,"inputId":"` + second + `"}`
	status, sent := post(messages, "client-key", sendBody)
	if status != http.StatusOK || sent.Input.ID != second {
		t.Fatalf("send: status %d, input %q; want 200 with input %s", status, sent.Input.ID, second)
	}
	readWSTypeForTest(t, conn, "run_session")
	// The turn is queued now: without the input id this retry would be
	// refused (requireIdle) and the client would queue the message again.
	status, resent := post(messages, "", sendBody)
	if status != http.StatusOK || resent.ID != created.ID || resent.Input.ID != second {
		t.Fatalf("retried send: status %d, input %q; want 200 with input %s", status, resent.Input.ID, second)
	}
	// The Idempotency-Key still replays, and still refuses another body.
	if status, replayed := post(messages, "client-key", sendBody); status != http.StatusOK || replayed.Input.ID != second {
		t.Fatalf("replayed key: status %d, input %q", status, replayed.Input.ID)
	}
	if status, _ := post(messages, "client-key", strings.Replace(sendBody, "follow up", "other", 1)); status != http.StatusConflict {
		t.Fatalf("same key, other body: status %d, want 409", status)
	}
	if got := userMessages(created.ID); !slices.Equal(got, []string{"start", "follow up"}) {
		t.Fatalf("user messages = %q; want each sent once", got)
	}

	// The id of a message another session took is refused, not replayed.
	other, err := backing.CreateAgentSession(ctx, store.CreateAgentSessionInput{WorkspaceID: "ws_input", AgentID: "agent_input_claude", Provider: "claude", Prompt: "other"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := backing.CompleteAgentSession(ctx, other.ID, "done", ""); err != nil {
		t.Fatal(err)
	}
	if status, _ := post("/api/agent-sessions/"+other.ID+"/messages", "", sendBody); status != http.StatusConflict {
		t.Fatalf("another session's input id: status %d, want 409", status)
	}
	for _, id := range []string{"not-a-uuid", strings.ToUpper(second), second + "0", "../" + second[3:]} {
		if status, _ := post(messages, "", `{"prompt":"x","inputId":"`+id+`"}`); status != http.StatusBadRequest {
			t.Fatalf("inputId %q: status %d, want 400", id, status)
		}
	}
	if got := userMessages(other.ID); !slices.Equal(got, []string{"other"}) {
		t.Fatalf("other session's user messages = %q", got)
	}
}
