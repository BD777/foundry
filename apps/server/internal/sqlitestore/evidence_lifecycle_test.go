package sqlitestore

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"github.com/foundry-dev/foundry/apps/server/internal/testfixture"
)

func evidenceLifecycleFixture(t *testing.T) (*Store, store.Issue, store.IssueContract, store.CandidateSnapshot, store.VerificationInput, store.Evidence) {
	t.Helper()
	db := newTestStore(t)
	ctx := context.Background()
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	must(db.RegisterDaemon(ctx, registrationInput(t, "ws_e2e", "evidence")))
	issue, err := db.CreateIssue(ctx, store.CreateIssueInput{WorkspaceID: "ws_e2e", SourceInput: "Deliver a complete document", Runtime: "claude"})
	must(err)
	testfixture.ConfirmContract(t, db, issue.ID)
	issue, err = db.GetIssue(ctx, issue.ID)
	must(err)
	contract, err := db.contractByRevision(ctx, issue.ID, *issue.CurrentContractRevision)
	must(err)
	_, err = db.StartIssueRun(ctx, issue.ID, store.Run{ID: "run_evidence", IssueID: issue.ID, Runtime: "claude", Events: []store.RunEvent{}})
	must(err)
	_, err = db.CompleteIssue(ctx, issue.ID, store.CompleteIssueInput{RunID: "run_evidence", Response: "Ready", EnvironmentID: "env_evidence", EnvironmentRevision: 1, Artifact: store.AcceptanceArtifact{ID: "art_evidence", IssueID: issue.ID}})
	must(err)
	actor := store.ActorRef{Kind: "daemon", ID: "worker", DisplayName: "Worker"}
	now := evidenceNow()
	for _, id := range []string{"manifest", "document", "parameters", "raw", "report"} {
		must(db.RegisterMaterial(ctx, issue.ID, store.Material{SchemaVersion: 1, ID: id, WorkspaceID: issue.WorkspaceID, IssueID: issue.ID, CreatedAt: now, CreatedBy: actor, Name: id, Carrier: "document", MimeType: "text/plain", ByteSize: 3, Digest: evidenceDigest(id), StorageDeviceID: "worker", CapturedAt: now, Redaction: store.MaterialRedaction{Status: "none"}, PreviewMaterialIDs: []string{}, Availability: "available", AvailabilityCheckedAt: now}))
	}
	candidate := store.CandidateSnapshot{SchemaVersion: 1, ID: "snapshot", WorkspaceID: issue.WorkspaceID, IssueID: issue.ID, CreatedAt: now, CreatedBy: actor, EnvironmentID: "env_evidence", EnvironmentRevision: 1, Purpose: "candidate", Repositories: []store.SnapshotRepository{}, FileManifestMaterialID: "manifest", ContentDigest: evidenceDigest("candidate"), CapturedAt: now}
	input := store.VerificationInput{SchemaVersion: 1, ID: "input", WorkspaceID: issue.WorkspaceID, IssueID: issue.ID, CreatedAt: now, CreatedBy: actor, ContractRevision: contract.Revision, ContractDigest: contract.ContentDigest, CandidateSnapshotID: candidate.ID, CandidateDigest: candidate.ContentDigest, Environment: store.EnvironmentSnapshot{DeviceID: "worker", ExecutionEnvironmentID: "env_evidence", Os: "darwin", Architecture: "arm64", Tools: []store.EnvironmentSnapshotToolsItem{}, ConfigurationDigest: evidenceDigest("config")}, Dependencies: []store.InputDependency{}, Targets: []store.TargetSnapshot{}, InputDigest: evidenceDigest("input"), BindingStatus: "verified", BindingNotes: []string{}}
	must(db.RegisterCandidate(ctx, issue.ID, candidate, input))
	criterion := contract.Criteria[0]
	evidence := store.Evidence{SchemaVersion: 1, ID: "evidence", WorkspaceID: issue.WorkspaceID, IssueID: issue.ID, CreatedAt: now, CreatedBy: actor, Title: "Candidate document", Description: "Actual candidate export", VerificationInputID: input.ID, Claims: []store.EvidenceClaim{{CriterionID: criterion.ID, RequirementID: criterion.EvidenceRequirements[0].ID, Purpose: "Review content"}}, Materials: []store.EvidenceMaterialRef{{MaterialID: "document", Role: "primary"}}, Source: store.EvidenceSource{Kind: "candidate_export", Producer: actor}, Collection: store.CollectionRecord{Operation: "file_export", CollectorName: "foundry", CollectorVersion: "1", InputMaterialID: "parameters", StartedAt: now, FinishedAt: now, Outcome: "completed", Completeness: "complete"}, CandidateBinding: "system_observed"}
	must(db.RegisterExportEvidence(ctx, issue.ID, evidence))
	return db, issue, contract, candidate, input, evidence
}

func TestEvidenceLifecycleRetainsPreliminaryFailureAndRequiresExactHumanReview(t *testing.T) {
	db, issue, contract, candidate, _, evidence := evidenceLifecycleFixture(t)
	ctx := context.Background()
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	actor := store.ActorRef{Kind: "daemon", ID: "worker", DisplayName: "Worker"}
	owner := store.ActorRef{Kind: "local_owner", ID: "owner", DisplayName: "Owner"}
	now := evidenceNow()
	criterion := contract.Criteria[0]
	v, err := db.RequestVerification(ctx, issue.ID, contract.Revision, candidate.ID, criterion.ID, owner, "judge")
	must(err)
	v, err = db.StartVerification(ctx, issue.ID, v.ID)
	must(err)
	must(db.MarkVerificationInterrupted(ctx, issue.ID, v.ID))
	v.Status = "completed"
	v.FinishedAt = &now
	citations := []store.EvidenceCitation{{EvidenceID: evidence.ID, MaterialID: "document"}}
	v.Result = &store.VerificationResult{Verdict: "fail", Summary: "Missing section", Reasoning: "The required section was not recognized", Findings: []store.VerificationFinding{{ID: "finding", Statement: criterion.Statement, Expected: "Complete section", Observed: "Section not recognized", Verdict: "fail", EvidenceCitations: citations, ReferenceCitations: []store.ReferenceCitation{}}}, Limitations: []string{}, UnmetRequirementIDs: []string{}, RawOutputMaterialID: "raw", ReportMaterialID: "report", CompletedAt: now}
	must(db.CompleteVerification(ctx, issue.ID, v, nil))
	review, err := db.CurrentReview(ctx, issue.ID)
	must(err)
	if review.Eligible {
		t.Fatal("agent failure accepted")
	}
	assessment, err := db.CreateHumanAssessment(ctx, issue.ID, store.HumanAssessmentInput{VerificationID: v.ID, Verdict: "pass", Rationale: store.RichContent{Text: "The section is present under a different heading", Media: []store.ReferenceMedia{}}, EvidenceCitations: citations}, owner, "assess")
	must(err)
	review, err = db.CurrentReview(ctx, issue.ID)
	must(err)
	if !review.Eligible || review.CriterionResults[0].HumanAssessmentID == nil || *review.CriterionResults[0].HumanAssessmentID != assessment.ID {
		t.Fatalf("human review missing: %+v", review)
	}
	raw, err := db.GetEvidenceRecord(ctx, issue.ID, "verification", v.ID)
	must(err)
	var original store.Verification
	must(json.Unmarshal(raw, &original))
	if original.Result.Verdict != "fail" {
		t.Fatal("human assessment rewrote original failure")
	}
	must(db.RecordReviewObservation(ctx, issue.ID, candidate.ID, []store.ReviewBlocker{{Code: "baseline_changed", Message: "Baseline moved"}}))
	blocked, err := db.CurrentReview(ctx, issue.ID)
	must(err)
	if blocked.ID == review.ID || blocked.Digest == review.Digest || blocked.Eligible {
		t.Fatal("live blocker mutated immutable review")
	}
	raw, err = db.GetEvidenceRecord(ctx, issue.ID, "review", review.ID)
	must(err)
	var retained store.ReviewSnapshot
	must(json.Unmarshal(raw, &retained))
	if !retained.Eligible || retained.Digest != review.Digest {
		t.Fatal("old review overwritten")
	}
	must(db.RecordReviewObservation(ctx, issue.ID, candidate.ID, []store.ReviewBlocker{}))
	review, err = db.CurrentReview(ctx, issue.ID)
	must(err)
	if _, err = db.ApproveReview(ctx, issue.ID, review.ID, review.Digest, actor, "daemon-accept", nil); err == nil {
		t.Fatal("daemon approved")
	}
	if _, err = db.ApproveReview(ctx, issue.ID, review.ID, review.Digest, store.ActorRef{Kind: "agent", ID: "verifier"}, "agent-accept", nil); err == nil {
		t.Fatal("verification Agent approved")
	}
	decision, err := db.ApproveReview(ctx, issue.ID, review.ID, review.Digest, owner, "accept", nil)
	must(err)
	changedRationale := &store.RichContent{Text: "Different approval", Media: []store.ReferenceMedia{}}
	if _, err = db.ApproveReview(ctx, issue.ID, review.ID, review.Digest, owner, "accept", changedRationale); err == nil || !strings.Contains(err.Error(), "idempotency_conflict") {
		t.Fatalf("approval replay changed content: %v", err)
	}
	if _, err = db.ApproveReview(ctx, issue.ID, review.ID, review.Digest, owner, "another-key", changedRationale); err == nil {
		t.Fatal("new key replaced original approval rationale")
	}
	issue, err = db.GetIssue(ctx, issue.ID)
	must(err)
	if issue.Status == "accepted" {
		t.Fatal("approval alone marked accepted")
	}
	if _, err = db.FinishAcceptance(ctx, issue.ID, decision.ID, "integration", ""); err == nil {
		t.Fatal("accepted without an integration snapshot receipt")
	}
	integration := candidate
	integration.ID = "integration_snapshot"
	integration.Purpose = "integration"
	integration.ParentSnapshotID = &candidate.ID
	must(db.RegisterIntegrationSnapshot(ctx, issue.ID, decision.ID, integration))
	_, err = db.FinishAcceptance(ctx, issue.ID, decision.ID, "integration", "")
	must(err)
	issue, err = db.GetIssue(ctx, issue.ID)
	must(err)
	if issue.Status != "accepted" {
		t.Fatal("integration did not finish")
	}
	_, err = db.FinishAcceptance(ctx, issue.ID, decision.ID, "integration", "")
	must(err)
	replayed, err := db.ApproveReview(ctx, issue.ID, review.ID, review.Digest, owner, "accept", nil)
	must(err)
	if replayed.Status != "integrated" {
		t.Fatal("idempotency replay returned stale approved projection")
	}
	if _, err = db.ApproveReview(ctx, issue.ID, review.ID, review.Digest, owner, "accept", changedRationale); err == nil {
		t.Fatal("integrated replay bypassed content validation")
	}
	if _, err = db.RequestVerification(ctx, issue.ID, contract.Revision, candidate.ID, criterion.ID, owner, "after-accept"); err == nil {
		t.Fatal("terminal issue scheduled new verification")
	}
}

func TestEvidenceDispatchCancelsQueuedAmendmentAndInvalidatesNewExecution(t *testing.T) {
	db, issue, contract, candidate, _, _ := evidenceLifecycleFixture(t)
	ctx := context.Background()
	owner := store.ActorRef{Kind: "local_owner", ID: "owner", DisplayName: "Owner"}
	v, err := db.RequestVerification(ctx, issue.ID, contract.Revision, candidate.ID, contract.Criteria[0].ID, owner, "queued")
	if err != nil {
		t.Fatal(err)
	}
	reason := "Revise the completion rule"
	draft, err := db.CreateContract(ctx, issue.ID, store.ContractDraftInput{BaseRevision: &contract.Revision, Content: store.ContractContentOf(contract), ChangeReason: &reason}, owner, "amend")
	if err != nil {
		t.Fatal(err)
	}
	started, err := db.StartVerification(ctx, issue.ID, v.ID)
	if err != nil || started.Status != "canceled" || started.Error == nil || started.Error.Code != "dispatch_invalidated" {
		t.Fatalf("queued amendment dispatched: %+v %v", started, err)
	}
	if _, err = db.DiscardContract(ctx, issue.ID, draft.Revision, "Retain original", owner, "discard"); err != nil {
		t.Fatal(err)
	}
	if _, err = db.StartIssueRun(ctx, issue.ID, store.Run{ID: "new-implementation", IssueID: issue.ID}); err != nil {
		t.Fatal(err)
	}
	current, err := db.GetIssue(ctx, issue.ID)
	if err != nil || current.CurrentCandidateSnapshotID != nil || current.CurrentReviewSnapshotID != nil {
		t.Fatalf("new run retained old snapshot: %+v %v", current, err)
	}
	review, err := db.CurrentReview(ctx, issue.ID)
	if err != nil || review.Eligible {
		t.Fatal("active implementation retained a reviewable candidate")
	}
}
