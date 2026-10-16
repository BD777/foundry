package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/feishu"
	"github.com/foundry-dev/foundry/apps/server/internal/personalagent"
	"github.com/foundry-dev/foundry/apps/server/internal/personalagent/prompt"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// nextChatRun is the next run of a session that is not Foundry's own (a
// digest summary, naming a chat).
func (d *digestDaemon) nextChatRun() wsRunSessionPayload {
	d.t.Helper()
	for {
		if run := d.nextRun(); run.Session.Source != store.DigestSessionSource && run.Session.Source != "naming" {
			return run
		}
	}
}

// Every run of the person's conversation with the assistant runs as the
// assistant, with its instructions, and its input carries Foundry's context
// for the turn after the person's words; the stored input stays theirs. A
// later run whose only news is the time and the work in progress has the
// same instructions byte for byte. A helper the assistant starts is an
// ordinary session.
func TestAssistantRunsCarryItsInstructionsAndTheTurnsContext(t *testing.T) {
	f := newDigestFixture(t)
	ctx := context.Background()
	conversation, err := f.server.createAndDispatch(ctx, store.CreateAgentSessionInput{
		CreatedByUserID: f.aliceID, WorkspaceID: "ws_pa", AgentID: "agent_pa", Provider: "claude", Prompt: "plan my week", Source: "chat",
	}, false)
	if err != nil {
		t.Fatal(err)
	}
	first := f.daemon.nextChatRun()
	if first.Session.ID != conversation.ID || first.Session.Role != store.AgentSessionRolePersonalAgent {
		t.Fatalf("the conversation ran as %+v", first.Session)
	}
	if !strings.HasPrefix(first.PersonalAgentInstructions, "You are ") || !strings.Contains(first.PersonalAgentInstructions, `"Budget" [ws_budget]`) {
		t.Fatalf("instructions:\n%s", first.PersonalAgentInstructions)
	}
	prompt1 := first.Session.Input.Prompt
	if !strings.HasPrefix(prompt1, "plan my week\n\n"+prompt.TurnContextStart) || !strings.HasSuffix(prompt1, prompt.TurnContextEnd) {
		t.Fatalf("the turn's input: %q", prompt1)
	}
	if stored, _ := f.db.GetAgentSession(ctx, conversation.ID); stored.Input.Prompt != "plan my week" {
		t.Fatalf("the stored input became %q", stored.Input.Prompt)
	}

	agent, _ := f.db.GetPersonalAgent(ctx, f.aliceID)
	// In the assistant's own folder: a first session in a project would be
	// news of the project (its day of last activity).
	helper, err := f.db.CreateAgentSession(ctx, store.CreateAgentSessionInput{CreatedByUserID: f.aliceID, WorkspaceID: "ws_pa",
		AgentID: "agent_pa", Provider: "claude", Prompt: "add an export", Source: "agent", ParentSessionID: conversation.ID})
	if err != nil {
		t.Fatal(err)
	}
	f.server.recordAssistantTask(ctx, agent, conversation.ID, helper)
	if run, ok, err := f.server.assistantRunFor(ctx, helper); ok || err != nil || run.Instructions != "" {
		t.Fatalf("a helper ran as the assistant: %v %v", ok, err)
	}

	f.daemon.complete(first.Session, "Here is your week.")
	waitForStatus(t, f.db, conversation.ID, "completed")
	if _, err := f.server.sendSessionMessage(ctx, conversation.ID, store.SendAgentSessionInput{Prompt: "and the next one"}); err != nil {
		t.Fatal(err)
	}
	second := f.daemon.nextChatRun()
	if second.Session.ID != conversation.ID {
		t.Fatalf("second run %+v", second.Session)
	}
	if second.PersonalAgentInstructions != first.PersonalAgentInstructions {
		t.Fatalf("the instructions changed with only the turn's state: %s", firstDifference(first.PersonalAgentInstructions, second.PersonalAgentInstructions))
	}
	if !strings.HasPrefix(second.Session.Input.Prompt, "and the next one\n\n") || !strings.Contains(second.Session.Input.Prompt, "add an export") {
		t.Fatalf("the second turn's context misses the new task: %q", second.Session.Input.Prompt)
	}
}

func waitForStatus(t *testing.T, db interface {
	GetAgentSessionSummary(context.Context, string) (store.AgentSession, error)
}, sessionID, status string) store.AgentSession {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		session, err := db.GetAgentSessionSummary(context.Background(), sessionID)
		if err == nil && session.Status == status {
			return session
		}
		if time.Now().After(deadline) {
			t.Fatalf("%s is %q, want %q (%v)", sessionID, session.Status, status, err)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// Setting up primes every project the person can read, past the hourly
// summary rate, at most digestPrimeConcurrency at a time: the next starts
// as one ends.
func TestSetupPrimesEveryProjectAFewAtATime(t *testing.T) {
	f := newDigestFixture(t)
	ctx := context.Background()
	projects := personalagent.DigestMigrationRate + 2
	for i := 1; i < projects; i++ {
		id := fmt.Sprintf("ws_p%02d", i)
		if err := f.db.RegisterDaemon(ctx, store.DaemonRegistration{
			Device:    store.DeviceProjection{ID: "dev_home", Label: "MacBook", Status: "connected"},
			Workspace: store.WorkspaceProjection{ID: id, Name: id, LocalPath: "/home/me/" + id},
		}); err != nil {
			t.Fatal(err)
		}
		if err := f.db.SetWorkspaceMember(ctx, id, f.aliceID, store.WorkspaceRoleOwner, "test"); err != nil {
			t.Fatal(err)
		}
	}
	f.server.primeAssistantDigests(ctx, f.aliceID)
	summarized := map[string]bool{}
	for len(summarized) < projects {
		run := f.daemon.nextRun()
		if running, _ := f.server.runningDigestSummaries(ctx, f.aliceID); running > digestPrimeConcurrency {
			t.Fatalf("%d first summaries run at once", running)
		}
		record, err := f.db.WorkspaceDigestForSummarySession(ctx, run.Session.ID)
		if err != nil {
			t.Fatal(err)
		}
		summarized[record.Digest.WorkspaceID] = true
		f.daemon.complete(run.Session, `{"l0":"A project","summary":"A project.","routeWhen":[],"notWhen":[]}`)
	}
}

// §6: a helper that ends tells the conversation that handed it off, as
// Foundry, never as the person; one asking a question leaves its task
// asking; a quiet one is reported once per silence; nothing reaches a
// stopped assistant.
func TestHandedOffWorkReportsBackToTheAssistant(t *testing.T) {
	f := newDigestFixture(t)
	ctx := context.Background()
	agent, _ := f.db.GetPersonalAgent(ctx, f.aliceID)
	agent.Settings.Language = "en"
	if _, err := f.db.SavePersonalAgentSettings(ctx, f.aliceID, agent.Settings); err != nil {
		t.Fatal(err)
	}
	conversation, err := f.server.createAndDispatch(ctx, store.CreateAgentSessionInput{
		CreatedByUserID: f.aliceID, WorkspaceID: "ws_pa", AgentID: "agent_pa", Provider: "claude", Prompt: "make the export", Source: "chat",
	}, false)
	if err != nil {
		t.Fatal(err)
	}
	f.daemon.complete(f.daemon.nextChatRun().Session, "On it.")
	waitForStatus(t, f.db, conversation.ID, "completed")
	handOff := func(prompt string) store.AgentSession {
		t.Helper()
		if _, err := f.server.createAndDispatch(ctx, store.CreateAgentSessionInput{CreatedByUserID: f.aliceID, WorkspaceID: "ws_budget",
			AgentID: "agent_budget", Provider: "claude", Prompt: prompt, Source: "agent", ParentSessionID: conversation.ID}, false); err != nil {
			t.Fatal(err)
		}
		return f.daemon.nextChatRun().Session
	}
	notice := func() string {
		t.Helper()
		run := f.daemon.nextChatRun()
		if run.Session.ID != conversation.ID {
			t.Fatalf("a run of %s, want the conversation", run.Session.ID)
		}
		stored, _ := f.db.GetAgentSession(ctx, conversation.ID)
		if _, personWrote := personalagent.PersonWords(stored.Input); !personalagent.IsNotice(stored.Input.Prompt) || personWrote {
			t.Fatalf("the report reads as the person's words: %q", stored.Input.Prompt)
		}
		if strings.Count(stored.Input.Prompt, strings.TrimSpace(personalagent.NoticePrefix)) != 1 {
			t.Fatalf("the report is marked as Foundry's more than once: %q", stored.Input.Prompt)
		}
		f.daemon.complete(run.Session, "Noted.")
		waitForStatus(t, f.db, conversation.ID, "completed")
		return stored.Input.Prompt
	}

	finished := handOff("add an Excel export")
	f.daemon.complete(finished, "Added the export.")
	if text := notice(); !strings.Contains(text, "Finished:") || !strings.Contains(text, "Added the export.") || !strings.Contains(text, "read_context") ||
		!strings.Contains(text, f.server.sessionURL(finished)) || !strings.Contains(f.server.sessionURL(finished), "/chats/"+finished.ID+"?workspace=ws_budget") {
		t.Fatalf("finished notice: %q", text)
	}

	previous := coalesceNotices
	coalesceNotices = 0
	t.Cleanup(func() { coalesceNotices = previous })
	asking := handOff("pick a chart")
	f.daemon.complete(asking, "Bars or lines?")
	if text := notice(); !strings.Contains(text, "Ended with a question") || !strings.Contains(text, "Bars or lines?") {
		t.Fatalf("question notice: %q", text)
	}
	tasks, _ := f.db.ListPersonalAgentTasks(ctx, f.aliceID, []string{store.PersonalAgentTaskAsking})
	if len(tasks) != 1 || tasks[0].SessionID != asking.ID {
		t.Fatalf("asking tasks = %+v", tasks)
	}

	quiet := handOff("a long job")
	if _, err := f.db.StartAgentSession(ctx, quiet.ID); err != nil {
		t.Fatal(err)
	}
	later := time.Now().Add(personalagent.TaskSilentAfter + time.Minute)
	if err := f.server.superviseAssistantTasks(ctx, later); err != nil {
		t.Fatal(err)
	}
	if text := notice(); !strings.Contains(text, "No news for 30 minutes") {
		t.Fatalf("silence notice: %q", text)
	}
	if err := f.server.superviseAssistantTasks(ctx, later.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	if _, err := f.server.StopPersonalAgent(ctx, f.aliceID); err != nil {
		t.Fatal(err)
	}
	select {
	case run := <-f.daemon.runs:
		if run.Session.ID == conversation.ID {
			t.Fatalf("the conversation was told again: %q", run.Session.Input.Prompt)
		}
	case <-time.After(300 * time.Millisecond):
	}
}

// §2, §7: a helper's news goes to the conversation that last sent it
// work: after the assistant moved to another computer, the conversation
// that first handed it off is in a project that is no longer the
// assistant's, and nothing there would read it.
func TestHelperNewsFollowsTheConversationThatSentItWork(t *testing.T) {
	previous := coalesceNotices
	coalesceNotices = 0
	t.Cleanup(func() { coalesceNotices = previous })
	f := newDigestFixture(t)
	ctx := context.Background()
	converse := func(workspaceID, agentID, prompt string) store.AgentSession {
		t.Helper()
		conversation, err := f.server.createAndDispatch(ctx, store.CreateAgentSessionInput{
			CreatedByUserID: f.aliceID, WorkspaceID: workspaceID, AgentID: agentID, Provider: "claude", Prompt: prompt, Source: "chat",
		}, false)
		if err != nil {
			t.Fatal(err)
		}
		f.daemon.complete(f.daemon.nextChatRun().Session, "On it.")
		waitForStatus(t, f.db, conversation.ID, "completed")
		return conversation
	}
	toldIs := func(want string) {
		t.Helper()
		run := f.daemon.nextChatRun()
		if run.Session.ID != want || !personalagent.IsNotice(run.Session.Input.Prompt) {
			t.Fatalf("the helper's news went to %s (%q), want %s", run.Session.ID, run.Session.Input.Prompt, want)
		}
		f.daemon.complete(run.Session, "Noted.")
		waitForStatus(t, f.db, want, "completed")
	}

	first := converse("ws_pa", "agent_pa", "make the export")
	if _, err := f.server.createAndDispatch(ctx, store.CreateAgentSessionInput{CreatedByUserID: f.aliceID, WorkspaceID: "ws_budget",
		AgentID: "agent_budget", Provider: "claude", Prompt: "add an Excel export", Source: "agent", ParentSessionID: first.ID}, false); err != nil {
		t.Fatal(err)
	}
	helper := f.daemon.nextChatRun().Session
	f.daemon.complete(helper, "Added the export.")
	toldIs(first.ID)

	// The assistant moves to a new folder; its old one becomes a project.
	if err := f.db.RegisterDaemon(ctx, store.DaemonRegistration{
		Device:    store.DeviceProjection{ID: "dev_home", Label: "MacBook", Status: "connected"},
		Workspace: store.WorkspaceProjection{ID: "ws_pa2", Name: "Assistant", LocalPath: "/home/me/Foundry/personal-agent-2"},
		Agents: []store.AgentProjection{{ID: "agent_pa2", WorkspaceID: "ws_pa2", DeviceID: "dev_home", Provider: "claude", Status: "healthy",
			AuthMode: "local_config", SecretStored: "local", ConfigScope: "workspace", ConfigLabel: "local", LastSeenLabel: "online"}},
	}); err != nil {
		t.Fatal(err)
	}
	if err := f.db.SetWorkspaceMember(ctx, "ws_pa2", f.aliceID, store.WorkspaceRoleOwner, "test"); err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.MovePersonalAgentHome(ctx, f.aliceID, "ws_pa2", "dev_home"); err != nil {
		t.Fatal(err)
	}
	second := converse("ws_pa2", "agent_pa2", "and a chart")
	waitForStatus(t, f.db, helper.ID, "completed")
	f.server.adoptAssistantTask(ctx, Actor{Kind: ActorAgent, Identity: store.SessionTokenIdentity{SessionID: second.ID, WorkspaceID: "ws_pa2"}}, helper)
	if _, err := f.server.sendSessionMessage(ctx, helper.ID, store.SendAgentSessionInput{Prompt: "add a chart"}); err != nil {
		t.Fatal(err)
	}
	again := f.daemon.nextChatRun().Session
	if again.ID != helper.ID {
		t.Fatalf("a run of %s, want the helper", again.ID)
	}
	f.daemon.complete(again, "Added the chart.")
	toldIs(second.ID)
	if tasks, _ := f.db.ListPersonalAgentTasks(ctx, f.aliceID, nil); len(tasks) != 1 || tasks[0].ConversationSessionID != second.ID || tasks[0].Status != store.PersonalAgentTaskDone {
		t.Fatalf("tasks = %+v", tasks)
	}
}

// Task events to one conversation within the window go as one.
func TestAssistantNoticesCoalesce(t *testing.T) {
	previous := coalesceNotices
	coalesceNotices = 100 * time.Millisecond
	t.Cleanup(func() { coalesceNotices = previous })
	var notices assistantNotices
	sent := make(chan string, 4)
	send := func(text string) { sent <- text }
	now := time.Now()
	notices.add("sess_c", "en", "first", now, send)
	notices.add("sess_c", "en", "second", now, send)
	notices.add("sess_c", "en", "third", now, send)
	if text := <-sent; text != "first" {
		t.Fatalf("first = %q", text)
	}
	select {
	case text := <-sent:
		if !strings.Contains(text, "2 updates") || !strings.Contains(text, "- second\n- third") {
			t.Fatalf("coalesced = %q", text)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("the gathered notices were never sent")
	}
}

// The Feishu desk acts for the person the chat is bound to only: another
// person's proposal is not found; the fixed words are the design's; a
// migrated chat is introduced once.
func TestFeishuDeskActsForThePairedPersonOnly(t *testing.T) {
	f := newAssistantFixture(t)
	ctx := context.Background()
	desk := personalAgentDesk{f.server}
	f.setPolicy(t, store.PersonalAgentActionArchive, store.PersonalAgentAsk)
	text, _ := f.tool(t, f.token, "archive_workspace", map[string]any{"workspaceId": "ws_alice"})
	var proposed store.PersonalAgentNeedsConfirmation
	if err := json.Unmarshal([]byte(text), &proposed); err != nil || proposed.ProposalID == "" {
		t.Fatalf("archive proposed %s", text)
	}
	pending, err := desk.PendingProposals(ctx, f.aliceID)
	if err != nil || len(pending) != 1 || pending[0].ID != proposed.ProposalID {
		t.Fatalf("pending = %+v %v", pending, err)
	}
	if _, err := desk.Accept(ctx, f.bobID, proposed.ProposalID, store.PersonalAgentViaFeishu); err == nil || errorStatus(err) != http.StatusNotFound {
		t.Fatalf("bob accepted alice's proposal: %v", err)
	}
	accepted, err := desk.Accept(ctx, f.aliceID, proposed.ProposalID, store.PersonalAgentViaFeishu)
	if err != nil || accepted.Status != store.PersonalAgentProposalApplied || !strings.Contains(strings.Join(f.lifecycle.calls, ";"), "archive ws_alice") {
		t.Fatalf("accepted = %+v %v, calls %v", accepted, err, f.lifecycle.calls)
	}

	for text, want := range map[string]string{"停": feishu.PersonalAgentWordStop, "resume": feishu.PersonalAgentWordResume, "好的": feishu.PersonalAgentWordAccept, "算了": feishu.PersonalAgentWordDecline, "停一下那个": ""} {
		if got := desk.Word(text); got != want {
			t.Errorf("Word(%q) = %q, want %q", text, got, want)
		}
	}

	route, ok, err := desk.Route(ctx, f.aliceID, "xapp_1", "ws_alice")
	if err != nil || !ok || route.WorkspaceID != "ws_pa" || !route.TakesDirectChats || !route.Introduce || !strings.HasSuffix(route.SettingsURL, personalagent.SettingsPath) {
		t.Fatalf("route = %+v %v %v", route, ok, err)
	}
	if !desk.ClaimIntroduction(ctx, f.aliceID, "xapp_1") || desk.ClaimIntroduction(ctx, f.aliceID, "xapp_1") {
		t.Fatal("the introduction is claimed once")
	}
	if route, _, _ = desk.Route(ctx, f.aliceID, "xapp_1", "ws_alice"); route.Introduce {
		t.Fatal("an introduced chat is introduced again")
	}
	if _, ok, _ := desk.Route(ctx, f.bobID, "xapp_1", "ws_bob"); ok {
		t.Fatal("bob, without an assistant, has one")
	}
}

// Setting up writes the folder's AGENTS.md; moving makes a new folder on
// the other computer, keeps the assistant's records and archives the old
// folder as a project of the person's. Only the person moves it, and only
// to a computer of theirs.
func TestSetupAndMovingTheAssistantsHome(t *testing.T) {
	f := newAssistantFixture(t)
	ctx := context.Background()
	setupCall := f.as(f.bob, http.MethodPost, "/api/personal-agent", `{"deviceId":"dev_bob","timezone":"Europe/London"}`)
	setupCall.headers["Accept-Language"] = "en-GB,en;q=0.9"
	created := doAuthCall(t, f.handler, setupCall)
	expectStatus(t, created, http.StatusCreated, "bob sets up his assistant")
	var bobs store.PersonalAgent
	_ = json.Unmarshal(created.Body.Bytes(), &bobs)
	if bobs.Settings.Language != "en" {
		t.Fatalf("bob's browser asks for English, his assistant speaks %q", bobs.Settings.Language)
	}
	if bobs.Settings.Timezone != "Europe/London" {
		t.Fatalf("bob's browser is in London, his assistant's time zone is %q", bobs.Settings.Timezone)
	}
	setup := f.lifecycle.creates[len(f.lifecycle.creates)-1]
	if setup.Kind != store.WorkspaceKindPersonalAgent || setup.FolderName != "personal-agent" || setup.Name != personalagent.DefaultNameEN || setup.Create == nil ||
		len(setup.Create.Files) != 1 || setup.Create.Files[0].Path != "AGENTS.md" || setup.Create.Files[0].Content != personalagent.AgentsFile() {
		t.Fatalf("setup created %+v", setup)
	}

	if err := f.server.store.SetWorkspaceKind(ctx, "ws_pa", store.WorkspaceKindPersonalAgent); err != nil {
		t.Fatal(err)
	}
	_, secondDevice := pairOverHTTP(t, f.handler, f.alice, "machine-alice-2", "dev_alice2")
	expectStatus(t, doAuthCall(t, f.handler, deviceCall(http.MethodPost, "/api/daemon/register",
		registrationBody("dev_alice2", "ws_alice2"), secondDevice)), http.StatusOK, "register dev_alice2")
	expectStatus(t, doAuthCall(t, f.handler, f.as(f.alice, http.MethodPost, "/api/personal-agent/home", `{"deviceId":"dev_bob"}`)),
		http.StatusNotFound, "moving to someone else's computer")
	moved := doAuthCall(t, f.handler, f.as(f.alice, http.MethodPost, "/api/personal-agent/home", `{"deviceId":"dev_alice2"}`))
	expectStatus(t, moved, http.StatusOK, "move home")
	var agent store.PersonalAgent
	_ = json.Unmarshal(moved.Body.Bytes(), &agent)
	if agent.HomeDeviceID != "dev_alice2" || agent.WorkspaceID != "ws_new_2" || len(agent.FormerWorkspaceIDs) != 1 || agent.FormerWorkspaceIDs[0] != "ws_pa" {
		t.Fatalf("moved = %+v", agent)
	}
	move := f.lifecycle.creates[len(f.lifecycle.creates)-1]
	if move.DeviceID != "dev_alice2" || move.Kind != store.WorkspaceKindPersonalAgent || move.Create.Files[0].Path != "AGENTS.md" {
		t.Fatalf("move created %+v", move)
	}
	old, err := f.server.store.GetWorkspace(ctx, "ws_pa")
	if err != nil || old.Kind == store.WorkspaceKindPersonalAgent || old.ArchivedAt == "" {
		t.Fatalf("the old folder = %+v %v", old, err)
	}
	if text, failed := f.tool(t, f.token, "list_tasks", map[string]any{}); !failed {
		t.Fatalf("the old conversation still acts as the assistant: %s", text)
	}
	expectStatus(t, doAuthCall(t, f.handler, authCall{method: http.MethodPost, path: "/api/personal-agent/home", body: `{"deviceId":"dev_alice"}`,
		headers: map[string]string{"Authorization": "Bearer " + f.token, "Content-Type": "application/json"}}), http.StatusForbidden, "a session token moves the assistant")

	// Back on the first computer it takes up the folder it left there.
	creates := len(f.lifecycle.creates)
	back := doAuthCall(t, f.handler, f.as(f.alice, http.MethodPost, "/api/personal-agent/home", `{"deviceId":"dev_alice"}`))
	expectStatus(t, back, http.StatusOK, "move back")
	_ = json.Unmarshal(back.Body.Bytes(), &agent)
	if agent.WorkspaceID != "ws_pa" || agent.HomeDeviceID != "dev_alice" || len(f.lifecycle.creates) != creates ||
		len(agent.FormerWorkspaceIDs) != 1 || agent.FormerWorkspaceIDs[0] != "ws_new_2" {
		t.Fatalf("moved back = %+v, %d new folders", agent, len(f.lifecycle.creates)-creates)
	}
	if again, _ := f.server.store.GetWorkspace(ctx, "ws_pa"); again.Kind != store.WorkspaceKindPersonalAgent || again.ArchivedAt != "" {
		t.Fatalf("the folder taken up again = %+v", again)
	}
	if text, failed := f.tool(t, f.token, "list_tasks", map[string]any{}); failed {
		t.Fatalf("its conversation there is the assistant's again: %s", text)
	}
}

// People read the role a session acts in: the person's conversation with
// their assistant is personal_agent; the classic view does not land in the
// assistant's workspace.
func TestAssistantConversationsShowTheirRole(t *testing.T) {
	f := newAssistantFixture(t)
	ctx := context.Background()
	read := doAuthCall(t, f.handler, f.as(f.alice, http.MethodGet, "/api/agent-sessions/"+f.conversation.ID+"?events=none", ""))
	expectStatus(t, read, http.StatusOK, "read the conversation")
	var session store.AgentSession
	_ = json.Unmarshal(read.Body.Bytes(), &session)
	if session.Role != store.AgentSessionRolePersonalAgent {
		t.Fatalf("role = %q", session.Role)
	}
	listed := doAuthCall(t, f.handler, f.as(f.alice, http.MethodGet, "/api/agent-sessions?workspaceId=ws_pa", ""))
	expectStatus(t, listed, http.StatusOK, "list the assistant's sessions")
	var sessions []store.AgentSession
	_ = json.Unmarshal(listed.Body.Bytes(), &sessions)
	if len(sessions) != 1 || sessions[0].Role != store.AgentSessionRolePersonalAgent {
		t.Fatalf("listed %+v", sessions)
	}
	thread := doAuthCall(t, f.handler, f.as(f.alice, http.MethodGet, "/api/agent-session-threads/"+f.conversation.ID+"?workspaceId=ws_pa", ""))
	expectStatus(t, thread, http.StatusOK, "read the conversation's thread")
	var items []store.AgentSession
	_ = json.Unmarshal(thread.Body.Bytes(), &items)
	if len(items) == 0 || items[0].Role != store.AgentSessionRolePersonalAgent {
		t.Fatalf("thread %s", thread.Body.String())
	}
	if stored, _ := f.server.store.GetAgentSessionSummary(ctx, f.conversation.ID); stored.Role != "" {
		t.Fatalf("the stored role became %q", stored.Role)
	}
	if err := f.server.store.SetWorkspaceKind(ctx, "ws_pa", store.WorkspaceKindPersonalAgent); err != nil {
		t.Fatal(err)
	}
	workspaces := []store.WorkspaceProjection{{ID: "ws_pa", Kind: store.WorkspaceKindPersonalAgent}, {ID: "ws_made", Kind: store.WorkspaceKindProject}, {ID: "ws_alice"}}
	f.server.recordPAAction(ctx, store.PersonalAgentActionRecord{UserID: f.aliceID, Tool: store.PersonalAgentActionCreateWorkspace,
		WorkspaceID: "ws_made", Outcome: store.PersonalAgentOutcomeApplied}, nil)
	if ordered := f.server.defaultWorkspacesFirst(ctx, f.aliceID, workspaces); ordered[0].ID != "ws_alice" {
		t.Fatalf("the default workspace is %s", ordered[0].ID)
	}
}

// The folder Foundry writes stays within the design's bound.
func TestAgentsFileIsShort(t *testing.T) {
	if lines := strings.Count(personalagent.AgentsFile(), "\n"); lines > personalagent.AgentsFileMaxLines {
		t.Fatalf("AGENTS.md has %d lines", lines)
	}
}

// firstDifference shows where two texts first differ, by line.
func firstDifference(a, b string) string {
	left, right := strings.Split(a, "\n"), strings.Split(b, "\n")
	for i := 0; i < len(left) || i < len(right); i++ {
		var l, r string
		if i < len(left) {
			l = left[i]
		}
		if i < len(right) {
			r = right[i]
		}
		if l != r {
			return fmt.Sprintf("line %d: %q, then %q", i+1, l, r)
		}
	}
	return "no difference"
}
