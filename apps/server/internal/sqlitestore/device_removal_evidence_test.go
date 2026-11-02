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

// A queued or running verification does not keep an offline device: it
// goes with the device, its issue and the rest of their evidence.
func TestOfflineDeviceWithVerificationsIsRemovable(t *testing.T) {
	db, issueID, revision, candidateID := verificationFixtureState(t)
	ctx := context.Background()
	owner := store.ActorRef{Kind: "local_owner", ID: "owner", DisplayName: "Owner"}
	contract, err := db.ContractByRevision(ctx, issueID, revision)
	if err != nil {
		t.Fatalf("contract: %v", err)
	}
	v, err := db.RequestVerification(ctx, issueID, revision, candidateID, contract.Criteria[0].ID, owner, "d1-queued")
	if err != nil {
		t.Fatalf("request verification: %v", err)
	}
	if _, err := db.StartVerification(ctx, issueID, v.ID); err != nil {
		t.Fatalf("start verification: %v", err)
	}
	removeDeviceForTest(t, db, "dev_ws_e2e")
	if _, err := db.PurgeRemovedDevice(ctx, "dev_ws_e2e"); err != nil {
		t.Fatal(err)
	}
	if got := countRows(t, db, `SELECT count(*) FROM evidence_records WHERE issue_id = ?`, issueID); got != 0 {
		t.Fatalf("%d evidence records of the removed device's issue left", got)
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
	contract, err := db.ContractByRevision(ctx, issue.ID, revision)
	if err != nil {
		t.Fatalf("contract: %v", err)
	}
	removeDeviceForTest(t, db, "dev_ws_e2e")
	owner := store.ActorRef{Kind: "local_owner", ID: "owner", DisplayName: "Owner"}
	if _, err := db.RequestVerification(ctx, issue.ID, revision, candidateID, contract.Criteria[0].ID, owner, "d4-gated"); !errors.Is(err, store.ErrDeviceRemoved) {
		t.Fatalf("RequestVerification after removal must return ErrDeviceRemoved, got %v", err)
	}
	if _, err := db.StartVerification(ctx, issue.ID, "ver_never"); !errors.Is(err, store.ErrDeviceRemoved) {
		t.Fatalf("StartVerification after removal must return ErrDeviceRemoved, got %v", err)
	}
}

// A confirmed issue waiting for its device does not keep it: once the
// device is removed nothing claims the issue, and the purge deletes it.
func TestRemovedDeviceQueuedIssueIsNeverClaimed(t *testing.T) {
	db := newTestStore(t)
	ctx := context.Background()
	registerDeviceRemovalDaemon(t, db, "dev_queued", "ws_queued")
	issue := confirmedIssueOnDevice(t, db, "ws_queued")
	removeDeviceForTest(t, db, "dev_queued")
	if err := claimIssueForTest(ctx, db, "dev_queued", "ws_queued"); !errors.Is(err, store.ErrDeviceRemoved) {
		t.Fatalf("claim on a removed device: %v", err)
	}
	if _, err := db.PurgeRemovedDevice(ctx, "dev_queued"); err != nil {
		t.Fatal(err)
	}
	if _, err := db.GetIssue(ctx, issue.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("the removed device's issue is still there: %v", err)
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
	removeDeviceForTest(t, db, "dev_ws_e2e")
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
