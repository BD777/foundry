package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// reachFixture is alice and bob, each with a workspace on their own
// connected device, a Claude agent there, and a native chat the device
// synced into it.
type reachFixture struct {
	isolationFixture
	db store.Store
}

func newReachFixture(t *testing.T) reachFixture {
	t.Helper()
	f := reachFixture{isolationFixture: newIsolationFixture(t)}
	f.db = f.server.store
	ctx := context.Background()
	for _, register := range []struct{ device, workspace, agent string }{
		{"dev_alice", "ws_alice", "agent_alice"}, {"dev_bob", "ws_bob", "agent_bob"},
	} {
		if err := f.db.RegisterDaemon(ctx, store.DaemonRegistration{
			Device:    store.DeviceProjection{ID: register.device, Label: "Device", Status: "connected", LastSeenLabel: "online"},
			Workspace: store.WorkspaceProjection{ID: register.workspace, Name: "W", LocalPath: "/tmp/" + register.workspace},
			Agents: []store.AgentProjection{{
				ID: register.agent, WorkspaceID: register.workspace, DeviceID: register.device, Provider: "claude", Status: "healthy",
				AuthMode: "local_config", SecretStored: "local", ConfigScope: "workspace", ConfigLabel: "local", LastSeenLabel: "online",
			}},
		}); err != nil {
			t.Fatal(err)
		}
		f.server.hub.connections[register.device] = &daemonConnection{
			hub: f.server.hub, deviceID: register.device, done: make(chan struct{}), send: make(chan wsEnvelope, 64),
			rpc: newDaemonRPC(), activeSessions: map[string]bool{}, dispatchedSessions: map[string]string{},
		}
		chatID := "native_claude_" + register.workspace
		if err := f.db.SyncChats(ctx, store.SyncChatsInput{WorkspaceID: register.workspace, Chats: []store.ChatThread{{
			ID: chatID, WorkspaceID: register.workspace, Provider: "claude", NativeSessionID: register.workspace, Title: "Terminal " + register.workspace,
			Status: "completed", UpdatedAt: "2026-10-09T10:00:00Z",
			Transcript: []store.TranscriptMessage{{ID: "m1", At: "2026-10-09T10:00:00Z", Kind: "user", Text: "hello"}},
		}}}); err != nil {
			t.Fatal(err)
		}
	}
	return f
}

// bearer posts a session-create request with a session token.
func (f reachFixture) bearer(t *testing.T, token, body string) (int, string) {
	t.Helper()
	response := doAuthCall(t, f.handler, authCall{method: http.MethodPost, path: "/api/agent-sessions", body: body,
		headers: map[string]string{"Authorization": "Bearer " + token, "Content-Type": "application/json"}})
	return response.Code, response.Body.String()
}

// A session token creates sessions over REST with the reach its Foundry
// tools have: no native session named by id, and a native chat it adopts
// only from the workspace it starts the session in, where it is Member.
func TestSessionTokenCreatesWithinItsReach(t *testing.T) {
	f := newReachFixture(t)
	ctx := context.Background()
	bobSession, err := f.db.CreateAgentSession(ctx, store.CreateAgentSessionInput{
		CreatedByUserID: f.bobID, WorkspaceID: "ws_bob", AgentID: "agent_bob", Provider: "claude", Prompt: "orchestrate",
	})
	if err != nil {
		t.Fatal(err)
	}
	token, err := f.db.MintAgentSessionToken(ctx, bobSession.ID)
	if err != nil {
		t.Fatal(err)
	}
	if code, body := f.bearer(t, token, `{"provider":"claude","prompt":"resume","nativeSessionId":"ws_bob"}`); code != http.StatusBadRequest || !strings.Contains(body, "nativeSessionId is not accepted") {
		t.Fatalf("a session token naming a native session = %d %s", code, body)
	}
	// Alice's chat is out of reach: from bob's workspace, from hers, and
	// once shared only to read.
	for _, body := range []string{
		`{"provider":"claude","prompt":"take it","chatId":"native_claude_ws_alice"}`,
		`{"workspaceId":"ws_alice","provider":"claude","prompt":"take it","chatId":"native_claude_ws_alice"}`,
	} {
		if code, text := f.bearer(t, token, body); code != http.StatusNotFound {
			t.Fatalf("a session token adopting a chat outside its reach (%s) = %d %s", body, code, text)
		}
	}
	expectStatus(t, doAuthCall(t, f.handler, f.as(f.alice, http.MethodPost, "/api/workspaces/ws_alice/members", `{"username":"bob","role":"viewer"}`)),
		http.StatusNoContent, "share with bob as viewer")
	if code, text := f.bearer(t, token, `{"workspaceId":"ws_alice","provider":"claude","prompt":"take it","chatId":"native_claude_ws_alice"}`); code != http.StatusForbidden {
		t.Fatalf("a session token adopting a chat it only reads = %d %s", code, text)
	}
	if chat, err := f.db.GetChat(ctx, "native_claude_ws_alice"); err != nil || chat.WorkspaceID != "ws_alice" {
		t.Fatalf("alice's chat moved: %+v %v", chat, err)
	}
	// A fork runs in its source's workspace, so it needs Member there too.
	aliceSession, err := f.db.CreateAgentSession(ctx, store.CreateAgentSessionInput{
		CreatedByUserID: f.aliceID, WorkspaceID: "ws_alice", AgentID: "agent_alice", Provider: "claude", Prompt: "alice's plan",
	})
	if err != nil {
		t.Fatal(err)
	}
	if code, text := f.bearer(t, token, `{"provider":"claude","prompt":"fork it","forkSessionId":"`+aliceSession.ID+`"}`); code != http.StatusForbidden {
		t.Fatalf("a session token forking a session it only reads = %d %s", code, text)
	}
	if text, isError := mcpToolCaller(t, f.handler, token)("create_session", map[string]any{"prompt": "fork it", "forkSessionId": aliceSession.ID}); !isError || text != "workspace not found" {
		t.Fatalf("create_session forking a session it only reads = %q", text)
	}
	if sessions, _ := f.db.ListAgentSessionSummaries(ctx, "ws_alice"); len(sessions) != 1 {
		t.Fatalf("alice's workspace has %d sessions, want only her own", len(sessions))
	}
	// An unassigned chat is in no workspace the token reaches.
	if err := f.db.SyncChats(ctx, store.SyncChatsInput{WorkspaceID: "", Chats: []store.ChatThread{{
		ID: "native_claude_loose", Provider: "claude", NativeSessionID: "loose", Title: "Loose", Status: "completed",
	}}}); err != nil {
		t.Fatal(err)
	}
	if code, text := f.bearer(t, token, `{"provider":"claude","prompt":"take it","chatId":"native_claude_loose"}`); code != http.StatusNotFound {
		t.Fatalf("a session token adopting an unassigned chat = %d %s", code, text)
	}
	// Its own workspace's chat it continues, as a person would.
	code, text := f.bearer(t, token, `{"provider":"claude","prompt":"continue","chatId":"native_claude_ws_bob"}`)
	var adopted store.AgentSession
	if code != http.StatusCreated || json.Unmarshal([]byte(text), &adopted) != nil || adopted.WorkspaceID != "ws_bob" || adopted.Title != "Terminal ws_bob" {
		t.Fatalf("a session token adopting its own workspace's chat = %d %s", code, text)
	}
}

// People keep adopting a native chat from the chat page.
func TestPersonStillAdoptsANativeChat(t *testing.T) {
	f := newReachFixture(t)
	response := doAuthCall(t, f.handler, f.as(f.alice, http.MethodPost, "/api/agent-sessions",
		`{"workspaceId":"ws_alice","agentId":"agent_alice","provider":"claude","prompt":"continue","chatId":"native_claude_ws_alice","source":"chat"}`))
	expectStatus(t, response, http.StatusCreated, "alice continues her native chat")
	var adopted store.AgentSession
	if err := json.Unmarshal(response.Body.Bytes(), &adopted); err != nil || adopted.Title != "Terminal ws_alice" || adopted.WorkspaceID != "ws_alice" {
		t.Fatalf("adopted = %+v %v", adopted, err)
	}
	full, err := f.db.GetAgentSession(context.Background(), adopted.ID)
	if err != nil || len(full.Events) == 0 || full.Events[0].Label != "Native transcript" {
		t.Fatalf("the session does not carry the chat's transcript: %+v %v", full.Events, err)
	}
}

// A session starts in the workspace whose Member check it passed, whatever
// agent the request names.
func TestCreateStaysInTheCheckedWorkspace(t *testing.T) {
	f := newReachFixture(t)
	response := doAuthCall(t, f.handler, f.as(f.alice, http.MethodPost, "/api/agent-sessions",
		`{"workspaceId":"ws_alice","agentId":"agent_bob","provider":"claude","prompt":"run on bob's device","source":"chat"}`))
	if response.Code == http.StatusCreated {
		var created store.AgentSession
		_ = json.Unmarshal(response.Body.Bytes(), &created)
		t.Fatalf("alice started a session through bob's agent: workspace %s device %s", created.WorkspaceID, created.DeviceID)
	}
	sessions, err := f.db.ListAgentSessionSummaries(context.Background(), "ws_bob")
	if err != nil || len(sessions) != 0 {
		t.Fatalf("bob's workspace got sessions: %+v %v", sessions, err)
	}
}
