package sqlitestore

import (
	"context"
	"errors"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// verificationFixtureState returns the evidence lifecycle fixture in its
// post-run "verifying" state: run terminal, candidate registered, no
// verification rows yet — exactly the state D1 originally missed.
func verificationFixtureState(t *testing.T) (db *Store, issueID string, revision int, candidateID string) {
	t.Helper()
	db, issue, contract, candidate, _, _ := evidenceLifecycleFixture(t)
	return db, issue.ID, contract.Revision, candidate.ID
}

// TestSoftRemoveBlockedByQueuedAndRunningVerification is D1: a queued or
// running verification is real assess/collect agent work on the device and
// must block removal while it exists; removal succeeds once it is terminal.
func TestSoftRemoveBlockedByQueuedAndRunningVerification(t *testing.T) {
	db, issueID, revision, candidateID := verificationFixtureState(t)
	ctx := context.Background()
	issue, err := db.GetIssue(ctx, issueID)
	if err != nil {
		t.Fatalf("get issue: %v", err)
	}
	owner := store.ActorRef{Kind: "local_owner", ID: "owner", DisplayName: "Owner"}
	contract, err := db.contractByRevision(ctx, issue.ID, revision)
	if err != nil {
		t.Fatalf("contract: %v", err)
	}
	v, err := db.RequestVerification(ctx, issue.ID, revision, candidateID, contract.Criteria[0].ID, owner, "d1-queued")
	if err != nil {
		t.Fatalf("request verification: %v", err)
	}
	if v.Status != "queued" {
		t.Fatalf("expected queued verification, got %s", v.Status)
	}
	if _, err := db.SoftRemoveDevice(ctx, "dev_ws_e2e"); !errors.Is(err, store.ErrDeviceBusy) {
		t.Fatalf("queued verification must block removal, got %v", err)
	}

	started, err := db.StartVerification(ctx, issue.ID, v.ID)
	if err != nil {
		t.Fatalf("start verification: %v", err)
	}
	if started.Status != "running" {
		t.Fatalf("expected running verification, got %s", started.Status)
	}
	if _, err := db.SoftRemoveDevice(ctx, "dev_ws_e2e"); !errors.Is(err, store.ErrDeviceBusy) {
		t.Fatalf("running verification must block removal, got %v", err)
	}

	// Terminal verification (canceled/failed/completed) no longer counts.
	stored, err := evidenceGet[store.Verification](ctx, db, issue.ID, "verification", v.ID)
	if err != nil {
		t.Fatalf("read verification: %v", err)
	}
	now := evidenceNow()
	stored.Status = "canceled"
	stored.FinishedAt = &now
	stored.Error = &store.VerificationError{Code: "test_canceled", Message: "terminal for test", Retryable: false}
	if err := db.updateEvidenceProjection(ctx, stored.ID, stored); err != nil {
		t.Fatalf("cancel verification: %v", err)
	}
	if _, err := db.SoftRemoveDevice(ctx, "dev_ws_e2e"); err != nil {
		t.Fatalf("removal must succeed after verification is terminal: %v", err)
	}
}

// TestRequestVerificationGatedAfterRemoval is D4 at the store layer: the
// HTTP handler's pre-check cannot close the TOCTOU window by itself. Creating
// queued verification inside its own write transaction must fail once the
// tombstone commits — otherwise the new row would deadlock every later
// removal attempt through the very busy counter it feeds.
func TestRequestVerificationGatedAfterRemoval(t *testing.T) {
	db, issueID, revision, candidateID := verificationFixtureState(t)
	ctx := context.Background()
	issue, err := db.GetIssue(ctx, issueID)
	if err != nil {
		t.Fatalf("get issue: %v", err)
	}
	contract, err := db.contractByRevision(ctx, issue.ID, revision)
	if err != nil {
		t.Fatalf("contract: %v", err)
	}
	if _, err := db.SoftRemoveDevice(ctx, "dev_ws_e2e"); err != nil {
		t.Fatalf("remove: %v", err)
	}
	owner := store.ActorRef{Kind: "local_owner", ID: "owner", DisplayName: "Owner"}
	if _, err := db.RequestVerification(ctx, issue.ID, revision, candidateID, contract.Criteria[0].ID, owner, "d4-gated"); !errors.Is(err, store.ErrDeviceRemoved) {
		t.Fatalf("RequestVerification after removal must return ErrDeviceRemoved, got %v", err)
	}
	if _, err := db.StartVerification(ctx, issue.ID, "ver_never"); !errors.Is(err, store.ErrDeviceRemoved) {
		t.Fatalf("StartVerification after removal must return ErrDeviceRemoved, got %v", err)
	}
}

// TestSoftRemoveBlockedByConfirmedQueuedIssue is D5: a pending issue with a
// confirmed contract is queued dispatchable work. It must block removal
// instead of becoming a permanently unclaimable pending row afterwards.
func TestSoftRemoveBlockedByConfirmedQueuedIssue(t *testing.T) {
	db := newTestStore(t)
	ctx := context.Background()
	registerDeviceRemovalDaemon(t, db, "dev_queued", "ws_queued")
	issue := confirmedIssueOnDevice(t, db, "ws_queued")

	if _, err := db.SoftRemoveDevice(ctx, "dev_queued"); !errors.Is(err, store.ErrDeviceBusy) {
		t.Fatalf("confirmed queued issue must block removal, got %v", err)
	}

	// Once the issue reaches a terminal state the device can be removed.
	if _, err := db.ClaimNextIssue(ctx, "dev_queued", "ws_queued"); err != nil {
		t.Fatalf("claim: %v", err)
	}
	run := store.Run{
		ID: "run_queued", IssueID: issue.ID, WorkspaceID: "ws_queued",
		Status: "running", Runtime: "mock", StartedLabel: "now",
	}
	if _, err := db.StartIssueRun(ctx, issue.ID, run); err != nil {
		t.Fatalf("start run: %v", err)
	}
	if _, err := db.CompleteIssue(ctx, issue.ID, store.CompleteIssueInput{
		RunID: run.ID, Error: "ended",
		Artifact: store.AcceptanceArtifact{
			ID: "art_queued", IssueID: issue.ID, Kind: "text", Title: "a", Summary: "s",
		},
	}); err != nil {
		t.Fatalf("complete run: %v", err)
	}
	if _, err := db.AbandonIssue(ctx, issue.ID, run.ID); err != nil {
		t.Fatalf("abandon: %v", err)
	}
	if _, err := db.SoftRemoveDevice(ctx, "dev_queued"); err != nil {
		t.Fatalf("removal after terminal issue: %v", err)
	}
}

// TestConfirmContractGatedAfterRemoval is D3: confirming a fresh draft on a
// blocked/verifying issue requeues it to pending; that internal path must
// refuse to create dispatchable work for a removed device.
func TestConfirmContractGatedAfterRemoval(t *testing.T) {
	db, issueID, _, _ := verificationFixtureState(t)
	ctx := context.Background()
	issue, err := db.GetIssue(ctx, issueID)
	if err != nil {
		t.Fatalf("get issue: %v", err)
	}
	if _, err := db.SoftRemoveDevice(ctx, "dev_ws_e2e"); err != nil {
		t.Fatalf("remove: %v", err)
	}
	owner := store.ActorRef{Kind: "local_owner", ID: "owner", DisplayName: "Owner"}
	content := store.ContractContent{
		Goal:        store.RichContent{Text: "Adjusted goal after verification", Media: []store.ReferenceMedia{}},
		InScope:     []string{},
		OutOfScope:  []string{},
		Constraints: []string{},
		Criteria: []store.AcceptanceCriterion{{
			ID: "criterion_d3", Title: "New output", Statement: "New observable result",
			Required: true, ProofKind: "content_completeness", EvaluationMode: "agent",
			Rubric: store.RichContent{Text: "Inspect the new result", Media: []store.ReferenceMedia{}},
			EvidenceRequirements: []store.EvidenceRequirement{{
				ID: "requirement_d3", Description: "Candidate export",
				AcceptedCarriers: []store.CarrierKind{"document"}, MinimumCount: 1,
				BindingPolicy: "system_observed",
			}},
		}},
	}
	records, err := db.ListEvidenceRecords(ctx, issue.ID, "contract")
	if err != nil {
		t.Fatalf("list contracts: %v", err)
	}
	base := len(records)
	changeReason := "verification rejected; adjust scope"
	draft, err := db.CreateContract(ctx, issue.ID,
		store.ContractDraftInput{Content: content, BaseRevision: &base, ChangeReason: &changeReason},
		owner, "d3-draft")
	if err != nil {
		t.Fatalf("creating a draft itself is historical editing, allowed: %v", err)
	}
	if _, err := db.ConfirmContract(ctx, issue.ID, draft.Revision, draft.ContentDigest, owner, "d3-confirm"); !errors.Is(err, store.ErrDeviceRemoved) {
		t.Fatalf("confirming a requeueing contract must be gated, got %v", err)
	}
	// The issue must not have been requeued.
	after, err := db.GetIssue(ctx, issue.ID)
	if err != nil {
		t.Fatalf("reload issue: %v", err)
	}
	if after.Status == "pending" {
		t.Fatalf("removed device issue must not be requeued to pending, got %s", after.Status)
	}
}
