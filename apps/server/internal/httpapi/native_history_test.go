package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"slices"
	"testing"

	"github.com/gorilla/websocket"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// answerNativeHistoryForTest answers the next read_native_history the
// device gets (skipping other messages) with transcript and before.
func answerNativeHistoryForTest(t *testing.T, conn *websocket.Conn, transcript []store.TranscriptMessage, before int64) wsReadNativeHistoryPayload {
	t.Helper()
	for {
		var envelope struct {
			ID      string          `json:"id"`
			Type    string          `json:"type"`
			Payload json.RawMessage `json:"payload"`
		}
		if err := conn.ReadJSON(&envelope); err != nil {
			t.Fatalf("read websocket: %v", err)
		}
		if envelope.Type != wsReadNativeHistoryType {
			continue
		}
		var request wsReadNativeHistoryPayload
		if err := json.Unmarshal(envelope.Payload, &request); err != nil {
			t.Fatal(err)
		}
		writeWSIDForTest(t, conn, envelope.ID, wsNativeHistoryReadType, map[string]any{"transcript": transcript, "before": before})
		return request
	}
}

func eventTexts(events []store.AgentSessionEvent) []string {
	texts := []string{}
	for _, event := range events {
		if event.Message != nil {
			texts = append(texts, event.Message.Text)
		}
	}
	return texts
}

// A native chat shows its latest part and pages back through its device; a
// session that continued one imports the earlier pages into its events as
// a reader scrolls back, until the chat's start.
func TestNativeChatHistoryPagesBackThroughItsDevice(t *testing.T) {
	ctx := context.Background()
	db := newTestStore(t)
	registerMacWorkspaces(t, db)
	latest := []store.TranscriptMessage{{ID: "u3", Kind: "user", Text: "third"}, {ID: "a3", Kind: "assistant", Text: "answer three"}}
	if err := db.SyncChats(ctx, store.SyncChatsInput{WorkspaceID: "ws_mac_a", Chats: []store.ChatThread{
		{ID: "native_claude_long", Provider: "claude", NativeSessionID: "long", Title: "Long", UpdatedAt: "2026-10-23T06:00:00Z", Transcript: latest, TranscriptBefore: 300},
		{ID: "native_claude_spare", Provider: "claude", NativeSessionID: "spare", Title: "Spare", UpdatedAt: "2026-10-23T06:00:00Z", Transcript: latest, TranscriptBefore: 300},
	}}); err != nil {
		t.Fatal(err)
	}
	// A session that continued one of them.
	session, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{WorkspaceID: "ws_mac_a", AgentID: "agent_ws_mac_a", Provider: "claude", Prompt: "continue", ChatID: "native_claude_long"})
	if err != nil {
		t.Fatal(err)
	}
	server := NewServer(db)
	httpServer := httptest.NewServer(server.Routes())
	defer httpServer.Close()

	// Before the device's worker can answer, older pages are refused plainly.
	conn := dialDaemonForTest(t, httpServer)
	writeWSForTest(t, conn, "hello", macHello(nil, nil))
	readWSTypeForTest(t, conn, "registered")
	refused := getJSONObjectForTest(t, server, "/api/chats/native_claude_spare/history?before=300", http.StatusServiceUnavailable)
	if refused["error"] != errNativeHistoryUnsupported.Error() {
		t.Fatalf("old worker = %v", refused)
	}
	conn.Close()

	conn = dialDaemonForTest(t, httpServer)
	writeWSForTest(t, conn, "hello", macHello([]string{daemonCapabilityNativeHistory}, nil))
	readWSTypeForTest(t, conn, "registered")

	// The chat itself: a page read straight from the device.
	pageResult := make(chan map[string]any, 1)
	go func() {
		pageResult <- getJSONObjectForTest(t, server, "/api/chats/native_claude_spare/history?before=300", http.StatusOK)
	}()
	request := answerNativeHistoryForTest(t, conn, []store.TranscriptMessage{{ID: "u1", Kind: "user", Text: "first"}}, 0)
	if request.Provider != "claude" || request.NativeSessionID != "spare" || request.Before != 300 || request.WorkspaceID != "ws_mac_a" {
		t.Fatalf("device request = %+v", request)
	}
	if page := <-pageResult; page["before"] != float64(0) || len(page["transcript"].([]any)) != 1 {
		t.Fatalf("chat page = %v", page)
	}

	read := func(before string) windowedAgentSession {
		t.Helper()
		path := "/api/agent-sessions/" + session.ID + "?eventsLimit=50"
		if before != "" {
			path += "&eventsBefore=" + url.QueryEscape(before)
		}
		request := httptest.NewRequest(http.MethodGet, path, nil)
		response := httptest.NewRecorder()
		server.Routes().ServeHTTP(response, request)
		if response.Code != http.StatusOK {
			t.Fatalf("%s = %d %s", path, response.Code, response.Body.String())
		}
		var page windowedAgentSession
		if err := json.Unmarshal(response.Body.Bytes(), &page); err != nil {
			t.Fatal(err)
		}
		return page
	}
	newest := read("")
	if got := eventTexts(newest.Events); !slices.Equal(got, []string{"third", "answer three", "continue"}) || newest.EventsBefore == "" {
		t.Fatalf("newest = %v before %q; the chat's earlier part is offered", got, newest.EventsBefore)
	}
	older := make(chan windowedAgentSession, 1)
	go func() { older <- read(newest.EventsBefore) }()
	request = answerNativeHistoryForTest(t, conn, []store.TranscriptMessage{{ID: "u2", Kind: "user", Text: "second"}}, 120)
	if request.NativeSessionID != "long" || request.Before != 300 {
		t.Fatalf("device request = %+v", request)
	}
	page := <-older
	if got := eventTexts(page.Events); !slices.Equal(got, []string{"second"}) || page.EventsBefore == "" {
		t.Fatalf("older = %v before %q", got, page.EventsBefore)
	}
	go func() { older <- read(page.EventsBefore) }()
	answerNativeHistoryForTest(t, conn, []store.TranscriptMessage{{ID: "u1", Kind: "user", Text: "first"}}, 0)
	page = <-older
	if got := eventTexts(page.Events); !slices.Equal(got, []string{"first"}) || page.EventsBefore != "" {
		t.Fatalf("oldest = %v before %q; the chat's start ends the history", got, page.EventsBefore)
	}
	// Imported for good: the whole conversation reads without the device.
	conn.Close()
	full, err := db.GetAgentSession(ctx, session.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got := eventTexts(full.Events); !slices.Equal(got, []string{"first", "second", "third", "answer three", "continue"}) {
		t.Fatalf("session = %v", got)
	}
}
