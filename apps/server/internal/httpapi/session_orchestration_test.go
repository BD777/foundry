package httpapi

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func lineageFixture(t *testing.T) (store.Store, store.AgentSession) {
	t.Helper()
	db := newTestStore(t)
	ctx := context.Background()
	if err := db.RegisterDaemon(ctx, store.DaemonRegistration{
		Device:    store.DeviceProjection{ID: "dev_lineage", Label: "Studio", Status: "connected", LastSeenLabel: "online"},
		Workspace: store.WorkspaceProjection{ID: "ws_lineage", Name: "Foundry", LocalPath: t.TempDir()},
		Agents: []store.AgentProjection{{
			ID: "agent_lineage", WorkspaceID: "ws_lineage", DeviceID: "dev_lineage",
			Provider: "claude", Status: "healthy", AuthMode: "local_config",
			SecretStored: "local", ConfigScope: "workspace", ConfigLabel: "local", LastSeenLabel: "online",
		}},
	}); err != nil {
		t.Fatalf("register daemon: %v", err)
	}
	parent, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{
		WorkspaceID: "ws_lineage", AgentID: "agent_lineage", Provider: "claude",
		Prompt: "parent task", Source: "chat",
	})
	if err != nil {
		t.Fatalf("create parent: %v", err)
	}
	return db, parent
}

// CHAT-01 scenario: an ungrouped parent gets a freshly created group holding
// parent first, child second; further children join the same group.
func TestLineageAutoGroupsUngroupedParent(t *testing.T) {
	db, parent := lineageFixture(t)
	ctx := context.Background()

	child, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{
		WorkspaceID: "ws_lineage", AgentID: "agent_lineage", Provider: "claude",
		Prompt: "child task", Source: "agent", ParentSessionID: parent.ID,
	})
	if err != nil {
		t.Fatalf("create child: %v", err)
	}
	if child.ParentSessionID != parent.ID || child.Source != "agent" {
		t.Fatalf("child lineage = %q source = %q", child.ParentSessionID, child.Source)
	}
	layout, err := db.GetChatLayout(ctx, "ws_lineage")
	if err != nil {
		t.Fatal(err)
	}
	if len(layout.Groups) != 1 || len(layout.Positions) != 2 {
		t.Fatalf("layout = %+v, want one group with two positions", layout)
	}
	groupID := layout.Groups[0].ID
	want := []string{parent.ID, child.ID}
	got := []string{layout.Positions[0].ChatID, layout.Positions[1].ChatID}
	if got[0] != want[0] || got[1] != want[1] ||
		layout.Positions[0].GroupID != groupID || layout.Positions[1].GroupID != groupID {
		t.Fatalf("positions = %+v, want parent then child in %s", got, groupID)
	}

	grandchild, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{
		WorkspaceID: "ws_lineage", AgentID: "agent_lineage", Provider: "claude",
		Prompt: "grandchild task", Source: "agent", ParentSessionID: child.ID,
	})
	if err != nil {
		t.Fatalf("create grandchild: %v", err)
	}
	layout, _ = db.GetChatLayout(ctx, "ws_lineage")
	if len(layout.Groups) != 1 || len(layout.Positions) != 3 {
		t.Fatalf("layout after grandchild = %+v", layout)
	}
	last := layout.Positions[len(layout.Positions)-1]
	if last.ChatID != grandchild.ID || last.GroupID != groupID {
		t.Fatalf("grandchild placement = %+v", last)
	}
}

// CHAT-01 scenario: a grouped parent keeps children inside its existing group.
func TestLineageInheritsExistingGroup(t *testing.T) {
	db, parent := lineageFixture(t)
	ctx := context.Background()
	layout, err := db.GetChatLayout(ctx, "ws_lineage")
	if err != nil {
		t.Fatal(err)
	}
	layout.Groups = []store.ChatLayoutGroup{{ID: "g_existing", Name: "专项工作"}}
	layout.Positions = []store.ChatPlacement{{ChatID: parent.ID, GroupID: "g_existing"}}
	if _, err := db.SaveChatLayout(ctx, store.SaveChatLayoutInput{
		WorkspaceID: "ws_lineage", ExpectedRevision: &layout.Revision, Layout: layout,
	}); err != nil {
		t.Fatalf("seed layout: %v", err)
	}

	child, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{
		WorkspaceID: "ws_lineage", AgentID: "agent_lineage", Provider: "claude",
		Prompt: "child task", Source: "agent", ParentSessionID: parent.ID,
	})
	if err != nil {
		t.Fatalf("create child: %v", err)
	}
	layout, _ = db.GetChatLayout(ctx, "ws_lineage")
	if len(layout.Groups) != 1 || layout.Groups[0].ID != "g_existing" {
		t.Fatalf("groups = %+v, want the existing group only", layout.Groups)
	}
	var groupIDs []string
	for _, position := range layout.Positions {
		if position.ChatID == child.ID {
			groupIDs = append(groupIDs, position.GroupID)
		}
	}
	if len(groupIDs) != 1 || groupIDs[0] != "g_existing" {
		t.Fatalf("child groups = %v, want g_existing", groupIDs)
	}
}

func TestLineageForeignParent(t *testing.T) {
	db, parent := lineageFixture(t)
	ctx := context.Background()
	if err := db.RegisterDaemon(ctx, store.DaemonRegistration{
		Device:    store.DeviceProjection{ID: "dev_other", Label: "Laptop", Status: "connected", LastSeenLabel: "online"},
		Workspace: store.WorkspaceProjection{ID: "ws_other", Name: "Other", LocalPath: t.TempDir()},
		Agents: []store.AgentProjection{{
			ID: "agent_other", WorkspaceID: "ws_other", DeviceID: "dev_other",
			Provider: "claude", Status: "healthy", AuthMode: "local_config",
			SecretStored: "local", ConfigScope: "workspace", ConfigLabel: "local", LastSeenLabel: "online",
		}},
	}); err != nil {
		t.Fatalf("register second workspace: %v", err)
	}
	_, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{
		WorkspaceID: "ws_other", AgentID: "agent_other", Provider: "claude",
		Prompt: "cross workspace", Source: "chat", ParentSessionID: parent.ID,
	})
	if err != store.ErrSessionParentMismatch {
		t.Fatalf("foreign parent error = %v, want ErrSessionParentMismatch", err)
	}
	// An agent may start work in another workspace; the child keeps its
	// lineage but stays out of the parent's chat layout.
	child, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{
		WorkspaceID: "ws_other", AgentID: "agent_other", Provider: "claude",
		Prompt: "cross workspace", Source: "agent", ParentSessionID: parent.ID,
	})
	if err != nil {
		t.Fatalf("cross-workspace agent child: %v", err)
	}
	if child.ParentSessionID != parent.ID || child.WorkspaceID != "ws_other" || child.CreatedGroupID != "" {
		t.Fatalf("cross-workspace child = parent %q workspace %q group %q", child.ParentSessionID, child.WorkspaceID, child.CreatedGroupID)
	}
	if count, err := db.CountActiveAgentChildren(ctx, parent.ID); err != nil || count != 1 {
		t.Fatalf("active children = %d, %v; want the cross-workspace child counted", count, err)
	}
	_, err = db.CreateAgentSession(ctx, store.CreateAgentSessionInput{
		WorkspaceID: "ws_lineage", AgentID: "agent_lineage", Provider: "claude",
		Prompt: "missing parent", Source: "agent", ParentSessionID: "sess_does_not_exist",
	})
	if err != store.ErrSessionParentNotFound {
		t.Fatalf("missing parent error = %v, want ErrSessionParentNotFound", err)
	}
}

func TestSessionTokenMintResolveRevoke(t *testing.T) {
	db, parent := lineageFixture(t)
	ctx := context.Background()

	token, err := db.MintAgentSessionToken(ctx, parent.ID)
	if err != nil || len(token) < 40 {
		t.Fatalf("mint token = %q, %v", token, err)
	}
	identity, err := db.ResolveSessionToken(ctx, token)
	if err != nil {
		t.Fatalf("resolve token: %v", err)
	}
	if identity.SessionID != parent.ID || identity.WorkspaceID != "ws_lineage" || identity.DeviceID != "dev_lineage" {
		t.Fatalf("identity = %+v", identity)
	}
	if _, err := db.ResolveSessionToken(ctx, token+"deadbeef"); err == nil {
		t.Fatal("bad token resolved")
	}

	// Each dispatch mints another token; a long-lived agent process may still
	// hold an earlier one, so earlier tokens stay valid, including after the
	// session settles: it can be continued.
	replacement, err := db.MintAgentSessionToken(ctx, parent.ID)
	if err != nil || replacement == token {
		t.Fatalf("second mint failed: %v", err)
	}
	if _, err := db.CancelAgentSession(ctx, parent.ID, "test cancel"); err != nil {
		t.Fatalf("cancel: %v", err)
	}
	for _, held := range []string{token, replacement} {
		if identity, err := db.ResolveSessionToken(ctx, held); err != nil || identity.SessionID != parent.ID {
			t.Fatalf("a settled session's token = %+v, %v; want it still valid", identity, err)
		}
	}

	// Deleting the session revokes every token it was given.
	layout, err := db.GetChatLayout(ctx, "ws_lineage")
	if err != nil {
		t.Fatal(err)
	}
	layout.Groups = append(layout.Groups, store.ChatLayoutGroup{ID: "doomed", Name: "Doomed"})
	layout.Positions = append(layout.Positions, store.ChatPlacement{ChatID: parent.ID, GroupID: "doomed"})
	if layout, err = db.SaveChatLayout(ctx, store.SaveChatLayoutInput{WorkspaceID: "ws_lineage", ExpectedRevision: &layout.Revision, Layout: layout}); err != nil {
		t.Fatal(err)
	}
	if _, err := db.DeleteChatGroup(ctx, store.DeleteChatGroupInput{WorkspaceID: "ws_lineage", GroupID: "doomed", ExpectedRevision: &layout.Revision}); err != nil {
		t.Fatalf("delete session: %v", err)
	}
	for _, held := range []string{token, replacement} {
		if _, err := db.ResolveSessionToken(ctx, held); err == nil {
			t.Fatal("a deleted session's token still resolves")
		}
	}
}

// End-to-end authorization over the real HTTP server: a dispatched session
// token is workspace-scoped, lineage-bound for control verbs, and rejected when
// invalid.
func TestSessionTokenHTTPPolicy(t *testing.T) {
	backing := newSecretTestStore(t)
	server := NewServer(backing)
	testServer := httptest.NewServer(server.Routes())
	defer testServer.Close()

	wsURL := "ws" + strings.TrimPrefix(testServer.URL, "http") + "/api/daemon/ws"
	conn, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("dial daemon websocket: %v", err)
	}
	defer conn.Close()
	writeWSForTest(t, conn, "hello", map[string]any{
		"device":    map[string]any{"id": "dev_http", "label": "Studio", "status": "connected", "lastSeenLabel": "online"},
		"workspace": map[string]any{"id": "ws_http", "name": "Foundry", "localPath": t.TempDir(), "baseline": "main", "contextSummary": "", "acceptedCount": 0, "resolvedCount": 0},
		"agents": []map[string]any{{
			"id": "agent_http", "workspaceId": "ws_http", "deviceId": "dev_http",
			"provider": "claude", "status": "healthy", "authMode": "local_config",
			"secretStored": "local", "configScope": "workspace", "configLabel": "local", "lastSeenLabel": "online",
		}},
		"providerHealth": []map[string]any{},
		"assets":         []map[string]any{},
	})
	readWSTypeForTest(t, conn, "registered")

	create := func(body, bearer string) (int, store.AgentSession) {
		request, _ := http.NewRequest(http.MethodPost, testServer.URL+"/api/agent-sessions", strings.NewReader(body))
		request.Header.Set("Content-Type", "application/json")
		if bearer != "" {
			request.Header.Set("Authorization", "Bearer "+bearer)
		}
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			t.Fatalf("post session: %v", err)
		}
		defer response.Body.Close()
		raw, _ := io.ReadAll(response.Body)
		var session store.AgentSession
		_ = json.Unmarshal(raw, &session)
		return response.StatusCode, session
	}

	readDispatchedToken := func() string {
		var envelope struct {
			Type    string `json:"type"`
			Payload struct {
				SessionToken string `json:"sessionToken"`
			} `json:"payload"`
		}
		_ = conn.SetReadDeadline(time.Now().Add(3 * time.Second))
		if err := conn.ReadJSON(&envelope); err != nil {
			t.Fatalf("read dispatch: %v", err)
		}
		if envelope.Type != "run_session" {
			t.Fatalf("dispatch type = %q", envelope.Type)
		}
		if envelope.Payload.SessionToken == "" {
			t.Fatal("dispatch carried no session token")
		}
		return envelope.Payload.SessionToken
	}

	doRequest := func(method, path, bearer string) int {
		request, _ := http.NewRequest(method, testServer.URL+path, nil)
		if bearer != "" {
			request.Header.Set("Authorization", "Bearer "+bearer)
		}
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			t.Fatalf("%s %s: %v", method, path, err)
		}
		_ = response.Body.Close()
		return response.StatusCode
	}

	parentBody := `{"agentId":"agent_http","workspaceId":"ws_http","provider":"claude","prompt":"parent","source":"chat"}`
	status, parent := create(parentBody, "")
	if status != http.StatusCreated {
		t.Fatalf("parent create status = %d", status)
	}
	parentToken := readDispatchedToken()

	// Bad credentials are a hard 401, never anonymous fallback.
	if status := doRequest(http.MethodGet, "/api/agent-sessions?workspaceId=ws_http", "not-a-real-token"); status != http.StatusUnauthorized {
		t.Fatalf("bad token status = %d, want 401", status)
	}

	// Workspace scoping: the token cannot read a workspace outside its scope,
	// and, as for people, cannot learn whether it exists.
	if status := doRequest(http.MethodGet, "/api/agent-sessions?workspaceId=ws_elsewhere", parentToken); status != http.StatusNotFound {
		t.Fatalf("cross-workspace list status = %d, want 404", status)
	}
	if status := doRequest(http.MethodGet, "/api/agent-sessions?workspaceId=ws_http", parentToken); status != http.StatusOK {
		t.Fatalf("same-workspace list status = %d", status)
	}
	// Endpoint surface: a session token cannot touch the profile admin API.
	if status := doRequest(http.MethodGet, "/api/profiles", parentToken); status != http.StatusForbidden {
		t.Fatalf("profile admin status = %d, want 403", status)
	}
	// Profiles are visible, device-scoped.
	if status := doRequest(http.MethodGet, "/api/agent-profiles", parentToken); status != http.StatusOK {
		t.Fatalf("agent profiles status = %d", status)
	}

	// A workspace outside the token's scope is not found; none means its own.
	if status, _ := create(`{"agentId":"agent_http","workspaceId":"ws_whatever","provider":"claude","prompt":"child"}`, parentToken); status != http.StatusNotFound {
		t.Fatalf("child create in an unreachable workspace = %d, want 404", status)
	}
	// The token creates a child: lineage and source are server-assigned.
	status, child := create(`{"agentId":"agent_http","provider":"claude","prompt":"child","source":"chat"}`, parentToken)
	if status != http.StatusCreated {
		t.Fatalf("child create status = %d", status)
	}
	if child.ParentSessionID != parent.ID || child.WorkspaceID != "ws_http" || child.Source != "agent" {
		t.Fatalf("child lineage = %+v", child)
	}
	childToken := readDispatchedToken()

	// Any session of the workspace is readable by any session token in it.
	if status := doRequest(http.MethodGet, "/api/agent-sessions/"+child.ID, parentToken); status != http.StatusOK {
		t.Fatalf("child read status = %d, want 200", status)
	}
	if status := doRequest(http.MethodGet, "/api/agent-sessions/"+parent.ID, childToken); status != http.StatusOK {
		t.Fatalf("child reading parent (same group) status = %d, want 200", status)
	}
}

// CHAT-01 orphan rule: cancelling a parent never cancels its child.
func TestCancelParentDoesNotCascade(t *testing.T) {
	db, parent := lineageFixture(t)
	ctx := context.Background()
	child, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{
		WorkspaceID: "ws_lineage", AgentID: "agent_lineage", Provider: "claude",
		Prompt: "child", Source: "agent", ParentSessionID: parent.ID,
	})
	if err != nil {
		t.Fatalf("create child: %v", err)
	}
	if _, err := db.CancelAgentSession(ctx, parent.ID, "Canceled by user"); err != nil {
		t.Fatalf("cancel parent: %v", err)
	}
	loaded, err := db.GetAgentSessionSummary(ctx, child.ID)
	if err != nil {
		t.Fatalf("load child: %v", err)
	}
	if loaded.Status != "queued" {
		t.Fatalf("child status = %q, want queued (orphans keep running)", loaded.Status)
	}
}

// P1 guardrails: fan-out and spawn-depth are enforced in the create
// transaction.
func TestLineageGuardrails(t *testing.T) {
	db, parent := lineageFixture(t)
	ctx := context.Background()
	for i := 0; i < 8; i++ {
		if _, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{
			WorkspaceID: "ws_lineage", AgentID: "agent_lineage", Provider: "claude",
			Prompt: "fan", Source: "agent", ParentSessionID: parent.ID,
		}); err != nil {
			t.Fatalf("child %d: %v", i, err)
		}
	}
	_, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{
		WorkspaceID: "ws_lineage", AgentID: "agent_lineage", Provider: "claude",
		Prompt: "over fanout", Source: "agent", ParentSessionID: parent.ID,
	})
	if err != store.ErrAgentFanOutLimit {
		t.Fatalf("fan-out error = %v, want ErrAgentFanOutLimit", err)
	}
	// Completing one child frees a slot.
	children, _ := db.ListAgentSessionChildren(ctx, "ws_lineage", parent.ID)
	if _, err := db.CompleteAgentSession(ctx, children[0].ID, "done", ""); err != nil {
		t.Fatal(err)
	}
	if _, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{
		WorkspaceID: "ws_lineage", AgentID: "agent_lineage", Provider: "claude",
		Prompt: "freed slot", Source: "agent", ParentSessionID: parent.ID,
	}); err != nil {
		t.Fatalf("create after slot freed: %v", err)
	}

	// Depth chain: parent(0) -> child(1) -> ... with limit depth 4. Fan-out
	// slots are all occupied above, so terminate every direct child first;
	// depth counts ancestors, not siblings.
	for _, child := range children {
		if _, err := db.CancelAgentSession(ctx, child.ID, "test cleanup"); err != nil {
			t.Fatal(err)
		}
	}
	chain, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{
		WorkspaceID: "ws_lineage", AgentID: "agent_lineage", Provider: "claude",
		Prompt: "d1", Source: "agent", ParentSessionID: parent.ID,
	})
	if err != nil {
		t.Fatal(err)
	}
	depth2, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{
		WorkspaceID: "ws_lineage", AgentID: "agent_lineage", Provider: "claude",
		Prompt: "d2", Source: "agent", ParentSessionID: chain.ID,
	})
	if err != nil {
		t.Fatal(err)
	}
	depth3, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{
		WorkspaceID: "ws_lineage", AgentID: "agent_lineage", Provider: "claude",
		Prompt: "d3", Source: "agent", ParentSessionID: depth2.ID,
	})
	if err != nil {
		t.Fatal(err)
	}
	depth4, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{
		WorkspaceID: "ws_lineage", AgentID: "agent_lineage", Provider: "claude",
		Prompt: "d4", Source: "agent", ParentSessionID: depth3.ID,
	})
	if err != nil {
		t.Fatalf("depth 4 child: %v", err)
	}
	_ = depth4
	_, err = db.CreateAgentSession(ctx, store.CreateAgentSessionInput{
		WorkspaceID: "ws_lineage", AgentID: "agent_lineage", Provider: "claude",
		Prompt: "too deep", Source: "agent", ParentSessionID: depth4.ID,
	})
	if err != store.ErrAgentLineageTooDeep {
		t.Fatalf("depth error = %v, want ErrAgentLineageTooDeep", err)
	}
}

// blocked is an active status: steer/cancel stay valid, resume clears it.
func TestBlockedResumeLifecycle(t *testing.T) {
	db, parent := lineageFixture(t)
	ctx := context.Background()
	if _, err := db.StartAgentSession(ctx, parent.ID); err != nil {
		t.Fatal(err)
	}
	blocked, err := db.BlockAgentSession(ctx, parent.ID, "模型限流，等待重试")
	if err != nil {
		t.Fatal(err)
	}
	if blocked.Status != "blocked" || blocked.BlockedReason == "" {
		t.Fatalf("blocked session = %+v", blocked)
	}
	if loaded, err := db.GetAgentSessionSummary(ctx, parent.ID); err != nil || loaded.Status != "blocked" {
		t.Fatalf("persisted blocked = %+v, %v", loaded, err)
	}
	resumed, err := db.ResumeAgentSession(ctx, parent.ID)
	if err != nil || resumed.Status != "running" || resumed.BlockedReason != "" {
		t.Fatalf("resumed = %+v, %v", resumed, err)
	}
}

// Inside one workspace any agent may read and control any session, whoever
// created it; lineage grants nothing and other workspaces stay closed.
func TestAgentsControlAnySessionOfTheirWorkspace(t *testing.T) {
	db, parent := lineageFixture(t)
	ctx := context.Background()
	stranger, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{
		WorkspaceID: "ws_lineage", AgentID: "agent_lineage", Provider: "claude",
		Prompt: "started by a person, not by the parent", Source: "chat",
	})
	if err != nil {
		t.Fatal(err)
	}
	server := NewServer(db)
	agent := Actor{Kind: ActorAgent, Identity: store.SessionTokenIdentity{SessionID: parent.ID, WorkspaceID: "ws_lineage", DeviceID: "dev_lineage"}}
	if !server.canReadSession(ctx, agent, stranger) || !server.canControlSession(ctx, agent, stranger) {
		t.Fatal("an agent must read and control an unrelated session of its workspace")
	}
	elsewhere := stranger
	elsewhere.WorkspaceID = "ws_other"
	if server.canReadSession(ctx, agent, elsewhere) || server.canControlSession(ctx, agent, elsewhere) {
		t.Fatal("an agent must not reach sessions of another workspace")
	}
}

// Remote MCP over HTTP: initialize/tools/list and a session-token
// list_sessions call that respects workspace scoping.
func TestRemoteMCP(t *testing.T) {
	db, parent := lineageFixture(t)
	token, err := db.MintAgentSessionToken(context.Background(), parent.ID)
	if err != nil {
		t.Fatal(err)
	}
	server := NewServer(db)
	post := func(body, bearer string) map[string]any {
		request := httptest.NewRequest(http.MethodPost, "/api/mcp", strings.NewReader(body))
		request.Header.Set("Content-Type", "application/json")
		if bearer != "" {
			request.Header.Set("Authorization", "Bearer "+bearer)
		}
		response := httptest.NewRecorder()
		server.Routes().ServeHTTP(response, request)
		if response.Code != http.StatusOK {
			t.Fatalf("mcp status = %d: %s", response.Code, response.Body.String())
		}
		var envelope map[string]any
		if err := json.Unmarshal(response.Body.Bytes(), &envelope); err != nil {
			t.Fatal(err)
		}
		return envelope
	}
	init := post(`{"jsonrpc":"2.0","id":1,"method":"initialize"}`, token)
	result, _ := init["result"].(map[string]any)
	if result == nil || result["protocolVersion"] == nil {
		t.Fatalf("initialize result = %+v", init)
	}
	tools := post(`{"jsonrpc":"2.0","id":2,"method":"tools/list"}`, token)
	result, _ = tools["result"].(map[string]any)
	list, _ := result["tools"].([]any)
	if len(list) < 9 {
		t.Fatalf("tools = %d", len(list))
	}
	// Every tool declares a typed input schema, so models send real types.
	for _, raw := range list {
		tool := raw.(map[string]any)
		schema, _ := tool["inputSchema"].(map[string]any)
		if schema["type"] != "object" {
			t.Fatalf("%v: inputSchema = %v", tool["name"], schema)
		}
		if tool["name"] == "create_session" {
			wait := schema["properties"].(map[string]any)["wait"].(map[string]any)
			if wait["type"] != "boolean" {
				t.Fatalf("create_session.wait = %v, want boolean", wait)
			}
		}
	}
	calls := post(`{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"list_sessions","arguments":{}}}`, token)
	if _, ok := calls["error"]; ok {
		t.Fatalf("list_sessions error: %+v", calls["error"])
	}
	// Notifications are accepted without a reply.
	notification := httptest.NewRequest(http.MethodPost, "/api/mcp", strings.NewReader(`{"jsonrpc":"2.0","method":"notifications/initialized"}`))
	notification.Header.Set("Authorization", "Bearer "+token)
	notified := httptest.NewRecorder()
	server.Routes().ServeHTTP(notified, notification)
	if notified.Code != http.StatusAccepted || notified.Body.Len() != 0 {
		t.Fatalf("notification = %d %q, want 202 with no body", notified.Code, notified.Body.String())
	}
	// initialize negotiates a supported protocol revision.
	negotiated := post(`{"jsonrpc":"2.0","id":5,"method":"initialize","params":{"protocolVersion":"2025-03-26"}}`, token)
	if got := negotiated["result"].(map[string]any)["protocolVersion"]; got != "2025-03-26" {
		t.Fatalf("negotiated protocolVersion = %v", got)
	}
	// A failing tool call is a readable tool result, not a protocol error.
	failed := post(`{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"get_session","arguments":{"sessionId":"missing"}}}`, token)
	failure, _ := failed["result"].(map[string]any)
	if failure == nil || failure["isError"] != true {
		t.Fatalf("failed tool call = %+v, want isError result", failed)
	}
	// A bad bearer is rejected before reaching MCP.
	request := httptest.NewRequest(http.MethodPost, "/api/mcp", strings.NewReader(`{"jsonrpc":"2.0","id":4,"method":"tools/list"}`))
	request.Header.Set("Authorization", "Bearer nope")
	response := httptest.NewRecorder()
	server.Routes().ServeHTTP(response, request)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("bad token status = %d, want 401", response.Code)
	}
}

// A human control token can adopt supervision; a session token cannot.
func TestAdoptAuthorization(t *testing.T) {
	db, parent := lineageFixture(t)
	ctx := context.Background()
	child, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{
		WorkspaceID: "ws_lineage", AgentID: "agent_lineage", Provider: "claude",
		Prompt: "child", Source: "agent", ParentSessionID: parent.ID,
	})
	if err != nil {
		t.Fatal(err)
	}
	token, err := db.MintAgentSessionToken(ctx, child.ID)
	if err != nil {
		t.Fatal(err)
	}
	server := NewServer(db)
	body := `{"supervisorSessionId":"` + parent.ID + `"}`
	request := httptest.NewRequest(http.MethodPost, "/api/agent-sessions/"+child.ID+"/adopt", strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Authorization", "Bearer "+token)
	response := httptest.NewRecorder()
	server.Routes().ServeHTTP(response, request)
	if response.Code != http.StatusForbidden {
		t.Fatalf("agent adopt status = %d, want 403", response.Code)
	}
}

// Fork: resuming a native transcript starts a fresh Foundry thread while the
// forked session stays untouched.
func TestSessionFork(t *testing.T) {
	db, _ := lineageFixture(t)
	ctx := context.Background()
	original, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{
		WorkspaceID: "ws_lineage", AgentID: "agent_lineage", Provider: "claude",
		Prompt: "original", Source: "chat", NativeSessionID: "native_abc",
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.StartAgentSession(ctx, original.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.CompleteAgentSession(ctx, original.ID, "done", "native_abc"); err != nil {
		t.Fatal(err)
	}

	input := store.CreateAgentSessionInput{
		WorkspaceID:     "ws_lineage",
		AgentID:         "agent_lineage",
		Provider:        "claude",
		Prompt:          "continue from a fork",
		ForkSessionID:   original.ID,
		NativeSessionID: "native_abc",
	}
	fork, err := db.CreateAgentSession(ctx, input)
	if err != nil {
		t.Fatalf("create fork via store: %v", err)
	}
	// The fork gets its own native session, a copy of the source's; the two
	// never write into one transcript.
	if fork.NativeSessionID == "" || fork.NativeSessionID == "native_abc" || fork.ForkNativeSessionID != "native_abc" {
		t.Fatalf("fork native session = %q copied from %q, want its own copy of native_abc", fork.NativeSessionID, fork.ForkNativeSessionID)
	}
	if fork.ID == original.ID || fork.ThreadID != fork.ID {
		t.Fatalf("fork = %q (thread %q), original = %q: a fork is a new session", fork.ID, fork.ThreadID, original.ID)
	}
}

// A verification session is a utility session at the protocol level.
func TestVerificationSource(t *testing.T) {
	db, _ := lineageFixture(t)
	child, err := db.CreateAgentSession(context.Background(), store.CreateAgentSessionInput{
		WorkspaceID: "ws_lineage", AgentID: "agent_lineage", Provider: "claude",
		Prompt: "verify independently", Source: "verification",
	})
	if err != nil {
		t.Fatal(err)
	}
	if child.Source != "verification" {
		t.Fatalf("source = %q", child.Source)
	}
}

// AI group naming answers in the chat title format; a bad answer leaves the
// deterministic name untouched, and raw JSON never becomes a group name.
func TestGroupNameFromResponse(t *testing.T) {
	cases := map[string]string{
		`{"title":"前端优化"}`:                   "前端优化",
		"```json\n{\"title\":\"支付重构\"}\n```": "支付重构",
		"- 数据库迁移":                            "数据库迁移",
		`{"title":""}`:                       "",
		"第一行\n第二行":                           "",
	}
	for input, want := range cases {
		if got := groupNameFromResponse(input); got != want {
			t.Fatalf("groupNameFromResponse(%q) = %q, want %q", input, got, want)
		}
	}
}

func TestRenameLayoutGroup(t *testing.T) {
	db, parent := lineageFixture(t)
	ctx := context.Background()
	child, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{
		WorkspaceID: "ws_lineage", AgentID: "agent_lineage", Provider: "claude",
		Prompt: "child", Source: "agent", ParentSessionID: parent.ID,
	})
	if err != nil {
		t.Fatal(err)
	}
	layout, _ := db.GetChatLayout(ctx, "ws_lineage")
	groupID := layout.Groups[0].ID
	renamed, err := db.RenameLayoutGroup(ctx, "ws_lineage", groupID, "专项：支付")
	if err != nil {
		t.Fatal(err)
	}
	if renamed.Groups[0].Name != "专项：支付" || renamed.Revision != layout.Revision+1 {
		t.Fatalf("renamed layout = %+v", renamed)
	}
	// Membership is unchanged.
	if ids, _ := db.SessionsInGroup(ctx, "ws_lineage", groupID); len(ids) != 2 {
		t.Fatalf("group members = %v", ids)
	}
	_ = child
}

func TestAgentSessionsInheritTheirParentsCreator(t *testing.T) {
	db, _ := lineageFixture(t)
	ctx := context.Background()
	parent, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{
		WorkspaceID: "ws_lineage", AgentID: "agent_lineage", Provider: "claude",
		Prompt: "human task", Source: "chat", CreatedByUserID: "user_alice",
	})
	if err != nil {
		t.Fatal(err)
	}
	child, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{
		WorkspaceID: "ws_lineage", AgentID: "agent_lineage", Provider: "claude",
		Prompt: "delegated task", Source: "agent", ParentSessionID: parent.ID,
	})
	if err != nil {
		t.Fatal(err)
	}
	if parent.CreatedByUserID != "user_alice" || child.CreatedByUserID != "user_alice" {
		t.Fatalf("creators parent=%q child=%q, want user_alice for both", parent.CreatedByUserID, child.CreatedByUserID)
	}
	stored, err := db.GetAgentSession(ctx, child.ID)
	if err != nil || stored.CreatedByUserID != "user_alice" {
		t.Fatalf("persisted child creator = %q %v", stored.CreatedByUserID, err)
	}
}

func TestHTTPIssueRecordsItsCreator(t *testing.T) {
	server := NewServer(newTestStore(t))
	created := postJSONForTest(t, server, "/api/issues", `{"sourceInput":"attributed issue","runtime":"mock"}`, http.StatusCreated)
	if created["createdByUserId"] != testOwner.ID {
		t.Fatalf("issue creator = %v, want %s", created["createdByUserId"], testOwner.ID)
	}
}

// Orchestration results: a child created without a runtime choice runs like
// its parent, and waiting on a settled child returns what it answered.
func TestMCPChildDefaultsAndWaitResult(t *testing.T) {
	db, parent := lineageFixture(t)
	ctx := context.Background()
	token, err := db.MintAgentSessionToken(ctx, parent.ID)
	if err != nil {
		t.Fatal(err)
	}
	server := NewServer(db)
	call := func(tool, arguments string) (string, bool) {
		body := `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"` + tool + `","arguments":` + arguments + `}}`
		request := httptest.NewRequest(http.MethodPost, "/api/mcp", strings.NewReader(body))
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("Authorization", "Bearer "+token)
		response := httptest.NewRecorder()
		server.Routes().ServeHTTP(response, request)
		var envelope struct {
			Result struct {
				Content []struct {
					Text string `json:"text"`
				} `json:"content"`
				IsError bool `json:"isError"`
			} `json:"result"`
		}
		if err := json.Unmarshal(response.Body.Bytes(), &envelope); err != nil || len(envelope.Result.Content) == 0 {
			t.Fatalf("%s: %d %s", tool, response.Code, response.Body.String())
		}
		return envelope.Result.Content[0].Text, envelope.Result.IsError
	}
	// Without a runtime the child used to find no agent; it now resolves the
	// parent's runtime and only stops at dispatch, since no daemon is connected.
	text, isError := call("create_session", `{"prompt":"Reply with exactly: CHILD-OK"}`)
	if !isError || text != "local daemon is not connected" {
		t.Fatalf("create_session without a runtime = %q (error %v), want it to reach dispatch", text, isError)
	}
	child, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{
		WorkspaceID: "ws_lineage", AgentID: "agent_lineage", Provider: "claude",
		Prompt: "Reply with exactly: CHILD-OK", Source: "agent", ParentSessionID: parent.ID,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.CompleteAgentSession(ctx, child.ID, "CHILD-OK", ""); err != nil {
		t.Fatal(err)
	}
	text, isError = call("wait_session", `{"sessionId":"`+child.ID+`","timeoutMs":2000}`)
	var waited map[string]any
	if isError || json.Unmarshal([]byte(text), &waited) != nil {
		t.Fatalf("wait_session = %q (error %v)", text, isError)
	}
	if waited["status"] != "completed" || waited["response"] != "CHILD-OK" {
		t.Fatalf("wait = status %v response %v, want completed CHILD-OK", waited["status"], waited["response"])
	}
	if _, ok := waited["events"]; ok {
		t.Fatal("wait result must not carry the event stream")
	}
	text, isError = call("handoff_session", `{"fromSessionId":"`+child.ID+`","prompt":"Continue."}`)
	if !isError || text != "local daemon is not connected" {
		t.Fatalf("handoff_session = %q (error %v), want it to reach dispatch", text, isError)
	}
	text, isError = call("list_models", `{"profileId":"missing"}`)
	if !isError || text != "unknown profile: missing" {
		t.Fatalf("list_models = %q (error %v)", text, isError)
	}
	if text, isError = call("read_context", `{"sessionId":"`+child.ID+`","scope":"subagents"}`); !isError {
		t.Fatalf("read_context subagents without a daemon = %q, want an error", text)
	}
}

func TestHandoffPromptCarriesFactsOnly(t *testing.T) {
	prompt := handoffPrompt(store.AgentSession{
		ID: "sess_a", Title: "Fix login", Status: "failed", Prompt: "Fix the login bug", Response: "Stuck on CSRF",
	}, "Try the token route.")
	want := "Handoff from session sess_a (\"Fix login\", status: failed).\n\nOriginal goal:\nFix the login bug\n\nLast recorded result:\nStuck on CSRF\n\nTry the token route."
	if prompt != want {
		t.Fatalf("handoff prompt = %q, want %q", prompt, want)
	}
}

func TestMCPArgumentsTolerateStringScalars(t *testing.T) {
	args := map[string]json.RawMessage{
		"yes": json.RawMessage(`true`), "yesText": json.RawMessage(`"true"`),
		"noText": json.RawMessage(`"no"`), "ms": json.RawMessage(`1500`),
		"msText": json.RawMessage(`"2500"`), "msBad": json.RawMessage(`"soon"`),
	}
	if !mcpArgBool(args, "yes") || !mcpArgBool(args, "yesText") || mcpArgBool(args, "noText") || mcpArgBool(args, "missing") {
		t.Fatal("boolean arguments must accept true and \"true\" only")
	}
	if mcpArgNumber(args, "ms", 1) != 1500 || mcpArgNumber(args, "msText", 1) != 2500 || mcpArgNumber(args, "msBad", 7) != 7 {
		t.Fatal("number arguments must accept numbers and numeric strings, else the fallback")
	}
}

func TestSessionDeviceResolvesARuntimeFromItsProfile(t *testing.T) {
	db := newTestStore(t)
	ctx := context.Background()
	if err := db.RegisterDaemon(ctx, store.DaemonRegistration{
		Device:    store.DeviceProjection{ID: "dev_profile", Label: "Studio", Status: "connected", LastSeenLabel: "online"},
		Workspace: store.WorkspaceProjection{ID: "ws_profile", Name: "Foundry", LocalPath: t.TempDir()},
		Agents: []store.AgentProjection{{
			ID: "agent_profile", WorkspaceID: "ws_profile", DeviceID: "dev_profile",
			Provider: "codex", ProfileID: "codex_local", Status: "healthy", AuthMode: "local_config",
			SecretStored: "local", ConfigScope: "workspace", ConfigLabel: "local", LastSeenLabel: "online",
		}},
	}); err != nil {
		t.Fatalf("register daemon: %v", err)
	}
	server := NewServer(db)
	input := store.CreateAgentSessionInput{WorkspaceID: "ws_profile", ProfileID: "codex_local"}
	// No daemon is connected, so success stops at the connection check.
	if status, err := server.resolveSessionDevice(ctx, &input); status != http.StatusConflict {
		t.Fatalf("profile-only resolution = %d %v, want it to reach the connection check", status, err)
	}
	if input.Provider != "codex" {
		t.Fatalf("provider = %q, want the profile's runtime", input.Provider)
	}
	unknown := store.CreateAgentSessionInput{WorkspaceID: "ws_profile", ProfileID: "missing"}
	if status, _ := server.resolveSessionDevice(ctx, &unknown); status != http.StatusBadRequest {
		t.Fatalf("unknown profile = %d, want 400", status)
	}
}

func TestLifecycleMessagesAboutAnEarlierInputAreStale(t *testing.T) {
	session := store.AgentSession{ID: "sess_a", Input: store.SessionInput{ID: "in_2"}}
	if !staleSessionInput(session, "in_1") {
		t.Fatal("a completion for an earlier input must not settle the current one")
	}
	if staleSessionInput(session, "in_2") || staleSessionInput(session, "") {
		t.Fatal("the current input, or a message without an input id, is not stale")
	}
}

// A child inherits its parent's profile. With two Claude profiles on one
// device the profile must decide, not whichever Claude agent is listed first.
func TestSessionAgentFollowsTheProfileNotTheFirstOfItsRuntime(t *testing.T) {
	agents := []store.AgentProjection{
		{ID: "agent_official", DeviceID: "dev_a", Provider: "claude", ProfileID: "claude_local"},
		{ID: "agent_relay", DeviceID: "dev_a", Provider: "claude", ProfileID: "cc_relay"},
	}
	agent, ok := pickSessionAgent(agents, store.CreateAgentSessionInput{Provider: "claude", ProfileID: "cc_relay"})
	if !ok || agent.ID != "agent_relay" {
		t.Fatalf("picked %+v, want the relay profile's agent", agent)
	}
	if _, ok := pickSessionAgent(agents, store.CreateAgentSessionInput{Provider: "codex", ProfileID: "cc_relay"}); ok {
		t.Fatal("a profile of another runtime must not match")
	}
	if agent, _ := pickSessionAgent(agents, store.CreateAgentSessionInput{Provider: "claude"}); agent.ID != "agent_official" {
		t.Fatalf("runtime only = %+v, want the first agent of that runtime", agent)
	}
}
