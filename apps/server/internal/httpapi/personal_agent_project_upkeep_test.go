package httpapi

import (
	"context"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/personalagent/assistant"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// A project's review outlives the assistant that last ran it: its next run
// resolves the person's current default assistant (DEV-256).
func TestProjectUpkeepRunsOnTheCurrentDefaultAssistant(t *testing.T) {
	f := newDigestFixture(t)
	ctx := context.Background()
	enableVerificationSessions(f)
	budget := f.digest(t)
	agent := defaultAssistantOf(t, f.server, f.aliceID)
	review, err := f.server.store.EnqueuePersonalAgentMaintenance(ctx, store.PersonalAgentMaintenance{
		ID: "maint-gone-executor", AssistantID: "asst_removed", UserID: f.aliceID, Role: "governance",
		WorkspaceID: "ws_budget", EventKey: assistant.GovernanceEventKey(budget),
	})
	if err != nil {
		t.Fatal(err)
	}
	f.server.assistant.RunMaintenance(ctx, review)
	ran, err := f.server.store.GetWorkspaceMaintenance(ctx, f.aliceID, "ws_budget", review.ID)
	if err != nil || ran.AssistantID != agent.ID || ran.Status != "running" {
		t.Fatalf("review whose executor was removed = %+v (%v), want running on %s", ran, err, agent.ID)
	}
	run := f.daemon.nextChatRun()
	f.daemon.complete(run.Session, `{"summary":"healthy","findings":[],"patches":[]}`)
	waitForStatus(t, f.db, run.Session.ID, "completed")
}

// Without a default assistant a project's review waits, and says why, rather
// than running on nobody's behalf (DEV-256).
func TestProjectUpkeepWaitsWhenThePersonHasNoDefaultAssistant(t *testing.T) {
	f := newDigestFixture(t)
	ctx := context.Background()
	member, err := f.db.CreateUser(ctx, store.NewUser{Username: "upkeep-owner", PasswordHash: "unused", Role: store.RoleMember})
	if err != nil {
		t.Fatal(err)
	}
	if err := f.db.SetWorkspaceMember(ctx, "ws_budget", member.ID, store.WorkspaceRoleOwner, "test"); err != nil {
		t.Fatal(err)
	}
	if _, err := f.server.workspaceDigests().Digest(ctx, member.ID, "ws_budget"); err != nil {
		t.Fatal(err)
	}
	records, err := f.db.ListWorkspaceDigests(ctx, member.ID)
	if err != nil || len(records) != 1 {
		t.Fatalf("digests = %+v, %v", records, err)
	}
	review, err := f.server.store.EnqueuePersonalAgentMaintenance(ctx, store.PersonalAgentMaintenance{
		ID: "maint-no-default", AssistantID: "asst_removed", UserID: member.ID, Role: "governance",
		WorkspaceID: "ws_budget", EventKey: assistant.GovernanceEventKey(records[0]),
	})
	if err != nil {
		t.Fatal(err)
	}
	f.server.assistant.RunMaintenance(ctx, review)
	waiting, err := f.server.store.GetWorkspaceMaintenance(ctx, member.ID, "ws_budget", review.ID)
	if err != nil || waiting.Status != "waiting" || waiting.Reason != "no_default_assistant" {
		t.Fatalf("review without a default assistant = %+v (%v), want waiting/no_default_assistant", waiting, err)
	}
}
