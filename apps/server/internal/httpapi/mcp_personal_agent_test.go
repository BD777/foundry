package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"slices"
	"strings"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/personalagent"
	"github.com/foundry-dev/foundry/apps/server/internal/personalagent/prompt"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// fakeLifecycle records what the assistant's writes apply instead of
// reaching a device.
type fakeLifecycle struct {
	calls   []string
	creates []WorkspaceCreateRequest
}

func (f *fakeLifecycle) CreateWorkspace(_ context.Context, actor WorkspaceActor, request WorkspaceCreateRequest) (store.WorkspaceProjection, error) {
	f.calls = append(f.calls, "create "+request.Name+" on "+request.DeviceID+" by "+actor.UserID)
	f.creates = append(f.creates, request)
	id := "ws_new"
	if len(f.creates) > 1 {
		id = fmt.Sprintf("ws_new_%d", len(f.creates))
	}
	return store.WorkspaceProjection{ID: id, Name: request.Name, DeviceID: request.DeviceID}, nil
}

func (f *fakeLifecycle) UpdateWorkspaceDetails(_ context.Context, _ WorkspaceActor, workspaceID string, details WorkspaceDetails) (store.WorkspaceProjection, error) {
	f.calls = append(f.calls, "rename "+workspaceID+" to "+*details.Name)
	return store.WorkspaceProjection{ID: workspaceID, Name: *details.Name}, nil
}

func (f *fakeLifecycle) ChangeWorkspaceSkills(_ context.Context, _ WorkspaceActor, workspaceID string, add, remove []string) ([]store.WorkspaceSkillBinding, error) {
	f.calls = append(f.calls, "skills "+workspaceID)
	return nil, nil
}

func (f *fakeLifecycle) ChangeWorkspaceConnectors(_ context.Context, _ WorkspaceActor, workspaceID string, add, remove []string) (store.WorkspaceExternalAccounts, error) {
	f.calls = append(f.calls, "connectors "+workspaceID+" +"+strings.Join(add, ","))
	return store.WorkspaceExternalAccounts{WorkspaceID: workspaceID}, nil
}

func (f *fakeLifecycle) ArchiveWorkspace(_ context.Context, _ WorkspaceActor, workspaceID string) (store.WorkspaceProjection, error) {
	f.calls = append(f.calls, "archive "+workspaceID)
	return store.WorkspaceProjection{ID: workspaceID, ArchivedAt: "2026-10-15T00:00:00Z"}, nil
}

func (f *fakeLifecycle) RestoreWorkspace(_ context.Context, _ WorkspaceActor, workspaceID string) (store.WorkspaceProjection, error) {
	f.calls = append(f.calls, "restore "+workspaceID)
	return store.WorkspaceProjection{ID: workspaceID}, nil
}

// assistantFixture: alice (the first admin) has an assistant in ws_pa on
// her device dev_alice beside her project ws_alice; bob owns ws_bob on his
// device and shares it with alice as a Maintainer. token is alice's
// assistant conversation's session token.
type assistantFixture struct {
	isolationFixture
	lifecycle    *fakeLifecycle
	conversation store.AgentSession
	token        string
}

func newAssistantFixture(t *testing.T) assistantFixture {
	t.Helper()
	f := assistantFixture{isolationFixture: newIsolationFixture(t), lifecycle: &fakeLifecycle{}}
	ctx, db := context.Background(), f.server.store
	expectStatus(t, doAuthCall(t, f.handler, deviceCall(http.MethodPost, "/api/daemon/register",
		registrationBody("dev_alice", "ws_pa"), f.aliceDevice)), http.StatusOK, "register ws_pa")
	for _, register := range []struct{ device, workspace string }{{"dev_alice", "ws_pa"}, {"dev_alice", "ws_alice"}, {"dev_bob", "ws_bob"}} {
		if err := db.RegisterDaemon(ctx, store.DaemonRegistration{
			Device:    store.DeviceProjection{ID: register.device, Label: "Device", Status: "connected", LastSeenLabel: "online"},
			Workspace: store.WorkspaceProjection{ID: register.workspace, Name: register.workspace, LocalPath: "/tmp/" + register.workspace},
			Agents: []store.AgentProjection{{
				ID: "agent_" + register.workspace, WorkspaceID: register.workspace, DeviceID: register.device, Provider: "claude", Status: "healthy",
				AuthMode: "local_config", SecretStored: "local", ConfigScope: "workspace", ConfigLabel: "local", LastSeenLabel: "online",
			}},
		}); err != nil {
			t.Fatal(err)
		}
	}
	if err := db.SetWorkspaceMember(ctx, "ws_bob", f.aliceID, store.WorkspaceRoleMaintainer, f.bobID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.CreatePersonalAgent(ctx, store.PersonalAgent{
		UserID: f.aliceID, WorkspaceID: "ws_pa", HomeDeviceID: "dev_alice", Settings: personalagent.DefaultSettings(),
	}); err != nil {
		t.Fatal(err)
	}
	f.conversation = f.startSession(t, "ws_pa", "", "help me with my week")
	f.token = f.mint(t, f.conversation.ID)
	previous := lifecycleFor
	lifecycleFor = func(*Server) workspaceLifecycle { return f.lifecycle }
	t.Cleanup(func() { lifecycleFor = previous })
	return f
}

func (f assistantFixture) startSession(t *testing.T, workspaceID, parentID, prompt string) store.AgentSession {
	t.Helper()
	source := "chat"
	if parentID != "" {
		source = "agent"
	}
	session, err := f.server.store.CreateAgentSession(context.Background(), store.CreateAgentSessionInput{
		CreatedByUserID: f.aliceID, WorkspaceID: workspaceID, AgentID: "agent_" + workspaceID, Provider: "claude",
		Prompt: prompt, Source: source, ParentSessionID: parentID,
	})
	if err != nil {
		t.Fatal(err)
	}
	return session
}

func (f assistantFixture) mint(t *testing.T, sessionID string) string {
	t.Helper()
	token, err := f.server.store.MintAgentSessionToken(context.Background(), sessionID)
	if err != nil {
		t.Fatal(err)
	}
	return token
}

// tool calls a Foundry tool with a session token; it answers the text and
// whether the tool failed.
func (f assistantFixture) tool(t *testing.T, token, name string, args any) (string, bool) {
	t.Helper()
	raw, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 1, "method": "tools/call",
		"params": map[string]any{"name": name, "arguments": args}})
	recorder := doAuthCall(t, f.handler, authCall{method: http.MethodPost, path: "/api/mcp", body: string(raw),
		headers: map[string]string{"Authorization": "Bearer " + token, "Content-Type": "application/json"}})
	var response struct {
		Result struct {
			Content []struct{ Text string } `json:"content"`
			IsError bool                    `json:"isError"`
		} `json:"result"`
		Error *struct{ Message string } `json:"error"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatalf("%s: %s", name, recorder.Body.String())
	}
	if response.Error != nil {
		return response.Error.Message, true
	}
	if len(response.Result.Content) == 0 {
		t.Fatalf("%s answered nothing: %s", name, recorder.Body.String())
	}
	return response.Result.Content[0].Text, response.Result.IsError
}

func (f assistantFixture) listedTools(t *testing.T, token string) []string {
	t.Helper()
	recorder := doAuthCall(t, f.handler, authCall{method: http.MethodPost, path: "/api/mcp",
		body:    `{"jsonrpc":"2.0","id":1,"method":"tools/list"}`,
		headers: map[string]string{"Authorization": "Bearer " + token, "Content-Type": "application/json"}})
	var response struct {
		Result struct {
			Tools []struct{ Name string } `json:"tools"`
		} `json:"result"`
	}
	_ = json.Unmarshal(recorder.Body.Bytes(), &response)
	names := []string{}
	for _, tool := range response.Result.Tools {
		names = append(names, tool.Name)
	}
	return names
}

func (f assistantFixture) setPolicy(t *testing.T, action, decision string) {
	t.Helper()
	ctx := context.Background()
	agent, err := f.server.store.GetPersonalAgent(ctx, f.aliceID)
	if err != nil {
		t.Fatal(err)
	}
	agent.Settings.Policy[action] = decision
	if _, err := f.server.store.SavePersonalAgentSettings(ctx, f.aliceID, agent.Settings); err != nil {
		t.Fatal(err)
	}
}

func (f assistantFixture) lastAction(t *testing.T) store.PersonalAgentActionRecord {
	t.Helper()
	actions, err := f.server.store.ListPersonalAgentActions(context.Background(), f.aliceID, 1)
	if err != nil || len(actions) == 0 {
		t.Fatalf("no audited action (%v)", err)
	}
	return actions[0]
}

// Only the person's own conversation with the assistant is the assistant:
// it lists the assistant's tools and not the resource or Feishu event
// tools; a session it starts and a chat elsewhere are ordinary sessions.
func TestAssistantRoleAndTools(t *testing.T) {
	f := newAssistantFixture(t)
	assistant := f.listedTools(t, f.token)
	for name := range personalAgentMCPTools {
		if !slices.Contains(assistant, name) {
			t.Errorf("the assistant does not list %s", name)
		}
	}
	for name := range assistantWithheldMCPTools {
		if slices.Contains(assistant, name) {
			t.Errorf("the assistant lists %s", name)
		}
	}
	if !slices.Contains(assistant, "create_session") || !slices.Contains(assistant, "list_resources") {
		t.Errorf("the assistant lost its orchestration tools: %v", assistant)
	}
	child := f.startSession(t, "ws_alice", f.conversation.ID, "a helper")
	elsewhere := f.startSession(t, "ws_alice", "", "a chat in a project")
	for label, token := range map[string]string{"its helper": f.mint(t, child.ID), "a chat elsewhere": f.mint(t, elsewhere.ID)} {
		listed := f.listedTools(t, token)
		if slices.Contains(listed, "remember") || !slices.Contains(listed, "acquire_resource") {
			t.Errorf("%s lists %v", label, listed)
		}
		if text, failed := f.tool(t, token, "remember", map[string]any{"op": "add", "item": map[string]any{"content": "x"}}); !failed {
			t.Errorf("%s remembered: %s", label, text)
		}
	}
	if text, failed := f.tool(t, f.token, "feishu_events", map[string]any{}); !failed || !strings.Contains(text, "not available to the person's assistant") {
		t.Errorf("the assistant read Feishu events: %s", text)
	}
}

// Every write tool is applied under auto, proposed under ask and refused
// under deny, and audited every time.
func TestAssistantWritesFollowThePolicy(t *testing.T) {
	cases := []struct {
		tool, action string
		args         map[string]any
		applied      string
	}{
		{"create_workspace", store.PersonalAgentActionCreateWorkspace,
			map[string]any{"name": "Family budget", "purpose": "Track spending.", "source": map[string]any{"kind": "empty"}},
			"create Family budget on dev_alice by "},
		{"update_workspace", store.PersonalAgentActionRenameWorkspace,
			map[string]any{"workspaceId": "ws_alice", "name": "Blog"}, "rename ws_alice to Blog"},
		{"archive_workspace", store.PersonalAgentActionArchive,
			map[string]any{"workspaceId": "ws_alice"}, "archive ws_alice"},
		{"archive_workspace", store.PersonalAgentActionRestore,
			map[string]any{"workspaceId": "ws_alice", "restore": true}, "restore ws_alice"},
	}
	for _, tc := range cases {
		for _, decision := range []string{store.PersonalAgentAuto, store.PersonalAgentAsk, store.PersonalAgentDeny} {
			t.Run(tc.action+"/"+decision, func(t *testing.T) {
				f := newAssistantFixture(t)
				f.setPolicy(t, tc.action, decision)
				text, failed := f.tool(t, f.token, tc.tool, tc.args)
				action := f.lastAction(t)
				if action.Tool != tc.tool || action.SessionID != f.conversation.ID {
					t.Fatalf("audit = %+v", action)
				}
				switch decision {
				case store.PersonalAgentAuto:
					if failed || len(f.lifecycle.calls) != 1 || !strings.HasPrefix(f.lifecycle.calls[0], tc.applied) {
						t.Fatalf("auto: %s (failed %v), calls %v", text, failed, f.lifecycle.calls)
					}
					if action.Outcome != store.PersonalAgentOutcomeApplied || action.Decision != store.PersonalAgentAuto {
						t.Fatalf("auto audit = %+v", action)
					}
				case store.PersonalAgentAsk:
					var answer store.PersonalAgentNeedsConfirmation
					if failed || json.Unmarshal([]byte(text), &answer) != nil || answer.Status != "needs_confirmation" || answer.ProposalID == "" || answer.Summary == "" {
						t.Fatalf("ask: %s", text)
					}
					if len(f.lifecycle.calls) != 0 {
						t.Fatalf("ask applied it: %v", f.lifecycle.calls)
					}
					// The card says what the rename would change.
					if tc.action == store.PersonalAgentActionRenameWorkspace && !strings.Contains(answer.Summary, "Blog") {
						t.Fatalf("the rename card hides the new name: %q", answer.Summary)
					}
					proposal, err := f.server.store.GetPersonalAgentProposal(context.Background(), f.aliceID, answer.ProposalID)
					if err != nil || proposal.Status != store.PersonalAgentProposalPending || proposal.Kind != tc.action || proposal.SessionID != f.conversation.ID {
						t.Fatalf("proposal = %+v (%v)", proposal, err)
					}
					if action.Outcome != store.PersonalAgentOutcomeProposed || action.ProposalID != answer.ProposalID {
						t.Fatalf("ask audit = %+v", action)
					}
				case store.PersonalAgentDeny:
					if !failed || !strings.Contains(text, "not allowed") || len(f.lifecycle.calls) != 0 {
						t.Fatalf("deny: %s (failed %v), calls %v", text, failed, f.lifecycle.calls)
					}
					if action.Outcome != store.PersonalAgentOutcomeRefused || action.Refusal != store.PersonalAgentRefusalNotAllowed {
						t.Fatalf("deny audit = %+v", action)
					}
				}
			})
		}
	}
}

// The assistant changes only what the person owns on their own devices,
// and never its own space's existence.
func TestAssistantManagesOnlyThePersonsOwnProjects(t *testing.T) {
	f := newAssistantFixture(t)
	for _, attempt := range []struct {
		tool    string
		args    map[string]any
		refusal string
	}{
		{"update_workspace", map[string]any{"workspaceId": "ws_bob", "name": "Mine"}, store.PersonalAgentRefusalNotOwner},
		{"archive_workspace", map[string]any{"workspaceId": "ws_bob"}, store.PersonalAgentRefusalNotOwner},
		{"archive_workspace", map[string]any{"workspaceId": "ws_pa"}, store.PersonalAgentRefusalNotAllowed},
		{"update_workspace", map[string]any{"workspaceId": "ws_nobody", "name": "x"}, store.PersonalAgentRefusalInvalid},
		{"create_workspace", map[string]any{"name": "On bob's", "purpose": "x", "source": map[string]any{"kind": "empty"}, "deviceId": "dev_bob"}, store.PersonalAgentRefusalNotOwner},
	} {
		text, failed := f.tool(t, f.token, attempt.tool, attempt.args)
		if action := f.lastAction(t); !failed || action.Refusal != attempt.refusal {
			t.Errorf("%s %v: %s, audit %+v", attempt.tool, attempt.args, text, action)
		}
	}
	if len(f.lifecycle.calls) != 0 {
		t.Fatalf("refused writes applied: %v", f.lifecycle.calls)
	}
}

// Asking more applies at once; asking less waits for the person.
func TestAssistantRulesTightenAtOnceAndLoosenByProposal(t *testing.T) {
	f := newAssistantFixture(t)
	ctx := context.Background()
	if text, failed := f.tool(t, f.token, "update_rules", map[string]any{"change": map[string]any{"action": "rename_workspace", "decision": "ask"}}); failed || !strings.Contains(text, "applied") {
		t.Fatalf("tighten: %s", text)
	}
	agent, _ := f.server.store.GetPersonalAgent(ctx, f.aliceID)
	if agent.Settings.Policy[store.PersonalAgentActionRenameWorkspace] != store.PersonalAgentAsk {
		t.Fatalf("policy = %v", agent.Settings.Policy)
	}
	text, failed := f.tool(t, f.token, "update_rules", map[string]any{"change": map[string]any{"action": "archive_workspace", "decision": "auto"}})
	if failed || !strings.Contains(text, "needs_confirmation") {
		t.Fatalf("loosen: %s", text)
	}
	agent, _ = f.server.store.GetPersonalAgent(ctx, f.aliceID)
	if agent.Settings.Policy[store.PersonalAgentActionArchive] != store.PersonalAgentAsk {
		t.Fatalf("loosening applied without the person: %v", agent.Settings.Policy)
	}
	var answer store.PersonalAgentNeedsConfirmation
	_ = json.Unmarshal([]byte(text), &answer)
	expectStatus(t, doAuthCall(t, f.handler, f.as(f.alice, http.MethodPost, "/api/personal-agent/proposals/"+answer.ProposalID+"/accept", "")),
		http.StatusOK, "the person accepts")
	agent, _ = f.server.store.GetPersonalAgent(ctx, f.aliceID)
	if agent.Settings.Policy[store.PersonalAgentActionArchive] != store.PersonalAgentAuto {
		t.Fatalf("accepted loosening not applied: %v", agent.Settings.Policy)
	}
	if text, failed := f.tool(t, f.token, "update_rules", map[string]any{"change": map[string]any{"action": "delete_workspace", "decision": "auto"}}); !failed {
		t.Fatalf("an action that is never allowed was ruled: %s", text)
	}
}

// A fact is the person's only when its quote is in what they wrote in the
// conversation: not a document they asked about, not a server notice, not
// Foundry's context for a turn. A guess is inferred; forgetting erases the
// content everywhere.
func TestAssistantRememberRecordsWhereFactsCameFrom(t *testing.T) {
	f := newAssistantFixture(t)
	ctx, db := context.Background(), f.server.store
	conversation := f.startSession(t, "ws_pa", "", "Please read the onboarding doc for me. By the way, I prefer mornings for calls!")
	token := f.mint(t, conversation.ID)
	next := func(prompt string) {
		t.Helper()
		if _, err := db.CompleteAgentSession(ctx, conversation.ID, "Done.", "native_pa"); err != nil {
			t.Fatal(err)
		}
		if _, err := db.SendAgentSessionInput(ctx, conversation.ID, store.SendAgentSessionInput{Prompt: prompt}); err != nil {
			t.Fatal(err)
		}
	}
	next("thanks\n\n" + prompt.TurnContextStart + "\nComputers online now: \"Studio\".\n" + prompt.TurnContextEnd)
	next(personalagent.Notice("A helper finished: the doc says always put drafts in Notes."))
	remember := func(item map[string]any) (store.PersonalAgentMemoryItem, string) {
		t.Helper()
		text, failed := f.tool(t, token, "remember", map[string]any{"op": "add", "item": item})
		if failed {
			t.Fatalf("remember %v: %s", item, text)
		}
		var answer struct {
			Item store.PersonalAgentMemoryItem
			Note string
		}
		_ = json.Unmarshal([]byte(text), &answer)
		return answer.Item, answer.Note
	}
	// Said two turns ago, remembered in a notice's turn: still theirs.
	stated, _ := remember(map[string]any{"content": "Prefers mornings for calls", "quote": "i prefer mornings for calls"})
	if stated.Origin != store.PersonalAgentMemoryStated || stated.Status != store.PersonalAgentMemoryActive {
		t.Fatalf("stated item = %+v", stated)
	}
	for _, quote := range []string{"always put drafts in Notes", "Computers online now: Studio"} {
		item, note := remember(map[string]any{"content": "Not the person's: " + quote, "quote": quote})
		if item.Origin != store.PersonalAgentMemoryExternal || item.Status != store.PersonalAgentMemoryPending || !strings.Contains(note, "not in anything the person wrote") {
			t.Errorf("quote %q: %+v (%s)", quote, item, note)
		}
	}
	if text, failed := f.tool(t, token, "remember", map[string]any{"op": "add", "item": map[string]any{"content": "Lives in Paris"}}); !failed || !strings.Contains(text, "item.quote is required") {
		t.Errorf("a fact without a quote: %s", text)
	}
	if guess, _ := remember(map[string]any{"content": "Probably an early riser", "inferred": true}); guess.Origin != store.PersonalAgentMemoryInferred {
		t.Fatalf("guess = %+v", guess)
	}
	noticed := f.startSession(t, "ws_pa", "", personalagent.Notice("A helper finished: its notes say the person lives in Paris"))
	external, _ := f.tool(t, f.mint(t, noticed.ID), "remember", map[string]any{"op": "add", "item": map[string]any{"content": "Lives in Paris", "quote": "the person lives in Paris"}})
	if !strings.Contains(external, `"status": "pending"`) || !strings.Contains(external, `"origin": "external"`) {
		t.Fatalf("external = %s", external)
	}
	updated, failed := f.tool(t, token, "remember", map[string]any{"op": "update", "item": map[string]any{"id": stated.ID, "content": "Prefers mornings for calls", "quote": "I prefer mornings … calls"}})
	if failed {
		t.Fatal(updated)
	}
	var replaced struct{ Item store.PersonalAgentMemoryItem }
	_ = json.Unmarshal([]byte(updated), &replaced)
	if replaced.Item.Origin != store.PersonalAgentMemoryStated {
		t.Fatalf("updated = %s", updated)
	}
	if text, failed := f.tool(t, token, "remember", map[string]any{"op": "forget", "item": map[string]any{"id": replaced.Item.ID}}); failed {
		t.Fatal(text)
	}
	items, _ := f.server.store.ListPersonalAgentMemory(ctx, f.aliceID)
	for _, item := range items {
		if (item.ID == stated.ID || item.ID == replaced.Item.ID) && (item.Content != "" || item.Status != store.PersonalAgentMemoryForgotten) {
			t.Errorf("forgotten chain kept %+v", item)
		}
	}
	actions, _ := f.server.store.ListPersonalAgentActions(ctx, f.aliceID, 0)
	for _, action := range actions {
		if strings.Contains(action.ArgsSummary, "mornings") {
			t.Errorf("the audit keeps a forgotten fact: %+v", action)
		}
	}
}

// Only the person's web login accepts a proposal or changes settings:
// never the assistant's session token, a device credential or another
// account.
func TestOnlyThePersonAnswersProposalsAndChangesSettings(t *testing.T) {
	f := newAssistantFixture(t)
	text, _ := f.tool(t, f.token, "archive_workspace", map[string]any{"workspaceId": "ws_alice"})
	var answer store.PersonalAgentNeedsConfirmation
	if json.Unmarshal([]byte(text), &answer) != nil || answer.ProposalID == "" {
		t.Fatalf("archive by default asks: %s", text)
	}
	accept := "/api/personal-agent/proposals/" + answer.ProposalID + "/accept"
	settings, _ := json.Marshal(personalagent.DefaultSettings())
	bearer := map[string]string{"Authorization": "Bearer " + f.token, "Content-Type": "application/json"}
	for _, attempt := range []struct {
		label string
		call  authCall
		want  int
	}{
		{"session token accepts", authCall{method: http.MethodPost, path: accept, headers: bearer}, http.StatusForbidden},
		{"device credential accepts", deviceCall(http.MethodPost, accept, "", f.aliceDevice), http.StatusForbidden},
		{"another person accepts", f.as(f.bob, http.MethodPost, accept, ""), http.StatusNotFound},
		{"session token saves settings", authCall{method: http.MethodPut, path: "/api/personal-agent/settings", body: string(settings), headers: bearer}, http.StatusForbidden},
		{"device credential saves settings", deviceCall(http.MethodPut, "/api/personal-agent/settings", string(settings), f.aliceDevice), http.StatusForbidden},
		{"session token stops", authCall{method: http.MethodPost, path: "/api/personal-agent/stop", headers: bearer}, http.StatusForbidden},
		{"device credential reads memory", deviceCall(http.MethodGet, "/api/personal-agent/memory", "", f.aliceDevice), http.StatusForbidden},
	} {
		if got := doAuthCall(t, f.handler, attempt.call).Code; got != attempt.want {
			t.Errorf("%s: %d, want %d", attempt.label, got, attempt.want)
		}
	}
	if len(f.lifecycle.calls) != 0 {
		t.Fatalf("a refused accept applied: %v", f.lifecycle.calls)
	}
	accepted := doAuthCall(t, f.handler, f.as(f.alice, http.MethodPost, accept, ""))
	expectStatus(t, accepted, http.StatusOK, "the person accepts")
	var proposal store.PersonalAgentProposal
	_ = json.Unmarshal(accepted.Body.Bytes(), &proposal)
	if proposal.Status != store.PersonalAgentProposalApplied || proposal.DecidedVia != store.PersonalAgentViaWeb ||
		!slices.Equal(f.lifecycle.calls, []string{"archive ws_alice"}) {
		t.Fatalf("accepted proposal = %+v, calls %v", proposal, f.lifecycle.calls)
	}
	if action := f.lastAction(t); action.ConfirmedVia != store.PersonalAgentViaWeb || action.Outcome != store.PersonalAgentOutcomeApplied {
		t.Fatalf("applied audit = %+v", action)
	}
	expectStatus(t, doAuthCall(t, f.handler, f.as(f.alice, http.MethodPost, accept, "")), http.StatusConflict, "accept twice")
	if len(f.lifecycle.calls) != 1 {
		t.Fatalf("approval applied twice: %v", f.lifecycle.calls)
	}

	over := personalagent.DefaultSettings()
	over.Limits.DailyWorkspaces = personalagent.LimitCaps.DailyWorkspaces + 1
	raw, _ := json.Marshal(over)
	expectStatus(t, doAuthCall(t, f.handler, f.as(f.alice, http.MethodPut, "/api/personal-agent/settings", string(raw))),
		http.StatusBadRequest, "a limit above its cap")
	expectStatus(t, doAuthCall(t, f.handler, f.as(f.alice, http.MethodPut, "/api/personal-agent/settings", string(settings))),
		http.StatusOK, "the person saves settings")
}

// Asked the same thing of the same project again, the person answers the
// new card: the older one expires instead of lingering, while a card about
// another project stays.
func TestAskingAgainSupersedesTheOlderCard(t *testing.T) {
	f := newAssistantFixture(t)
	ctx := context.Background()
	f.setPolicy(t, store.PersonalAgentActionRenameWorkspace, store.PersonalAgentAsk)
	f.setPolicy(t, store.PersonalAgentActionArchive, store.PersonalAgentAsk)
	propose := func(tool string, args map[string]any) string {
		t.Helper()
		text, _ := f.tool(t, f.token, tool, args)
		var answer store.PersonalAgentNeedsConfirmation
		if err := json.Unmarshal([]byte(text), &answer); err != nil || answer.ProposalID == "" {
			t.Fatalf("%s did not propose: %s", tool, text)
		}
		return answer.ProposalID
	}
	first := propose("update_workspace", map[string]any{"workspaceId": "ws_alice", "name": "Later"})
	archive := propose("archive_workspace", map[string]any{"workspaceId": "ws_alice"})
	second := propose("update_workspace", map[string]any{"workspaceId": "ws_alice", "name": "Sooner"})
	for id, want := range map[string]string{first: store.PersonalAgentProposalExpired, archive: store.PersonalAgentProposalPending, second: store.PersonalAgentProposalPending} {
		if got, err := f.server.store.GetPersonalAgentProposal(ctx, f.aliceID, id); err != nil || got.Status != want {
			t.Errorf("proposal %s is %q (%v), want %s", id, got.Status, err, want)
		}
	}
}

// The stop switch cancels the assistant's conversations and the work it
// handed off, voids its proposals and refuses its writes, all without the
// model; resuming restarts nothing.
func TestStopRequestsEverythingWithoutInventingOfflineReceipts(t *testing.T) {
	f := newAssistantFixture(t)
	ctx := context.Background()
	f.setPolicy(t, store.PersonalAgentActionRenameWorkspace, store.PersonalAgentAsk)
	text, _ := f.tool(t, f.token, "update_workspace", map[string]any{"workspaceId": "ws_alice", "name": "Later"})
	if !strings.Contains(text, "needs_confirmation") {
		t.Fatalf("rename asks: %s", text)
	}
	agent, _ := f.server.store.GetPersonalAgent(ctx, f.aliceID)
	helpers := []store.AgentSession{}
	for _, workspace := range []string{"ws_alice", "ws_bob"} {
		helper := f.startSession(t, workspace, f.conversation.ID, "work for the person")
		f.server.recordAssistantTask(ctx, agent, f.conversation.ID, helper)
		helpers = append(helpers, helper)
	}
	unrelated := f.startSession(t, "ws_alice", "", "the person's own chat")

	stopped := doAuthCall(t, f.handler, f.as(f.alice, http.MethodPost, "/api/personal-agent/stop", ""))
	expectStatus(t, stopped, http.StatusOK, "stop")
	var answer personalAgentSwitch
	_ = json.Unmarshal(stopped.Body.Bytes(), &answer)
	if answer.Stopped != 0 || answer.Agent.State != store.PersonalAgentStopped || !strings.Contains(answer.Reply, "0") {
		t.Fatalf("stop answered %+v", answer)
	}
	for _, session := range append(helpers, f.conversation) {
		if got, _ := f.server.store.GetAgentSessionSummary(ctx, session.ID); got.Status == "canceled" {
			t.Errorf("%s falsely marked canceled without a native receipt", session.ID)
		}
	}
	pendingStops, e := f.server.store.ListPersonalAgentRunControls(ctx, f.aliceID)
	if e != nil || len(pendingStops) != 3 {
		t.Fatalf("missing stop requests: %+v %v", pendingStops, e)
	}
	for _, control := range pendingStops {
		if control.State != "stop_requested" || control.SessionID == unrelated.ID {
			t.Fatalf("wrong stop scope: %+v", control)
		}
	}
	if got, _ := f.server.store.GetAgentSessionSummary(ctx, unrelated.ID); got.Status == "canceled" {
		t.Error("stop cancelled a session the assistant did not start")
	}
	if pending, _ := f.server.store.ListPersonalAgentProposals(ctx, f.aliceID, []string{store.PersonalAgentProposalPending}); len(pending) != 0 {
		t.Errorf("proposals survived the stop: %+v", pending)
	}
	if text, failed := f.tool(t, f.token, "create_workspace", map[string]any{"name": "x", "purpose": "x", "source": map[string]any{"kind": "empty"}}); !failed || f.lastAction(t).Refusal != store.PersonalAgentRefusalStopped {
		t.Fatalf("a stopped assistant wrote: %s", text)
	}
	if _, err := f.server.createAndDispatch(ctx, store.CreateAgentSessionInput{
		WorkspaceID: "ws_alice", AgentID: "agent_ws_alice", Provider: "claude", Prompt: "more", Source: "agent", ParentSessionID: f.conversation.ID,
	}, false); err == nil || !strings.Contains(err.Error(), "pressed stop") {
		t.Fatalf("a stopped assistant handed off work: %v", err)
	}

	resumed := doAuthCall(t, f.handler, f.as(f.alice, http.MethodPost, "/api/personal-agent/resume", ""))
	expectStatus(t, resumed, http.StatusOK, "resume")
	_ = json.Unmarshal(resumed.Body.Bytes(), &answer)
	if answer.Agent.State != store.PersonalAgentActive || len(answer.Tasks) != 0 {
		t.Fatalf("resume answered %+v", answer)
	}
	for _, control := range pendingStops {
		current, _ := f.server.store.GetPersonalAgentRunControl(ctx, f.aliceID, control.ID)
		if current.State != "stop_requested" {
			t.Fatal("resume erased a pending stop")
		}
		if allowed, e := f.server.store.AuthorizePersonalAgentDispatch(ctx, control.SessionID, control.InputID); e != nil || allowed {
			t.Fatalf("resume redispatched stopped input: %v %v", allowed, e)
		}
	}
}

// §9: past a limit the server refuses with a readable error and the
// settings link.
func TestAssistantLimits(t *testing.T) {
	f := newAssistantFixture(t)
	ctx := context.Background()
	agent, _ := f.server.store.GetPersonalAgent(ctx, f.aliceID)
	agent.Settings.Limits.DailyWorkspaces = 1
	agent.Settings.Limits.ConcurrentSessions = 1
	agent.Settings.Limits.HourlyTurns = 2
	if _, err := f.server.store.SavePersonalAgentSettings(ctx, f.aliceID, agent.Settings); err != nil {
		t.Fatal(err)
	}
	create := map[string]any{"name": "One", "purpose": "x", "source": map[string]any{"kind": "empty"}}
	if text, failed := f.tool(t, f.token, "create_workspace", create); failed {
		t.Fatalf("first project: %s", text)
	}
	text, failed := f.tool(t, f.token, "create_workspace", create)
	if !failed || !strings.Contains(text, "limit reached") || !strings.Contains(text, personalagent.SettingsPath) ||
		f.lastAction(t).Refusal != store.PersonalAgentRefusalLimit {
		t.Fatalf("second project the same day: %s", text)
	}

	delegate := store.CreateAgentSessionInput{WorkspaceID: "ws_alice", AgentID: "agent_ws_alice", Provider: "claude",
		Prompt: "work", Source: "agent", ParentSessionID: f.conversation.ID}
	if _, err := f.server.createAndDispatch(ctx, delegate, false); err != nil && !strings.Contains(err.Error(), "not connected") {
		t.Fatalf("first helper: %v", err)
	}
	if tasks, _ := f.server.store.ListPersonalAgentTasks(ctx, f.aliceID, nil); len(tasks) != 1 {
		t.Fatalf("the helper is not followed up: %+v", tasks)
	}
	helper := f.startSession(t, "ws_alice", f.conversation.ID, "a running helper")
	f.server.recordAssistantTask(ctx, agent, f.conversation.ID, helper)
	if _, err := f.server.createAndDispatch(ctx, delegate, false); err == nil || !strings.Contains(err.Error(), "running at once") {
		t.Fatalf("past the concurrent limit: %v", err)
	}

	// Two conversations started this hour: a third turn is refused.
	f.startSession(t, "ws_pa", "", "another question")
	if err := f.server.admitAssistantTurn(ctx, f.conversation); err == nil || !strings.Contains(err.Error(), "replies in the last hour") {
		t.Fatalf("past the hourly turns: %v", err)
	}
	if err := f.server.admitAssistantTurn(ctx, helper); err != nil {
		t.Fatalf("a helper's turn is not the assistant's: %v", err)
	}
}

func personalAgentToolNames() []string {
	names := []string{}
	for name := range personalAgentMCPTools {
		names = append(names, name)
	}
	slices.Sort(names)
	return names
}

func TestAssistantRefusalsKeepTheirStatus(t *testing.T) {
	settings := "https://foundry.example/assistant/settings"
	if err := notAllowed(store.PersonalAgentActionArchive, settings); errorStatus(err) != http.StatusUnprocessableEntity || !strings.Contains(err.Error(), settings) {
		t.Fatalf("not allowed answers %d: %v", errorStatus(err), err)
	}
	// The link the assistant passes on is a full one: a Feishu chat cannot
	// open a path of the web app.
	limit := limitRefusal(&personalagent.LimitError{Limit: "dailyWorkspaces", Max: 3}, settings)
	if kind := refusalKind(limit); kind != store.PersonalAgentRefusalLimit || !strings.Contains(limit.Error(), "("+settings+")") {
		t.Fatalf("a limit is refused as %s: %v", kind, limit)
	}
}
