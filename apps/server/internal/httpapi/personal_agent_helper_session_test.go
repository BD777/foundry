package httpapi

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/personalagent"
	"github.com/foundry-dev/foundry/apps/server/internal/sessions"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// createHelper starts a session through the assistant's create_session and
// answers the session it started, or the tool's refusal.
func (f assistantFixture) createHelper(t *testing.T, arguments map[string]any) (store.AgentSession, string, bool) {
	t.Helper()
	text, failed := f.tool(t, f.token, "create_session", arguments)
	if failed {
		return store.AgentSession{}, text, true
	}
	var answer struct {
		ID     string `json:"id"`
		Status string `json:"status"`
	}
	if err := json.Unmarshal([]byte(text), &answer); err != nil || answer.ID == "" {
		t.Fatalf("create_session answer = %q (%v)", text, err)
	}
	session, err := f.server.store.GetAgentSessionSummary(context.Background(), answer.ID)
	if err != nil {
		t.Fatal(err)
	}
	return session, text, false
}

// The assistant starts a helper through the generic create_session: in a
// workspace its permission package includes, as its conversation's child,
// followed as a task and counted against the person's §9 limits.
func TestAssistantCreatesHelperThroughCreateSession(t *testing.T) {
	f := newAssistantFixture(t)
	ctx := context.Background()
	helper, text, failed := f.createHelper(t, map[string]any{
		"workspaceId": "ws_alice", "prompt": "tidy the synthetic photos", "title": "Tidy photos",
	})
	if failed {
		t.Fatalf("create_session: %s", text)
	}
	if helper.WorkspaceID != "ws_alice" || helper.ParentSessionID != f.conversation.ID ||
		helper.CreatedByUserID != f.aliceID || helper.Source != store.SessionSourceAgent || helper.Title != "Tidy photos" {
		t.Fatalf("helper = %+v", helper)
	}
	agent := mustAgent(t, f)
	tasks, err := f.server.store.ListPersonalAgentTasks(ctx, agent.ID, nil)
	if err != nil {
		t.Fatal(err)
	}
	followed := false
	for _, task := range tasks {
		if task.SessionID == helper.ID && task.ConversationSessionID == f.conversation.ID {
			followed = true
		}
	}
	if !followed {
		t.Fatalf("the helper is not followed as an assistant task: %+v", tasks)
	}
	usage, err := f.server.store.PersonalAgentUsage(ctx, agent, personalagent.Windows(time.Now(), time.UTC))
	if err != nil {
		t.Fatal(err)
	}
	if usage.SessionsToday != 1 || usage.ActiveSessions != 1 {
		t.Fatalf("limits did not count the helper: %+v", usage)
	}
}

// Only workspaces the assistant's permission package includes as a Member
// start a helper; the refusal reads as dispatch_item's.
func TestAssistantCreateSessionRefusesOutOfScopeWorkspace(t *testing.T) {
	f := newAssistantFixture(t)
	f.editPackage(t, func(pkg *store.PermissionPackage) {
		pkg.Workspaces = store.PermissionListRule{Scope: store.PermissionListScopeListed, Include: []string{"ws_bob"}}
	})
	if _, text, failed := f.createHelper(t, map[string]any{"workspaceId": "ws_alice", "prompt": "work here"}); !failed || !strings.Contains(text, "permissions do not include") {
		t.Fatalf("create_session outside the package = %q, want it refused", text)
	}
	helper, text, failed := f.createHelper(t, map[string]any{"workspaceId": "ws_bob", "prompt": "work there"})
	if failed || helper.WorkspaceID != "ws_bob" {
		t.Fatalf("create_session inside the package = %q", text)
	}
}

// A helper that names no account runs on the assistant's executor role
// (its configured default), not on the workspace's first account.
func TestAssistantCreateSessionAppliesExecutorDefault(t *testing.T) {
	f := newAssistantFixture(t)
	ctx := context.Background()
	registerHelperAccounts(t, f)
	agent := mustAgent(t, f)
	agent.Settings.RoleOverrides = map[string]store.PersonalAgentRunPreference{
		"executor": {ProfileID: "codex_local", Runtime: "codex", Model: "cheap-model", Effort: "low"},
	}
	if _, err := f.server.store.SavePersonalAgentSettings(ctx, agent.ID, agent.Settings); err != nil {
		t.Fatal(err)
	}
	helper, text, failed := f.createHelper(t, map[string]any{"workspaceId": "ws_alice", "prompt": "sort the inbox"})
	if failed {
		t.Fatalf("create_session: %s", text)
	}
	if helper.Provider != "codex" || helper.ProfileID != "codex_local" || helper.Model != "cheap-model" || helper.CodexReasoningEffort != "low" {
		t.Fatalf("helper ran on %s/%s %s (%s), want the executor default codex_local/cheap-model (low)",
			helper.Provider, helper.ProfileID, helper.Model, helper.CodexReasoningEffort)
	}
}

// An operation captured before the generic start path (already in flight)
// still drains: it starts a session through the same admission, delivers
// the assistant's own prompt without a Foundry preamble, and reconciles to
// review when that turn completes.
func TestLegacyInFlightOperationDrainsThroughTheGenericPath(t *testing.T) {
	f := newAssistantFixture(t)
	ctx := context.Background()
	agent := mustAgent(t, f)
	items := f.server.store.(store.PersonalAgentListStore)
	item, err := items.AddPersonalAgentItem(ctx, store.PersonalAgentListItem{
		AssistantID: agent.ID, UserID: f.aliceID, Text: "tidy the synthetic photos",
		Plan: &store.PersonalAgentItemPlan{Mode: "execute", Progress: "ready", WorkspaceID: "ws_alice"},
	})
	if err != nil {
		t.Fatal(err)
	}
	const prompt = "Tidy the synthetic photos; report the files you changed."
	text, failed := f.tool(t, f.token, "dispatch_item", map[string]any{
		"itemId": item.ID, "intentRevision": item.IntentRevision, "stepKey": "legacy", "workspaceId": "ws_alice", "prompt": prompt,
	})
	if failed {
		t.Fatalf("capture: %s", text)
	}
	var captured store.PersonalAgentOperation
	if err := json.Unmarshal([]byte(text), &captured); err != nil || captured.ID == "" {
		t.Fatalf("capture answer = %q (%v)", text, err)
	}
	// As an operation captured before DEV-239 waits between capture and
	// delivery: it is already claiming its dispatch.
	op, err := f.server.store.GetPersonalAgentOperation(ctx, agent.ID, captured.ID)
	if err != nil {
		t.Fatal(err)
	}
	op.Status = "dispatching"
	if op, err = f.server.store.SavePersonalAgentOperation(ctx, op); err != nil {
		t.Fatal(err)
	}
	f.server.hub.connections["dev_alice"] = &daemonConnection{
		hub: f.server.hub, deviceID: "dev_alice", done: make(chan struct{}), send: make(chan wsEnvelope, 64),
		rpc: newDaemonRPC(), activeSessions: map[string]bool{}, dispatchedSessions: map[string]string{},
	}
	f.server.assistant.DeliverOperation(ctx, op)
	delivered, err := f.server.store.GetPersonalAgentOperation(ctx, agent.ID, op.ID)
	if err != nil || delivered.Status != "delivered" || delivered.SessionID == "" {
		t.Fatalf("legacy operation did not deliver: %+v %v", delivered, err)
	}
	session, err := f.server.store.GetAgentSessionSummary(ctx, delivered.SessionID)
	if err != nil {
		t.Fatal(err)
	}
	if session.Input.Prompt != prompt {
		t.Fatalf("delivered prompt = %q, want the assistant's brief alone", session.Input.Prompt)
	}
	if session.ParentSessionID != f.conversation.ID || session.WorkspaceID != "ws_alice" || session.Source != store.SessionSourceAgent {
		t.Fatalf("legacy helper = %+v", session)
	}
	if session.Status == "queued" {
		if _, err := f.server.store.StartAgentSession(ctx, session.ID); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := f.server.store.CompleteAgentSession(ctx, session.ID, "Changed 2 files.", "native-legacy"); err != nil {
		t.Fatal(err)
	}
	f.server.assistant.DeliverOperation(ctx, delivered)
	reviewed, err := f.server.store.GetPersonalAgentOperation(ctx, agent.ID, op.ID)
	if err != nil || reviewed.Status != "review" || reviewed.Reason != "execution_completed_requires_evidence" {
		t.Fatalf("legacy operation did not reconcile: %+v %v", reviewed, err)
	}
}

// A helper's finished turn reaches the assistant conversation as turn_end,
// the generic child report, not a separate supervision notice only.
func TestAssistantHelperTurnEndReachesTheConversation(t *testing.T) {
	f := newAssistantFixture(t)
	ctx := context.Background()
	if _, err := f.server.store.StartAgentSession(ctx, f.conversation.ID); err != nil {
		t.Fatal(err)
	}
	helper, text, failed := f.createHelper(t, map[string]any{"workspaceId": "ws_alice", "prompt": "count the photos"})
	if failed {
		t.Fatalf("create_session: %s", text)
	}
	if _, err := f.server.store.StartAgentSession(ctx, helper.ID); err != nil {
		t.Fatal(err)
	}
	completed, err := f.server.store.CompleteAgentSession(ctx, helper.ID, "There are 42 photos.", "native-helper")
	if err != nil {
		t.Fatal(err)
	}
	childReportReactions{f.server}.SessionChanged(ctx, sessions.Completed, sessions.Slim(completed))
	items, err := f.server.store.SessionInboxItems(ctx, f.conversation.ID, time.Now().Add(-time.Hour), 50)
	if err != nil {
		t.Fatal(err)
	}
	for _, item := range items {
		if item.SenderSessionID == helper.ID && item.Delivery == store.DeliveryTurnEnd && strings.HasPrefix(item.Prompt, sessions.ChildReportPrefix) {
			if !strings.Contains(item.Prompt, "There are 42 photos.") {
				t.Fatalf("report lost the answer: %s", item.Prompt)
			}
			return
		}
	}
	t.Fatalf("the helper's turn_end did not reach the assistant conversation: %+v", items)
}

// A helper the assistant starts with create_session carries the executor
// role's token and time budget, the same pinned-run mechanism dispatch uses,
// so an unattended helper is bounded on this path too.
func TestAssistantCreateSessionAppliesExecutorBudget(t *testing.T) {
	f := newAssistantFixture(t)
	ctx := context.Background()
	agent := mustAgent(t, f)
	agent.Settings.RoleOverrides = map[string]store.PersonalAgentRunPreference{
		"executor": {ProfileID: "device_default", TokenBudget: 1234, TimeoutMinutes: 7},
	}
	if _, err := f.server.store.SavePersonalAgentSettings(ctx, agent.ID, agent.Settings); err != nil {
		t.Fatal(err)
	}
	helper, text, failed := f.createHelper(t, map[string]any{"workspaceId": "ws_alice", "prompt": "count the photos"})
	if failed {
		t.Fatalf("create_session: %s", text)
	}
	budget := helper.Input.ExecutionBudget
	if budget == nil || budget.TokenBudget != 1234 || budget.TimeoutMinutes != 7 {
		t.Fatalf("helper budget = %+v, want the executor role's 1234 tokens and 7 minutes", budget)
	}
	snapshot, err := f.server.store.RunSnapshotForUser(ctx, f.aliceID, budget.SnapshotID)
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.InputID != helper.Input.ID || snapshot.WorkspaceID != "ws_alice" || snapshot.Role != "executor" ||
		snapshot.TokenBudget != 1234 || snapshot.TimeoutMinutes != 7 {
		t.Fatalf("helper run snapshot = %+v", snapshot)
	}
	controls, err := f.server.store.ListPersonalAgentRunControls(ctx, agent.ID)
	if err != nil {
		t.Fatal(err)
	}
	for _, control := range controls {
		if control.SnapshotID == budget.SnapshotID && control.SessionID == helper.ID &&
			control.TokenBudget == 1234 && control.TimeoutMinutes == 7 && control.State == "monitoring" {
			return
		}
	}
	t.Fatalf("no run control for the helper's budget: %+v", controls)
}
