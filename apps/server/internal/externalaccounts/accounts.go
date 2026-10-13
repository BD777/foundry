package externalaccounts

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// Accounts lists the person's accounts with their status brought up to date.
func (s *Service) Accounts(ctx context.Context, userID string) ([]store.ExternalAccount, error) {
	accounts, err := s.store.ListExternalAccounts(ctx, userID)
	if err != nil {
		return nil, err
	}
	for index := range accounts {
		accounts[index] = s.withComputedStatus(accounts[index])
	}
	s.withAppNames(ctx, accounts)
	return accounts, nil
}

// withComputedStatus derives "expiring" from the expiries at read time, so
// the page is right between sweeps.
func (s *Service) withComputedStatus(account store.ExternalAccount) store.ExternalAccount {
	if account.Status != store.ExternalAccountReady && account.Status != store.ExternalAccountExpiring {
		return account
	}
	now := s.Now()
	if refreshExpiry, ok := parseTime(account.RefreshExpiresAt); ok && !now.Before(refreshExpiry) {
		account.Status = store.ExternalAccountNeedsReauth
		account.StatusDetail = "refresh_token_expired"
		return account
	}
	if authExpiry, ok := parseTime(account.AuthExpiresAt); ok && !now.Before(authExpiry) {
		account.Status = store.ExternalAccountNeedsReauth
		account.StatusDetail = "authorization_expired"
		return account
	}
	account.Status = store.ExternalAccountReady
	if refreshExpiry, ok := parseTime(account.RefreshExpiresAt); ok && !account.KeepAlive && refreshExpiry.Sub(now) < 2*s.KeepAliveLead {
		account.Status = store.ExternalAccountExpiring
	}
	if authExpiry, ok := parseTime(account.AuthExpiresAt); ok && authExpiry.Sub(now) < 7*24*time.Hour {
		account.Status = store.ExternalAccountExpiring
	}
	return account
}

// Update changes the label or the keep-alive switch.
func (s *Service) Update(ctx context.Context, account store.ExternalAccount, update store.ExternalAccountUpdate, actorID string) (store.ExternalAccount, error) {
	if update.Label != nil {
		if label := strings.TrimSpace(*update.Label); label != "" {
			account.Label = label
		}
	}
	if update.KeepAlive != nil && *update.KeepAlive != account.KeepAlive {
		account.KeepAlive = *update.KeepAlive
		detail := "off"
		if account.KeepAlive {
			detail = "on"
		}
		s.event(ctx, store.ExternalAccountEvent{AccountID: account.ID, Kind: "keep_alive_changed", Detail: detail, ActorID: actorID})
	}
	saved, err := s.store.SaveExternalAccount(ctx, account)
	if err != nil {
		return store.ExternalAccount{}, err
	}
	s.changed(saved.ID)
	return s.withComputedStatus(saved), nil
}

// Revoke is "stop using now": the grant is revoked at the provider and
// deleted here; the account stays, marked revoked, until disconnected. The
// gateway refuses the account's handles from then on.
func (s *Service) Revoke(ctx context.Context, account store.ExternalAccount, actorID string) (store.ExternalAccount, error) {
	lock := s.lockFor(account.ID)
	lock.Lock()
	defer lock.Unlock()
	account, err := s.store.GetExternalAccount(ctx, account.ID)
	if err != nil {
		return account, err
	}
	if err := s.revokeLocked(ctx, account); err != nil {
		return account, err
	}
	account.Status = store.ExternalAccountRevoked
	account.StatusDetail = ""
	account.AccessExpiresAt = ""
	account.RefreshExpiresAt = ""
	saved, err := s.store.SaveExternalAccount(ctx, account)
	if err != nil {
		return account, err
	}
	s.event(ctx, store.ExternalAccountEvent{AccountID: account.ID, Kind: "revoked", ActorID: actorID})
	s.changed(saved.ID)
	return saved, nil
}

// revokeLocked revokes at the provider when a grant is held, then deletes
// the sealed grant. A grant the server no longer holds is already gone.
func (s *Service) revokeLocked(ctx context.Context, account store.ExternalAccount) error {
	if !s.SecretsConfigured() {
		return nil
	}
	grant, err := s.loadGrant(ctx, account.ID)
	if errors.Is(err, store.ErrNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	if err := s.Integrations.Err(); err != nil {
		return fmt.Errorf("cannot revoke %s at the provider: %w", account.ID, err)
	}
	app, err := s.store.GetExternalProviderApp(ctx, account.AppID)
	if err == nil {
		var credentials AppCredentials
		if credentials, err = s.AppCredentials(ctx, app); err == nil {
			var provider ServerHeldProvider
			if provider, err = s.serverHeld(account.Provider); err == nil {
				err = provider.Revoke(ctx, credentials, grant)
			}
		}
	}
	if err != nil {
		return fmt.Errorf("revoke at the provider: %w", err)
	}
	if err := s.secrets.DeleteSecret(ctx, GrantSecretID(account.ID)); err != nil && !errors.Is(err, store.ErrNotFound) {
		return fmt.Errorf("delete the grant of %s: %w", account.ID, err)
	}
	return nil
}

// Disconnect revokes (when a grant is still held) and removes the account
// with its bindings and audit lines.
func (s *Service) Disconnect(ctx context.Context, account store.ExternalAccount, actorID string) error {
	lock := s.lockFor(account.ID)
	lock.Lock()
	defer lock.Unlock()
	if account.Status != store.ExternalAccountRevoked {
		if err := s.revokeLocked(ctx, account); err != nil {
			return err
		}
	}
	if err := s.store.DeleteExternalAccount(ctx, account.ID); err != nil {
		return err
	}
	s.changed(account.ID)
	return nil
}
