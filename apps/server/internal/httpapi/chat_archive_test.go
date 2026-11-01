package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func TestArchiveHTTPAndMCPExplicitRestore(t *testing.T) {
	ctx := context.Background()
	backing := newEmptyTestStore(t)
	registerQueueDevice(t, backing, "claude")
	create := func(prompt string) store.AgentSession {
		v, e := backing.CreateAgentSession(ctx, store.CreateAgentSessionInput{WorkspaceID: "ws_queue", AgentID: "agent_queue", Provider: "claude", Prompt: prompt, Source: "chat"})
		if e != nil {
			t.Fatal(e)
		}
		v, e = backing.CompleteAgentSession(ctx, v.ID, "done", "native_"+prompt)
		if e != nil {
			t.Fatal(e)
		}
		return v
	}
	parent := create("parent")
	child := create("child")
	server := NewServer(backing)
	live := httptest.NewServer(server.Routes())
	defer live.Close()
	client := queueClient{t: t, server: server, url: live.URL}
	token, e := backing.MintAgentSessionToken(ctx, parent.ID)
	if e != nil {
		t.Fatal(e)
	}
	tool := mcpToolCaller(t, server.Routes(), token)
	text, failed := tool("archive_session", map[string]any{"sessionId": child.ID})
	if failed {
		t.Fatalf("archive_session=%s", text)
	}
	for _, call := range []struct{ path, body string }{
		{"/api/agent-sessions/" + child.ID + "/messages", `{"prompt":"blocked"}`},
		{"/api/chats/" + child.ID + "/queue", `{"text":"blocked"}`},
	} {
		status, raw := client.call(http.MethodPost, call.path, call.body, "")
		if status != http.StatusConflict || !strings.Contains(string(raw), "session_archived") {
			t.Fatalf("%s=%d %s", call.path, status, raw)
		}
	}
	text, failed = tool("send_message", map[string]any{"sessionId": child.ID, "prompt": "blocked"})
	if !failed || !strings.Contains(text, "session_archived") {
		t.Fatalf("MCP send=%s failed=%v", text, failed)
	}
	for mode, want := range map[string]bool{"": false, "only": true, "include": true} {
		status, raw := client.call(http.MethodGet, "/api/agent-sessions?workspaceId=ws_queue&archived="+mode, "", "")
		if status != 200 {
			t.Fatalf("list=%d %s", status, raw)
		}
		if strings.Contains(string(raw), child.ID) != want {
			t.Fatalf("mode %s child visible=%v: %s", mode, !want, raw)
		}
	}
	status, raw := client.call(http.MethodGet, "/api/agent-sessions/"+child.ID, "", "")
	if status != 200 || !strings.Contains(string(raw), "archivedAt") {
		t.Fatalf("read=%d %s", status, raw)
	}
	text, failed = tool("read_context", map[string]any{"sessionId": child.ID})
	if failed || !strings.Contains(text, "archivedAt") {
		t.Fatalf("read_context=%s", text)
	}
	text, failed = tool("list_sessions", map[string]any{"workspaceId": "ws_queue", "archived": "only"})
	if failed || !strings.Contains(text, child.ID) {
		t.Fatalf("list_sessions=%s", text)
	}
	text, failed = tool("archive_session", map[string]any{"sessionId": child.ID, "restore": true})
	if failed {
		t.Fatalf("unarchive=%s", text)
	}
	v, _ := backing.GetAgentSessionSummary(ctx, child.ID)
	if v.ArchivedAt != "" {
		t.Fatal("restore left archive state")
	}
	detail, e := backing.GetAgentSession(ctx, child.ID)
	if e != nil {
		t.Fatal(e)
	}
	seen := map[string]bool{}
	for _, event := range detail.Events {
		if event.Label == "Chat archived" || event.Label == "Chat unarchived" {
			if !strings.Contains(event.Detail, `"actorSessionId":"`+parent.ID+`"`) {
				t.Fatalf("audit omits actor: %+v", event)
			}
			seen[event.Label] = true
		}
	}
	if len(seen) != 2 {
		t.Fatalf("missing archive/restore audits: %+v", seen)
	}
}
func TestArchiveAuthorizationAndAtomicPreflight(t *testing.T) {
	f := newIsolationFixture(t)
	ctx := context.Background()
	if err := f.server.store.RegisterDaemon(ctx, store.DaemonRegistration{Device: store.DeviceProjection{ID: "dev_alice", Label: "Alice", Status: "connected"}, Workspace: store.WorkspaceProjection{ID: "ws_alice", Name: "Archive", LocalPath: t.TempDir()}, Agents: []store.AgentProjection{{ID: "agent_archive_http", WorkspaceID: "ws_alice", DeviceID: "dev_alice", Provider: "claude", Status: "healthy", AuthMode: "local_config"}}}); err != nil {
		t.Fatal(err)
	}
	v, e := f.server.store.CreateAgentSession(ctx, store.CreateAgentSessionInput{WorkspaceID: "ws_alice", AgentID: "agent_archive_http", Provider: "claude", Prompt: "archive", CreatedByUserID: f.aliceID})
	if e != nil {
		t.Fatal(e)
	}

	payload, _ := json.Marshal(store.ArchiveChatsInput{WorkspaceID: "ws_alice", ChatIDs: []string{v.ID}, DryRun: true})
	pre := doAuthCall(t, f.handler, f.as(f.alice, http.MethodPost, "/api/chats/archive", string(payload)))
	expectStatus(t, pre, 200, "archive preflight")
	var result store.ArchiveChatsResult
	if e = json.Unmarshal(pre.Body.Bytes(), &result); e != nil || len(result.Blockers) != 1 || result.Blockers[0].Code != "running" {
		t.Fatalf("preflight=%s %v", pre.Body, e)
	}
	payload, _ = json.Marshal(store.ArchiveChatsInput{WorkspaceID: "ws_alice", ChatIDs: []string{v.ID}})
	blocked := doAuthCall(t, f.handler, f.as(f.alice, http.MethodPost, "/api/chats/archive", string(payload)))
	expectStatus(t, blocked, 409, "queued archive")
	denied := doAuthCall(t, f.handler, f.as(f.bob, http.MethodPost, "/api/chats/archive", string(payload)))
	if denied.Code != 403 && denied.Code != 404 {
		t.Fatalf("foreign archive=%d %s", denied.Code, denied.Body)
	}
	detail, _ := f.server.store.GetAgentSessionSummary(ctx, v.ID)
	if detail.ArchivedAt != "" {
		t.Fatal("blocked archive mutated session")
	}
}

func TestArchivePersonalAgentBulkRequiresConfirmation(t *testing.T) {
	f := newAssistantFixture(t)
	ctx := context.Background()
	ids := []string{}
	for i := 0; i < 4; i++ {
		v := f.startSession(t, "ws_alice", f.conversation.ID, "archive synthetic")
		if _, e := f.server.store.CompleteAgentSession(ctx, v.ID, "done", ""); e != nil {
			t.Fatal(e)
		}
		ids = append(ids, v.ID)
	}
	text, failed := f.tool(t, f.token, "archive_session", map[string]any{"sessionIds": ids})
	if failed || !strings.Contains(text, "needs_confirmation") {
		t.Fatalf("bulk=%s failed=%v", text, failed)
	}
	var proposal store.PersonalAgentNeedsConfirmation
	if e := json.Unmarshal([]byte(text), &proposal); e != nil {
		t.Fatal(e)
	}
	for _, id := range ids {
		v, _ := f.server.store.GetAgentSessionSummary(ctx, id)
		if v.ArchivedAt != "" {
			t.Fatal("proposal applied without approval")
		}
	}
	accepted := doAuthCall(t, f.handler, f.as(f.alice, http.MethodPost, "/api/personal-agent/proposals/"+proposal.ProposalID+"/accept", ""))
	expectStatus(t, accepted, 200, "accept archive proposal")
	var decided store.PersonalAgentProposal
	if e := json.Unmarshal(accepted.Body.Bytes(), &decided); e != nil || decided.Status != store.PersonalAgentProposalApplied {
		t.Fatalf("proposal did not apply: %s", accepted.Body.String())
	}
	for _, id := range ids {
		v, _ := f.server.store.GetAgentSessionSummary(ctx, id)
		if v.ArchivedAt == "" || v.ArchivedBySession != f.conversation.ID {
			t.Fatalf("confirmed archive=%+v", v.ChatArchive)
		}
	}
}

// An agent archives and restores the native chats of a device its person
// paired, never those of a device another account paired, even in a
// workspace shared with its person as Member.
func TestArchiveNativeChatByAgentFollowsDeviceOwner(t *testing.T) {
	f := newIsolationFixture(t)
	ctx := context.Background()
	db := f.server.store
	for _, register := range []struct{ device, workspace, agent string }{
		{"dev_alice", "ws_alice", "agent_alice"}, {"dev_bob", "ws_bob", "agent_bob"},
	} {
		if err := db.RegisterDaemon(ctx, store.DaemonRegistration{
			Device:    store.DeviceProjection{ID: register.device, Label: "Device", Status: "connected"},
			Workspace: store.WorkspaceProjection{ID: register.workspace, Name: "W", LocalPath: t.TempDir()},
			Agents:    []store.AgentProjection{{ID: register.agent, WorkspaceID: register.workspace, DeviceID: register.device, Provider: "codex", Status: "healthy", AuthMode: "local_config"}},
		}); err != nil {
			t.Fatal(err)
		}
		if _, err := db.SyncChatsChanges(ctx, store.SyncChatsInput{WorkspaceID: register.workspace, Chats: []store.ChatThread{{
			ID: "native_codex_" + register.workspace, WorkspaceID: register.workspace, Provider: "codex", NativeSessionID: register.workspace, Title: "Terminal chat", Status: "completed",
		}}}); err != nil {
			t.Fatal(err)
		}
	}
	expectStatus(t, doAuthCall(t, f.handler, f.as(f.alice, http.MethodPost, "/api/workspaces/ws_alice/members", `{"username":"bob","role":"member"}`)),
		http.StatusNoContent, "share with bob as member")
	bobSession, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{CreatedByUserID: f.bobID, WorkspaceID: "ws_bob", AgentID: "agent_bob", Provider: "codex", Prompt: "tidy"})
	if err != nil {
		t.Fatal(err)
	}
	token, err := db.MintAgentSessionToken(ctx, bobSession.ID)
	if err != nil {
		t.Fatal(err)
	}
	tool := mcpToolCaller(t, f.handler, token)
	archived := func(id string) bool {
		chat, err := db.GetChat(ctx, id)
		if err != nil {
			t.Fatal(err)
		}
		return chat.ArchivedAt != ""
	}

	if text, failed := tool("archive_session", map[string]any{"sessionId": "native_codex_ws_bob"}); failed || !archived("native_codex_ws_bob") {
		t.Fatalf("own device archive=%s failed=%v", text, failed)
	}
	if text, failed := tool("archive_session", map[string]any{"sessionId": "native_codex_ws_bob", "restore": true}); failed || archived("native_codex_ws_bob") {
		t.Fatalf("own device restore=%s failed=%v", text, failed)
	}
	if text, failed := tool("archive_session", map[string]any{"sessionId": "native_codex_ws_alice"}); !failed || !strings.Contains(text, "device its person paired") || archived("native_codex_ws_alice") {
		t.Fatalf("foreign device archive=%s failed=%v", text, failed)
	}
}
