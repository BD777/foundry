package externalaccounts

import (
	"context"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// Internals the package's tests (package externalaccounts_test, which uses
// externalaccountstest) check.
var (
	EmailDomain          = emailDomain
	FeishuAlwaysScopes   = feishuAlwaysScopes
	FeishuApprovalScopes = feishuApprovalScopes
	ParseTime            = parseTime
	RefreshTokenExpiry   = refreshTokenExpiry
)

const FeishuRefreshFallback = feishuRefreshFallback

func (s *Service) LoadGrant(ctx context.Context, accountID string) (Grant, error) {
	return s.loadGrant(ctx, accountID)
}

func (s *Service) WithComputedStatus(account store.ExternalAccount) store.ExternalAccount {
	return s.withComputedStatus(account)
}

func (s *Service) HasSecret(ctx context.Context, id string) bool { return s.hasSecret(ctx, id) }
