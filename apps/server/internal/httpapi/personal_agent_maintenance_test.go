package httpapi

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/personalagent"
	"github.com/foundry-dev/foundry/apps/server/internal/personalagent/assistant"
	"github.com/foundry-dev/foundry/apps/server/internal/personalagent/prompt"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"github.com/foundry-dev/foundry/apps/server/internal/workspacedigest"
)

// fail reports the session's turn as failed, as a device does.
func (d *digestDaemon) fail(session store.AgentSession, message string) {
	d.write("test_failed_"+session.ID, wsSessionCompleteType, map[string]any{
		"sessionId": session.ID, "inputId": session.Input.ID, "error": message,
	})
}

// nextUpkeepNotice is the next run that is not Foundry's own utility work
// (a digest summary or a chat title).
func (d *digestDaemon) nextUpkeepNotice() wsRunSessionPayload {
	for {
		run := d.nextRun()
		if run.Session.Source == store.SessionSourceDigest || run.Session.Source == "naming" {
			continue
		}
		return run
	}
}

func TestMaintenanceEventCaptureIsIdempotent(t *testing.T) {
	f := newAssistantFixture(t)
	ctx := context.Background()
	agent := defaultAssistantOf(t, f.server, f.aliceID)
	f.server.assistant.EnqueueMaintenance(ctx, agent, "governance", "ws_project", "", "revision-one")
	f.server.assistant.EnqueueMaintenance(ctx, agent, "governance", "ws_project", "", "revision-one")
	jobs, e := f.server.store.ListWorkspaceMaintenance(ctx, f.aliceID, "ws_project")
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
	jobs, _ = f.server.store.ListWorkspaceMaintenance(ctx, f.aliceID, "ws_project")
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

// A large project's packet stops at the read bound and says what it omitted;
// it never makes one review read every docs/ file over the device channel.
func TestGovernancePacketIsBounded(t *testing.T) {
	f := newDigestFixture(t)
	ctx := context.Background()
	files := []store.WorkspaceFileEntry{
		{ID: "root", WorkspaceID: "ws_budget", Path: "AGENTS.md", Name: "AGENTS.md", Kind: "file"},
	}
	for i := 0; i < 60; i++ {
		path := fmt.Sprintf("docs/%02d.md", i)
		files = append(files, store.WorkspaceFileEntry{ID: path, WorkspaceID: "ws_budget", Path: path, Name: path, Kind: "file"})
	}
	if err := f.db.RegisterDaemon(ctx, store.DaemonRegistration{
		Device:         store.DeviceProjection{ID: "dev_home", Label: "MacBook", Status: "connected"},
		Workspace:      store.WorkspaceProjection{ID: "ws_budget", Name: "Budget", LocalPath: "/home/me/budget"},
		WorkspaceFiles: files,
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
	if !strings.Contains(prompt, `"omittedFiles":13`) {
		t.Fatalf("packet did not report omitted files:\n%s", prompt)
	}
	if got := strings.Count(prompt, `"path":"docs/`); got != 47 {
		t.Fatalf("packet read %d docs files, want 47", got)
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
	if run.Session.Source != "verification" || run.Session.Input.ExecutionBudget == nil || run.Session.WorkspaceID != "ws_pa" {
		t.Fatalf("wrong role envelope %+v", run.Session)
	}
	if !strings.Contains(run.Session.Input.Prompt, `"workspaceId":"ws_budget"`) {
		t.Fatalf("governance did not read the target over the device channel: %s", run.Session.Input.Prompt)
	}
	// Replaying the dispatcher after native acceptance reconciles its identity.
	f.server.assistant.RunMaintenance(ctx, job)
	sessions, _ := f.db.ListAgentSessionSummaries(ctx, "ws_pa")
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

// enableVerificationSessions adds the read-only verifier capability the
// fixture's device ships without.
func enableVerificationSessions(f digestFixture) {
	c := f.server.hub.connectionFor("dev_home")
	if c == nil {
		return
	}
	c.registrationMu.Lock()
	defer c.registrationMu.Unlock()
	for _, capability := range c.registration.Capabilities {
		if capability == store.DaemonCapabilityVerificationSessions {
			return
		}
	}
	c.registration.Capabilities = append(c.registration.Capabilities, store.DaemonCapabilityVerificationSessions)
}

// Governance runs in the assistant's home workspace, not in the project it
// reviews; the project's files arrive over the device channel (DEV-238).
func TestGovernanceRunsInTheAssistantHomeAndReadsTheTargetOverTheChannel(t *testing.T) {
	f := newDigestFixture(t)
	ctx := context.Background()
	enableVerificationSessions(f)
	f.daemon.setInstruction("AGENTS.md", "# Budget\n\nRun make before publishing.\n")
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
	agent := defaultAssistantOf(t, f.server, f.aliceID)
	job, err := f.server.store.EnqueuePersonalAgentMaintenance(ctx, store.PersonalAgentMaintenance{
		ID: "maint-home", AssistantID: agent.ID, UserID: f.aliceID, Role: "governance",
		WorkspaceID: "ws_budget", EventKey: assistant.GovernanceEventKey(f.digest(t)),
	})
	if err != nil {
		t.Fatal(err)
	}
	f.server.assistant.RunMaintenance(ctx, job)
	job, _ = f.server.store.GetPersonalAgentMaintenance(ctx, agent.ID, job.ID)
	if job.Status != "running" {
		t.Fatalf("did not start: %+v", job)
	}
	run := f.daemon.nextChatRun()
	if run.Session.WorkspaceID != "ws_pa" {
		t.Fatalf("governance ran in %s, want the assistant home ws_pa", run.Session.WorkspaceID)
	}
	if !strings.Contains(run.Session.Input.Prompt, `"workspaceId":"ws_budget"`) ||
		!strings.Contains(run.Session.Input.Prompt, "Run make before publishing.") {
		t.Fatalf("governance lacked the target packet:\n%s", run.Session.Input.Prompt)
	}
	f.daemon.complete(run.Session, `{"summary":"healthy","findings":[],"patches":[]}`)
	waitForStatus(t, f.db, run.Session.ID, "completed")
}

// Digests are the person's upkeep: a stopped default assistant's conversation
// does not freeze them on its online home (DEV-238).
func TestDigestSummariesRunOnAStoppedDefaultAssistantsHome(t *testing.T) {
	f := newDigestFixture(t)
	ctx := context.Background()
	agent := defaultAssistantOf(t, f.server, f.aliceID)
	if _, err := f.db.SetPersonalAgentState(ctx, agent.ID, store.PersonalAgentStopped); err != nil {
		t.Fatal(err)
	}
	f.digest(t)
	f.server.runDigestSummaries(ctx, 0)
	records, _ := f.db.ListWorkspaceDigests(ctx, f.aliceID)
	var record store.WorkspaceDigestRecord
	for _, candidate := range records {
		if candidate.Digest.WorkspaceID == "ws_budget" {
			record = candidate
		}
	}
	select {
	case run := <-f.daemon.runs:
		if run.Session.Source != store.SessionSourceDigest || run.Session.WorkspaceID != "ws_pa" {
			t.Fatalf("summary did not run on the stopped assistant's home: %+v", run.Session)
		}
		f.daemon.complete(run.Session, `{"l0":"budget","summary":"Tracks the family budget.","routeWhen":[],"notWhen":[]}`)
		waitForStatus(t, f.db, run.Session.ID, "completed")
	case <-time.After(5 * time.Second):
		if record.SummarySessionID != "" {
			claimed, _ := f.db.GetAgentSessionSummary(ctx, record.SummarySessionID)
			t.Fatalf("no summary session; digest = %+v; claimed session = %+v", record, claimed)
		}
		t.Fatalf("no summary session; digest = %+v", record)
	}
	if current, _ := f.db.GetAssistant(ctx, agent.ID); current.State != store.PersonalAgentStopped {
		t.Fatal("upkeep resumed the assistant's conversation")
	}
}

// A project whose machine is away defers only its own review; reviews that
// read an online project keep running (DEV-238).
func TestAnOfflineTargetDefersOnlyItsOwnReview(t *testing.T) {
	f := newDigestFixture(t)
	ctx := context.Background()
	enableVerificationSessions(f)
	budget := f.digest(t)
	if err := f.db.RegisterDaemon(ctx, store.DaemonRegistration{
		Device:    store.DeviceProjection{ID: "dev_away", Label: "Away", Status: "disconnected"},
		Workspace: store.WorkspaceProjection{ID: "ws_away", Name: "Away project", LocalPath: "/home/me/away"},
	}); err != nil {
		t.Fatal(err)
	}
	if err := f.db.SetWorkspaceMember(ctx, "ws_away", f.aliceID, store.WorkspaceRoleOwner, "test"); err != nil {
		t.Fatal(err)
	}
	if _, err := f.server.workspaceDigests().Digest(ctx, f.aliceID, "ws_away"); err != nil {
		t.Fatal(err)
	}
	records, err := f.server.store.ListWorkspaceDigests(ctx, f.aliceID)
	if err != nil {
		t.Fatal(err)
	}
	away := store.WorkspaceDigestRecord{}
	for _, record := range records {
		if record.Digest.WorkspaceID == "ws_away" {
			away = record
		}
	}
	if away.Digest.WorkspaceID == "" {
		t.Fatal("no digest for the offline project")
	}
	agent := defaultAssistantOf(t, f.server, f.aliceID)
	offline, err := f.server.store.EnqueuePersonalAgentMaintenance(ctx, store.PersonalAgentMaintenance{
		ID: "maint-offline", AssistantID: agent.ID, UserID: f.aliceID, Role: "governance",
		WorkspaceID: "ws_away", EventKey: assistant.GovernanceEventKey(away),
	})
	if err != nil {
		t.Fatal(err)
	}
	online, err := f.server.store.EnqueuePersonalAgentMaintenance(ctx, store.PersonalAgentMaintenance{
		ID: "maint-online", AssistantID: agent.ID, UserID: f.aliceID, Role: "governance",
		WorkspaceID: "ws_budget", EventKey: assistant.GovernanceEventKey(budget),
	})
	if err != nil {
		t.Fatal(err)
	}
	f.server.assistant.RunMaintenance(ctx, offline)
	offline, _ = f.server.store.GetPersonalAgentMaintenance(ctx, agent.ID, offline.ID)
	if offline.Status != "waiting" || offline.Reason != "target_device_offline" {
		t.Fatalf("offline target = %+v, want waiting/target_device_offline", offline)
	}
	f.server.assistant.RunMaintenance(ctx, online)
	online, _ = f.server.store.GetPersonalAgentMaintenance(ctx, agent.ID, online.ID)
	if online.Status != "running" {
		t.Fatalf("an offline project blocked another review: %+v", online)
	}
	run := f.daemon.nextChatRun()
	f.daemon.complete(run.Session, `{"summary":"healthy","findings":[],"patches":[]}`)
	waitForStatus(t, f.db, run.Session.ID, "completed")
}

// A target archived or removed while a review waited is settled, never left
// waiting for a person who cannot act on it (DEV-238).
func TestArchivedTargetsAndWaitingReviewsAreSuperseded(t *testing.T) {
	f := newDigestFixture(t)
	ctx := context.Background()
	enableVerificationSessions(f)
	agent := defaultAssistantOf(t, f.server, f.aliceID)
	record := f.digest(t)
	job, err := f.server.store.EnqueuePersonalAgentMaintenance(ctx, store.PersonalAgentMaintenance{
		ID: "maint-archive", AssistantID: agent.ID, UserID: f.aliceID, Role: "governance",
		WorkspaceID: "ws_budget", EventKey: assistant.GovernanceEventKey(record),
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.SetWorkspaceArchived(ctx, "ws_budget", time.Now()); err != nil {
		t.Fatal(err)
	}
	f.server.assistant.RunMaintenance(ctx, job)
	job, _ = f.server.store.GetPersonalAgentMaintenance(ctx, agent.ID, job.ID)
	if job.Status != "superseded" || job.Reason != "workspace_archived" {
		t.Fatalf("archived target = %+v, want superseded/workspace_archived", job)
	}
	// A review already waiting for approval is settled by the sweep too.
	job.Status, job.Reason = "review", ""
	job.Result = &store.MaintenanceResult{Summary: "change", Patches: []store.MaintenancePatch{{Path: "AGENTS.md", Content: "# x", Reason: "y"}}}
	if _, err := f.server.store.SavePersonalAgentMaintenance(ctx, job); err != nil {
		t.Fatal(err)
	}
	saved := assistant.UpkeepSweepInterval
	assistant.UpkeepSweepInterval = 0
	defer func() { assistant.UpkeepSweepInterval = saved }()
	f.server.assistant.FinalizeGoneTargets(ctx)
	job, _ = f.server.store.GetPersonalAgentMaintenance(ctx, agent.ID, job.ID)
	if job.Status != "superseded" || job.Reason != "workspace_archived" {
		t.Fatalf("review on an archived target = %+v, want superseded", job)
	}
}

// A review that must wait for a running one is postponed before a session
// exists: a concurrency/budget refusal is not a failed native run.
func TestBusyMaintenanceDoesNotCreateASession(t *testing.T) {
	f := newDigestFixture(t)
	ctx := context.Background()
	enableVerificationSessions(f)
	budget := f.digest(t)
	if err := f.db.RegisterDaemon(ctx, store.DaemonRegistration{
		Device:    store.DeviceProjection{ID: "dev_home", Label: "MacBook", Status: "connected"},
		Workspace: store.WorkspaceProjection{ID: "ws_second", Name: "Second", LocalPath: "/home/me/second"},
	}); err != nil {
		t.Fatal(err)
	}
	if err := f.db.SetWorkspaceMember(ctx, "ws_second", f.aliceID, store.WorkspaceRoleOwner, "test"); err != nil {
		t.Fatal(err)
	}
	if _, err := f.server.workspaceDigests().Digest(ctx, f.aliceID, "ws_second"); err != nil {
		t.Fatal(err)
	}
	records, _ := f.server.store.ListWorkspaceDigests(ctx, f.aliceID)
	second := store.WorkspaceDigestRecord{}
	for _, record := range records {
		if record.Digest.WorkspaceID == "ws_second" {
			second = record
		}
	}
	agent := defaultAssistantOf(t, f.server, f.aliceID)
	first, err := f.server.store.EnqueuePersonalAgentMaintenance(ctx, store.PersonalAgentMaintenance{
		ID: "maint-first", AssistantID: agent.ID, UserID: f.aliceID, Role: "governance",
		WorkspaceID: "ws_budget", EventKey: assistant.GovernanceEventKey(budget),
	})
	if err != nil {
		t.Fatal(err)
	}
	f.server.assistant.RunMaintenance(ctx, first)
	first, _ = f.server.store.GetPersonalAgentMaintenance(ctx, agent.ID, first.ID)
	if first.Status != "running" {
		t.Fatalf("first review did not start: %+v", first)
	}
	run := f.daemon.nextChatRun()
	countVerification := func() int {
		sessions, _ := f.db.ListAgentSessionSummaries(ctx, "ws_pa")
		count := 0
		for _, session := range sessions {
			if session.Source == store.SessionSourceVerification {
				count++
			}
		}
		return count
	}
	before := countVerification()
	blocked, err := f.server.store.EnqueuePersonalAgentMaintenance(ctx, store.PersonalAgentMaintenance{
		ID: "maint-blocked", AssistantID: agent.ID, UserID: f.aliceID, Role: "governance",
		WorkspaceID: "ws_second", EventKey: assistant.GovernanceEventKey(second),
	})
	if err != nil {
		t.Fatal(err)
	}
	f.server.assistant.RunMaintenance(ctx, blocked)
	blocked, _ = f.server.store.GetPersonalAgentMaintenance(ctx, agent.ID, blocked.ID)
	if blocked.Status != "waiting" || blocked.Reason != "maintenance_busy" {
		t.Fatalf("second review = %+v, want waiting/maintenance_busy", blocked)
	}
	if after := countVerification(); after != before {
		t.Fatalf("a busy review created a session: %d -> %d", before, after)
	}
	f.daemon.complete(run.Session, `{"summary":"healthy","findings":[],"patches":[]}`)
	waitForStatus(t, f.db, run.Session.ID, "completed")
}

// A failed review is retried a bounded number of times with backoff.
func TestFailedReviewsRetryWithBackoff(t *testing.T) {
	f := newDigestFixture(t)
	ctx := context.Background()
	enableVerificationSessions(f)
	f.server.hub.retrySessionFailure = func(context.Context, store.AgentSession, string) (bool, error) { return false, nil }
	agent := defaultAssistantOf(t, f.server, f.aliceID)
	job, err := f.server.store.EnqueuePersonalAgentMaintenance(ctx, store.PersonalAgentMaintenance{
		ID: "maint-retry", AssistantID: agent.ID, UserID: f.aliceID, Role: "governance",
		WorkspaceID: "ws_budget", EventKey: assistant.GovernanceEventKey(f.digest(t)),
	})
	if err != nil {
		t.Fatal(err)
	}
	f.server.assistant.RunMaintenance(ctx, job)
	for attempt := 1; attempt <= 2; attempt++ {
		run := f.daemon.nextChatRun()
		f.daemon.fail(run.Session, "sandbox failed")
		waitForStatus(t, f.db, run.Session.ID, "failed")
		// The next drain settles the failed run and schedules a retry.
		job, _ = f.server.store.GetPersonalAgentMaintenance(ctx, agent.ID, job.ID)
		f.server.assistant.RunMaintenance(ctx, job)
		job, _ = f.server.store.GetPersonalAgentMaintenance(ctx, agent.ID, job.ID)
		if job.Attempt != attempt || job.Status != "pending" || job.Reason != "retry_scheduled" || job.InputID != "" || job.SessionID != "" {
			t.Fatalf("attempt %d = %+v, want pending/retry_scheduled with no input", attempt, job)
		}
		f.server.assistant.RunMaintenance(ctx, job)
	}
	run := f.daemon.nextChatRun()
	f.daemon.fail(run.Session, "sandbox failed again")
	waitForStatus(t, f.db, run.Session.ID, "failed")
	job, _ = f.server.store.GetPersonalAgentMaintenance(ctx, agent.ID, job.ID)
	f.server.assistant.RunMaintenance(ctx, job)
	job, _ = f.server.store.GetPersonalAgentMaintenance(ctx, agent.ID, job.ID)
	if job.Status != "failed" || job.Attempt != 2 {
		t.Fatalf("exhausted retries = %+v, want failed at attempt 2", job)
	}
}

// Upkeep facts live in the assistant's own folder and never become a turn
// of its conversation, even as the state changes (DEV-252).
func TestUpkeepFactsAreWrittenNotSent(t *testing.T) {
	f := newDigestFixture(t)
	ctx := context.Background()
	agent := defaultAssistantOf(t, f.server, f.aliceID)
	job, err := f.server.store.EnqueuePersonalAgentMaintenance(ctx, store.PersonalAgentMaintenance{
		ID: "maint-facts", AssistantID: agent.ID, UserID: f.aliceID, Role: "governance",
		WorkspaceID: "ws_budget", EventKey: "facts-event",
	})
	if err != nil {
		t.Fatal(err)
	}
	job.Status = "review"
	job.Result = &store.MaintenanceResult{Summary: "change", Patches: []store.MaintenancePatch{{Path: "AGENTS.md", Content: "# x", Reason: "y"}}}
	if saved, err := f.server.store.SavePersonalAgentMaintenance(ctx, job); err != nil {
		t.Fatal(err)
	} else {
		job = saved
	}
	saved := assistant.UpkeepSweepInterval
	assistant.UpkeepSweepInterval = 0
	defer func() { assistant.UpkeepSweepInterval = saved }()
	f.server.assistant.RefreshUpkeep(ctx)
	facts := f.daemon.workspaceFiles("ws_pa")[prompt.UpkeepPath]
	for _, want := range []string{"Budget", "1 suggested change", "/workspace?workspace=ws_budget"} {
		if !strings.Contains(facts, want) {
			t.Fatalf("the upkeep file lacks %q:\n%s", want, facts)
		}
	}
	// Count churn rewrites the facts, and still sends nothing.
	job.Result = &store.MaintenanceResult{Summary: "change", Patches: []store.MaintenancePatch{
		{Path: "AGENTS.md", Content: "# x", Reason: "y"},
		{Path: "README.md", Content: "# y", Reason: "z"},
	}}
	if _, err := f.server.store.SavePersonalAgentMaintenance(ctx, job); err != nil {
		t.Fatal(err)
	}
	f.server.assistant.RefreshUpkeep(ctx)
	if facts := f.daemon.workspaceFiles("ws_pa")[prompt.UpkeepPath]; !strings.Contains(facts, "2 suggested changes") {
		t.Fatalf("the upkeep file did not follow the state:\n%s", facts)
	}
	deadline := time.After(300 * time.Millisecond)
	for {
		select {
		case run := <-f.daemon.runs:
			if run.Session.Source == "naming" {
				continue
			}
			t.Fatalf("upkeep sent a turn: %+v", run.Session)
		case <-deadline:
			return
		}
	}
}

// Only the assistant the upkeep belongs to gets it, with its own settings
// link: a second assistant's review never appears in the default's file.
func TestUpkeepFactsGoOnlyToTheOwningAssistant(t *testing.T) {
	f := newDigestFixture(t)
	ctx := context.Background()
	owner := defaultAssistantOf(t, f.server, f.aliceID)
	if err := f.db.RegisterDaemon(ctx, store.DaemonRegistration{
		Device:    store.DeviceProjection{ID: "dev_home", Label: "MacBook", Status: "connected"},
		Workspace: store.WorkspaceProjection{ID: "ws_second", Name: "Second", LocalPath: "/home/me/second"},
	}); err != nil {
		t.Fatal(err)
	}
	if err := f.db.SetWorkspaceMember(ctx, "ws_second", f.aliceID, store.WorkspaceRoleOwner, "test"); err != nil {
		t.Fatal(err)
	}
	second, err := f.db.CreatePersonalAgent(ctx, store.PersonalAgent{
		UserID: f.aliceID, WorkspaceID: "ws_second", HomeDeviceID: "dev_home", Settings: personalagent.DefaultSettings(),
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, job := range []store.PersonalAgentMaintenance{
		{ID: "maint-owner", AssistantID: owner.ID, UserID: f.aliceID, Role: "governance", WorkspaceID: "ws_budget", EventKey: "owner"},
		{ID: "maint-second", AssistantID: second.ID, UserID: f.aliceID, Role: "memory", WorkspaceID: "ws_second", VaultID: "v", EventKey: "second"},
	} {
		stored, err := f.server.store.EnqueuePersonalAgentMaintenance(ctx, job)
		if err != nil {
			t.Fatal(err)
		}
		stored.Status = "review"
		stored.Result = &store.MaintenanceResult{Patches: []store.MaintenancePatch{{Path: "AGENTS.md", Content: "# x", Reason: "y"}}}
		if _, err := f.server.store.SavePersonalAgentMaintenance(ctx, stored); err != nil {
			t.Fatal(err)
		}
	}
	saved := assistant.UpkeepSweepInterval
	assistant.UpkeepSweepInterval = 0
	defer func() { assistant.UpkeepSweepInterval = saved }()
	f.server.assistant.RefreshUpkeep(ctx)
	ownerFacts := f.daemon.workspaceFiles("ws_pa")[prompt.UpkeepPath]
	secondFacts := f.daemon.workspaceFiles("ws_second")[prompt.UpkeepPath]
	if !strings.Contains(ownerFacts, "Budget") || strings.Contains(ownerFacts, "ws_second") ||
		!strings.Contains(ownerFacts, "/workspace?workspace=ws_budget") {
		t.Fatalf("the default assistant's upkeep file = %q", ownerFacts)
	}
	if !strings.Contains(secondFacts, "Second") || strings.Contains(secondFacts, "ws_budget") ||
		!strings.Contains(secondFacts, "/workspace?workspace=ws_second") {
		t.Fatalf("the second assistant's upkeep file = %q", secondFacts)
	}
}

func TestGovernanceActivityDoesNotScheduleAnotherReview(t *testing.T) {
	f := newDigestFixture(t)
	ctx := context.Background()
	record := f.digest(t)
	f.server.assistant.CaptureMaintenanceEvents(ctx)
	count := func() int {
		rows, err := f.server.store.ListWorkspaceMaintenance(ctx, f.aliceID, "ws_budget")
		if err != nil {
			t.Fatal(err)
		}
		return len(rows)
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
