package httpapi

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// A worker without its own upload record asks what the server holds of its
// chats; only its own workspace's native chats are named, with the fields it
// compares and the number of transcript messages stored.
func TestDaemonChatDigestsNameStoredNativeChats(t *testing.T) {
	f := newIsolationFixture(t)
	sync := `{"workspaceId":"ws_alice","chats":[
		{"id":"native_claude_full","workspaceId":"ws_alice","provider":"claude","nativeSessionId":"full","title":"Full","preview":"done",
		 "updatedAt":"2026-10-11T10:00:00Z","status":"completed","answerRevision":"r1",
		 "transcript":[{"id":"m1","kind":"user","text":"hi"},{"id":"m2","kind":"assistant","text":"done"}]},
		{"id":"native_codex_summary","workspaceId":"ws_alice","provider":"codex","nativeSessionId":"summary","title":"Summary","preview":"p",
		 "updatedAt":"2026-10-11T11:00:00Z","status":"running"}]}`
	expectStatus(t, doAuthCall(t, f.handler, deviceCall(http.MethodPost, "/api/daemon/chats/sync", sync, f.aliceDevice)),
		http.StatusOK, "alice's device syncs chats")
	recorder := doAuthCall(t, f.handler, deviceCall(http.MethodGet, "/api/daemon/chats/digests?workspaceId=ws_alice", "", f.aliceDevice))
	expectStatus(t, recorder, http.StatusOK, "alice's device lists chat digests")
	var body struct {
		Chats []store.ChatDigest `json:"chats"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	want := []store.ChatDigest{
		{ID: "native_claude_full", UpdatedAt: "2026-10-11T10:00:00Z", Status: "completed", AnswerRevision: "r1", Title: "Full", Preview: "done", TranscriptMessages: 2},
		{ID: "native_codex_summary", UpdatedAt: "2026-10-11T11:00:00Z", Status: "running", Title: "Summary", Preview: "p"},
	}
	if len(body.Chats) != len(want) {
		t.Fatalf("digests = %+v, want %+v", body.Chats, want)
	}
	for index := range want {
		if body.Chats[index] != want[index] {
			t.Fatalf("digest %d = %+v, want %+v", index, body.Chats[index], want[index])
		}
	}
	expectStatus(t, doAuthCall(t, f.handler, deviceCall(http.MethodGet, "/api/daemon/chats/digests?workspaceId=ws_alice", "", f.bobDevice)),
		http.StatusNotFound, "bob's device lists alice's chat digests")
	expectStatus(t, doAuthCall(t, f.handler, deviceCall(http.MethodGet, "/api/daemon/chats/digests", "", f.aliceDevice)),
		http.StatusBadRequest, "a digest list without a workspace")
}
