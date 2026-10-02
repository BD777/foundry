package httpapi

import (
	"context"
	"strings"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// A Feishu thread drives an Issue through the same operations and rules as
// the web, as the group's bound account.
func TestFeishuThreadDrivesAnIssueAsTheBoundAccount(t *testing.T) {
	f := newIsolationFixture(t)
	ctx := context.Background()
	db := f.server.store
	registration := store.DaemonRegistration{
		Capabilities: []string{store.DaemonCapabilityIssueSessions, store.DaemonCapabilityIssueClarification},
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

	issue, err := f.server.StartIssue(ctx, "ws_bob", f.bobID, "Add usage to the README")
	if err != nil {
		t.Fatal(err)
	}
	if issue.Runtime != "claude" || issue.CreatedByUserID != f.bobID || issue.Clarification == nil || issue.Clarification.Status != "replying" {
		t.Fatalf("the Issue did not start clarifying as the bound account: %+v", issue)
	}
	if url := f.server.IssueURL(issue); !strings.Contains(url, "/issues/"+issue.ID+"?workspace=ws_bob") {
		t.Fatalf("issue url = %q", url)
	}
	if _, err := f.server.IssueMessage(ctx, issue.ID, f.bobID, "for new users"); err == nil {
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
	f.server.hub.settleIssueClarification(ctx, session, &store.ClarificationResponse{Message: "Which file?"})
	if receipt, err := f.server.IssueMessage(ctx, issue.ID, f.bobID, "README.md"); err != nil || !strings.Contains(receipt, "澄清") {
		t.Fatalf("a reply during clarification: %q %v", receipt, err)
	}

	// Someone else's account may not confirm the criteria from the group.
	if _, err := f.server.ConfirmIssue(ctx, issue.ID, f.aliceID); err == nil {
		t.Fatal("an account outside the workspace confirmed the criteria")
	}
	current, _ := db.GetIssue(ctx, issue.ID)
	if current.ContractState == "confirmed" {
		t.Fatal("the contract was confirmed")
	}

	if _, err := f.server.IssueMessage(ctx, issue.ID, f.aliceID, "also add a badge"); err == nil {
		t.Fatal("an account outside the workspace talked to the Issue")
	}
}
