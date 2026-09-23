package sqlitestore

import (
	"context"
	"fmt"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func (s *Store) RegisterAlignedCandidate(ctx context.Context, issueID, previousSnapshotID string, candidate store.CandidateSnapshot, input store.VerificationInput) error {
	return s.withTx(ctx, func(tx *Store) error {
		issue, err := tx.GetIssue(ctx, issueID)
		if err != nil {
			return err
		}
		if err = tx.requireConfirmedContract(ctx, issue); err != nil {
			return err
		}
		if issue.Status != "verifying" || issue.Run == nil || issue.Run.Status == "running" || issue.CurrentCandidateSnapshotID == nil ||
			(*issue.CurrentCandidateSnapshotID != previousSnapshotID && *issue.CurrentCandidateSnapshotID != candidate.ID) {
			return fmt.Errorf("alignment_input_changed")
		}
		before, err := evidenceGet[store.CandidateSnapshot](ctx, tx, issue.ID, "candidate", previousSnapshotID)
		if err != nil {
			return err
		}
		if candidate.EnvironmentID != before.EnvironmentID || candidate.EnvironmentRevision <= before.EnvironmentRevision ||
			candidate.ParentSnapshotID == nil || *candidate.ParentSnapshotID != before.ID {
			return fmt.Errorf("alignment_snapshot_mismatch")
		}
		run, err := tx.getRun(ctx, issue.Run.ID)
		if err != nil {
			return err
		}
		run.EnvironmentRevision = candidate.EnvironmentRevision
		issue.Run = &run
		if err = tx.saveRun(ctx, run, time.Now().UTC()); err != nil {
			return err
		}
		if err = tx.saveIssue(ctx, issue, time.Time{}, time.Now().UTC()); err != nil {
			return err
		}
		if err = tx.RegisterCandidate(ctx, issueID, candidate, input); err != nil {
			return err
		}
		decisions, err := evidenceList[store.AcceptanceDecision](ctx, tx, issue.ID, "decision")
		if err != nil {
			return err
		}
		for _, d := range decisions {
			if d.Status == "approved" {
				if _, err = tx.FinishAcceptance(ctx, issue.ID, d.ID, "", "baseline_aligned_reverification_required"); err != nil {
					return err
				}
			}
		}
		return nil
	})
}
