package httpapi

import (
	"context"
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
		if account.runtime == "codex" {
			profile.Model, profile.Models = "cheap-model", []string{"cheap-model"}
		}
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
	if preview := f.server.previewHelper(ctx, agent, "ws_alice"); preview.Model != "cheap-model" || preview.Unavailable != "" || preview.Note != "" {
		t.Fatalf("preview: %+v", preview)
	}

	// The chosen model is not on that computer: the step waits and the
	// assistant is told why at once.
	agent.Settings.RoleOverrides["executor"] = store.PersonalAgentRunPreference{ProfileID: "codex_local", Runtime: "codex", Model: "absent-model"}
	if _, err := f.server.runs.Resolve(ctx, agent, "executor", "ws_alice"); err == nil || !strings.Contains(err.Error(), "model_unavailable") {
		t.Fatalf("missing model silently replaced: %v", err)
	}
	if preview := f.server.previewHelper(ctx, agent, "ws_alice"); !strings.Contains(preview.Unavailable, "model_unavailable") || preview.Note == "" {
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
		if preview := f.server.previewHelper(ctx, agent, "ws_alice"); preview.Reason != run.ReasonUsedDeviceDefault || preview.Note == "" {
			t.Fatalf("fallback preview: %+v", preview)
		}
	}

	// The assistant itself keeps its own choice throughout.
	coordinator, err := personalagent.RunPreference(agent.Settings, "coordinator")
	if err != nil || coordinator.Model != "smart-model" {
		t.Fatalf("assistant: %+v %v", coordinator, err)
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
	if _, err := f.server.store.SavePersonalAgentSettings(ctx, f.aliceID, agent.Settings); err != nil {
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
