package sqlitestore

import (
	"context"
	"fmt"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func (s *Store) requireConfirmedContract(ctx context.Context, issue store.Issue) error {
	if issue.Status == "accepted" || issue.Status == "abandoned" {
		return fmt.Errorf("terminal_issue")
	}
	if issue.ContractState != "confirmed" || issue.CurrentContractRevision == nil || issue.DraftContractRevision != nil {
		return fmt.Errorf("contract_confirmation_required")
	}
	c, err := s.contractByRevision(ctx, issue.ID, *issue.CurrentContractRevision)
	if err != nil {
		return err
	}
	if c.Status != "confirmed" || c.Confirmation == nil || c.Confirmation.ContentDigest != c.ContentDigest || !store.IsHumanActor(c.Confirmation.Actor) {
		return fmt.Errorf("contract_confirmation_required")
	}
	return nil
}
