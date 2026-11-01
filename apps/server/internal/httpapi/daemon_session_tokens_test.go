package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// Claude fires a timer itself while its process lives: the device asks for
// a token for the turn, the session settled or not.
func TestDaemonMintsATokenForItsSessionsTimerTurn(t *testing.T) {
	backing := newEmptyTestStore(t)
	ctx := context.Background()
	registerQueueDevice(t, backing, "claude")
	session, err := backing.CreateAgentSession(ctx, store.CreateAgentSessionInput{
		WorkspaceID: "ws_queue", AgentID: "agent_queue", Provider: "claude", Prompt: "inspect every 30 minutes", Source: "chat",
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := backing.CompleteAgentSession(ctx, session.ID, "scheduled", "native_inspect"); err != nil {
		t.Fatal(err)
	}
	server := NewServer(backing)
	live := httptest.NewServer(server.Routes())
	defer live.Close()
	client := queueClient{t: t, server: server, url: live.URL}

	status, raw := client.call(http.MethodPost, "/api/daemon/sessions/"+session.ID+"/session-tokens", "", "")
	var minted struct {
		SessionToken string `json:"sessionToken"`
	}
	if status != http.StatusOK || json.Unmarshal(raw, &minted) != nil || minted.SessionToken == "" {
		t.Fatalf("session token for a timer turn = %d %s", status, raw)
	}
	if identity, err := backing.ResolveSessionToken(ctx, minted.SessionToken); err != nil || identity.SessionID != session.ID {
		t.Fatalf("minted token = %+v, %v", identity, err)
	}
	if status, _ := client.call(http.MethodPost, "/api/daemon/sessions/sess_missing/session-tokens", "", ""); status != http.StatusNotFound {
		t.Fatalf("token for an unknown session = %d, want 404", status)
	}
}
