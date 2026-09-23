package sqlitestore

import (
	"context"
	"errors"
	"fmt"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"time"
)

func (s *Store) ApproveReview(ctx context.Context, issueID, reviewID, digest string, actor store.ActorRef, requestID string, rationale *store.RichContent) (store.AcceptanceDecision, error) {
	var result store.AcceptanceDecision
	if !store.IsHumanActor(actor) {
		return result, fmt.Errorf("user_action_required")
	}
	err := s.evidenceRequest(ctx, issueID+"/accept", requestID, []any{reviewID, digest, actor, rationale}, func(tx *Store) (any, error) {
		issue, err := tx.GetIssue(ctx, issueID)
		if err != nil {
			return nil, err
		}
		decisions, err := evidenceList[store.AcceptanceDecision](ctx, tx, issue.ID, "decision")
		if err != nil {
			return nil, err
		}
		for _, decision := range decisions {
			if decision.ReviewSnapshotID != reviewID || decision.ReviewDigest != digest {
				continue
			}
			if evidenceDigest(decision.CreatedBy) != evidenceDigest(actor) || evidenceDigest(decision.Rationale) != evidenceDigest(rationale) {
				return nil, fmt.Errorf("acceptance_request_conflict")
			}
			if decision.Status == "invalidated" {
				return nil, fmt.Errorf("decision_invalidated")
			}
			return decision, nil
		}
		if issue.Status != "verifying" {
			return nil, fmt.Errorf("issue_not_verifying")
		}
		if rationale != nil {
			if err = validateRichRationale(ctx, tx, issue, *rationale); err != nil {
				return nil, err
			}
		}
		current, err := tx.CurrentReview(ctx, issue.ID)
		if err != nil {
			return nil, err
		}
		if current.ID != reviewID || current.Digest != digest || !current.Eligible {
			return nil, fmt.Errorf("review_changed_or_ineligible")
		}
		for _, decision := range decisions {
			if decision.Status == "approved" {
				decision.Status = "invalidated"
				at := evidenceNow()
				reason := "Superseded review"
				decision.InvalidatedAt = &at
				decision.InvalidationReason = &reason
				if err = tx.updateEvidenceProjection(ctx, decision.ID, decision); err != nil {
					return nil, err
				}
			}
		}
		d := store.AcceptanceDecision{SchemaVersion: 1, ID: evidenceID("decision"), WorkspaceID: issue.WorkspaceID, IssueID: issue.ID, CreatedAt: evidenceNow(), CreatedBy: actor, ReviewSnapshotID: reviewID, ReviewDigest: digest, ContractRevision: current.ContractRevision, CandidateSnapshotID: current.CandidateSnapshotID, Status: "approved"}
		d.Rationale = rationale
		sequence, err := tx.nextEvidenceSequence(ctx, issue.ID, "decision")
		if err != nil {
			return nil, err
		}
		if err = tx.insertEvidenceRecord(ctx, issue, "decision", d.ID, sequence, d); err != nil {
			return nil, err
		}
		err = tx.auditEvidence(ctx, issue, actor, requestID, "acceptance_approved", "decision", d.ID, evidenceDigest(d), "")
		return d, err
	}, &result)
	if err == nil {
		// The idempotency ledger keeps the original response; return the current
		// status projection without losing its request-content conflict check.
		result, err = evidenceGet[store.AcceptanceDecision](ctx, s, issueID, "decision", result.ID)
		if err == nil && result.Status == "invalidated" {
			err = fmt.Errorf("decision_invalidated")
		}
	}
	return result, err
}

func (s *Store) RegisterIntegrationSnapshot(ctx context.Context, issueID, decisionID string, snapshot store.CandidateSnapshot) error {
	return s.withTx(ctx, func(tx *Store) error {
		issue, err := tx.GetIssue(ctx, issueID)
		if err != nil {
			return err
		}
		if err = validateRecordScope(issue, "CandidateSnapshot", snapshot); err != nil {
			return err
		}
		decision, err := evidenceGet[store.AcceptanceDecision](ctx, tx, issue.ID, "decision", decisionID)
		if err != nil {
			return err
		}
		candidate, err := evidenceGet[store.CandidateSnapshot](ctx, tx, issue.ID, "candidate", decision.CandidateSnapshotID)
		if err != nil {
			return err
		}
		if decision.Status != "approved" || snapshot.Purpose != "integration" || snapshot.ParentSnapshotID == nil || *snapshot.ParentSnapshotID != candidate.ID || snapshot.ContentDigest != candidate.ContentDigest || snapshot.FileManifestMaterialID != candidate.FileManifestMaterialID || len(snapshot.Repositories) != len(candidate.Repositories) {
			return fmt.Errorf("integration_snapshot_mismatch")
		}
		for _, repo := range candidate.Repositories {
			found := false
			for _, target := range snapshot.Repositories {
				if repo.RepoID == target.RepoID && repo.TreeOid == target.TreeOid && repo.BaselineCommit == target.BaselineCommit {
					found = true
				}
			}
			if !found {
				return fmt.Errorf("integration_tree_mismatch")
			}
		}
		old, err := evidenceGet[store.CandidateSnapshot](ctx, tx, issue.ID, "integration", snapshot.ID)
		if err == nil {
			if evidenceDigest(old) == evidenceDigest(snapshot) {
				return nil
			}
			return fmt.Errorf("immutable_integration_conflict")
		}
		if !errors.Is(err, store.ErrNotFound) {
			return err
		}
		sequence, err := tx.nextEvidenceSequence(ctx, issue.ID, "integration")
		if err != nil {
			return err
		}
		return tx.insertEvidenceRecord(ctx, issue, "integration", snapshot.ID, sequence, snapshot)
	})
}
func (s *Store) FinishAcceptance(ctx context.Context, issueID, decisionID, integrationID, invalidReason string) (store.AcceptanceDecision, error) {
	var result store.AcceptanceDecision
	err := s.withTx(ctx, func(tx *Store) error {
		issue, err := tx.GetIssue(ctx, issueID)
		if err != nil {
			return err
		}
		d, err := evidenceGet[store.AcceptanceDecision](ctx, tx, issue.ID, "decision", decisionID)
		if err != nil {
			return err
		}
		if d.Status == "integrated" {
			if d.IntegrationID != nil && *d.IntegrationID == integrationID {
				result = d
				return nil
			}
			return fmt.Errorf("integration_conflict")
		}
		if d.Status != "approved" {
			return fmt.Errorf("decision_invalidated")
		}
		action := "acceptance_invalidated"
		if invalidReason != "" {
			d.Status = "invalidated"
			at := evidenceNow()
			d.InvalidatedAt = &at
			d.InvalidationReason = &invalidReason
		} else {
			if integrationID == "" || issue.Status != "verifying" || issue.ContractState != "confirmed" || issue.DraftContractRevision != nil || issue.CurrentContractRevision == nil || *issue.CurrentContractRevision != d.ContractRevision || issue.CurrentCandidateSnapshotID == nil || *issue.CurrentCandidateSnapshotID != d.CandidateSnapshotID {
				return fmt.Errorf("acceptance_input_changed")
			}
			approved, err := evidenceGet[store.ReviewSnapshot](ctx, tx, issue.ID, "review", d.ReviewSnapshotID)
			if err != nil {
				return err
			}
			current, err := tx.CurrentReview(ctx, issue.ID)
			if err != nil {
				return err
			}
			if !store.SameReviewJudgments(current, approved) {
				return fmt.Errorf("verification_selection_changed")
			}
			integrations, err := evidenceList[store.CandidateSnapshot](ctx, tx, issue.ID, "integration")
			if err != nil {
				return err
			}
			hasReceipt := false
			for _, snapshot := range integrations {
				if snapshot.ParentSnapshotID != nil && *snapshot.ParentSnapshotID == d.CandidateSnapshotID {
					hasReceipt = true
				}
			}
			if !hasReceipt {
				return fmt.Errorf("integration_receipt_missing")
			}
			d.Status = "integrated"
			d.IntegrationID = &integrationID
			issue.Status = "accepted"
			action = "integration_completed"
			if err = tx.saveIssue(ctx, issue, time.Time{}, time.Now().UTC()); err != nil {
				return err
			}
		}
		if err = tx.updateEvidenceProjection(ctx, d.ID, d); err != nil {
			return err
		}
		if err = tx.auditEvidence(ctx, issue, store.ActorRef{Kind: "system", ID: "foundry", DisplayName: "Foundry"}, decisionID, action, "decision", d.ID, evidenceDigest(d), invalidReason); err != nil {
			return err
		}
		result = d
		return nil
	})
	return result, err
}
