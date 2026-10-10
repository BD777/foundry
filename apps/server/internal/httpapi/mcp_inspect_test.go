package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func TestInspectedIDAcceptsIdsAndLinks(t *testing.T) {
	for raw, want := range map[string]string{
		"sess_1791473310893954782": "sess_1791473310893954782",
		"  `sess_42`. ":            "sess_42",
		"native_claude_d3f03924-c53a-4c3c-acd9-3a0916b50574":                  "native_claude_d3f03924-c53a-4c3c-acd9-3a0916b50574",
		"https://foundry.example/chats/sess_42?workspace=ws_a":                "sess_42",
		"https://foundry.example/base/chats/native_codex_019f%2Dx?workspace=": "native_codex_019f-x",
		"<http://localhost:5173/chats/sess_7>":                                "sess_7",
		"/chats/sess_8?workspace=ws_b":                                        "sess_8",
		"https://foundry.example/issues/iss_1":                                "https://foundry.example/issues/iss_1",
	} {
		if got := inspectedID(raw); got != want {
			t.Errorf("inspectedID(%q) = %q, want %q", raw, got, want)
		}
	}
}

// mcpToolCaller calls one Foundry tool over /api/mcp with a bearer token
// and returns its text and whether it is an error result.
func mcpToolCaller(t *testing.T, handler http.Handler, token string) func(tool string, arguments any) (string, bool) {
	return func(tool string, arguments any) (string, bool) {
		t.Helper()
		params, _ := json.Marshal(map[string]any{"name": tool, "arguments": arguments})
		body := `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":` + string(params) + `}`
		request := httptest.NewRequest(http.MethodPost, "/api/mcp", strings.NewReader(body))
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("Authorization", "Bearer "+token)
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		var envelope struct {
			Result struct {
				Content []struct {
					Text string `json:"text"`
				} `json:"content"`
				IsError bool `json:"isError"`
			} `json:"result"`
			Error *struct {
				Message string `json:"message"`
			} `json:"error"`
		}
		if err := json.Unmarshal(response.Body.Bytes(), &envelope); err != nil {
			t.Fatalf("%s: %d %s", tool, response.Code, response.Body.String())
		}
		if envelope.Error != nil {
			return envelope.Error.Message, true
		}
		if len(envelope.Result.Content) == 0 {
			t.Fatalf("%s: no content: %s", tool, response.Body.String())
		}
		return envelope.Result.Content[0].Text, envelope.Result.IsError
	}
}

// A long session that ended the way sess_1791473310893954782 did: a turn
// left a Monitor open and the worker gave up at its idle timeout.
func seedLongFailedSession(t *testing.T, db store.Store, workspaceID, agentID string) store.AgentSession {
	t.Helper()
	ctx := context.Background()
	session, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{
		WorkspaceID: workspaceID, AgentID: agentID, Provider: "claude", Prompt: "Harden the proxy", Source: "chat",
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.StartAgentSession(ctx, session.ID); err != nil {
		t.Fatal(err)
	}
	append := func(event store.AgentSessionEvent) {
		t.Helper()
		event.SessionID = session.ID
		if event.ID == "" {
			event.ID = fmt.Sprintf("evt_%s_%d", session.ID, time.Now().UnixNano())
		}
		if event.Level == "" {
			event.Level = "info"
		}
		if err := db.AppendAgentSessionEvent(ctx, event); err != nil {
			t.Fatal(err)
		}
	}
	bulk := strings.Repeat("tool output ", 400)
	for index := 0; index < 300; index++ {
		append(store.AgentSessionEvent{Label: "Used tool", Detail: fmt.Sprintf("Bash %d %s", index, bulk),
			Message: &store.TranscriptMessage{ID: fmt.Sprintf("m%d", index), Kind: "tool", Text: bulk}})
		append(store.AgentSessionEvent{Label: "Model request usage", Detail: "msg", Metadata: &store.AgentSessionEventMetadata{
			RequestUsage: &store.ModelRequestUsage{RequestID: fmt.Sprintf("r%d", index)}}})
	}
	append(store.AgentSessionEvent{Label: "Subtask failed", Level: "error", Detail: "Probe the US exit",
		Metadata: &store.AgentSessionEventMetadata{TaskID: "b1"}})
	append(store.AgentSessionEvent{Label: "Starting subtask", Detail: "US account cooldown events",
		Metadata: &store.AgentSessionEventMetadata{TaskID: "bmon", TaskType: "local_bash"}})
	append(store.AgentSessionEvent{Label: "Response stream", Detail: strings.Repeat("All set. ", 300),
		Message: &store.TranscriptMessage{ID: "answer", Kind: "assistant", Text: strings.Repeat("All set. ", 300)}})
	append(store.AgentSessionEvent{Label: "Waiting for background tasks", Detail: "1 background task(s) are still open; this result is intermediate, and Foundry waits for the main agent to continue."})
	append(store.AgentSessionEvent{ID: "evt_failed", Label: "Session failed", Level: "error", Detail: "Claude Agent SDK stopped producing events before the session idle timeout."})
	failed, err := db.FailAgentSession(ctx, session.ID, "Claude Agent SDK stopped producing events before the session idle timeout.")
	if err != nil {
		t.Fatal(err)
	}
	return failed
}

func TestGetSessionIsACompactSummary(t *testing.T) {
	db, parent := lineageFixture(t)
	ctx := context.Background()
	token, err := db.MintAgentSessionToken(ctx, parent.ID)
	if err != nil {
		t.Fatal(err)
	}
	failed := seedLongFailedSession(t, db, "ws_lineage", "agent_lineage")
	call := mcpToolCaller(t, NewServer(db).Routes(), token)

	full, _ := db.GetAgentSession(ctx, failed.ID)
	whole, _ := json.Marshal(full)
	text, isError := call("get_session", map[string]any{"sessionId": "https://foundry.example/chats/" + failed.ID + "?workspace=ws_lineage"})
	if isError {
		t.Fatalf("get_session = %s", text)
	}
	if len(whole) < 1_000_000 || len(text) > 4_000 {
		t.Fatalf("summary is %d bytes of a %d-byte session, want a few KB", len(text), len(whole))
	}
	var digest sessionDigest
	if err := json.Unmarshal([]byte(text), &digest); err != nil {
		t.Fatal(err)
	}
	if digest.ID != failed.ID || digest.Kind != "session" || digest.Status != "failed" ||
		digest.Error != "Claude Agent SDK stopped producing events before the session idle timeout." {
		t.Fatalf("digest = %+v", digest)
	}
	if digest.Device == nil || digest.Device.ID != "dev_lineage" || digest.Device.Name != "Studio" || digest.Device.Online == nil ||
		digest.Workspace == nil || digest.Workspace.Name != "Foundry" || digest.Runtime != "claude" || digest.CreatedAt == "" || digest.LastInput != "Harden the proxy" {
		t.Fatalf("digest places = %+v device %+v workspace %+v", digest, digest.Device, digest.Workspace)
	}
	// Token reports are left out, as in the web.
	if digest.Events.Total != 306 || digest.Events.Errors != 2 {
		t.Fatalf("event counts = %+v, want 306 events (the opening message too) with 2 errors", digest.Events)
	}
	if answer := []rune(digest.LastAnswer); len(answer) > inspectAnswerLimit || !strings.HasPrefix(digest.LastAnswer, "All set.") {
		t.Fatalf("last answer = %d characters %q", len(answer), digest.LastAnswer)
	}
	if digest.LastError == nil || digest.LastError.ID != "evt_failed" || digest.LastError.Label != "Session failed" ||
		len(digest.LastError.Before) != 3 || !strings.Contains(digest.LastError.Before[2], "Waiting for background tasks") {
		t.Fatalf("last error = %+v", digest.LastError)
	}
	if len(digest.OpenBackgroundTasks) != 1 || digest.OpenBackgroundTasks[0].ID != "bmon" || digest.OpenBackgroundTasks[0].Description != "US account cooldown events" {
		t.Fatalf("open background tasks = %+v", digest.OpenBackgroundTasks)
	}
	if !strings.Contains(digest.More, "scope=events") {
		t.Fatalf("more = %q", digest.More)
	}
	// read_context's summary is the same digest.
	if summary, _ := call("read_context", map[string]any{"sessionId": failed.ID}); summary != text {
		t.Fatalf("read_context summary differs from get_session:\n%s", summary)
	}
	if text, isError := call("read_context", map[string]any{"sessionId": failed.ID, "scope": "everything"}); !isError || !strings.Contains(text, "unknown scope") {
		t.Fatalf("unknown scope = %q", text)
	}
	if text, isError := call("get_session", map[string]any{"sessionId": "sess_missing"}); !isError || !strings.Contains(text, "no session or chat sess_missing") {
		t.Fatalf("missing session = %q", text)
	}
}

func TestReadEventsOverMCP(t *testing.T) {
	db, parent := lineageFixture(t)
	ctx := context.Background()
	token, err := db.MintAgentSessionToken(ctx, parent.ID)
	if err != nil {
		t.Fatal(err)
	}
	failed := seedLongFailedSession(t, db, "ws_lineage", "agent_lineage")
	call := mcpToolCaller(t, NewServer(db).Routes(), token)

	text, isError := call("read_context", map[string]any{"sessionId": failed.ID, "scope": "events", "levels": []string{"error", "warning"}, "tail": 20})
	if isError {
		t.Fatal(text)
	}
	lines := strings.Split(strings.TrimSpace(text), "\n")
	if !strings.HasPrefix(lines[0], failed.ID+": 2 of 306 events match (levels=error,warning); showing 2.") || len(lines) != 4 ||
		!strings.Contains(lines[2], " | error | Subtask failed | Probe the US exit") ||
		!strings.Contains(lines[3], " | error | Session failed | Claude Agent SDK stopped producing events") {
		t.Fatalf("errors =\n%s", text)
	}
	// context shows what led up to each error.
	text, _ = call("read_context", map[string]any{"sessionId": failed.ID, "scope": "events", "levels": "error", "tail": 1, "context": 2})
	if !strings.Contains(text, "Response stream") || !strings.Contains(text, "Waiting for background tasks") || strings.Contains(text, "Subtask failed") {
		t.Fatalf("context =\n%s", text)
	}
	// A query pages forward with the cursor it prints.
	text, _ = call("read_context", map[string]any{"sessionId": failed.ID, "scope": "events", "query": "BASH 1", "limit": 5})
	if !strings.Contains(text, "111 of 306 events match") || strings.Count(text, "| Used tool |") != 5 || !strings.Contains(text, "Later matches: after=") {
		t.Fatalf("query page =\n%s", text)
	}
	cursor := text[strings.Index(text, "after=")+len("after=") : len(strings.TrimSpace(text))]
	next, _ := call("read_context", map[string]any{"sessionId": failed.ID, "scope": "events", "query": "bash 1", "limit": 5, "after": cursor})
	if !strings.Contains(next, "106 of 306 events match") || !strings.Contains(next, "Earlier matches: before=") {
		t.Fatalf("next page =\n%s", next)
	}
	// Lines are cut to a few hundred characters and the read to maxBytes.
	text, _ = call("read_context", map[string]any{"sessionId": failed.ID, "scope": "events", "labels": []string{"used tool"}, "tail": 100, "maxBytes": 3000})
	if len(text) > 3600 || !strings.Contains(text, "lines left out at maxBytes 3000") || !strings.Contains(text, "Earlier matches: before=") || !strings.Contains(text, "Bash 299 ") {
		t.Fatalf("budgeted tail (%d bytes) =\n%s", len(text), text)
	}
	if text, isError := call("read_context", map[string]any{"sessionId": failed.ID, "scope": "events", "after": "yesterday"}); !isError || !strings.Contains(text, "unknown cursor") {
		t.Fatalf("bad cursor = %q", text)
	}
}

func TestReadEventsCursorsAndFilters(t *testing.T) {
	base := time.Date(2026, 10, 9, 20, 0, 0, 0, time.UTC)
	events := []inspectEvent{}
	for index := 0; index < 10; index++ {
		at := base.Add(time.Duration(index) * time.Minute)
		level := "info"
		if index%3 == 0 {
			level = "error"
		}
		events = append(events, inspectEvent{
			id: fmt.Sprintf("e%d", index), at: at.Format(time.RFC3339Nano), when: at,
			level: level, label: fmt.Sprintf("Step %d", index), detail: "line\nbreak " + strings.Repeat("x", 400),
		})
	}
	read := func(query eventQuery) string {
		t.Helper()
		if query.limit == 0 {
			query.limit = inspectDefaultLimit
		}
		if query.maxBytes == 0 {
			query.maxBytes = inspectDefaultBytes
		}
		text, err := readEvents("sess_x", events, query)
		if err != nil {
			t.Fatal(err)
		}
		return text
	}
	text := read(eventQuery{levels: map[string]bool{"error": true}})
	if !strings.Contains(text, "4 of 10 events match") || strings.Count(text, "| error |") != 4 {
		t.Fatalf("levels =\n%s", text)
	}
	if !strings.Contains(text, "2026-10-09T20:00:00Z | error | Step 0 | line break xxx") || !strings.Contains(text, "…") {
		t.Fatalf("a line is one line, cut with a mark =\n%s", text)
	}
	// Times and ids both work as cursors; an id cursor excludes its event.
	text = read(eventQuery{after: "2026-10-09T20:02:30Z", before: "e6"})
	if !strings.Contains(text, "3 of 10 events match") || !strings.Contains(text, "Step 3") || !strings.Contains(text, "Step 5") || strings.Contains(text, "Step 6") {
		t.Fatalf("window =\n%s", text)
	}
	text = read(eventQuery{tail: 2, before: "e9"})
	if !strings.Contains(text, "Step 7") || !strings.Contains(text, "Step 8") || !strings.Contains(text, "Earlier matches: before=e7") || !strings.Contains(text, "Later matches: after=e8") {
		t.Fatalf("tail before =\n%s", text)
	}
	text = read(eventQuery{limit: 3})
	if !strings.Contains(text, "Later matches: after=e2") || strings.Contains(text, "Earlier matches") {
		t.Fatalf("first page =\n%s", text)
	}
}

// An agent reads a session by link in another workspace of its person, and
// only while that person reaches it.
func TestInspectionFollowsReach(t *testing.T) {
	f := newIsolationFixture(t)
	ctx := context.Background()
	db := f.server.store
	for _, register := range []struct{ device, workspace, agent string }{
		{"dev_alice", "ws_alice", "agent_alice"}, {"dev_bob", "ws_bob", "agent_bob"},
	} {
		if err := db.RegisterDaemon(ctx, store.DaemonRegistration{
			Device:    store.DeviceProjection{ID: register.device, Label: "Device", Status: "connected", LastSeenLabel: "online"},
			Workspace: store.WorkspaceProjection{ID: register.workspace, Name: "W", LocalPath: "/tmp/w"},
			Agents: []store.AgentProjection{{
				ID: register.agent, WorkspaceID: register.workspace, DeviceID: register.device, Provider: "claude", Status: "healthy",
				AuthMode: "local_config", SecretStored: "local", ConfigScope: "workspace", ConfigLabel: "local", LastSeenLabel: "online",
			}},
		}); err != nil {
			t.Fatal(err)
		}
	}
	bobSession, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{
		CreatedByUserID: f.bobID, WorkspaceID: "ws_bob", AgentID: "agent_bob", Provider: "claude", Prompt: "work",
	})
	if err != nil {
		t.Fatal(err)
	}
	token, err := db.MintAgentSessionToken(ctx, bobSession.ID)
	if err != nil {
		t.Fatal(err)
	}
	aliceSession := seedLongFailedSession(t, db, "ws_alice", "agent_alice")
	if err := db.SyncChats(ctx, store.SyncChatsInput{WorkspaceID: "ws_alice", Chats: []store.ChatThread{{
		ID: "native_claude_n1", WorkspaceID: "ws_alice", Provider: "claude", NativeSessionID: "n1", Title: "Terminal chat", Status: "completed",
		Transcript: []store.TranscriptMessage{
			{ID: "line-1", At: "2026-10-09T10:00:00Z", Kind: "user", Text: "Deploy it"},
			{ID: "line-2", At: "2026-10-09T10:00:05Z", Kind: "tool", Title: "Bash", Status: "failed", Text: "permission denied"},
			{ID: "line-3", At: "2026-10-09T10:00:09Z", Kind: "assistant", Text: "The deploy failed: permission denied."},
		},
	}}}); err != nil {
		t.Fatal(err)
	}
	call := mcpToolCaller(t, f.handler, token)
	link := "https://foundry.example/chats/" + aliceSession.ID + "?workspace=ws_alice"

	for _, read := range []struct {
		tool string
		args map[string]any
	}{
		{"get_session", map[string]any{"sessionId": link}},
		{"read_context", map[string]any{"sessionId": link, "scope": "events"}},
		{"read_context", map[string]any{"sessionId": "native_claude_n1", "scope": "events"}},
	} {
		if text, isError := call(read.tool, read.args); !isError || !strings.Contains(text, "no session or chat") {
			t.Fatalf("%s %v outside reach = %q, want not found", read.tool, read.args, text)
		}
	}
	expectStatus(t, doAuthCall(t, f.handler, f.as(f.alice, http.MethodPost, "/api/workspaces/ws_alice/members", `{"username":"bob","role":"viewer"}`)),
		http.StatusNoContent, "share with bob as viewer")
	text, isError := call("get_session", map[string]any{"sessionId": link})
	if isError || !strings.Contains(text, `"status": "failed"`) || !strings.Contains(text, `"id": "ws_alice"`) {
		t.Fatalf("get_session across workspaces = %s", text)
	}
	text, isError = call("read_context", map[string]any{"sessionId": link, "scope": "events", "levels": []string{"error"}, "tail": 1})
	if isError || !strings.Contains(text, "Session failed") {
		t.Fatalf("events across workspaces = %s", text)
	}
	text, isError = call("get_session", map[string]any{"sessionId": "native_claude_n1"})
	if isError || !strings.Contains(text, `"kind": "native_chat"`) || !strings.Contains(text, `"lastAnswer": "The deploy failed: permission denied."`) ||
		!strings.Contains(text, `"lastInput": "Deploy it"`) || !strings.Contains(text, `"errors": 1`) {
		t.Fatalf("native chat summary = %s", text)
	}
	text, isError = call("read_context", map[string]any{"sessionId": "native_claude_n1", "scope": "events", "levels": []string{"error"}})
	if isError || !strings.Contains(text, "2026-10-09T10:00:05Z | error | tool: Bash | permission denied") {
		t.Fatalf("native chat events = %s", text)
	}
}
