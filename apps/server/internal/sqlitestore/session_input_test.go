package sqlitestore

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func TestSessionInputsContinueTheSameSession(t *testing.T) {
	ctx := context.Background()
	db := newTestStore(t)
	registerAgentSessionTestDaemon(t, db, "ws_input", "agent_input")
	session, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{WorkspaceID: "ws_input", AgentID: "agent_input", Provider: "codex", Prompt: "first"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.SendAgentSessionInput(ctx, session.ID, store.SendAgentSessionInput{Prompt: "too early"}); !errors.Is(err, store.ErrAgentSessionActive) {
		t.Fatalf("input while queued = %v, want ErrAgentSessionActive (steer instead)", err)
	}
	if _, err := db.CompleteAgentSession(ctx, session.ID, "first answer", "native_input"); err != nil {
		t.Fatal(err)
	}
	next, err := db.SendAgentSessionInput(ctx, session.ID, store.SendAgentSessionInput{Prompt: "second"})
	if err != nil {
		t.Fatal(err)
	}
	if next.ID != session.ID || next.Prompt != "first" || next.Input.Prompt != "second" || next.Input.ID == session.Input.ID {
		t.Fatalf("next input = %+v; want the same session keeping its goal with a new input", next)
	}
	if next.Status != "queued" || next.Response != "" || next.CompletedAt != "" || next.NativeSessionID != "native_input" {
		t.Fatalf("next input state = %+v; want queued on the same native session with the old answer cleared", next)
	}
	var rows int
	if err := db.conn().QueryRowContext(ctx, `SELECT COUNT(*) FROM agent_sessions WHERE workspace_id = 'ws_input'`).Scan(&rows); err != nil || rows != 1 {
		t.Fatalf("rows = %d, %v; a conversation is one session", rows, err)
	}
}

func TestSessionInputSwitchingRuntimeStartsANewNativeSession(t *testing.T) {
	ctx := context.Background()
	db := newTestStore(t)
	registerAgentSessionTestDaemon(t, db, "ws_switch", "agent_codex")
	if err := db.RegisterDaemon(ctx, store.DaemonRegistration{
		Device:    store.DeviceProjection{ID: "dev_ws_switch", Label: "Payload Device", Status: "connected", LastSeenLabel: "online"},
		Workspace: store.WorkspaceProjection{ID: "ws_switch", Name: "Payload Workspace", LocalPath: t.TempDir()},
		Agents: []store.AgentProjection{
			{ID: "agent_codex", WorkspaceID: "ws_switch", DeviceID: "dev_ws_switch", Provider: "codex", Status: "healthy", AuthMode: "local_config", SecretStored: "local", ConfigScope: "workspace", ConfigLabel: "local", LastSeenLabel: "online"},
			{ID: "agent_claude", WorkspaceID: "ws_switch", DeviceID: "dev_ws_switch", Provider: "claude", Status: "healthy", AuthMode: "local_config", SecretStored: "local", ConfigScope: "workspace", ConfigLabel: "local", LastSeenLabel: "online"},
		},
	}); err != nil {
		t.Fatal(err)
	}
	session, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{WorkspaceID: "ws_switch", AgentID: "agent_codex", Provider: "codex", Prompt: "first", Model: "gpt-6-astra", CodexReasoningEffort: "high"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.CompleteAgentSession(ctx, session.ID, "answer", "native_codex"); err != nil {
		t.Fatal(err)
	}
	switched, err := db.SendAgentSessionInput(ctx, session.ID, store.SendAgentSessionInput{
		AgentID: "agent_claude", Provider: "claude", Prompt: "continue on claude",
		ImportedContext: "earlier conversation", ProfileTransitionNote: "Switched to Claude",
	})
	if err != nil {
		t.Fatal(err)
	}
	if switched.ID != session.ID || switched.Provider != "claude" || switched.AgentID != "agent_claude" || switched.NativeSessionID != "" {
		t.Fatalf("switched = %+v; want the same session on claude with a fresh native session", switched)
	}
	// Codex's model and settings must not reach Claude.
	if switched.Model != "" || switched.CodexReasoningEffort != "" {
		t.Fatalf("switched session kept Codex's model %q / effort %q", switched.Model, switched.CodexReasoningEffort)
	}
	// Claude has not seen the conversation: the server tells it, not the client.
	if switched.Input.ImportedContext != "User: first\n\nAssistant: answer" {
		t.Fatalf("imported context = %q", switched.Input.ImportedContext)
	}
	// The device's record of the Codex conversation is still this chat.
	if owned, err := db.AgentSessionNativeSessions(ctx, session.ID); err != nil || len(owned) != 1 || owned[0].NativeSessionID != "native_codex" {
		t.Fatalf("owned native sessions = %+v, %v", owned, err)
	}
	if err := db.SyncChats(ctx, store.SyncChatsInput{WorkspaceID: "ws_switch", Chats: []store.ChatThread{
		{ID: "codex_record", WorkspaceID: "ws_switch", Provider: "codex", NativeSessionID: "native_codex"},
	}}); err != nil {
		t.Fatal(err)
	}
	if chats, err := db.ListChats(ctx, "ws_switch"); err != nil || len(chats) != 0 {
		t.Fatalf("the Codex record is listed as another chat: %+v %v", chats, err)
	}
	detail, err := db.GetAgentSession(ctx, session.ID)
	if err != nil {
		t.Fatal(err)
	}
	var kinds []string
	for _, event := range detail.Events {
		if event.Message != nil {
			kinds = append(kinds, event.Message.Kind)
		}
	}
	if len(kinds) != 3 || kinds[0] != "user" || kinds[1] != "boundary" || kinds[2] != "user" {
		t.Fatalf("transcript kinds = %v; want the first input, the transition boundary, then the new input", kinds)
	}
}

// Each input's answer stays in the transcript: a streamed answer is not
// repeated, and an answer only reported on completion is recorded, since the
// next input clears Response.
func TestEveryInputKeepsItsAnswerInTheTranscript(t *testing.T) {
	ctx := context.Background()
	db := newTestStore(t)
	registerAgentSessionTestDaemon(t, db, "ws_answer", "agent_answer")
	session, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{WorkspaceID: "ws_answer", AgentID: "agent_answer", Provider: "codex", Prompt: "first"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.CompleteAgentSession(ctx, session.ID, "reported only", "native"); err != nil {
		t.Fatal(err)
	}
	if _, err := db.SendAgentSessionInput(ctx, session.ID, store.SendAgentSessionInput{Prompt: "second"}); err != nil {
		t.Fatal(err)
	}
	if err := db.AppendAgentSessionEvent(ctx, store.AgentSessionEvent{ID: "evt_streamed", SessionID: session.ID, Label: "Response stream", Detail: "streamed", Level: "info"}); err != nil {
		t.Fatal(err)
	}
	if _, err := db.CompleteAgentSession(ctx, session.ID, "streamed", "native"); err != nil {
		t.Fatal(err)
	}
	detail, err := db.GetAgentSession(ctx, session.ID)
	if err != nil {
		t.Fatal(err)
	}
	var transcript []string
	for _, event := range detail.Events {
		if event.Message != nil {
			transcript = append(transcript, event.Message.Text)
		} else if event.Label == "Response stream" {
			transcript = append(transcript, event.Detail)
		}
	}
	if got := strings.Join(transcript, "|"); got != "first|reported only|second|streamed" {
		t.Fatalf("transcript = %s", got)
	}
}
