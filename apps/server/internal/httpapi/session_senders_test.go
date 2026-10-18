package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// A link to a session names its chat as the list shows it, for whoever may
// view it; to anyone else the session does not exist.
func TestSessionLinkNamesTheChatOnlyForItsViewers(t *testing.T) {
	f := newIsolationFixture(t)
	ctx := context.Background()
	db := f.server.store
	if err := db.RegisterDaemon(ctx, store.DaemonRegistration{
		Device:    store.DeviceProjection{ID: "dev_alice", Label: "Device", Status: "connected", LastSeenLabel: "online"},
		Workspace: store.WorkspaceProjection{ID: "ws_alice", Name: "W", LocalPath: "/tmp/w"},
		Agents: []store.AgentProjection{{
			ID: "agent_alice", WorkspaceID: "ws_alice", DeviceID: "dev_alice", Provider: "claude", Status: "healthy",
			AuthMode: "local_config", SecretStored: "local", ConfigScope: "workspace", ConfigLabel: "local", LastSeenLabel: "online",
		}},
	}); err != nil {
		t.Fatal(err)
	}
	session, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{
		CreatedByUserID: f.aliceID, WorkspaceID: "ws_alice", AgentID: "agent_alice", Provider: "claude", Prompt: "research the scheduler",
	})
	if err != nil {
		t.Fatal(err)
	}
	path := "/api/agent-sessions/" + session.ID + "/link"
	read := func(as string) store.SessionLink {
		t.Helper()
		recorder := doAuthCall(t, f.handler, f.as(as, http.MethodGet, path, ""))
		expectStatus(t, recorder, http.StatusOK, "read link")
		var link store.SessionLink
		if err := json.Unmarshal(recorder.Body.Bytes(), &link); err != nil {
			t.Fatal(err)
		}
		return link
	}
	if link := read(f.alice); link != (store.SessionLink{ID: session.ID, WorkspaceID: "ws_alice", Title: session.Title}) {
		t.Fatalf("link = %+v, want the session's own title before its chat is named", link)
	}
	if _, err := db.RenameChat(ctx, session.ID, store.RenameChatInput{WorkspaceID: "ws_alice", Title: "Scheduler research"}); err != nil {
		t.Fatal(err)
	}
	if link := read(f.alice); link.Title != "Scheduler research" {
		t.Fatalf("link = %+v, want the chat's title", link)
	}
	denied := doAuthCall(t, f.handler, f.as(f.bob, http.MethodGet, path, ""))
	if denied.Code == http.StatusOK || strings.Contains(denied.Body.String(), "Scheduler") {
		t.Fatalf("a stranger reads the link: %d %s", denied.Code, denied.Body.String())
	}
}

// A message one session sends another names the sender on its transcript
// event; the person's own messages name nobody.
func TestSendMessageNamesTheSendingSession(t *testing.T) {
	db, parent := lineageFixture(t)
	ctx := context.Background()
	child, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{
		WorkspaceID: "ws_lineage", AgentID: "agent_lineage", Provider: "claude", Prompt: "child", Source: "agent", ParentSessionID: parent.ID,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.CompleteAgentSession(ctx, child.ID, "done", ""); err != nil {
		t.Fatal(err)
	}
	token, err := db.MintAgentSessionToken(ctx, parent.ID)
	if err != nil {
		t.Fatal(err)
	}
	call := mcpToolCaller(t, NewServer(db).Routes(), token)
	if text, isError := call("send_message", map[string]any{"sessionId": child.ID, "prompt": "Also check the docs."}); isError {
		t.Fatalf("send_message = %q", text)
	}
	sent, err := db.GetAgentSession(ctx, child.ID)
	if err != nil {
		t.Fatal(err)
	}
	if sent.Input.SentBySessionID != parent.ID {
		t.Fatalf("input = %+v, want it sent by %s", sent.Input, parent.ID)
	}
	for _, event := range sent.Events {
		if event.ID == "evt_"+sent.Input.ID {
			if event.Metadata == nil || event.Metadata.SentBySessionID != parent.ID {
				t.Fatalf("input event = %+v, want it to name %s", event, parent.ID)
			}
			return
		}
	}
	t.Fatalf("no event for the input in %+v", sent.Events)
}

// A message steered into a running turn is written by its device; the
// server names its sender on the event when it arrives.
func TestSteeredMessageNamesTheSendingSession(t *testing.T) {
	db, parent := lineageFixture(t)
	ctx := context.Background()
	server := NewServer(db)
	input := store.SendAgentSessionInput{Prompt: "Also check the docs.", SentBySessionID: parent.ID}
	if err := server.recordSteerSender(ctx, "sess_running", &input); err != nil {
		t.Fatal(err)
	}
	if !store.ValidSessionInputID(input.InputID) {
		t.Fatalf("steer input id = %q, want one the device names its event by", input.InputID)
	}
	steered := store.AgentSessionEvent{ID: "evt_" + input.InputID, SessionID: "sess_running", Label: steeredIntoTurnLabel, Detail: input.Prompt, Level: "info"}
	named := server.hub.withSteerSender(ctx, steered)
	if named.Metadata == nil || named.Metadata.SentBySessionID != parent.ID {
		t.Fatalf("steered event = %+v, want it to name %s", named, parent.ID)
	}
	for _, event := range []store.AgentSessionEvent{
		{ID: "evt_typed", SessionID: "sess_running", Label: steeredIntoTurnLabel, Detail: "typed", Level: "info"},
		{ID: "evt_" + input.InputID, SessionID: "sess_running", Label: "Response stream", Detail: "answer", Level: "info"},
	} {
		if got := server.hub.withSteerSender(ctx, event); got.Metadata != nil {
			t.Fatalf("event %+v named a sender: %+v", event, got.Metadata)
		}
	}
	typed := store.SendAgentSessionInput{Prompt: "from the person"}
	if err := server.recordSteerSender(ctx, "sess_running", &typed); err != nil || !store.ValidSessionInputID(typed.InputID) {
		t.Fatalf("person's steer: id %q, %v; want stable input identity", typed.InputID, err)
	}
	if got := server.hub.withSteerSender(ctx, store.AgentSessionEvent{ID: "evt_" + typed.InputID, SessionID: "sess_running", Label: steeredIntoTurnLabel}); got.Metadata != nil {
		t.Fatalf("person's steer unexpectedly named a session sender: %+v", got.Metadata)
	}
}
