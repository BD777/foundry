package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// A worker learns which of its native chats this server still shows as
// running, and only for its own workspace.
func TestDaemonRunningChatsNamesStuckNativeChats(t *testing.T) {
	f := newIsolationFixture(t)
	sync := `{"workspaceId":"ws_alice","chats":[
		{"id":"native_codex_old","workspaceId":"ws_alice","provider":"codex","nativeSessionId":"old","title":"old","status":"running"},
		{"id":"native_codex_done","workspaceId":"ws_alice","provider":"codex","nativeSessionId":"done","title":"done","status":"completed"}]}`
	expectStatus(t, doAuthCall(t, f.handler, deviceCall(http.MethodPost, "/api/daemon/chats/sync", sync, f.aliceDevice)),
		http.StatusOK, "alice's device syncs chats")
	recorder := doAuthCall(t, f.handler, deviceCall(http.MethodGet, "/api/daemon/chats/running?workspaceId=ws_alice", "", f.aliceDevice))
	expectStatus(t, recorder, http.StatusOK, "alice's device lists running chats")
	var body struct {
		ChatIDs []string `json:"chatIds"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if len(body.ChatIDs) != 1 || body.ChatIDs[0] != "native_codex_old" {
		t.Fatalf("running chats = %v, want [native_codex_old]", body.ChatIDs)
	}
	expectStatus(t, doAuthCall(t, f.handler, deviceCall(http.MethodGet, "/api/daemon/chats/running?workspaceId=ws_alice", "", f.bobDevice)),
		http.StatusNotFound, "bob's device lists alice's running chats")
}

// A chat sync names the chats this server never keeps, so the worker stops
// sending them: here the native chat of a Foundry session.
func TestDaemonChatSyncNamesRefusedChats(t *testing.T) {
	f := newIsolationFixture(t)
	register := `{"device":{"id":"dev_alice","label":"Device","status":"connected","lastSeenLabel":"online"},` +
		`"workspace":{"id":"ws_alice","name":"W","localPath":"/tmp/w","baseline":"main","contextSummary":"","acceptedCount":0,"resolvedCount":0},` +
		`"providerHealth":[],"assets":[],"skills":[],"workspaceFiles":[],"agents":[{"id":"agent_alice","workspaceId":"ws_alice","deviceId":"dev_alice",` +
		`"deviceLabel":"Device","provider":"codex","status":"healthy","authMode":"local_config","secretStored":"local","configScope":"workspace",` +
		`"configLabel":"local","lastSeenLabel":"online"}]}`
	expectStatus(t, doAuthCall(t, f.handler, deviceCall(http.MethodPost, "/api/daemon/register", register, f.aliceDevice)),
		http.StatusOK, "register alice's agent")
	ctx := context.Background()
	session, err := f.server.store.CreateAgentSession(ctx, store.CreateAgentSessionInput{
		AgentID: "agent_alice", WorkspaceID: "ws_alice", Provider: "codex", Prompt: "work", Source: "chat", CreatedByUserID: f.aliceID,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.server.store.CompleteAgentSession(ctx, session.ID, "done", "owned"); err != nil {
		t.Fatal(err)
	}
	sync := `{"workspaceId":"ws_alice","chats":[
		{"id":"native_codex_owned","workspaceId":"ws_alice","provider":"codex","nativeSessionId":"owned","title":"owned","status":"completed","recentMessages":[{"role":"user","text":"hi"}]},
		{"id":"native_codex_mine","workspaceId":"ws_alice","provider":"codex","nativeSessionId":"mine","title":"mine","status":"completed","recentMessages":[{"role":"user","text":"hi"}]}]}`
	recorder := doAuthCall(t, f.handler, deviceCall(http.MethodPost, "/api/daemon/chats/sync", sync, f.aliceDevice))
	expectStatus(t, recorder, http.StatusOK, "alice's device syncs chats")
	var body syncedChats
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Status != "synced" || body.Count != 2 || len(body.Refused) != 1 || body.Refused[0] != "native_codex_owned" {
		t.Fatalf("sync answer = %s", recorder.Body.String())
	}
}
