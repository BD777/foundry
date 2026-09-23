package sqlitestore

import (
	"context"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"github.com/foundry-dev/foundry/apps/server/internal/testfixture"
)

func TestIssueRunReplayAndRetryHistory(t *testing.T) {
	db := newTestStore(t)
	ctx := context.Background()
	if err := db.RegisterDaemon(ctx, registrationInput(t, "ws_runs", "runs")); err != nil {
		t.Fatal(err)
	}
	issue, err := db.CreateIssue(ctx, store.CreateIssueInput{WorkspaceID: "ws_runs", Title: "work"})
	if err != nil {
		t.Fatal(err)
	}
	run := store.Run{ID: "run_one", IssueID: issue.ID, Runtime: "mock", Events: []store.RunEvent{}}
	testfixture.ConfirmContract(t, db, issue.ID)
	if _, err = db.StartIssueRun(ctx, issue.ID, run); err != nil {
		t.Fatal(err)
	}
	event := store.RunEvent{ID: "evt_once", RunID: run.ID, Label: "write", Detail: "candidate", Level: "info"}
	for i := 0; i < 2; i++ {
		if err = db.AppendRunEvent(ctx, event); err != nil {
			t.Fatal(err)
		}
	}
	input := store.CompleteIssueInput{RunID: run.ID, Error: "executor interrupted", EnvironmentID: "env_one", Artifact: store.AcceptanceArtifact{ID: "art_one", IssueID: issue.ID, Kind: "text"}}
	for i := 0; i < 2; i++ {
		if _, err = db.CompleteIssue(ctx, issue.ID, input); err != nil {
			t.Fatal(err)
		}
	}
	if _, err = db.StartIssueRun(ctx, issue.ID, run); err != nil {
		t.Fatal(err)
	}
	current, _ := db.GetIssue(ctx, issue.ID)
	if current.Status != "blocked" || current.Run.Status != "failed" || len(current.Run.Events) != 1 {
		t.Fatalf("replay changed completed run: %#v", current)
	}
	if _, err = db.UpdateIssueStatus(ctx, issue.ID, "pending"); err != nil {
		t.Fatal(err)
	}
	retry := store.Run{ID: "run_two", IssueID: issue.ID, Runtime: "mock", Events: []store.RunEvent{}}
	if _, err = db.StartIssueRun(ctx, issue.ID, retry); err != nil {
		t.Fatal(err)
	}
	if _, err = db.CompleteIssue(ctx, issue.ID, input); err != nil {
		t.Fatal(err)
	}
	current, _ = db.GetIssue(ctx, issue.ID)
	if current.Run.ID != retry.ID || current.Status != "in_progress" {
		t.Fatal("stale completion replaced retry")
	}
	runs, err := db.ListRuns(ctx, "ws_runs")
	if err != nil || len(runs) != 2 {
		t.Fatalf("history missing: %v %#v", err, runs)
	}
	other, _ := db.CreateIssue(ctx, store.CreateIssueInput{WorkspaceID: "ws_runs", Title: "other"})
	if _, err = db.CompleteIssue(ctx, other.ID, input); err == nil {
		t.Fatal("cross-issue completion was accepted")
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
	if _, err := db.StartIssueRun(ctx, issue.ID, store.Run{ID: "run_feedback", IssueID: issue.ID}); err != nil {
		t.Fatal(err)
	}
	complete := store.CompleteIssueInput{RunID: "run_feedback", Response: "First candidate ready", Artifact: store.AcceptanceArtifact{ID: "art_feedback", IssueID: issue.ID}}
	for i := 0; i < 2; i++ {
		if _, err := db.CompleteIssue(ctx, issue.ID, complete); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := db.RequestIssueChanges(ctx, issue.ID, "wrong run", "old"); err == nil {
		t.Fatal("stale feedback accepted")
	}
	for i := 0; i < 2; i++ {
		if _, err := db.RequestIssueChanges(ctx, issue.ID, "Update the shared rules", "run_feedback"); err != nil {
			t.Fatal(err)
		}
	}
	saved, _ := db.GetIssue(ctx, issue.ID)
	if saved.Status != "pending" || len(saved.Messages) != 2 || saved.Messages[0].Role != "assistant" || saved.Messages[1].Text != "Update the shared rules" {
		t.Fatalf("unexpected conversation: %#v", saved.Messages)
	}
}

func TestIssueSteerPersistsOnceAndCanceledIssueCanContinue(t *testing.T) {
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
	if _, err = db.StartIssueRun(ctx, issue.ID, store.Run{ID: "run_steer", IssueID: issue.ID}); err != nil {
		t.Fatal(err)
	}
	event := store.RunEvent{ID: "evt_steer", RunID: "run_steer", Label: "Steered into active turn", Detail: "Check mobile", At: "2026-09-09T01:00:00Z"}
	for i := 0; i < 2; i++ {
		if err = db.AppendRunEvent(ctx, event); err != nil {
			t.Fatal(err)
		}
	}
	saved, _ := db.GetIssue(ctx, issue.ID)
	if saved.Status != "in_progress" || len(saved.Messages) != 1 || saved.Messages[0].Text != "Check mobile" || saved.Messages[0].RunID != "run_steer" {
		t.Fatalf("steer lost or replayed: %#v", saved)
	}
	_, err = db.CompleteIssue(ctx, issue.ID, store.CompleteIssueInput{RunID: "run_steer", Canceled: true, EnvironmentID: "env_retained", Artifact: store.AcceptanceArtifact{ID: "art_steer", IssueID: issue.ID}})
	if err != nil {
		t.Fatal(err)
	}
	saved, _ = db.GetIssue(ctx, issue.ID)
	if saved.Status != "blocked" || saved.Run.EnvironmentID != "env_retained" {
		t.Fatalf("cancellation lost candidate: %#v", saved)
	}
	saved, err = db.RequestIssueChanges(ctx, issue.ID, "Continue with mobile fixes", "run_steer")
	if err != nil || saved.Status != "pending" || len(saved.Messages) != 2 {
		t.Fatalf("resume failed: %v %#v", err, saved)
	}
}
