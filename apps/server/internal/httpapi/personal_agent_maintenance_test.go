package httpapi

import (
	"context"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"github.com/foundry-dev/foundry/apps/server/internal/workspacedigest"
	"strings"
	"testing"
)

func TestMaintenanceResultRejectsWritesOutsideReviewedContract(t *testing.T) {
	valid := `{"summary":"Initialize purpose","findings":[],"patches":[{"path":"AGENTS.md","baseHash":"missing","content":"# Purpose\nAsk before changing goals.","reason":"No context file exists"}]}`
	if _, e := parseMaintenanceResult("governance", valid); e != nil {
		t.Fatal(e)
	}
	for _, raw := range []string{strings.Replace(valid, "AGENTS.md", "../AGENTS.md", 1), strings.Replace(valid, "missing", "not-a-hash", 1), strings.Replace(valid, `"findings":[]`, `"findings":[{"kind":"confirmed_fact","summary":"guess","sourceRefs":[]}]`, 1)} {
		if _, e := parseMaintenanceResult("governance", raw); e == nil {
			t.Fatal("invalid model output accepted", raw)
		}
	}
	if _, e := parseMaintenanceResult("memory", valid); e == nil {
		t.Fatal("memory review wrote a new source fact")
	}
}
func TestMaintenanceEventCaptureIsIdempotent(t *testing.T) {
	f := newAssistantFixture(t)
	ctx := context.Background()
	b, e := f.server.maintenanceStore()
	if e != nil {
		t.Fatal(e)
	}
	f.server.enqueueMaintenance(ctx, b, f.aliceID, "governance", "ws_project", "", "revision-one")
	f.server.enqueueMaintenance(ctx, b, f.aliceID, "governance", "ws_project", "", "revision-one")
	jobs, e := b.ListPersonalAgentMaintenance(ctx, f.aliceID)
	if e != nil || len(jobs) != 1 {
		t.Fatalf("jobs %+v %v", jobs, e)
	}
	job := jobs[0]
	job.Status = "complete"
	job.Result = &store.MaintenanceResult{Summary: "healthy"}
	if _, e = b.SavePersonalAgentMaintenance(ctx, job); e != nil {
		t.Fatal(e)
	}
	f.server.enqueueMaintenance(ctx, b, f.aliceID, "governance", "ws_project", "", "revision-one")
	jobs, _ = b.ListPersonalAgentMaintenance(ctx, f.aliceID)
	if len(jobs) != 1 || jobs[0].Status != "complete" {
		t.Fatal("unchanged content scheduled another model call")
	}
}

func TestMaintenanceNativeReceiptAndSandboxBoundary(t *testing.T) {
	f := newDigestFixture(t)
	ctx := context.Background()
	b, _ := f.server.maintenanceStore()
	job, e := b.EnqueuePersonalAgentMaintenance(ctx, store.PersonalAgentMaintenance{ID: "maint-lifecycle", UserID: f.aliceID, Role: "governance", WorkspaceID: "ws_budget", EventKey: governanceEventKey(f.digest(t))})
	if e != nil {
		t.Fatal(e)
	}
	f.server.runMaintenance(ctx, b, job)
	job, _ = b.GetPersonalAgentMaintenance(ctx, f.aliceID, job.ID)
	if job.Status != "waiting" || job.Reason != "worker_update_required" {
		t.Fatalf("ran without readonly sandbox: %+v", job)
	}
	c := f.server.hub.connectionFor("dev_home")
	c.registrationMu.Lock()
	c.registration.Capabilities = append(c.registration.Capabilities, store.DaemonCapabilityVerificationSessions)
	c.registrationMu.Unlock()
	f.server.runMaintenance(ctx, b, job)
	job, _ = b.GetPersonalAgentMaintenance(ctx, f.aliceID, job.ID)
	if job.Status != "running" {
		t.Fatalf("did not start: %+v", job)
	}
	run := f.daemon.nextChatRun()
	if run.Session.Source != "verification" || run.Session.Input.ExecutionBudget == nil || run.Session.WorkspaceID != "ws_budget" {
		t.Fatalf("wrong role envelope %+v", run.Session)
	}
	// Replaying the dispatcher after native acceptance reconciles its identity.
	f.server.runMaintenance(ctx, b, job)
	sessions, _ := f.db.ListAgentSessionSummaries(ctx, "ws_budget")
	if len(sessions) != 1 {
		t.Fatal("duplicate maintenance execution")
	}
	f.daemon.complete(run.Session, `{"summary":"Review the missing contract","findings":[{"kind":"missing","summary":"State the workspace purpose","sourceRefs":["AGENTS.md"]}],"patches":[{"path":"AGENTS.md","baseHash":"missing","content":"# Synthetic context\nPurpose: compare formats.","reason":"Make the purpose explicit"}]}`)
	waitForStatus(t, f.db, run.Session.ID, "completed")
	job, _ = b.GetPersonalAgentMaintenance(ctx, f.aliceID, job.ID)
	f.server.runMaintenance(ctx, b, job)
	job, _ = b.GetPersonalAgentMaintenance(ctx, f.aliceID, job.ID)
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
	op := store.PersonalAgentContextPatch{ID: "context-once", UserID: f.aliceID, JobID: job.ID, WorkspaceID: "ws_budget", DeviceID: "dev_home", Index: 0, Path: "AGENTS.md", BaseHash: "missing", Hash: "expected"}
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
	b, _ := f.server.maintenanceStore()
	record := f.digest(t)
	f.server.captureMaintenanceEvents(ctx, b)
	count := func() int {
		rows, err := b.ListPersonalAgentMaintenance(ctx, f.aliceID)
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
	f.server.captureMaintenanceEvents(ctx, b)
	if count() != 1 {
		t.Fatal("ordinary activity scheduled another model review")
	}
	record.FilesRev = "reviewed-instructions-really-changed"
	if err := f.server.store.SaveWorkspaceDigest(ctx, record); err != nil {
		t.Fatal(err)
	}
	f.server.captureMaintenanceEvents(ctx, b)
	if count() != 2 {
		t.Fatal("instruction change was lost")
	}
}
