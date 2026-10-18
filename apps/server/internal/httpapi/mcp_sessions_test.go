package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"github.com/foundry-dev/foundry/apps/server/internal/testfixture"
)

// mcpToolNames lists the tools tools/list shows to a bearer token.
func mcpToolNames(t *testing.T, handler http.Handler, token string) []string {
	t.Helper()
	request := httptest.NewRequest(http.MethodPost, "/api/mcp", strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"tools/list"}`))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Authorization", "Bearer "+token)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	var envelope struct {
		Result struct {
			Tools []struct {
				Name string `json:"name"`
			} `json:"tools"`
		} `json:"result"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &envelope); err != nil {
		t.Fatalf("tools/list: %d %s", response.Code, response.Body.String())
	}
	names := []string{}
	for _, tool := range envelope.Result.Tools {
		names = append(names, tool.Name)
	}
	return names
}

func catalogToolNames(except ...string) []string {
	names := []string{}
	for _, tool := range remoteMCPTools {
		if !slices.Contains(except, tool.name) {
			names = append(names, tool.name)
		}
	}
	return names
}

// Every tool in the catalog has a handler, and every handler a catalog entry.
func TestEveryCatalogToolHasAHandler(t *testing.T) {
	handled := []string{}
	for name := range mcpToolHandlers {
		handled = append(handled, name)
	}
	catalog := catalogToolNames()
	slices.Sort(handled)
	slices.Sort(catalog)
	if !slices.Equal(handled, catalog) {
		t.Fatalf("handlers %v, catalog %v", handled, catalog)
	}
}

// A session sees exactly the tools its role may call, and a tool outside its
// list is refused when called anyway.
func TestToolsListFollowsTheSessionsRole(t *testing.T) {
	db, chat := lineageFixture(t)
	ctx := context.Background()
	handler := NewServer(db).Routes()
	mint := func(sessionID string) string {
		t.Helper()
		token, err := db.MintAgentSessionToken(ctx, sessionID)
		if err != nil {
			t.Fatal(err)
		}
		return token
	}

	chatToken := mint(chat.ID)
	if names := mcpToolNames(t, handler, chatToken); !slices.Equal(names, catalogToolNames(append(personalAgentToolNames(), "ask_person")...)) {
		t.Fatalf("a chat sees %v, want every tool but ask_person and the assistant's", names)
	}
	call := mcpToolCaller(t, handler, chatToken)
	if text, isError := call("ask_person", map[string]any{"question": "Deploy?"}); !isError || !strings.Contains(text, "only an Issue's execution can ask the person") {
		t.Fatalf("a chat calling ask_person = %q", text)
	}
	if text, isError := call("find_workspace", map[string]any{"query": "budget"}); !isError || !strings.Contains(text, "only available to the person's assistant") {
		t.Fatalf("a chat calling find_workspace = %q", text)
	}
	if text, isError := call("delete_everything", map[string]any{}); !isError || text != "unknown tool: delete_everything" {
		t.Fatalf("an unknown tool = %q", text)
	}

	discussed, err := db.CreateIssue(ctx, store.CreateIssueInput{WorkspaceID: "ws_lineage", SourceInput: "make the greeting friendlier", Runtime: "claude"})
	if err != nil {
		t.Fatal(err)
	}
	draft := firstDraft(t, db, discussed.ID)
	_, clarification, err := db.AskClarification(ctx, store.AskClarificationInput{IssueID: discussed.ID, Revision: draft.Revision, ContentDigest: draft.ContentDigest,
		Message: "Which file holds the greeting?", ChangeReason: "Clarify the target"}, store.ActorRef{Kind: "local_owner", ID: "owner", DisplayName: "Owner"}, "clarify-1")
	if err != nil {
		t.Fatal(err)
	}
	if clarification.Role != store.AgentSessionRoleIssueClarification {
		t.Fatalf("clarification role = %q", clarification.Role)
	}
	clarifyToken := mint(clarification.ID)
	if names := mcpToolNames(t, handler, clarifyToken); !slices.Equal(names, []string{"list_sessions", "read_context"}) {
		t.Fatalf("a clarification sees %v, want list_sessions and read_context, as the worker grants it", names)
	}
	call = mcpToolCaller(t, handler, clarifyToken)
	if text, isError := call("get_session", map[string]any{"sessionId": chat.ID}); !isError || !strings.Contains(text, "get_session is not available to an Issue's clarification") {
		t.Fatalf("a clarification calling get_session = %q", text)
	}
	if text, isError := call("read_context", map[string]any{"sessionId": chat.ID}); isError || !strings.Contains(text, `"id": "`+chat.ID+`"`) {
		t.Fatalf("a clarification reading a session = %q", text)
	}

	executed, err := db.CreateIssue(ctx, store.CreateIssueInput{WorkspaceID: "ws_lineage", Title: "deploy", Runtime: "claude"})
	if err != nil {
		t.Fatal(err)
	}
	testfixture.ConfirmContract(t, db, executed.ID)
	_, execution, err := db.ClaimIssueExecution(ctx, "dev_lineage", "ws_lineage")
	if err != nil {
		t.Fatal(err)
	}
	if names := mcpToolNames(t, handler, mint(execution.ID)); !slices.Equal(names, catalogToolNames(personalAgentToolNames()...)) {
		t.Fatalf("an Issue's execution sees %v, want every tool but the assistant's", names)
	}
}

// list_sessions reads one cheap page at a time, filtered in SQL before the
// limit, and list_group_sessions lists a group in the same form.
func TestListSessionsPagesSlimSummaries(t *testing.T) {
	db, parent := lineageFixture(t)
	ctx := context.Background()
	handler := NewServer(db).Routes()
	token, err := db.MintAgentSessionToken(ctx, parent.ID)
	if err != nil {
		t.Fatal(err)
	}
	create := func(prompt, source, parentID string) store.AgentSession {
		t.Helper()
		session, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{
			WorkspaceID: "ws_lineage", AgentID: "agent_lineage", Provider: "claude",
			Prompt: prompt, Source: source, ParentSessionID: parentID,
		})
		if err != nil {
			t.Fatal(err)
		}
		return session
	}
	// The children are the oldest sessions: a filter applied after a page
	// was cut would miss them.
	first := create(strings.Repeat("Long brief. ", 400), "agent", parent.ID)
	second := create("Second child", "agent", parent.ID)
	others := []store.AgentSession{}
	for _, prompt := range []string{"a", "b", "c", "d", "e"} {
		others = append(others, create("Unrelated "+prompt, "chat", ""))
	}
	create("Name this chat", "naming", "")
	if _, err := db.RenameChat(ctx, second.ID, store.RenameChatInput{WorkspaceID: "ws_lineage", Title: "Renamed child"}); err != nil {
		t.Fatal(err)
	}
	call := mcpToolCaller(t, handler, token)
	type listed struct {
		Sessions   []map[string]any `json:"sessions"`
		NextCursor string           `json:"nextCursor"`
	}
	list := func(arguments map[string]any) (listed, string) {
		t.Helper()
		text, isError := call("list_sessions", arguments)
		var page listed
		if isError || json.Unmarshal([]byte(text), &page) != nil {
			t.Fatalf("list_sessions %v = %s", arguments, text)
		}
		return page, text
	}

	page, text := list(map[string]any{"parentOnly": true, "limit": 1})
	if len(page.Sessions) != 1 || page.Sessions[0]["id"] != second.ID || page.NextCursor == "" {
		t.Fatalf("first page of children = %s", text)
	}
	if page.Sessions[0]["title"] != "Renamed child" {
		t.Fatalf("a list shows the title the person sees: %s", text)
	}
	page, text = list(map[string]any{"parentOnly": true, "limit": 1, "cursor": page.NextCursor})
	if len(page.Sessions) != 1 || page.Sessions[0]["id"] != first.ID || page.NextCursor != "" {
		t.Fatalf("last page of children = %s", text)
	}
	// One line per session, without prompts, inputs or events.
	if len(text) > 600 || strings.Contains(text, `"prompt"`) || strings.Contains(text, `"input"`) || strings.Count(text, "\n") != 4 {
		t.Fatalf("a list item carries more than a summary:\n%s", text)
	}
	allowed := map[string]bool{"id": true, "title": true, "status": true, "runtime": true, "profile": true, "profileId": true, "device": true, "deviceId": true,
		"workspaceId": true, "parentSessionId": true, "issueId": true, "role": true, "source": true, "activityAt": true}
	item := page.Sessions[0]
	for key := range item {
		if !allowed[key] {
			t.Fatalf("unexpected list field %q in %v", key, item)
		}
	}
	if item["parentSessionId"] != parent.ID || item["source"] != "agent" || item["device"] != "Studio" || item["deviceId"] != "dev_lineage" ||
		item["workspaceId"] != "ws_lineage" || item["runtime"] != "claude" || item["status"] != "queued" || item["activityAt"] == "" {
		t.Fatalf("list item = %v", item)
	}

	seen := []string{}
	cursor := ""
	for pages := 0; pages < 10; pages++ {
		arguments := map[string]any{"limit": 3}
		if cursor != "" {
			arguments["cursor"] = cursor
		}
		page, _ = list(arguments)
		for _, session := range page.Sessions {
			seen = append(seen, session["id"].(string))
		}
		if cursor = page.NextCursor; cursor == "" {
			break
		}
	}
	want := []string{others[4].ID, others[3].ID, others[2].ID, others[1].ID, others[0].ID, second.ID, first.ID, parent.ID}
	if !slices.Equal(seen, want) {
		t.Fatalf("paging read %v, want every session but the naming one, newest first: %v", seen, want)
	}
	if text, isError := call("list_sessions", map[string]any{"cursor": "not-a-cursor"}); !isError || !strings.Contains(text, "unknown cursor") {
		t.Fatalf("a bad cursor = %q", text)
	}

	summary, _ := call("read_context", map[string]any{"sessionId": first.ID})
	var digest sessionDigest
	if err := json.Unmarshal([]byte(summary), &digest); err != nil || digest.Group == nil {
		t.Fatalf("the summary names no group: %s", summary)
	}
	text, isError := call("list_group_sessions", map[string]any{"groupId": digest.Group.ID})
	var group struct {
		Group    store.ChatLayoutGroup `json:"group"`
		Sessions []map[string]any      `json:"sessions"`
	}
	if isError || json.Unmarshal([]byte(text), &group) != nil {
		t.Fatalf("list_group_sessions = %s", text)
	}
	ids := []string{}
	for _, session := range group.Sessions {
		ids = append(ids, session["id"].(string))
	}
	if group.Group.ID != digest.Group.ID || group.Group.Name == "" || !slices.Equal(ids, []string{parent.ID, second.ID, first.ID}) || len(text) > 1500 {
		t.Fatalf("group = %s", text)
	}
	if text, isError := call("list_group_sessions", map[string]any{"groupId": "grp_missing"}); !isError || !strings.Contains(text, "no group grp_missing") {
		t.Fatalf("a missing group = %q", text)
	}
}

// The tools that act on a session answer an unreachable one exactly like a
// missing one, and a readable one they may not control with the reason.
func TestSessionToolsDoNotDiscloseUnreachableSessions(t *testing.T) {
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
	aliceSession, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{
		CreatedByUserID: f.aliceID, WorkspaceID: "ws_alice", AgentID: "agent_alice", Provider: "claude", Prompt: "alice's work",
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.CompleteAgentSession(ctx, aliceSession.ID, "done", ""); err != nil {
		t.Fatal(err)
	}
	call := mcpToolCaller(t, f.handler, token)
	actions := []struct {
		tool string
		args map[string]any
	}{
		{"send_message", map[string]any{"prompt": "hi"}},
		{"cancel_session", map[string]any{}},
		{"rename_session", map[string]any{"title": "Mine now"}},
		{"wait_session", map[string]any{"timeoutMs": 1000}},
		{"handoff_session", map[string]any{"prompt": "continue"}},
	}
	for _, id := range []string{aliceSession.ID, "sess_missing"} {
		for _, action := range actions {
			args := map[string]any{"sessionId": "https://foundry.example/chats/" + id + "?workspace=ws_alice"}
			for key, value := range action.args {
				args[key] = value
			}
			text, isError := call(action.tool, args)
			if !isError || text != "no session or chat "+id+" that you can read (ids look like sess_…, native_claude_…, native_codex_…)" {
				t.Fatalf("%s on %s = %q, want the not-found answer", action.tool, id, text)
			}
		}
	}

	expectStatus(t, doAuthCall(t, f.handler, f.as(f.alice, http.MethodPost, "/api/workspaces/ws_alice/members", `{"username":"bob","role":"viewer"}`)),
		http.StatusNoContent, "share with bob as viewer")
	if text, isError := call("send_message", map[string]any{"sessionId": aliceSession.ID, "prompt": "hi"}); !isError ||
		text != "cannot message "+aliceSession.ID+": you reach its workspace as Viewer, and controlling a session needs Member" {
		t.Fatalf("send_message to a session it only reads = %q", text)
	}
	if text, isError := call("wait_session", map[string]any{"sessionId": aliceSession.ID, "timeoutMs": 1000}); isError || !strings.Contains(text, `"status": "completed"`) {
		t.Fatalf("waiting on a readable session = %q", text)
	}
	// A handoff takes its source's work over: an agent hands off only a
	// session it controls, wherever the replacement would start.
	for _, workspace := range []string{"", "ws_bob"} {
		if text, isError := call("handoff_session", map[string]any{"sessionId": aliceSession.ID, "prompt": "continue", "workspaceId": workspace}); !isError ||
			text != "cannot hand off "+aliceSession.ID+": you reach its workspace as Viewer, and controlling a session needs Member" {
			t.Fatalf("a handoff of a session it only reads (into %q) = %q", workspace, text)
		}
	}
}

// Arguments renamed for one vocabulary keep their old names, and create
// no longer passes an undocumented native session id through.
func TestRenamedToolArgumentsKeepTheirOldNames(t *testing.T) {
	db, parent := lineageFixture(t)
	ctx := context.Background()
	token, err := db.MintAgentSessionToken(ctx, parent.ID)
	if err != nil {
		t.Fatal(err)
	}
	child, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{
		WorkspaceID: "ws_lineage", AgentID: "agent_lineage", Provider: "claude", Prompt: "child", Source: "agent", ParentSessionID: parent.ID,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.CompleteAgentSession(ctx, child.ID, "done", ""); err != nil {
		t.Fatal(err)
	}
	call := mcpToolCaller(t, NewServer(db).Routes(), token)
	for _, arguments := range []map[string]any{
		{"sessionId": child.ID, "prompt": "Continue."},
		{"fromSessionId": child.ID, "prompt": "Continue."},
	} {
		if text, isError := call("handoff_session", arguments); isError || !strings.Contains(text, `"status": "queued"`) {
			t.Fatalf("handoff_session %v = %q, want it to wait for the offline device", arguments, text)
		}
	}
	for _, arguments := range []map[string]any{
		{"sessionId": child.ID, "prompt": "Again."},
		{"sessionId": child.ID, "message": "Again."},
	} {
		if text, isError := call("send_message", arguments); isError || !strings.Contains(text, "waitingForDevice") {
			t.Fatalf("send_message %v = %q, want it to wait for the offline device", arguments, text)
		}
		// More for a session already waiting is refused, saying why.
		if text, isError := call("send_message", arguments); !isError || !strings.Contains(text, "already waits for its offline device") {
			t.Fatalf("send_message %v again = %q, want it refused", arguments, text)
		}
		if _, err := db.CancelAgentSession(ctx, child.ID, "test"); err != nil {
			t.Fatal(err)
		}
	}
	if text, isError := call("send_message", map[string]any{"sessionId": child.ID}); !isError || text == "local daemon is not connected" {
		t.Fatalf("send_message without a message = %q, want it refused", text)
	}
	if text, isError := call("create_session", map[string]any{"prompt": "resume", "nativeSessionId": "native-1"}); !isError || !strings.Contains(text, "nativeSessionId is not accepted") {
		t.Fatalf("create_session with nativeSessionId = %q", text)
	}
}

// parentSessionId lists the sessions one session started, in its workspace.
func TestListSessionsByParent(t *testing.T) {
	db, parent := lineageFixture(t)
	ctx := context.Background()
	handler := NewServer(db).Routes()
	child, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{
		WorkspaceID: "ws_lineage", AgentID: "agent_lineage", Provider: "claude",
		Prompt: "child", Source: "agent", ParentSessionID: parent.ID,
	})
	if err != nil {
		t.Fatal(err)
	}
	other, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{
		WorkspaceID: "ws_lineage", AgentID: "agent_lineage", Provider: "claude", Prompt: "unrelated", Source: "chat",
	})
	if err != nil {
		t.Fatal(err)
	}
	token, err := db.MintAgentSessionToken(ctx, other.ID)
	if err != nil {
		t.Fatal(err)
	}
	call := mcpToolCaller(t, handler, token)
	text, isError := call("list_sessions", map[string]any{"parentSessionId": parent.ID})
	if isError || !strings.Contains(text, child.ID) || strings.Contains(text, `"id":"`+other.ID) || strings.Contains(text, `"id":"`+parent.ID) {
		t.Fatalf("children of %s = %s", parent.ID, text)
	}
	if text, isError := call("list_sessions", map[string]any{"parentSessionId": "sess_missing"}); !isError || !strings.Contains(text, "no session or chat sess_missing") {
		t.Fatalf("children of a missing session = %q", text)
	}
}
