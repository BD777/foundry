package sqlitestore

import (
	"context"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"github.com/foundry-dev/foundry/apps/server/internal/testfixture"
)

// An execution asks; its turn ends blocked on the question; the person's
// answer resumes the Issue in its candidate, once.
func TestExecutionQuestionBlocksTheIssueUntilAnswered(t *testing.T) {
	db := newTestStore(t)
	ctx := context.Background()
	if err := db.RegisterDaemon(ctx, store.DaemonRegistration{
		Device:    store.DeviceProjection{ID: "dev_ask", Label: "D", Status: "connected"},
		Workspace: store.WorkspaceProjection{ID: "ws_ask", Name: "W", LocalPath: "/tmp/ws_ask"},
		Agents: []store.AgentProjection{{ID: "agent_ask", WorkspaceID: "ws_ask", DeviceID: "dev_ask", Provider: "claude", Status: "healthy",
			AuthMode: "local_config", SecretStored: "local", ConfigScope: "workspace", ConfigLabel: "local", LastSeenLabel: "online"}},
	}); err != nil {
		t.Fatal(err)
	}
	issue, err := db.CreateIssue(ctx, store.CreateIssueInput{WorkspaceID: "ws_ask", SourceInput: "deploy the site", Runtime: "claude"})
	if err != nil {
		t.Fatal(err)
	}
	testfixture.ConfirmContract(t, db, issue.ID)
	_, execution, err := db.ClaimIssueExecution(ctx, "dev_ask", "ws_ask")
	if err != nil {
		t.Fatal(err)
	}
	ask := store.IssueQuestion{Kind: "permission", Text: "Deploy the candidate to staging?", Options: []string{"Yes", "No"}}
	if _, err := db.AskIssueQuestion(ctx, execution.ID, ask); err == nil {
		t.Fatal("a queued execution asked before it ran")
	}
	if _, err := db.StartAgentSession(ctx, execution.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.StartIssueRun(ctx, issue.ID, store.Run{ID: execution.ID, Runtime: "claude", StartedAt: time.Now().UTC().Format(time.RFC3339)}); err != nil {
		t.Fatal(err)
	}
	helper, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{WorkspaceID: "ws_ask", AgentID: "agent_ask", Provider: "claude", Prompt: "help", IssueID: issue.ID, ParentSessionID: execution.ID})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.StartAgentSession(ctx, helper.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.AskIssueQuestion(ctx, helper.ID, ask); err == nil {
		t.Fatal("a helper session asked the person directly")
	}
	asked, err := db.AskIssueQuestion(ctx, execution.ID, ask)
	if err != nil {
		t.Fatal(err)
	}
	question := asked.Question
	if question == nil || question.RunID != execution.ID || len(asked.Messages) == 0 || asked.Messages[len(asked.Messages)-1].Text != ask.Text {
		t.Fatalf("the question was not recorded in the conversation: %+v", asked.Question)
	}
	if again, err := db.AskIssueQuestion(ctx, execution.ID, ask); err != nil || again.Question.ID != question.ID {
		t.Fatal("a resent question was not idempotent", err)
	}
	if _, err := db.AskIssueQuestion(ctx, execution.ID, store.IssueQuestion{Kind: "input", Text: "Another thing?"}); err == nil {
		t.Fatal("a second question was accepted while one waits")
	}
	if _, err := db.AnswerIssueQuestion(ctx, issue.ID, question.ID, "Yes", ""); err == nil {
		t.Fatal("answered while the execution was still finishing its turn")
	}
	blocked, err := db.CompleteIssue(ctx, issue.ID, store.CompleteIssueInput{RunID: execution.ID, Response: "Waiting for approval to deploy.", Artifact: store.AcceptanceArtifact{ID: "art_1", IssueID: issue.ID, Kind: "text", Title: "Summary"}})
	if err != nil {
		t.Fatal(err)
	}
	if blocked.Status != "blocked" || blocked.BlockedReason == nil || blocked.BlockedReason.Kind != "needs_permission" || blocked.BlockedReason.Message != ask.Text {
		t.Fatalf("the turn did not end blocked on the question: %s %+v", blocked.Status, blocked.BlockedReason)
	}
	if _, err := db.AnswerIssueQuestion(ctx, issue.ID, "question_other", "Yes", ""); err == nil {
		t.Fatal("answered a question that does not exist")
	}
	resumed, err := db.AnswerIssueQuestion(ctx, issue.ID, question.ID, "Yes, staging only.", "")
	if err != nil {
		t.Fatal(err)
	}
	last := resumed.Messages[len(resumed.Messages)-1]
	if resumed.Status != "pending" || resumed.Question != nil || last.ID != question.ID+"_answer" || last.Text != "Yes, staging only." {
		t.Fatalf("the answer did not resume the Issue: %s %+v %+v", resumed.Status, resumed.Question, last)
	}
	if replay, err := db.AnswerIssueQuestion(ctx, issue.ID, question.ID, "Yes, staging only.", ""); err != nil || len(replay.Messages) != len(resumed.Messages) {
		t.Fatal("a resent answer was recorded twice", err)
	}
	next, _, err := db.ClaimIssueExecution(ctx, "dev_ask", "ws_ask")
	if err != nil || next.ID != issue.ID {
		t.Fatal("the answered Issue was not dispatched again", err)
	}
}
