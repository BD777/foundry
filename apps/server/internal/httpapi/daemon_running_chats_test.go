package httpapi

import (
	"encoding/json"
	"net/http"
	"testing"
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
