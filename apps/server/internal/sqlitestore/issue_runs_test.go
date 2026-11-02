package sqlitestore

import (
	"context"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"github.com/foundry-dev/foundry/apps/server/internal/testfixture"
)

// An execution starts and settles once; a completion that is not the
// current execution's leaves the Issue as it is.
func TestIssueExecutionReplayAndRetry(t *testing.T) {
	db := newTestStore(t)
	ctx := context.Background()
	if err := db.RegisterDaemon(ctx, registrationInput(t, "ws_runs", "runs")); err != nil {
		t.Fatal(err)
	}
	issue, err := db.CreateIssue(ctx, store.CreateIssueInput{WorkspaceID: "ws_runs", Title: "work"})
	if err != nil {
		t.Fatal(err)
	}
	run := store.Run{ID: "run_one", Runtime: "mock"}
	testfixture.ConfirmContract(t, db, issue.ID)
	if _, err = db.StartIssueRun(ctx, issue.ID, run); err != nil {
		t.Fatal(err)
	}
	input := store.CompleteIssueInput{RunID: run.ID, Error: "executor interrupted", EnvironmentID: "env_one"}
	for i := 0; i < 2; i++ {
		if _, err = db.CompleteIssue(ctx, issue.ID, input); err != nil {
			t.Fatal(err)
		}
	}
	if _, err = db.StartIssueRun(ctx, issue.ID, run); err != nil {
		t.Fatal(err)
	}
	current, _ := db.GetIssue(ctx, issue.ID)
	if current.Status != "blocked" || current.Run.Status != "failed" || current.Run.EnvironmentID != "env_one" {
		t.Fatalf("replay changed completed run: %#v", current)
	}
	if _, err = db.RequestIssueChanges(ctx, issue.ID, "", "", ""); err != nil {
		t.Fatal(err)
	}
	retry := store.Run{ID: "run_two", Runtime: "mock"}
	if _, err = db.StartIssueRun(ctx, issue.ID, retry); err != nil {
		t.Fatal(err)
	}
	if _, err = db.CompleteIssue(ctx, issue.ID, input); err != nil {
		t.Fatal(err)
	}
	current, _ = db.GetIssue(ctx, issue.ID)
	if current.Run.ID != retry.ID || current.Run.Status != "running" || current.Status != "in_progress" {
		t.Fatal("stale completion replaced retry")
	}
	other, _ := db.CreateIssue(ctx, store.CreateIssueInput{WorkspaceID: "ws_runs", Title: "other"})
	if settled, err := db.CompleteIssue(ctx, other.ID, input); err != nil || settled.Run != nil || settled.Status != other.Status {
		t.Fatal("another Issue's completion settled this one", err)
	}
}

func TestIssueFeedbackIsPersistentAndBoundToCurrentRun(t *testing.T) {
	db := newTestStore(t)
	ctx := context.Background()
	if err := db.RegisterDaemon(ctx, registrationInput(t, "ws_feedback", "feedback")); err != nil {
		t.Fatal(err)
	}
	issue, _ := db.CreateIssue(ctx, store.CreateIssueInput{WorkspaceID: "ws_feedback", Title: "Feedback"})
	testfixture.ConfirmContract(t, db, issue.ID)
	if _, err := db.StartIssueRun(ctx, issue.ID, store.Run{ID: "run_feedback"}); err != nil {
		t.Fatal(err)
	}
	complete := store.CompleteIssueInput{RunID: "run_feedback", Response: "First candidate ready"}
	for i := 0; i < 2; i++ {
		if _, err := db.CompleteIssue(ctx, issue.ID, complete); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := db.RequestIssueChanges(ctx, issue.ID, "wrong run", "old", ""); err == nil {
		t.Fatal("stale feedback accepted")
	}
	for i := 0; i < 2; i++ {
		if _, err := db.RequestIssueChanges(ctx, issue.ID, "Update the shared rules", "run_feedback", ""); err != nil {
			t.Fatal(err)
		}
	}
	saved, _ := db.GetIssue(ctx, issue.ID)
	if saved.Status != "pending" || len(saved.Messages) != 2 || saved.Messages[0].Role != "assistant" || saved.Messages[1].Text != "Update the shared rules" {
		t.Fatalf("unexpected conversation: %#v", saved.Messages)
	}
}

func TestCanceledIssueCanContinue(t *testing.T) {
	db := newTestStore(t)
	ctx := context.Background()
	if err := db.RegisterDaemon(ctx, registrationInput(t, "ws_steer", "steer")); err != nil {
		t.Fatal(err)
	}
	issue, err := db.CreateIssue(ctx, store.CreateIssueInput{WorkspaceID: "ws_steer", Title: "Steer"})
	if err != nil {
		t.Fatal(err)
	}
	testfixture.ConfirmContract(t, db, issue.ID)
	if _, err = db.StartIssueRun(ctx, issue.ID, store.Run{ID: "run_steer"}); err != nil {
		t.Fatal(err)
	}
	_, err = db.CompleteIssue(ctx, issue.ID, store.CompleteIssueInput{RunID: "run_steer", Canceled: true, EnvironmentID: "env_retained"})
	if err != nil {
		t.Fatal(err)
	}
	saved, _ := db.GetIssue(ctx, issue.ID)
	if saved.Status != "blocked" || saved.Run.EnvironmentID != "env_retained" {
		t.Fatalf("cancellation lost candidate: %#v", saved)
	}
	saved, err = db.RequestIssueChanges(ctx, issue.ID, "Continue with mobile fixes", "run_steer", "")
	if err != nil || saved.Status != "pending" || len(saved.Messages) != 1 {
		t.Fatalf("resume failed: %v %#v", err, saved)
	}
}
