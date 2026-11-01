package sqlitestore

import (
	"context"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"github.com/foundry-dev/foundry/apps/server/internal/testfixture"
	"testing"
)

func TestAbandonedIssueIsRetainedAndCannotBeClaimedOrContinued(t *testing.T) {
	db := newTestStore(t)
	ctx := context.Background()
	if err := db.RegisterDaemon(ctx, registrationInput(t, "ws_abandon", "abandon")); err != nil {
		t.Fatal(err)
	}
	issue, err := db.CreateIssue(ctx, store.CreateIssueInput{WorkspaceID: "ws_abandon", Title: "Retain history"})
	if err != nil {
		t.Fatal(err)
	}
	testfixture.ConfirmContract(t, db, issue.ID)
	_, err = db.StartIssueRun(ctx, issue.ID, store.Run{ID: "r_abandon", IssueID: issue.ID})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.AbandonIssue(ctx, issue.ID, "r_abandon"); err == nil {
		t.Fatal("abandoned active execution")
	}
	_, err = db.CompleteIssue(ctx, issue.ID, store.CompleteIssueInput{RunID: "r_abandon", Error: "Execution failed", EnvironmentID: "env_retained", Artifact: store.AcceptanceArtifact{ID: "art_abandon", IssueID: issue.ID}})
	if err != nil {
		t.Fatal(err)
	}
	issue, _ = db.GetIssue(ctx, issue.ID)
	if issue.Status != "blocked" || issue.BlockedReason.Kind != "system_error" {
		t.Fatalf("failure not blocked: %#v", issue)
	}
	if _, err = db.AbandonIssue(ctx, issue.ID, "stale"); err == nil {
		t.Fatal("stale abandonment accepted")
	}
	for i := 0; i < 2; i++ {
		issue, err = db.AbandonIssue(ctx, issue.ID, "r_abandon")
		if err != nil || issue.Status != "abandoned" || issue.Run.EnvironmentID != "env_retained" {
			t.Fatalf("abandon lost candidate: %v %#v", err, issue)
		}
	}
	if _, err = db.RequestIssueChanges(ctx, issue.ID, "Continue", "r_abandon", ""); err == nil {
		t.Fatal("abandoned Issue continued")
	}
	if _, err = db.StartIssueRun(ctx, issue.ID, store.Run{ID: "new_run", IssueID: issue.ID}); err == nil {
		t.Fatal("abandoned Issue started")
	}
	if _, _, err = db.ClaimIssueExecution(ctx, "", "ws_abandon"); err == nil {
		t.Fatal("abandoned Issue was queued")
	}
	runs, err := db.ListRuns(ctx, "ws_abandon")
	if err != nil || len(runs) != 1 {
		t.Fatalf("history missing: %v", err)
	}
}
