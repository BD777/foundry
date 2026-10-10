package httpapi

import (
	"bufio"
	"compress/gzip"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// streamLinesForTest reads an event stream line by line as it arrives.
func streamLinesForTest(t *testing.T, body io.Reader) <-chan string {
	t.Helper()
	lines := make(chan string, 256)
	go func() {
		defer close(lines)
		scanner := bufio.NewScanner(body)
		scanner.Buffer(make([]byte, 0, 1<<16), 1<<22)
		for scanner.Scan() {
			lines <- scanner.Text()
		}
	}()
	return lines
}

func awaitLineForTest(t *testing.T, lines <-chan string, want func(string) bool, what string) string {
	t.Helper()
	deadline := time.After(2 * time.Second)
	for {
		select {
		case line, ok := <-lines:
			if !ok {
				t.Fatalf("stream ended before %s", what)
			}
			if want(line) {
				return line
			}
		case <-deadline:
			t.Fatalf("%s did not arrive within 2s", what)
		}
	}
}

// A browser that accepts gzip gets a compressed stream it can decode as it
// arrives: each frame, the retry hint and heartbeats are flushed through the
// compressor at once.
func TestEventStreamIsCompressedFrameByFrame(t *testing.T) {
	interval := eventHeartbeatInterval
	eventHeartbeatInterval = 100 * time.Millisecond
	defer func() { eventHeartbeatInterval = interval }()
	hub := newBrowserEventHub()
	server := streamServerForTest(hub)
	defer server.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	request, err := http.NewRequestWithContext(ctx, http.MethodGet, server.URL, nil)
	if err != nil {
		t.Fatal(err)
	}
	// Set explicitly, so the client hands over the compressed bytes.
	request.Header.Set("Accept-Encoding", "gzip, deflate, br")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	for header, want := range map[string]string{
		"Content-Encoding":  "gzip",
		"Content-Type":      "text/event-stream",
		"X-Accel-Buffering": "no",
	} {
		if got := response.Header.Get(header); got != want {
			t.Fatalf("%s = %q, want %q", header, got, want)
		}
	}
	if !strings.Contains(response.Header.Get("Vary"), "Accept-Encoding") {
		t.Fatalf("Vary = %q", response.Header.Get("Vary"))
	}
	decoded, err := gzip.NewReader(response.Body)
	if err != nil {
		t.Fatalf("stream is not gzip: %v", err)
	}
	lines := streamLinesForTest(t, decoded)
	awaitLineForTest(t, lines, func(line string) bool { return line == "retry: 1000" }, "the retry hint")
	for index := 0; index < 5; index++ {
		id := fmt.Sprintf("evt_gzip_%d", index)
		hub.PublishIn("ws_1", "agent_session_event", store.AgentSessionEvent{ID: id, Detail: strings.Repeat("answer so far ", 50*index)})
		awaitLineForTest(t, lines, func(line string) bool {
			return strings.HasPrefix(line, "data: ") && strings.Contains(line, `"id":"`+id+`"`)
		}, "frame "+id)
	}
	awaitLineForTest(t, lines, func(line string) bool { return line == ": keepalive" }, "a heartbeat")
}

// A client that does not accept gzip reads the stream as before.
func TestEventStreamStaysPlainWithoutGzip(t *testing.T) {
	hub := newBrowserEventHub()
	server := streamServerForTest(hub)
	defer server.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	for _, acceptEncoding := range []string{"identity", "gzip;q=0, identity"} {
		request, err := http.NewRequestWithContext(ctx, http.MethodGet, server.URL, nil)
		if err != nil {
			t.Fatal(err)
		}
		request.Header.Set("Accept-Encoding", acceptEncoding)
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		if got := response.Header.Get("Content-Encoding"); got != "" {
			t.Fatalf("Accept-Encoding %q: Content-Encoding = %q", acceptEncoding, got)
		}
		lines := streamLinesForTest(t, response.Body)
		awaitLineForTest(t, lines, func(line string) bool { return line == "retry: 1000" }, "the retry hint")
		hub.PublishIn("ws_1", "agent_session_event", store.AgentSessionEvent{ID: "evt_plain"})
		awaitLineForTest(t, lines, func(line string) bool { return strings.Contains(line, `"id":"evt_plain"`) }, "the plain frame")
		response.Body.Close()
	}
}

// The streamed transcript event carries the time the server stored, which is
// also the session's lastActivityAt: a live client and a fresh read agree,
// so the live one never takes its transcript for stale.
func TestStreamedSessionEventCarriesTheStoredTime(t *testing.T) {
	db := newTestStore(t)
	server := NewServer(db)
	viewer := subscribeForTest(server.events, 256)
	testServer := httptest.NewServer(server.Routes())
	defer testServer.Close()
	conn := dialDaemonForTest(t, testServer)
	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	writeWSForTest(t, conn, "hello", map[string]any{
		"device":    map[string]any{"id": "dev_at", "label": "At", "status": "connected", "lastSeenLabel": "online"},
		"workspace": map[string]any{"id": "ws_at", "name": "At", "localPath": t.TempDir()},
		"agents": []map[string]any{{
			"id": "agent_at", "workspaceId": "ws_at", "deviceId": "dev_at", "provider": "codex", "status": "healthy",
			"authMode": "local_config", "secretStored": "local", "configScope": "workspace", "configLabel": "local", "lastSeenLabel": "online",
		}},
	})
	readWSTypeForTest(t, conn, "registered")
	created := postJSONForTest(t, server, "/api/agent-sessions", `{"workspaceId":"ws_at","agentId":"agent_at","provider":"codex","prompt":"first"}`, http.StatusCreated)
	sessionID := created["id"].(string)
	var run struct {
		Session store.AgentSession `json:"session"`
	}
	readWSUntilForTest(t, conn, "run_session", &run)
	writeWSForTest(t, conn, "session_started", map[string]any{"sessionId": sessionID, "inputId": run.Session.Input.ID})
	skipToAckForTest(t, conn)
	writeWSForTest(t, conn, "session_event", map[string]any{"event": map[string]any{
		"id": "evt_at", "sessionId": sessionID, "label": "Response stream", "detail": "partial", "level": "info", "at": "2000-01-01T00:00:00Z",
	}})
	skipToAckForTest(t, conn)

	streamedAt := ""
	for len(viewer.ch) > 0 && streamedAt == "" {
		_, envelope := frameForTest(t, <-viewer.ch)
		if payload, ok := envelope["payload"].(map[string]any); ok && envelope["type"] == "agent_session_event" && payload["id"] == "evt_at" {
			streamedAt, _ = payload["at"].(string)
		}
	}
	if streamedAt == "" || streamedAt == "2000-01-01T00:00:00Z" {
		t.Fatalf("streamed at = %q, want the server's time", streamedAt)
	}
	var read struct {
		LastActivityAt string                    `json:"lastActivityAt"`
		Events         []store.AgentSessionEvent `json:"events"`
	}
	body := requestForTest(t, server, http.MethodGet, "/api/agent-sessions/"+sessionID+"?eventsLimit=10", "", http.StatusOK).Body.Bytes()
	if err := json.Unmarshal(body, &read); err != nil {
		t.Fatal(err)
	}
	storedAt := ""
	for _, event := range read.Events {
		if event.ID == "evt_at" {
			storedAt = event.At
		}
	}
	if storedAt != streamedAt || read.LastActivityAt != streamedAt {
		t.Fatalf("streamed %q, stored %q, lastActivityAt %q: want one time", streamedAt, storedAt, read.LastActivityAt)
	}
}
