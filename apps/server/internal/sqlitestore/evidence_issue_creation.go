package sqlitestore

import (
	"context"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func (s *Store) CreateIssueIdempotent(ctx context.Context, input store.CreateIssueInput, requestID string) (store.Issue, error) {
	var result store.Issue
	err := s.evidenceRequest(ctx, "issues/create", requestID, input, func(tx *Store) (any, error) {
		return tx.createIssue(ctx, input)
	}, &result)
	return result, err
}
