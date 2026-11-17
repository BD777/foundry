package httpapi

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// A child session that names no model runs on the target workspace's
// execution default, not on its parent's profile (DEV-269). The parent here
// names Claude on another account, which the child must not copy.

// chatParent is an orchestrator chat in ws_budget that named its own model.
func (f accountsFixture) chatParent(t *testing.T, provider, profileID, model string) (store.AgentSession, string) {
	t.Helper()
	ctx := context.Background()
	parent, err := f.db.CreateAgentSession(ctx, store.CreateAgentSessionInput{
		CreatedByUserID: f.aliceID, WorkspaceID: "ws_budget", AgentID: "agent_budget",
		Provider: provider, ProfileID: profileID, Model: model, Prompt: "orchestrate", Source: "chat",
	})
	if err != nil {
		t.Fatal(err)
	}
	token, err := f.db.MintAgentSessionToken(ctx, parent.ID)
	if err != nil {
		t.Fatal(err)
	}
	return parent, token
}

func setWorkspaceExecutionDefault(t *testing.T, db executionDefaultWriter, userID, workspaceID string, value store.StoredExecutionModelDefault) {
	t.Helper()
	value.OwnerUserID, value.WorkspaceID = userID, workspaceID
	if value.Alternatives == nil {
		value.Alternatives = []store.ExecutionModelChoice{}
	}
	if err := db.SetExecutionDefault(context.Background(), value); err != nil {
		t.Fatal(err)
	}
}

type executionDefaultWriter interface {
	SetExecutionDefault(ctx context.Context, value store.StoredExecutionModelDefault) error
}

// childStartResult is the create_session answer this file reads.
type childStartResult struct {
	ID     string `json:"id"`
	Model  string `json:"model"`
	RunsOn string `json:"runsOn"`
}

func createChildSession(t *testing.T, call func(string, any) (string, bool), arguments map[string]any) childStartResult {
	t.Helper()
	if _, given := arguments["prompt"]; !given {
		arguments["prompt"] = "do the work"
	}
	text, isError := call("create_session", arguments)
	if isError {
		t.Fatalf("create_session = %s", text)
	}
	var result childStartResult
	if err := json.Unmarshal([]byte(text), &result); err != nil || result.ID == "" {
		t.Fatalf("create_session result = %s", text)
	}
	return result
}

func storedSession(t *testing.T, f accountsFixture, id string) store.AgentSession {
	t.Helper()
	session, err := f.db.GetAgentSession(context.Background(), id)
	if err != nil {
		t.Fatal(err)
	}
	return session
}

func TestChildSessionNamesNoModelRunsOnTheWorkspaceExecutionDefault(t *testing.T) {
	f := newAccountsFixture(t)
	_, token := f.chatParent(t, "claude", "claude_local", "parent-opus")
	setWorkspaceExecutionDefault(t, f.db, f.aliceID, "ws_budget", store.StoredExecutionModelDefault{
		ProviderID: accountsGateway, Runtime: "codex", Model: "flux/GPT-6.1-Sol", Effort: "high",
	})

	child := createChildSession(t, mcpToolCaller(t, f.server.Routes(), token), map[string]any{})
	stored := storedSession(t, f, child.ID)
	if stored.Provider != "codex" || stored.ProfileID != accountsGateway || stored.Model != "flux/GPT-6.1-Sol" ||
		stored.CodexReasoningEffort != "high" || stored.ParentSessionID == "" {
		t.Fatalf("child runs on %s %s/%s effort %q, want the workspace's execution default", stored.Provider, stored.ProfileID, stored.Model, stored.CodexReasoningEffort)
	}
	if !strings.Contains(child.RunsOn, "the workspace's execution default") || !strings.Contains(child.RunsOn, "flux/GPT-6.1-Sol (high)") {
		t.Fatalf("result runsOn = %q", child.RunsOn)
	}
}

func TestChildSessionNamesNoModelTakesTheExecutionDefaultWorkerGroup(t *testing.T) {
	f := newAccountsFixture(t)
	ctx := context.Background()
	group, err := f.db.SaveWorkerGroup(ctx, store.StoredWorkerGroup{
		OwnerUserID: f.aliceID, Label: "Default workers",
		Members: []store.WorkerGroupMember{{
			ProviderKind: "discovered", ProviderID: accountsGateway, Runtime: "codex", Model: "group-model", Effort: "medium",
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	_, token := f.chatParent(t, "claude", "claude_local", "parent-opus")
	setWorkspaceExecutionDefault(t, f.db, f.aliceID, "ws_budget", store.StoredExecutionModelDefault{WorkerGroupID: group.ID})

	child := createChildSession(t, mcpToolCaller(t, f.server.Routes(), token), map[string]any{})
	stored := storedSession(t, f, child.ID)
	if stored.WorkerGroupID != group.ID || stored.ProfileID != accountsGateway || stored.Model != "group-model" {
		t.Fatalf("child runs on group %q %s/%s, want the default group's member", stored.WorkerGroupID, stored.ProfileID, stored.Model)
	}
	if !strings.Contains(child.RunsOn, "worker group") || !strings.Contains(child.RunsOn, "group-model") {
		t.Fatalf("result runsOn = %q", child.RunsOn)
	}
}

func TestChildSessionFallsBackWhenTheExecutionDefaultCannotRunOnTheComputer(t *testing.T) {
	f := newAccountsFixture(t)
	_, token := f.chatParent(t, "claude", "claude_local", "parent-opus")
	// The service is not assigned to the workspace's device.
	setWorkspaceExecutionDefault(t, f.db, f.aliceID, "ws_budget", store.StoredExecutionModelDefault{
		ProviderID: f.service.ID, Runtime: "claude", Model: "service-model",
	})

	child := createChildSession(t, mcpToolCaller(t, f.server.Routes(), token), map[string]any{})
	stored := storedSession(t, f, child.ID)
	if stored.ProfileID != accountsGateway {
		t.Fatalf("fallback account = %q, want the workspace's usable account %q", stored.ProfileID, accountsGateway)
	}
	if !strings.Contains(child.RunsOn, "the workspace's account default") || !strings.Contains(child.RunsOn, "cannot run on this computer") {
		t.Fatalf("result runsOn = %q", child.RunsOn)
	}
}

func TestChildSessionKeepsAModelItsOrchestratorNamed(t *testing.T) {
	f := newAccountsFixture(t)
	_, token := f.chatParent(t, "claude", "claude_local", "parent-opus")
	setWorkspaceExecutionDefault(t, f.db, f.aliceID, "ws_budget", store.StoredExecutionModelDefault{
		ProviderID: accountsGateway, Runtime: "codex", Model: "flux/GPT-6.1-Sol", Effort: "high",
	})
	call := mcpToolCaller(t, f.server.Routes(), token)

	outside := createChildSession(t, call, map[string]any{"provider": "claude", "profileId": "claude_local", "model": "claude-opus-5-5"})
	stored := storedSession(t, f, outside.ID)
	if stored.Provider != "claude" || stored.ProfileID != "claude_local" || stored.Model != "claude-opus-5-5" {
		t.Fatalf("a named model was changed: %s %s/%s", stored.Provider, stored.ProfileID, stored.Model)
	}
	if !strings.Contains(outside.RunsOn, "which you named") || !strings.Contains(outside.RunsOn, "not among this workspace's execution models") ||
		!strings.Contains(outside.RunsOn, "flux/GPT-6.1-Sol") {
		t.Fatalf("result runsOn = %q", outside.RunsOn)
	}

	inside := createChildSession(t, call, map[string]any{"provider": "codex", "profileId": accountsGateway, "model": "flux/GPT-6.1-Sol", "codexReasoningEffort": "low"})
	insideStored := storedSession(t, f, inside.ID)
	if insideStored.Model != "flux/GPT-6.1-Sol" || insideStored.CodexReasoningEffort != "low" {
		t.Fatalf("a named model that is the execution default was changed: %s/%s effort %q", insideStored.ProfileID, insideStored.Model, insideStored.CodexReasoningEffort)
	}
	if inside.RunsOn != "" {
		t.Fatalf("a choice inside the execution models needs no remark: %q", inside.RunsOn)
	}
}

func TestChildSessionForkKeepsItsSourceAgent(t *testing.T) {
	f := newAccountsFixture(t)
	parent, token := f.chatParent(t, "claude", "claude_local", "parent-opus")
	setWorkspaceExecutionDefault(t, f.db, f.aliceID, "ws_budget", store.StoredExecutionModelDefault{
		ProviderID: accountsGateway, Runtime: "codex", Model: "flux/GPT-6.1-Sol",
	})

	child := createChildSession(t, mcpToolCaller(t, f.server.Routes(), token), map[string]any{"prompt": "fork it", "forkSessionId": parent.ID})
	stored := storedSession(t, f, child.ID)
	if stored.Provider != parent.Provider || stored.ProfileID != parent.ProfileID || stored.AgentID != parent.AgentID {
		t.Fatalf("fork runs on %s %s/%s, want its source's %s %s/%s", stored.Provider, stored.ProfileID, stored.AgentID, parent.Provider, parent.ProfileID, parent.AgentID)
	}
	if child.RunsOn != "" {
		t.Fatalf("a fork needs no execution-model remark: %q", child.RunsOn)
	}
}
