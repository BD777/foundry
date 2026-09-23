package sqlitestore

import (
	"context"
	"fmt"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// StartVerification is the dispatch authorization boundary. An amendment that
// wins this transaction cancels queued work; already-started tools may settle.
func (s *Store) StartVerification(ctx context.Context, issueID, verificationID string) (store.Verification, error) {
	var result store.Verification
	err := s.withTx(ctx, func(tx *Store) error {
		issue, err := tx.GetIssue(ctx, issueID)
		if err != nil {
			return err
		}
		// Dispatch boundary: a soft-removed device must never run assess/
		// collect agents. This sits before the queued-state check so even a
		// pre-existing queued verification cannot start after removal (busy
		// accounting normally prevents removal while one exists).
		if err := tx.assertWorkspaceDeviceNotRemoved(ctx, issue.WorkspaceID); err != nil {
			return err
		}
		v, err := evidenceGet[store.Verification](ctx, tx, issue.ID, "verification", verificationID)
		if err != nil {
			return err
		}
		if v.Status != "queued" {
			return fmt.Errorf("verification_not_queued")
		}
		input, err := evidenceGet[store.VerificationInput](ctx, tx, issue.ID, "input", v.VerificationInputID)
		if err != nil {
			return err
		}
		reason := ""
		if gateErr := tx.requireConfirmedContract(ctx, issue); gateErr != nil {
			reason = gateErr.Error()
		} else if *issue.CurrentContractRevision != v.ContractRevision || issue.CurrentCandidateSnapshotID == nil || *issue.CurrentCandidateSnapshotID != input.CandidateSnapshotID {
			reason = "verification_input_changed"
		}
		now := evidenceNow()
		if reason != "" {
			v.Status = "canceled"
			v.FinishedAt = &now
			v.Error = &store.VerificationError{Code: "dispatch_invalidated", Message: reason, Retryable: false}
		} else {
			v.Status = "running"
			v.StartedAt = &now
		}
		if err = tx.updateEvidenceProjection(ctx, v.ID, v); err != nil {
			return err
		}
		result = v
		return nil
	})
	return result, err
}

// Transport loss is not a terminal execution fact. A retained Worker receipt
// may still complete this record without rewriting a historical verdict.
func (s *Store) MarkVerificationInterrupted(ctx context.Context, issueID, verificationID string) error {
	return s.withTx(ctx, func(tx *Store) error {
		v, err := evidenceGet[store.Verification](ctx, tx, issueID, "verification", verificationID)
		if err != nil || v.Status != "running" {
			return err
		}
		v.Error = &store.VerificationError{Code: "verification_transport_interrupted", Message: "Awaiting retained Worker result; the operation will not be replayed", Retryable: false}
		return tx.updateEvidenceProjection(ctx, v.ID, v)
	})
}
