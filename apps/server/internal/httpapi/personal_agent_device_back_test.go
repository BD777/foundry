package httpapi

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/personalagent"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// §6: when a computer that was away connects again, the conversation that
// handed a helper work there hears that it is back and what waited for it,
// as a server notice: helpers queued for it, which start by themselves,
// helpers still running there, a helper that failed while the computer
// was offline (it waited too long), a write refused for that reason. A
// connection that blinked tells nothing about the queued and running
// helpers, and nothing reaches a stopped assistant.
func TestAssistantHearsWhenAComputerIsBack(t *testing.T) {
	previous := coalesceNotices
	coalesceNotices = 0
	t.Cleanup(func() { coalesceNotices = previous })
	f := newDigestFixture(t)
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	agent, _ := f.db.GetPersonalAgent(ctx, f.aliceID)
	agent.Settings.Language = "en"
	if _, err := f.db.SavePersonalAgentSettings(ctx, f.aliceID, agent.Settings); err != nil {
		t.Fatal(err)
	}
	if err := f.db.RegisterDaemon(ctx, store.DaemonRegistration{
		Device:    store.DeviceProjection{ID: "dev_studio", Label: "Studio", Status: "connected"},
		Workspace: store.WorkspaceProjection{ID: "ws_photos", Name: "Photos", LocalPath: "/home/me/photos"},
		Agents: []store.AgentProjection{{ID: "agent_photos", WorkspaceID: "ws_photos", DeviceID: "dev_studio", Provider: "claude", Status: "healthy",
			AuthMode: "local_config", SecretStored: "local", ConfigScope: "workspace", ConfigLabel: "local", LastSeenLabel: "online"}},
	}); err != nil {
		t.Fatal(err)
	}
	if err := f.db.SetWorkspaceMember(ctx, "ws_photos", f.aliceID, store.WorkspaceRoleOwner, "test"); err != nil {
		t.Fatal(err)
	}
	conversation, err := f.server.createAndDispatch(ctx, store.CreateAgentSessionInput{
		CreatedByUserID: f.aliceID, WorkspaceID: "ws_pa", AgentID: "agent_pa", Provider: "claude", Prompt: "sort my photos", Source: "chat",
	}, false)
	if err != nil {
		t.Fatal(err)
	}
	f.daemon.complete(f.daemon.nextChatRun().Session, "On it.")
	waitForStatus(t, f.db, conversation.ID, "completed")
	quiet := func() {
		t.Helper()
		select {
		case run := <-f.daemon.runs:
			if run.Session.ID == conversation.ID {
				t.Fatalf("the conversation was told: %q", run.Session.Input.Prompt)
			}
		case <-time.After(300 * time.Millisecond):
		}
	}
	told := func() string {
		t.Helper()
		run := f.daemon.nextChatRun()
		if run.Session.ID != conversation.ID {
			t.Fatalf("a run of %s, want the conversation", run.Session.ID)
		}
		stored, _ := f.db.GetAgentSession(ctx, conversation.ID)
		if !personalagent.IsNotice(stored.Input.Prompt) {
			t.Fatalf("the news reads as the person's words: %q", stored.Input.Prompt)
		}
		f.daemon.complete(run.Session, "Noted.")
		waitForStatus(t, f.db, conversation.ID, "completed")
		return stored.Input.Prompt
	}
	connects := func(away time.Duration) {
		t.Helper()
		f.server.hub.disconnects.serverSide("dev_studio", errors.New("read timeout"), time.Now().Add(-away))
		f.server.hub.onDeviceConnected(ctx, "dev_studio", nil)
	}
	handOff := func(prompt string) store.AgentSession {
		t.Helper()
		helper, err := f.server.createAndDispatch(ctx, store.CreateAgentSessionInput{CreatedByUserID: f.aliceID, WorkspaceID: "ws_photos",
			AgentID: "agent_photos", Provider: "claude", Prompt: prompt, Source: "agent", ParentSessionID: conversation.ID}, false)
		if err != nil || helper.Status != "queued" {
			t.Fatalf("a helper on the offline Studio: %s %v", helper.Status, err)
		}
		return helper
	}

	// The Studio is offline: the helper waits for it. One that waited too
	// long fails, and the assistant hears so.
	failed := handOff("sort the photos by year")
	quiet()
	if err := f.server.expireDeviceWaits(ctx, time.Now().Add(offlineWaitLimit+time.Minute)); err != nil {
		t.Fatal(err)
	}
	if text := told(); !strings.Contains(text, "Failed:") || !strings.Contains(text, failed.ID) || !strings.Contains(text, "stayed offline") {
		t.Fatalf("failed notice: %q", text)
	}
	waiting := handOff("print the best ones")
	// Another helper ran there when the Studio went away.
	running, err := f.db.CreateAgentSession(ctx, store.CreateAgentSessionInput{CreatedByUserID: f.aliceID, WorkspaceID: "ws_photos",
		AgentID: "agent_photos", Provider: "claude", Prompt: "tag the faces", Source: "agent", ParentSessionID: conversation.ID})
	if err != nil {
		t.Fatal(err)
	}
	agent, _ = f.db.GetPersonalAgent(ctx, f.aliceID)
	f.server.recordAssistantTask(ctx, agent, conversation.ID, running)
	if _, err := f.db.StartAgentSession(ctx, running.ID); err != nil {
		t.Fatal(err)
	}

	// Seconds away: the queued and running helpers did not wait, the
	// failed one did.
	connects(5 * time.Second)
	if text := told(); !strings.Contains(text, `"Studio" is back online`) || !strings.Contains(text, failed.ID) || !strings.Contains(text, "failed while it was offline") ||
		strings.Contains(text, running.ID) || strings.Contains(text, waiting.ID) {
		t.Fatalf("back notice after a blink: %q", text)
	}
	connects(10 * time.Minute)
	if text := told(); !strings.Contains(text, running.ID) || !strings.Contains(text, "waited for it (now running)") ||
		!strings.Contains(text, waiting.ID) || !strings.Contains(text, "was queued for it and is starting by itself now") ||
		!strings.Contains(text, "do not send it again") || strings.Contains(text, failed.ID) {
		t.Fatalf("back notice: %q", text)
	}
	// The same return told again (a second hello on the connection): nothing.
	f.server.hub.onDeviceConnected(ctx, "dev_studio", nil)
	quiet()

	// A write refused because the computer was offline is told once it is
	// back; one refused for another reason is not.
	scope := paScope{agent: agent, sessionID: conversation.ID}
	refusal := &statusError{http.StatusConflict, ErrLocalDaemonNotConnected}
	f.server.noteOfflineRefusal(ctx, scope, "create_workspace", paWrite{argsSummary: `create "Albums" (empty)`, deviceID: "dev_studio"}, refusal)
	f.server.noteOfflineRefusal(ctx, scope, "update_workspace", paWrite{argsSummary: "rename", workspaceID: "ws_photos"}, errors.New("invalid name"))
	connects(5 * time.Second)
	if text := told(); !strings.Contains(text, `create_workspace: create "Albums" (empty)`) || strings.Contains(text, "rename") {
		t.Fatalf("refusal notice: %q", text)
	}

	// Nothing reaches a stopped assistant.
	f.server.noteOfflineRefusal(ctx, scope, "create_workspace", paWrite{argsSummary: `create "Albums" (empty)`, deviceID: "dev_studio"}, refusal)
	if _, err := f.db.SetPersonalAgentState(ctx, f.aliceID, store.PersonalAgentStopped); err != nil {
		t.Fatal(err)
	}
	connects(time.Hour)
	quiet()
}

// The assistant's write the lifecycle refuses because the computer is
// offline is kept for when that computer is back.
func TestAssistantWriteRefusedOfflineIsKeptForTheComputer(t *testing.T) {
	f := newAssistantFixture(t)
	lifecycleFor = func(*Server) workspaceLifecycle { return offlineLifecycle{f.lifecycle} }
	text, failed := f.tool(t, f.token, "create_workspace", map[string]any{"name": "Albums", "deviceId": "dev_alice", "source": map[string]any{"kind": "empty"}})
	if !failed || !strings.Contains(text, ErrLocalDaemonNotConnected.Error()) {
		t.Fatalf("create on an offline computer: %s", text)
	}
	refusals, _ := f.server.assistantDeviceWaits.back("dev_alice", "")
	if len(refusals) != 1 || refusals[0].conversationID != f.conversation.ID || !strings.Contains(refusals[0].line, `create_workspace: create "Albums"`) {
		t.Fatalf("refusals kept = %+v", refusals)
	}
}

type offlineLifecycle struct{ *fakeLifecycle }

func (offlineLifecycle) CreateWorkspace(context.Context, WorkspaceActor, WorkspaceCreateRequest) (store.WorkspaceProjection, error) {
	return store.WorkspaceProjection{}, &statusError{http.StatusConflict, ErrLocalDaemonNotConnected}
}
