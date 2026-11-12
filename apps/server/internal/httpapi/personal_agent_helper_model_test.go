package httpapi

import (
	"context"
	"encoding/json"
	"slices"
	"strings"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/personalagent"
	"github.com/foundry-dev/foundry/apps/server/internal/personalagent/run"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// registerHelperAccounts gives ws_alice two usable accounts: Claude and
// Codex subscriptions; Codex advertises one model.
func registerHelperAccounts(t *testing.T, f assistantFixture) store.WorkspaceProjection {
	t.Helper()
	ctx := context.Background()
	workspace, err := f.server.store.GetWorkspace(ctx, "ws_alice")
	if err != nil {
		t.Fatal(err)
	}
	var agents []store.AgentProjection
	var profiles []store.AgentProfileProjection
	for _, account := range []struct{ id, runtime string }{{"claude_local", "claude"}, {"codex_local", "codex"}} {
		agents = append(agents, store.AgentProjection{
			ID: store.ServerAgentID(workspace.DeviceID, workspace.ID, account.id), WorkspaceID: workspace.ID, DeviceID: workspace.DeviceID,
			Provider: account.runtime, ProfileID: account.id, ConnectionType: "local_login", Status: "healthy", AuthMode: "local_config", ConfigScope: "device",
		})
		profile := store.AgentProfileProjection{ID: account.id, DeviceID: workspace.DeviceID, Runtime: account.runtime, ConnectionType: "local_login", Status: "healthy", AuthMode: "local_config", ConfigScope: "device"}
		profile.Model = "smart-model"
		if account.runtime == "codex" {
			profile.Model = "cheap-model"
		}
		profile.Models = []string{profile.Model}
		profiles = append(profiles, profile)
	}
	if err := f.server.store.RegisterDaemon(ctx, store.DaemonRegistration{Device: store.DeviceProjection{ID: workspace.DeviceID, Status: "connected"}, Workspace: workspace, Agents: agents, AgentProfiles: profiles}); err != nil {
		t.Fatal(err)
	}
	return workspace
}

// The work the assistant hands off runs on the helper model the person
// chose, not the assistant's; when that cannot run on the computer it
// waits, or runs on the computer's default only when the person allowed it.
func TestHelperModelIsTheAssistantsSecondChoice(t *testing.T) {
	f := newAssistantFixture(t)
	ctx := context.Background()
	registerHelperAccounts(t, f)
	agent, err := f.server.store.GetPersonalAgent(ctx, f.aliceID)
	if err != nil {
		t.Fatal(err)
	}
	agent.Settings.RunDefault = &store.PersonalAgentRunPreference{ProfileID: "claude_local", Runtime: "claude", Model: "smart-model", Effort: "high"}
	agent.Settings.RoleOverrides = map[string]store.PersonalAgentRunPreference{
		"executor": {ProfileID: "codex_local", Runtime: "codex", Model: "cheap-model", Effort: "low"},
	}
	helper, err := f.server.runs.Resolve(ctx, agent, "executor", "ws_alice")
	if err != nil || helper.ProfileID != "codex_local" || helper.Model != "cheap-model" || helper.Effort != "low" || helper.SelectionReason != "configured" {
		t.Fatalf("helper: %+v %v", helper, err)
	}
	if preview := f.server.previewHelper(ctx, agent, "ws_alice", "default"); preview.Model != "cheap-model" || preview.Unavailable != "" || preview.Note != "" {
		t.Fatalf("preview: %+v", preview)
	}

	// The chosen model is not on that computer: the step waits and the
	// assistant is told why at once.
	agent.Settings.RoleOverrides["executor"] = store.PersonalAgentRunPreference{ProfileID: "codex_local", Runtime: "codex", Model: "absent-model"}
	if _, err := f.server.runs.Resolve(ctx, agent, "executor", "ws_alice"); err == nil || !strings.Contains(err.Error(), "model_unavailable") {
		t.Fatalf("missing model silently replaced: %v", err)
	}
	if preview := f.server.previewHelper(ctx, agent, "ws_alice", "default"); !strings.Contains(preview.Unavailable, "model_unavailable") || preview.Note == "" {
		t.Fatalf("unavailable preview: %+v", preview)
	}
	agent.Settings.RoleOverrides["executor"] = store.PersonalAgentRunPreference{ProfileID: "prof_absent", Runtime: "claude", Model: "x"}
	if _, err := f.server.runs.Resolve(ctx, agent, "executor", "ws_alice"); err == nil || !strings.Contains(err.Error(), "account_unavailable") {
		t.Fatalf("missing account silently replaced: %v", err)
	}

	// Allowed: the computer's default, recorded as such.
	for _, override := range []store.PersonalAgentRunPreference{
		{ProfileID: "prof_absent", Runtime: "claude", Model: "x", WhenUnavailable: "device_default"},
		{ProfileID: "codex_local", Runtime: "codex", Model: "absent-model", WhenUnavailable: "device_default"},
	} {
		agent.Settings.RoleOverrides["executor"] = override
		helper, err = f.server.runs.Resolve(ctx, agent, "executor", "ws_alice")
		if err != nil || helper.SelectionReason != run.ReasonUsedDeviceDefault || helper.Model == "absent-model" || helper.Model == "x" {
			t.Fatalf("fallback for %+v: %+v %v", override, helper, err)
		}
		if preview := f.server.previewHelper(ctx, agent, "ws_alice", "default"); preview.Reason != run.ReasonUsedDeviceDefault || preview.Note == "" {
			t.Fatalf("fallback preview: %+v", preview)
		}
	}

	// The assistant itself keeps its own choice throughout.
	coordinator, err := personalagent.RunPreference(agent.Settings, "coordinator")
	if err != nil || coordinator.Model != "smart-model" {
		t.Fatalf("assistant: %+v %v", coordinator, err)
	}
}

func TestExecutorUsesAssistantWorkspaceGlobalThenLegacy(t *testing.T) {
	t.Run("assistant override", func(t *testing.T) {
		f := newAssistantFixture(t)
		ctx := context.Background()
		registerHelperAccounts(t, f)
		agent := mustAgent(t, f)
		agent.Settings.ExecutionModels = &store.PersonalAgentExecutionModels{
			ProviderKind: store.ExecutionModelChoiceProviderKindSubscription,
			ProviderID:   "claude_local", Runtime: "claude", Model: "smart-model",
		}
		agent.Settings.RoleOverrides = map[string]store.PersonalAgentRunPreference{
			"executor": {ProfileID: "codex_local", Runtime: "codex", Model: "cheap-model"},
		}
		if _, err := f.server.store.SavePersonalAgentSettings(ctx, agent.ID, agent.Settings); err != nil {
			t.Fatal(err)
		}
		for _, scope := range []string{"", "ws_alice"} {
			if err := f.server.store.SetExecutionDefault(ctx, store.StoredExecutionModelDefault{
				OwnerUserID: f.aliceID, WorkspaceID: scope, ProviderID: "codex_local",
				Runtime: "codex", Model: "cheap-model", Alternatives: []store.ExecutionModelChoice{},
			}); err != nil {
				t.Fatal(err)
			}
		}
		helper, err := f.server.runs.Resolve(ctx, agent, "executor", "ws_alice")
		if err != nil || helper.ProfileID != "claude_local" || helper.Model != "smart-model" {
			t.Fatalf("assistant override: %+v %v", helper, err)
		}
	})

	t.Run("workspace", func(t *testing.T) {
		f := newAssistantFixture(t)
		ctx := context.Background()
		registerHelperAccounts(t, f)
		agent := mustAgent(t, f)
		for scope, model := range map[string]string{"": "cheap-model", "ws_alice": "smart-model"} {
			runtime, profileID := "codex", "codex_local"
			if model == "smart-model" {
				runtime, profileID = "claude", "claude_local"
			}
			if err := f.server.store.SetExecutionDefault(ctx, store.StoredExecutionModelDefault{
				OwnerUserID: f.aliceID, WorkspaceID: scope, ProviderID: profileID,
				Runtime: runtime, Model: model, Alternatives: []store.ExecutionModelChoice{},
			}); err != nil {
				t.Fatal(err)
			}
		}
		helper, err := f.server.runs.Resolve(ctx, agent, "executor", "ws_alice")
		if err != nil || helper.ProfileID != "claude_local" || helper.Model != "smart-model" {
			t.Fatalf("workspace: %+v %v", helper, err)
		}
	})

	t.Run("global", func(t *testing.T) {
		f := newAssistantFixture(t)
		ctx := context.Background()
		registerHelperAccounts(t, f)
		agent := mustAgent(t, f)
		if err := f.server.store.SetExecutionDefault(ctx, store.StoredExecutionModelDefault{
			OwnerUserID: f.aliceID, ProviderID: "codex_local", Runtime: "codex",
			Model: "cheap-model", Alternatives: []store.ExecutionModelChoice{},
		}); err != nil {
			t.Fatal(err)
		}
		helper, err := f.server.runs.Resolve(ctx, agent, "executor", "ws_alice")
		if err != nil || helper.ProfileID != "codex_local" || helper.Model != "cheap-model" {
			t.Fatalf("global: %+v %v", helper, err)
		}
	})

	t.Run("legacy", func(t *testing.T) {
		f := newAssistantFixture(t)
		ctx := context.Background()
		registerHelperAccounts(t, f)
		agent := mustAgent(t, f)
		agent.Settings.RoleOverrides = map[string]store.PersonalAgentRunPreference{
			"executor": {ProfileID: "claude_local", Runtime: "claude", Model: "smart-model"},
		}
		if _, err := f.server.store.SavePersonalAgentSettings(ctx, agent.ID, agent.Settings); err != nil {
			t.Fatal(err)
		}
		helper, err := f.server.runs.Resolve(ctx, agent, "executor", "ws_alice")
		if err != nil || helper.ProfileID != "claude_local" || helper.Model != "smart-model" {
			t.Fatalf("legacy: %+v %v", helper, err)
		}
	})
}

func TestExecutorWorkerGroupAndAlternatives(t *testing.T) {
	f := newAssistantFixture(t)
	ctx := context.Background()
	registerHelperAccounts(t, f)
	group, err := f.server.store.SaveWorkerGroup(ctx, store.StoredWorkerGroup{
		OwnerUserID: f.aliceID, Label: "Interchangeable helpers",
		Members: []store.WorkerGroupMember{
			{ProviderKind: "subscription", ProviderID: "claude_local", Runtime: "claude", Model: "smart-model"},
			{ProviderKind: "subscription", ProviderID: "codex_local", Runtime: "codex", Model: "cheap-model"},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	agent := mustAgent(t, f)
	agent.Settings.ExecutionModels = &store.PersonalAgentExecutionModels{
		WorkerGroupID: group.ID,
		Alternatives: []store.ExecutionModelChoice{{
			ProviderKind: store.ExecutionModelChoiceProviderKindSubscription,
			ProviderID:   "codex_local", Runtime: "codex", Model: "cheap-model",
		}},
	}
	if _, err := f.server.store.SavePersonalAgentSettings(ctx, agent.ID, agent.Settings); err != nil {
		t.Fatal(err)
	}
	helper, err := f.server.runs.ResolveExecutor(ctx, agent, "ws_alice", "default")
	if err != nil || helper.Model == "" || !slices.Contains([]string{"smart-model", "cheap-model"}, helper.Model) {
		t.Fatalf("group member: %+v %v", helper, err)
	}
	alternativeID := personalagent.ExecutionChoiceID(agent.Settings.ExecutionModels.Alternatives[0])
	alternative, err := f.server.runs.ResolveExecutor(ctx, agent, "ws_alice", alternativeID)
	if err != nil || alternative.ProfileID != "codex_local" || alternative.Model != "cheap-model" ||
		alternative.SelectionReason != run.ReasonExecutionAlternative {
		t.Fatalf("alternative by id: %+v %v", alternative, err)
	}
	if err := f.server.runs.ValidateExecutorChoice(ctx, agent, "ws_alice", "not-listed"); err == nil || !strings.Contains(err.Error(), "executionChoice") {
		t.Fatalf("invalid choice: %v", err)
	}
}

func TestDispatchItemRejectsExecutionChoiceOutsideTheList(t *testing.T) {
	f := newAssistantFixture(t)
	ctx := context.Background()
	agent := mustAgent(t, f)
	agent.Settings.ExecutionModels = &store.PersonalAgentExecutionModels{
		ProviderID: "claude_local", Runtime: "claude", Model: "smart-model",
		Alternatives: []store.ExecutionModelChoice{{
			ProviderID: "codex_local", Runtime: "codex", Model: "cheap-model",
		}},
	}
	if _, err := f.server.store.SavePersonalAgentSettings(ctx, agent.ID, agent.Settings); err != nil {
		t.Fatal(err)
	}
	item, err := f.server.store.AddPersonalAgentItem(ctx, store.PersonalAgentListItem{
		UserID: f.aliceID, AssistantID: agent.ID, Text: "Reject an unlisted helper model",
		Plan: &store.PersonalAgentItemPlan{Mode: "execute", Progress: "ready", WorkspaceID: "ws_alice"},
	})
	if err != nil {
		t.Fatal(err)
	}
	text, failed := f.tool(t, f.token, "dispatch_item", map[string]any{
		"itemId": item.ID, "intentRevision": item.IntentRevision,
		"stepKey": "reject-choice", "workspaceId": "ws_alice",
		"prompt": "Do not run with an unlisted model.", "executionChoice": "not-listed",
	})
	if !failed || !strings.Contains(text, "executionChoice") {
		t.Fatalf("unlisted executionChoice was accepted: %s", text)
	}
}

func TestAssistantGetExecutionDefaultReturnsItsOwnOverride(t *testing.T) {
	f := newAssistantFixture(t)
	ctx := context.Background()
	agent := mustAgent(t, f)
	agent.Settings.ExecutionModels = &store.PersonalAgentExecutionModels{
		ProviderID: "claude_local", Runtime: "claude", Model: "smart-model",
		Alternatives: []store.ExecutionModelChoice{{
			ProviderID: "codex_local", Runtime: "codex", Model: "cheap-model",
		}},
	}
	if _, err := f.server.store.SavePersonalAgentSettings(ctx, agent.ID, agent.Settings); err != nil {
		t.Fatal(err)
	}
	text, failed := f.tool(t, f.token, "get_execution_default", map[string]any{"workspaceId": "ws_alice"})
	var view executionDefaultsView
	if failed || json.Unmarshal([]byte(text), &view) != nil {
		t.Fatalf("read assistant execution model: %s", text)
	}
	if view.Effective.Scope != "assistant" || view.Effective.Model != "smart-model" ||
		len(view.Effective.Alternatives) != 1 || view.Effective.Alternatives[0].ID == "" {
		t.Fatalf("assistant execution model = %+v", view.Effective)
	}
}

// The assistant's settings never choose a Chat session's account: a
// session naming none runs on the account last used there, else the first
// usable one, whatever the person picked for their assistant.
func TestChatAccountIgnoresTheAssistantsChoice(t *testing.T) {
	f := newAssistantFixture(t)
	ctx := context.Background()
	workspace := registerHelperAccounts(t, f)
	agent, err := f.server.store.GetPersonalAgent(ctx, f.aliceID)
	if err != nil {
		t.Fatal(err)
	}
	first, _, err := f.server.chooseAccount(ctx, workspace, "", f.aliceID)
	if err != nil {
		t.Fatal(err)
	}
	other := "codex_local"
	if first.ProfileID == other {
		other = "claude_local"
	}
	agent.Settings.AssistantProfileID = other
	agent.Settings.RunDefault = &store.PersonalAgentRunPreference{ProfileID: other}
	agent.Settings.RoleOverrides = map[string]store.PersonalAgentRunPreference{"executor": {ProfileID: other}}
	if _, err := f.server.store.SavePersonalAgentSettings(ctx, agent.ID, agent.Settings); err != nil {
		t.Fatal(err)
	}
	chosen, _, err := f.server.chooseAccount(ctx, workspace, "", f.aliceID)
	if err != nil || chosen.ProfileID != first.ProfileID {
		t.Fatalf("chat followed the assistant: %+v (before %s) %v", chosen, first.ProfileID, err)
	}
	choice, ok, err := f.server.chooseAgent(ctx, workspace, nil, "", f.aliceID)
	if err != nil || !ok || choice.ProfileID != first.ProfileID {
		t.Fatalf("chat agent followed the assistant: %+v %v", choice, err)
	}
}
