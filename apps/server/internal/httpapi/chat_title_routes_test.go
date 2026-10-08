package httpapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// The chat list names Foundry sessions (sess_…) as well as native chats, and
// renames either; the access check must find a session's workspace.
func TestChatTitleRoutesAcceptASessionID(t *testing.T) {
	fixture := setupProjectedSessionFixture(t)
	session, err := fixture.backing.CreateAgentSession(context.Background(), store.CreateAgentSessionInput{
		AgentID:     fixture.agentID,
		WorkspaceID: fixture.workspace.ID,
		Provider:    "claude",
		ProfileID:   fixture.profile.ID,
		Prompt:      "synthetic",
		Source:      "chat",
	})
	if err != nil {
		t.Fatalf("create session: %v", err)
	}
	body := `{"title":"Renamed","workspaceId":` + jsonString(fixture.workspace.ID) + `}`
	requestForTest(t, fixture.server, http.MethodPost, "/api/chats/"+session.ID+"/title", body, http.StatusOK)
	requestForTest(t, fixture.server, http.MethodPost, "/api/chats/sess_missing/title", body, http.StatusNotFound)
	// Recap reaches its handler too; with no device connected it cannot start.
	recap := httptest.NewRecorder()
	fixture.server.Routes().ServeHTTP(recap, httptest.NewRequest(http.MethodPost, "/api/chats/"+session.ID+"/recap-title",
		strings.NewReader(`{"workspaceId":`+jsonString(fixture.workspace.ID)+`}`)))
	if recap.Code == http.StatusNotFound {
		t.Fatalf("recap of a session was refused as not found: %s", recap.Body.String())
	}
}

// A chat that ran on a server connection (a projected agent, never in the
// device's agent list) can still be named while its device is connected.
func TestRecapNamesAChatThatRanOnAServerConnection(t *testing.T) {
	fixture := setupProjectedSessionFixture(t)
	session, err := fixture.backing.CreateAgentSession(context.Background(), store.CreateAgentSessionInput{
		AgentID:     fixture.agentID,
		WorkspaceID: fixture.workspace.ID,
		Provider:    "claude",
		ProfileID:   fixture.profile.ID,
		Prompt:      "Fix the flaky login test",
		Source:      "chat",
	})
	if err != nil {
		t.Fatalf("create session: %v", err)
	}
	connection := newDaemonConnection(fixture.server.hub, nil)
	fixture.server.hub.connections[fixture.deviceID] = connection
	defer close(connection.done)
	go func() {
		for {
			select {
			case <-connection.done:
				return
			case <-connection.send:
			}
		}
	}()
	body := `{"workspaceId":` + jsonString(fixture.workspace.ID) + `}`
	requestForTest(t, fixture.server, http.MethodPost, "/api/chats/"+session.ID+"/recap-title", body, http.StatusAccepted)
}
