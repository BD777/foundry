package issues

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// Summary is what an Issue works to and how far it came, as the Foundry
// tools read it.
type Summary struct {
	// Contract is the one it works to: the confirmed one, or the draft
	// while none is confirmed; nil without either.
	Contract *store.IssueContract
	// Verdicts are each criterion's latest verification on that revision.
	Verdicts map[string]store.Verification
	// Review is its current review, when it has one that reads.
	Review *store.ReviewSnapshot
}

// Summary reads what the Issue works to and how far it came.
func (s *Service) Summary(ctx context.Context, issue store.Issue) (Summary, error) {
	summary := Summary{Verdicts: map[string]store.Verification{}}
	if issue.CurrentReviewSnapshotID != nil {
		raw, err := s.store.GetEvidenceRecord(ctx, issue.ID, "review", *issue.CurrentReviewSnapshotID)
		var review store.ReviewSnapshot
		if err == nil && json.Unmarshal(raw, &review) == nil {
			summary.Review = &review
		}
	}
	revision := issue.CurrentContractRevision
	if revision == nil {
		revision = issue.DraftContractRevision
	}
	if revision == nil {
		return summary, nil
	}
	contract, err := s.store.ContractByRevision(ctx, issue.ID, *revision)
	if errors.Is(err, store.ErrNotFound) {
		return summary, nil
	}
	if err != nil {
		return Summary{}, err
	}
	summary.Contract = &contract
	verifications, err := s.store.ListEvidenceRecords(ctx, issue.ID, "verification")
	if err != nil {
		return Summary{}, err
	}
	for _, raw := range verifications {
		var verification store.Verification
		if json.Unmarshal(raw, &verification) != nil || verification.ContractRevision != contract.Revision {
			continue
		}
		if known, ok := summary.Verdicts[verification.CriterionID]; !ok || verification.Sequence > known.Sequence {
			summary.Verdicts[verification.CriterionID] = verification
		}
	}
	return summary, nil
}
