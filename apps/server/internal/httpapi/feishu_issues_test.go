package httpapi

import (
	"context"
	"encoding/json"
	"strings"
	"sync"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"github.com/foundry-dev/foundry/apps/server/internal/testfixture"
)

// feishuIssueFixture is bob's workspace with a Claude Agent on its
// connected device, as a group bound to bob reaches it. The device answers
// its Issue environment requests with worker's result (by default, Git is
// ready).
func feishuIssueFixture(t *testing.T, worker func(action string) string) isolationFixture {
	t.Helper()
	f := newIsolationFixture(t)
	ctx := context.Background()
	db := f.server.store
	registration := store.DaemonRegistration{
		Capabilities: []string{},
		Device:       store.DeviceProjection{ID: "dev_bob", Label: "D", Status: "connected"},
		Workspace:    store.WorkspaceProjection{ID: "ws_bob", Name: "W", LocalPath: "/tmp/w"},
		Agents: []store.AgentProjection{{ID: "agent_bob", WorkspaceID: "ws_bob", DeviceID: "dev_bob", Provider: "claude", Status: "healthy",
			AuthMode: "local_config", SecretStored: "local", ConfigScope: "workspace", ConfigLabel: "local", LastSeenLabel: "online"}},
	}
	if err := db.RegisterDaemon(ctx, registration); err != nil {
		t.Fatal(err)
	}
	connection := &daemonConnection{hub: f.server.hub, done: make(chan struct{}), send: make(chan wsEnvelope, 16), rpc: newDaemonRPC(),
		deviceID: "dev_bob", registration: registration, dispatchedSessions: map[string]string{}, activeSessions: map[string]bool{}}
	f.server.hub.connections["dev_bob"] = connection
	if worker == nil {
		worker = func(string) string { return `{"status":"ready"}` }
	}
	stop := make(chan struct{})
	t.Cleanup(func() { close(stop) })
	go func() {
		for {
			select {
			case envelope := <-connection.send:
				if envelope.Type != wsIssueEnvironmentType {
					continue
				}
				var payload struct{ Action string }
				_ = json.Unmarshal(envelope.Payload, &payload)
				connection.rpc.resolve(envelope.ID, json.RawMessage(worker(payload.Action)))
			case <-stop:
				return
			}
		}
	}()
	return f
}

// A Feishu thread drives an Issue through the same operations and rules as
// the web, as the group's bound account.
func TestFeishuThreadDrivesAnIssueAsTheBoundAccount(t *testing.T) {
	f := feishuIssueFixture(t, nil)
	desk := issueDesk{f.server}
	ctx := context.Background()
	db := f.server.store

	issue, _, err := desk.StartIssue(ctx, "ws_bob", f.bobID, "om_start", "Add usage to the README")
	if err != nil {
		t.Fatal(err)
	}
	if issue.Runtime != "claude" || issue.CreatedByUserID != f.bobID || issue.Clarification == nil || issue.Clarification.Status != "replying" {
		t.Fatalf("the Issue did not start clarifying as the bound account: %+v", issue)
	}
	if url := desk.IssueURL(issue); !strings.Contains(url, "/issues/"+issue.ID+"?workspace=ws_bob") {
		t.Fatalf("issue url = %q", url)
	}
	if _, err := desk.IssueMessage(ctx, issue.ID, f.bobID, "for new users"); err == nil {
		t.Fatal("a second message was sent while the Agent was still replying")
	}
	// The clarification session answers; the next reply clarifies again.
	session, err := db.GetAgentSession(ctx, issue.Clarification.SessionID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.StartAgentSession(ctx, session.ID); err != nil {
		t.Fatal(err)
	}
	if session, err = db.CompleteAgentSession(ctx, session.ID, "Which file?", "native"); err != nil {
		t.Fatal(err)
	}
	f.server.issueService.Settle(ctx, session, nil, &store.ClarificationResponse{Message: "Which file?"})
	if receipt, err := desk.IssueMessage(ctx, issue.ID, f.bobID, "README.md"); err != nil || !strings.Contains(receipt, "澄清") {
		t.Fatalf("a reply during clarification: %q %v", receipt, err)
	}

	// Someone else's account may not confirm the criteria from the group.
	if _, err := desk.ConfirmIssue(ctx, issue.ID, f.aliceID); err == nil {
		t.Fatal("an account outside the workspace confirmed the criteria")
	}
	current, _ := db.GetIssue(ctx, issue.ID)
	if current.ContractState == "confirmed" {
		t.Fatal("the contract was confirmed")
	}

	if _, err := desk.IssueMessage(ctx, issue.ID, f.aliceID, "also add a badge"); err == nil {
		t.Fatal("an account outside the workspace talked to the Issue")
	}
}

// The message keys the Issue it starts: a redelivered message starts it
// once, the same goal asked again starts a new Issue.
func TestFeishuSameGoalTwiceStartsTwoIssues(t *testing.T) {
	f := feishuIssueFixture(t, nil)
	desk := issueDesk{f.server}
	ctx := context.Background()
	first, _, err := desk.StartIssue(ctx, "ws_bob", f.bobID, "om_first", "Add usage to the README")
	if err != nil {
		t.Fatal(err)
	}
	if again, _, err := desk.StartIssue(ctx, "ws_bob", f.bobID, "om_first", "Add usage to the README"); err != nil || again.ID != first.ID {
		t.Fatalf("a redelivered message started another Issue: %s %v", again.ID, err)
	}
	if _, err := f.server.store.AbandonIssue(ctx, first.ID, ""); err != nil {
		t.Fatal(err)
	}
	second, _, err := desk.StartIssue(ctx, "ws_bob", f.bobID, "om_second", "Add usage to the README")
	if err != nil {
		t.Fatal(err)
	}
	if second.ID == first.ID || second.Status == "abandoned" {
		t.Fatalf("the same goal asked again returned the abandoned Issue: %s %s", second.ID, second.Status)
	}
}

// Feedback from a thread asks the device first, as the web's does: it
// stops the candidate's previews and refuses a candidate that may not change.
func TestFeishuFeedbackRunsTheRetryCheck(t *testing.T) {
	asked := make(chan string, 4)
	f := feishuIssueFixture(t, func(action string) string {
		asked <- action
		return `{"status":"","error":"the candidate has a pending acceptance"}`
	})
	desk := issueDesk{f.server}
	ctx := context.Background()
	db := f.server.store
	issue, err := db.CreateIssue(ctx, store.CreateIssueInput{WorkspaceID: "ws_bob", Title: "Candidate", Runtime: "claude", CreatedByUserID: f.bobID})
	if err != nil {
		t.Fatal(err)
	}
	testfixture.ConfirmContract(t, db, issue.ID)
	if _, err = db.StartIssueRun(ctx, issue.ID, store.Run{ID: "run_feedback"}); err != nil {
		t.Fatal(err)
	}
	if _, err = db.CompleteIssue(ctx, issue.ID, store.CompleteIssueInput{RunID: "run_feedback", EnvironmentID: "env_feedback", EnvironmentRevision: 1}); err != nil {
		t.Fatal(err)
	}
	if _, err := desk.IssueMessage(ctx, issue.ID, f.bobID, "also add a badge"); err == nil || !strings.Contains(err.Error(), "pending acceptance") {
		t.Fatalf("feedback skipped the device's retry check: %v", err)
	}
	if current, _ := db.GetIssue(ctx, issue.ID); current.Status != "verifying" || len(asked) != 1 || <-asked != "check_retry" {
		t.Fatalf("a candidate that may not change was queued again: %s", current.Status)
	}
}

// A group's /issue in a workspace without Git sets Git up the way the web
// does once the person agrees, and says why when the device cannot.
func TestFeishuIssueSetsUpGitLikeTheWeb(t *testing.T) {
	var (
		mu      sync.Mutex
		actions []string
		ready   bool
		refuse  string
	)
	f := feishuIssueFixture(t, func(action string) string {
		mu.Lock()
		defer mu.Unlock()
		actions = append(actions, action)
		switch {
		case action == "initialize_git" && refuse != "":
			return `{"status":"","error":"` + refuse + `"}`
		case action == "initialize_git":
			ready = true
		}
		if ready {
			return `{"status":"ready"}`
		}
		return `{"status":"needs_git"}`
	})
	desk := issueDesk{f.server}
	ctx := context.Background()
	mu.Lock()
	refuse = "the folder is inside another repository"
	mu.Unlock()
	if _, _, err := desk.StartIssue(ctx, "ws_bob", f.bobID, "om_refused", "Add usage"); err == nil || !strings.Contains(err.Error(), refuse) {
		t.Fatalf("a failed Git setup was not reported with the device's reason: %v", err)
	}
	if issues, _ := f.server.store.ListIssues(ctx, "ws_bob"); len(issues) != 0 {
		t.Fatal("an Issue was created without Git")
	}
	mu.Lock()
	refuse, actions = "", nil
	mu.Unlock()
	issue, initialized, err := desk.StartIssue(ctx, "ws_bob", f.bobID, "om_git", "Add usage")
	if err != nil || !initialized || issue.ID == "" {
		t.Fatalf("Git was not set up for the Issue: %v %v", initialized, err)
	}
	mu.Lock()
	defer mu.Unlock()
	if strings.Join(actions, ",") != "git_status,initialize_git" {
		t.Fatalf("actions = %v", actions)
	}
}
