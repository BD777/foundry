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

// A message about the draft goes to the Issue's clarification session; the
// reply the device reports lands in the Issue conversation.
func TestIssueClarificationRunsAsTheIssuesSession(t *testing.T) {
	db := newTestStore(t)
	ctx := context.Background()
	server := NewServer(db)
	registration := store.DaemonRegistration{Capabilities: []string{store.DaemonCapabilityIssueClarification}, Device: store.DeviceProjection{ID: "dev_clarify"}, Workspace: store.WorkspaceProjection{ID: "ws_clarify"}}
	if err := db.RegisterDaemon(ctx, registration); err != nil {
		t.Fatal(err)
	}
	issue, err := db.CreateIssue(ctx, store.CreateIssueInput{WorkspaceID: "ws_clarify", SourceInput: "make the greeting friendlier", Runtime: "claude"})
	if err != nil {
		t.Fatal(err)
	}
	draft := firstDraft(t, db, issue.ID)
	ask := func(key string) *httptest.ResponseRecorder {
		body, _ := json.Marshal(map[string]any{"expectedRevision": 1, "expectedContentDigest": draft.ContentDigest, "message": "Which file holds the greeting?", "changeReason": "Clarify the target"})
		request := httptest.NewRequest(http.MethodPost, "/api/issues/"+issue.ID+"/clarify", strings.NewReader(string(body)))
		request.Header.Set("Idempotency-Key", key)
		response := httptest.NewRecorder()
		server.Routes().ServeHTTP(response, request)
		return response
	}
	if response := ask("offline"); response.Code != http.StatusConflict || !strings.Contains(response.Body.String(), "worker_offline") {
		t.Fatalf("clarification without the device: %d %s", response.Code, response.Body.String())
	}
	connection := &daemonConnection{hub: server.hub, done: make(chan struct{}), send: make(chan wsEnvelope, 8), rpc: newDaemonRPC(), deviceID: "dev_clarify",
		dispatchedSessions: map[string]string{}, activeSessions: map[string]bool{}}
	server.hub.connections["dev_clarify"] = connection
	if response := ask("outdated"); response.Code != http.StatusConflict || !strings.Contains(response.Body.String(), "worker_outdated") {
		t.Fatalf("an older worker must not run clarification as a chat: %d %s", response.Code, response.Body.String())
	}
	connection.registration = registration

	response := ask("ask")
	if response.Code != http.StatusOK {
		t.Fatalf("clarify: %d %s", response.Code, response.Body.String())
	}
	var asked store.Issue
	if err := json.Unmarshal(response.Body.Bytes(), &asked); err != nil {
		t.Fatal(err)
	}
	if asked.Clarification == nil || asked.Clarification.Status != "replying" || len(asked.Messages) != 1 {
		t.Fatalf("the message is not waiting for a reply: %#v %#v", asked.Clarification, asked.Messages)
	}
	if len(connection.send) != 1 {
		t.Fatalf("the clarification input was not dispatched, %d messages", len(connection.send))
	}
	envelope := <-connection.send
	var dispatched wsRunSessionPayload
	if err := json.Unmarshal(envelope.Payload, &dispatched); err != nil {
		t.Fatal(err)
	}
	session := dispatched.Session
	if envelope.Type != wsRunSessionType || session.Role != store.AgentSessionRoleIssueClarification || session.IssueID != issue.ID ||
		dispatched.Clarification == nil || dispatched.Clarification.Message != "Which file holds the greeting?" || dispatched.Clarification.Draft.Revision != 1 {
		t.Fatalf("dispatch did not carry the clarification turn: %#v", dispatched)
	}
	if replay := ask("ask"); replay.Code != http.StatusOK || len(connection.send) != 0 {
		t.Fatalf("a replayed request sent the input again: %d, %d messages", replay.Code, len(connection.send))
	}
	message := httptest.NewRecorder()
	server.Routes().ServeHTTP(message, httptest.NewRequest(http.MethodPost, "/api/agent-sessions/"+session.ID+"/messages", strings.NewReader(`{"prompt":"hi"}`)))
	if message.Code != http.StatusConflict {
		t.Fatalf("the clarification session took a message outside its Issue: %d %s", message.Code, message.Body.String())
	}

	for _, message := range []struct {
		kind    string
		payload any
	}{
		{wsSessionStartedType, wsSessionStartedPayload{SessionID: session.ID, InputID: session.Input.ID}},
		{wsSessionCompleteType, wsSessionCompletedPayload{SessionID: session.ID, InputID: session.Input.ID, Response: "greet.mjs", NativeSessionID: "native-1",
			ClarificationResult: &store.ClarificationResponse{Message: "It is in greet.mjs. Should the farewell match?"}}},
	} {
		raw, _ := json.Marshal(message.payload)
		if err := connection.handleEnvelope(ctx, wsEnvelope{Type: message.kind, Payload: raw}); err != nil {
			t.Fatal(err)
		}
	}
	answered, err := db.GetIssue(ctx, issue.ID)
	if err != nil {
		t.Fatal(err)
	}
	if answered.Clarification.Status != "answered" || len(answered.Messages) != 2 || answered.Messages[1].Text != "It is in greet.mjs. Should the farewell match?" || answered.Status != "blocked" {
		t.Fatalf("the reply did not reach the Issue: %#v %#v", answered.Clarification, answered.Messages)
	}
}

// The clarification session's token reads its workspace and nothing more.
func TestClarificationTokenOnlyReads(t *testing.T) {
	db := newTestStore(t)
	ctx := context.Background()
	server := NewServer(db)
	if err := db.RegisterDaemon(ctx, store.DaemonRegistration{Device: store.DeviceProjection{ID: "dev_read"}, Workspace: store.WorkspaceProjection{ID: "ws_read"}}); err != nil {
		t.Fatal(err)
	}
	issue, err := db.CreateIssue(ctx, store.CreateIssueInput{WorkspaceID: "ws_read", SourceInput: "tidy the README", Runtime: "claude"})
	if err != nil {
		t.Fatal(err)
	}
	draft := firstDraft(t, db, issue.ID)
	_, session, err := db.AskClarification(ctx, store.AskClarificationInput{IssueID: issue.ID, Revision: 1, ContentDigest: draft.ContentDigest, Message: "what is in the README?", ChangeReason: "Clarify"},
		store.ActorRef{Kind: "local_owner", ID: "owner"}, "ask")
	if err != nil {
		t.Fatal(err)
	}
	scope, err := server.agentScope(ctx, db, Actor{Kind: ActorAgent, Identity: store.SessionTokenIdentity{SessionID: session.ID, WorkspaceID: "ws_read"}})
	if err != nil {
		t.Fatal(err)
	}
	if !scope.can("ws_read", store.WorkspaceRoleViewer) || scope.can("ws_read", store.WorkspaceRoleMember) {
		t.Fatalf("clarification scope = %#v", scope.roles)
	}
}

func firstDraft(t *testing.T, st store.EvidenceStore, issueID string) store.IssueContract {
	t.Helper()
	records, err := st.ListEvidenceRecords(context.Background(), issueID, "contract")
	if err != nil || len(records) == 0 {
		t.Fatal("no draft", err)
	}
	var draft store.IssueContract
	if err := json.Unmarshal(records[0], &draft); err != nil {
		t.Fatal(err)
	}
	return draft
}
