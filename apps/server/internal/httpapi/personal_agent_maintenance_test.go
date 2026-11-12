package httpapi

import (
	"context"
	"fmt"
	"strings"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/personalagent/assistant"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"github.com/foundry-dev/foundry/apps/server/internal/workspacedigest"
)

func TestMaintenanceEventCaptureIsIdempotent(t *testing.T) {
	f := newAssistantFixture(t)
	ctx := context.Background()
	agent := defaultAssistantOf(t, f.server, f.aliceID)
	f.server.assistant.EnqueueMaintenance(ctx, agent, "governance", "ws_project", "", "revision-one")
	f.server.assistant.EnqueueMaintenance(ctx, agent, "governance", "ws_project", "", "revision-one")
	jobs, e := f.server.store.ListPersonalAgentMaintenance(ctx, agent.ID)
	if e != nil || len(jobs) != 1 {
		t.Fatalf("jobs %+v %v", jobs, e)
	}
	job := jobs[0]
	job.Status = "complete"
	job.Result = &store.MaintenanceResult{Summary: "healthy"}
	if _, e = f.server.store.SavePersonalAgentMaintenance(ctx, job); e != nil {
		t.Fatal(e)
	}
	f.server.assistant.EnqueueMaintenance(ctx, agent, "governance", "ws_project", "", "revision-one")
	jobs, _ = f.server.store.ListPersonalAgentMaintenance(ctx, agent.ID)
	if len(jobs) != 1 || jobs[0].Status != "complete" {
		t.Fatal("unchanged content scheduled another model call")
	}
}

func TestGovernancePromptIncludesLongInstructionBudget(t *testing.T) {
	f := newDigestFixture(t)
	ctx := context.Background()
	release := "## Release\n" + strings.Repeat("Publish from the release branch after the full browser matrix.\n", 12)
	agents := strings.Repeat("Use the repository convention.\n", 287) + release
	f.daemon.setInstruction("AGENTS.md", agents)
	if err := f.db.RegisterDaemon(ctx, store.DaemonRegistration{
		Device:    store.DeviceProjection{ID: "dev_home", Label: "MacBook", Status: "connected"},
		Workspace: store.WorkspaceProjection{ID: "ws_budget", Name: "Budget", LocalPath: "/home/me/budget"},
		WorkspaceFiles: []store.WorkspaceFileEntry{
			{ID: "f1", WorkspaceID: "ws_budget", Path: "AGENTS.md", Name: "AGENTS.md", Kind: "file"},
			{ID: "f2", WorkspaceID: "ws_budget", Path: "README.md", Name: "README.md", Kind: "file"},
		},
		Agents: []store.AgentProjection{{
			ID: "agent_budget", WorkspaceID: "ws_budget", DeviceID: "dev_home", Provider: "claude", Status: "healthy",
			AuthMode: "local_config", SecretStored: "local", ConfigScope: "workspace", ConfigLabel: "local", LastSeenLabel: "online",
		}},
	}); err != nil {
		t.Fatal(err)
	}
	prompt, err := f.server.assistant.MaintenancePrompt(ctx, store.PersonalAgentMaintenance{Role: "governance", WorkspaceID: "ws_budget", UserID: f.aliceID})
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		fmt.Sprintf(`"path":"AGENTS.md","lines":300,"bytes":%d`, len(agents)),
		`"overLineBudget":true`,
		"at or below 200 lines",
		"patches must only split or delete. Do not add content.",
		"Never use @import",
	} {
		if !strings.Contains(prompt, want) {
			t.Fatalf("governance prompt lacks %q:\n%s", want, prompt)
		}
	}
}

func TestMaintenanceNativeReceiptAndSandboxBoundary(t *testing.T) {
	f := newDigestFixture(t)
	ctx := context.Background()
	agent := defaultAssistantOf(t, f.server, f.aliceID)
	job, e := f.server.store.EnqueuePersonalAgentMaintenance(ctx, store.PersonalAgentMaintenance{ID: "maint-lifecycle", AssistantID: agent.ID, UserID: f.aliceID, Role: "governance", WorkspaceID: "ws_budget", EventKey: assistant.GovernanceEventKey(f.digest(t))})
	if e != nil {
		t.Fatal(e)
	}
	f.server.assistant.RunMaintenance(ctx, job)
	job, _ = f.server.store.GetPersonalAgentMaintenance(ctx, agent.ID, job.ID)
	if job.Status != "waiting" || job.Reason != "worker_update_required" {
		t.Fatalf("ran without readonly sandbox: %+v", job)
	}
	c := f.server.hub.connectionFor("dev_home")
	c.registrationMu.Lock()
	c.registration.Capabilities = append(c.registration.Capabilities, store.DaemonCapabilityVerificationSessions)
	c.registrationMu.Unlock()
	f.server.assistant.RunMaintenance(ctx, job)
	job, _ = f.server.store.GetPersonalAgentMaintenance(ctx, agent.ID, job.ID)
	if job.Status != "running" {
		t.Fatalf("did not start: %+v", job)
	}
	run := f.daemon.nextChatRun()
	if run.Session.Source != "verification" || run.Session.Input.ExecutionBudget == nil || run.Session.WorkspaceID != "ws_budget" {
		t.Fatalf("wrong role envelope %+v", run.Session)
	}
	// Replaying the dispatcher after native acceptance reconciles its identity.
	f.server.assistant.RunMaintenance(ctx, job)
	sessions, _ := f.db.ListAgentSessionSummaries(ctx, "ws_budget")
	if len(sessions) != 1 {
		t.Fatal("duplicate maintenance execution")
	}
	f.daemon.complete(run.Session, `{"summary":"Review the missing contract","findings":[{"kind":"missing","summary":"State the workspace purpose","sourceRefs":["AGENTS.md"]}],"patches":[{"path":"AGENTS.md","baseHash":"missing","content":"# Synthetic context\nPurpose: compare formats.","reason":"Make the purpose explicit"}]}`)
	waitForStatus(t, f.db, run.Session.ID, "completed")
	job, _ = f.server.store.GetPersonalAgentMaintenance(ctx, agent.ID, job.ID)
	f.server.assistant.RunMaintenance(ctx, job)
	job, _ = f.server.store.GetPersonalAgentMaintenance(ctx, agent.ID, job.ID)
	if job.Status != "review" || job.Result == nil {
		t.Fatalf("missing proposal %+v", job)
	}
	source, e := (digestSources{f.server}).Collect(ctx, workspacedigest.Access{UserID: f.aliceID, WorkspaceID: "ws_budget", Role: store.WorkspaceRoleOwner})
	if e != nil {
		t.Fatal(e)
	}
	for _, session := range source.Sessions {
		if session.ID == run.Session.ID {
			t.Fatal("maintenance became new source activity")
		}
	}
	// File writes cannot begin while a conversation relies on this context.
	active, e := f.db.CreateAgentSession(ctx, store.CreateAgentSessionInput{CreatedByUserID: f.aliceID, WorkspaceID: "ws_budget", AgentID: "agent_budget", Prompt: "Independent work"})
	if e != nil {
		t.Fatal(e)
	}
	patches := f.server.store.(store.PersonalAgentContextPatchStore)
	op := store.PersonalAgentContextPatch{ID: "context-once", AssistantID: agent.ID, UserID: f.aliceID, JobID: job.ID, WorkspaceID: "ws_budget", DeviceID: "dev_home", Index: 0, Path: "AGENTS.md", BaseHash: "", Hash: "expected"}
	if _, e = patches.BeginPersonalAgentContextPatch(ctx, op, job.Revision); e == nil || !strings.Contains(e.Error(), "workspace_active") {
		t.Fatalf("changed live context: %v", e)
	}
	_, _ = f.db.CancelAgentSession(ctx, active.ID, "synthetic test cleanup")
	op, e = patches.BeginPersonalAgentContextPatch(ctx, op, job.Revision)
	if e != nil {
		t.Fatal(e)
	}
	_, e = f.db.CreateAgentSession(ctx, store.CreateAgentSessionInput{CreatedByUserID: f.aliceID, WorkspaceID: "ws_budget", AgentID: "agent_budget", Prompt: "New work while receipt unknown"})
	if e == nil || !strings.Contains(e.Error(), "workspace_context_update_pending") {
		t.Fatalf("new work bypassed context fence: %v", e)
	}
	op.Status = "conflict"
	if _, e = patches.SavePersonalAgentContextPatch(ctx, op); e != nil {
		t.Fatal(e)
	}
}

func TestGovernanceActivityDoesNotScheduleAnotherReview(t *testing.T) {
	f := newDigestFixture(t)
	ctx := context.Background()
	agent := defaultAssistantOf(t, f.server, f.aliceID)
	record := f.digest(t)
	f.server.assistant.CaptureMaintenanceEvents(ctx)
	count := func() int {
		rows, err := f.server.store.ListPersonalAgentMaintenance(ctx, agent.ID)
		if err != nil {
			t.Fatal(err)
		}
		n := 0
		for _, row := range rows {
			if row.Role == "governance" && row.WorkspaceID == "ws_budget" {
				n++
			}
		}
		return n
	}
	if count() != 1 {
		t.Fatal("initial review missing")
	}
	record.ContentRev = "ordinary-session-finished"
	record.Digest.RecentSessions = []store.WorkspaceDigestSession{{ID: "new-session", Status: "completed"}}
	if err := f.server.store.SaveWorkspaceDigest(ctx, record); err != nil {
		t.Fatal(err)
	}
	f.server.assistant.CaptureMaintenanceEvents(ctx)
	if count() != 1 {
		t.Fatal("ordinary activity scheduled another model review")
	}
	record.FilesRev = "reviewed-instructions-really-changed"
	if err := f.server.store.SaveWorkspaceDigest(ctx, record); err != nil {
		t.Fatal(err)
	}
	f.server.assistant.CaptureMaintenanceEvents(ctx)
	if count() != 2 {
		t.Fatal("instruction change was lost")
	}
}
