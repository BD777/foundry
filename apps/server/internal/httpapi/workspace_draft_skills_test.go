package httpapi

import (
	"context"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"testing"
)

func TestSkillTrialRejectsInheritedHistoryAndInvalidModes(t *testing.T) {
	f := setupProjectedSessionFixture(t)
	for _, input := range []store.CreateAgentSessionInput{
		{SkillSelection: &store.SkillSelection{Mode: "invalid"}},
		{SkillSelection: &store.SkillSelection{Mode: "include"}, ForkSessionID: "old"},
		{SkillSelection: &store.SkillSelection{Mode: "include"}, NativeSessionID: "old"},
		{SkillSelection: &store.SkillSelection{Mode: "include"}, ChatID: "old"},
		{SkillSelection: &store.SkillSelection{Mode: "exclude"}, ImportedContext: "target skill text"},
	} {
		input.WorkspaceID = f.workspace.ID
		if _, err := f.server.resolveSkillTrial(context.Background(), input); err == nil {
			t.Fatal("unsafe trial accepted")
		}
	}
}
func TestWorkspaceDraftViewDoesNotClaimAnOfflineWorkerSupportsTrials(t *testing.T) {
	f := setupProjectedSessionFixture(t)
	view, err := f.server.workspaceDraftView(context.Background(), f.workspace.ID, false)
	if err != nil {
		t.Fatal(err)
	}
	if view.Supported {
		t.Fatal("offline worker reported supported")
	}
	if _, err = f.server.workspaceDraftView(context.Background(), f.workspace.ID, true); err == nil {
		t.Fatal("offline refresh succeeded")
	}
}

func TestSkillTrialsLockOnlyAuthorizedDraftRevisions(t *testing.T) {
	f := setupProjectedSessionFixture(t)
	ctx := context.Background()
	connection := newDaemonConnection(f.server.hub, nil)
	connection.deviceID = f.deviceID
	connection.registration.Capabilities = []string{workspaceDraftCapability}
	f.server.hub.connections[f.deviceID] = connection
	defer close(connection.done)
	draft := store.WorkspaceDraftSkill{ID: "draft_one", WorkspaceID: f.workspace.ID, ExecutionRootID: f.workspace.ID, Name: "example", Digest: "v1", Status: "ready", SnapshotPath: "/verified/v1/SKILL.md", SnapshotDigest: "manifest"}
	if err := f.backing.SaveWorkspaceDrafts(ctx, f.workspace.ID, f.workspace.ID, store.WorkspaceDraftSkills{Enabled: true, Supported: true, Skills: []store.WorkspaceDraftSkill{draft}}); err != nil {
		t.Fatal(err)
	}
	input := store.CreateAgentSessionInput{WorkspaceID: f.workspace.ID, AgentID: f.agentID, Provider: "claude", Prompt: "trial", SkillSelection: &store.SkillSelection{Mode: "include", Drafts: []store.DraftSelectionRef{{ID: draft.ID, Digest: draft.Digest}}}}
	selected, err := f.server.resolveSkillTrial(ctx, input)
	if err != nil {
		t.Fatal(err)
	}
	if len(selected.Drafts) != 1 || selected.Drafts[0].Digest != "v1" {
		t.Fatalf("snapshot not locked: %#v", selected)
	}
	input.SkillSelection.Mode = "exclude"
	selected, err = f.server.resolveSkillTrial(ctx, input)
	if err != nil {
		t.Fatal(err)
	}
	if len(selected.Drafts) != 0 {
		t.Fatal("baseline includes target draft")
	}
	governance := draft
	governance.ID = "draft_governance"
	governance.Name = "Foundry"
	if err := f.backing.SaveWorkspaceDrafts(ctx, f.workspace.ID, f.workspace.ID, store.WorkspaceDraftSkills{Enabled: true, Skills: []store.WorkspaceDraftSkill{governance}}); err != nil {
		t.Fatal(err)
	}
	original := input.SkillSelection.Drafts
	input.SkillSelection.Drafts = []store.DraftSelectionRef{{ID: governance.ID, Digest: governance.Digest}}
	if _, err = f.server.resolveSkillTrial(ctx, input); err == nil {
		t.Fatal("case variation replaced governance")
	}
	input.SkillSelection.Drafts = original
	input.SkillSelection.Drafts[0].Digest = "not-scanned"
	if _, err = f.server.resolveSkillTrial(ctx, input); err == nil {
		t.Fatal("unresolved snapshot accepted")
	}
	input.SkillSelection.Drafts = nil
	input.SkillSelection.Names = []string{"foundry"}
	if _, err = f.server.resolveSkillTrial(ctx, input); err == nil {
		t.Fatal("governance removed")
	}
	input.SkillSelection.Names = nil
	input.SkillSelection.Drafts = []store.DraftSelectionRef{{ID: draft.ID, Digest: draft.Digest}}
	if err := f.backing.SetWorkspaceDraftsEnabled(ctx, f.workspace.ID, false); err != nil {
		t.Fatal(err)
	}
	if _, err = f.server.resolveSkillTrial(ctx, input); err == nil {
		t.Fatal("disabled workspace draft accepted")
	}
}

func TestSkillTrialChildrenCannotReintroduceExcludedMethods(t *testing.T) {
	f := setupProjectedSessionFixture(t)
	ctx := context.Background()
	parent, err := f.backing.CreateAgentSession(ctx, store.CreateAgentSessionInput{WorkspaceID: f.workspace.ID, AgentID: f.agentID, Provider: "claude", Prompt: "baseline", ResolvedSkillSelection: &store.ResolvedSkillSelection{Mode: "exclude", ExcludedNames: []string{"example"}, Drafts: []store.WorkspaceDraftSkill{}, LibraryRefs: []store.SessionSkillRef{}}})
	if err != nil {
		t.Fatal(err)
	}
	child := store.CreateAgentSessionInput{WorkspaceID: f.workspace.ID, AgentID: f.agentID, Provider: "claude", ParentSessionID: parent.ID, Prompt: "subtask"}
	if err = f.server.prepareSessionSkillSelection(ctx, &child); err != nil {
		t.Fatal(err)
	}
	if child.ResolvedSkillSelection == nil || child.ResolvedSkillSelection.Mode != "exclude" || len(child.ResolvedSkillSelection.ExcludedNames) != 1 {
		t.Fatal("child did not inherit the baseline")
	}
	for _, change := range []func(*store.CreateAgentSessionInput){
		func(c *store.CreateAgentSessionInput) { c.SkillSelection = &store.SkillSelection{Mode: "include"} },
		func(c *store.CreateAgentSessionInput) { c.WorkspaceID = "another" },
		func(c *store.CreateAgentSessionInput) { c.ForkSessionID = "creator" },
		func(c *store.CreateAgentSessionInput) { c.ImportedContext = "method text" },
	} {
		candidate := child
		change(&candidate)
		if err = f.server.prepareSessionSkillSelection(ctx, &candidate); err == nil {
			t.Fatal("child escaped locked trial inputs")
		}
	}
}
