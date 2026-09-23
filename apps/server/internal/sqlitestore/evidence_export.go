package sqlitestore

import (
	"context"
	"errors"
	"fmt"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func (s *Store) RegisterExportEvidence(ctx context.Context, issueID string, e store.Evidence) error {
	return s.withTx(ctx, func(tx *Store) error {
		issue, err := tx.GetIssue(ctx, issueID)
		if err != nil {
			return err
		}
		if err = tx.requireConfirmedContract(ctx, issue); err != nil {
			return err
		}
		if err = validateRecordScope(issue, "Evidence", e); err != nil {
			return err
		}
		if e.Source.Kind != "candidate_export" || e.CandidateBinding != "system_observed" || e.Collection.Operation != "file_export" {
			return fmt.Errorf("candidate_export_required")
		}
		input, err := evidenceGet[store.VerificationInput](ctx, tx, issue.ID, "input", e.VerificationInputID)
		if err != nil {
			return err
		}
		if input.ContractRevision != *issue.CurrentContractRevision || issue.CurrentCandidateSnapshotID == nil || input.CandidateSnapshotID != *issue.CurrentCandidateSnapshotID {
			return fmt.Errorf("input_changed")
		}
		contract, err := tx.contractByRevision(ctx, issue.ID, input.ContractRevision)
		if err != nil {
			return err
		}
		for _, claim := range e.Claims {
			valid := false
			for _, c := range contract.Criteria {
				if c.ID != claim.CriterionID {
					continue
				}
				for _, r := range c.EvidenceRequirements {
					if r.ID == claim.RequirementID {
						valid = true
					}
				}
			}
			if !valid {
				return fmt.Errorf("invalid_export_claim")
			}
		}
		for _, m := range e.Materials {
			if _, err = tx.GetEvidenceRecord(ctx, issue.ID, "material", m.MaterialID); err != nil {
				return err
			}
		}
		if _, err = tx.GetEvidenceRecord(ctx, issue.ID, "material", e.Collection.InputMaterialID); err != nil {
			return err
		}
		if old, err := evidenceGet[store.Evidence](ctx, tx, issue.ID, "evidence", e.ID); err == nil {
			if evidenceDigest(old) == evidenceDigest(e) {
				return nil
			}
			return fmt.Errorf("immutable_evidence_conflict")
		} else if !errors.Is(err, store.ErrNotFound) {
			return err
		}
		sequence, err := tx.nextEvidenceSequence(ctx, issue.ID, "evidence")
		if err != nil {
			return err
		}
		if err = tx.insertEvidenceRecord(ctx, issue, "evidence", e.ID, sequence, e); err != nil {
			return err
		}
		return tx.auditEvidence(ctx, issue, e.CreatedBy, e.ID, "evidence_registered", "evidence", e.ID, evidenceDigest(e), "")
	})
}
