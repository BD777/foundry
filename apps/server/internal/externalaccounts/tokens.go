package externalaccounts

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// Use is why a token is minted; it goes into the audit line.
type Use struct {
	SessionID string
	DeviceID  string
	// By names the refresher in the account's LastRefreshBy: "session",
	// "keep_alive", "manual".
	By string
}

// Mint returns an access token for the account: the current one while it
// has RefreshLead left, else a freshly refreshed one. The server is the
// only refresher; the per-account lock makes two concurrent mints spend one
// refresh token once. Each mint is an audit line of the account.
func (s *Service) Mint(ctx context.Context, account store.ExternalAccount, use Use) (store.ExternalAccountToken, error) {
	return s.token(ctx, account.ID, use, true)
}

// AccessToken is Mint for the provider gateway, which calls it on every
// request it forwards as the account and keeps its own audit: no account
// event per call, and the last-used time written at most once a minute.
func (s *Service) AccessToken(ctx context.Context, accountID string, use Use) (store.ExternalAccountToken, error) {
	return s.token(ctx, accountID, use, false)
}

func (s *Service) token(ctx context.Context, accountID string, use Use, audit bool) (store.ExternalAccountToken, error) {
	lock := s.lockFor(accountID)
	lock.Lock()
	defer lock.Unlock()
	// The caller's copy may predate a refresh another mint just made.
	account, err := s.store.GetExternalAccount(ctx, accountID)
	if err != nil {
		return store.ExternalAccountToken{}, err
	}
	if account.Mode != store.ExternalCredentialServerHeld {
		return store.ExternalAccountToken{}, fmt.Errorf("%w: %s is device-local", ErrAccountUnusable, account.ID)
	}
	if account.Status == store.ExternalAccountRevoked || account.Status == store.ExternalAccountNeedsReauth {
		return store.ExternalAccountToken{}, fmt.Errorf("%w: %s is %s", ErrAccountUnusable, account.ID, account.Status)
	}
	grant, err := s.loadGrant(ctx, account.ID)
	if err != nil {
		return store.ExternalAccountToken{}, err
	}
	now := s.Now()
	refreshed := false
	if grant.AccessExpiresAt.Sub(now) < s.RefreshLead {
		grant, err = s.refreshLocked(ctx, &account, grant, use)
		if err != nil {
			return store.ExternalAccountToken{}, err
		}
		refreshed = true
	}
	lastUsed, _ := parseTime(account.LastUsedAt)
	if audit || refreshed || now.Sub(lastUsed) >= time.Minute {
		account.LastUsedAt = s.formatTime(now)
		if _, err := s.store.SaveExternalAccount(ctx, account); err != nil {
			return store.ExternalAccountToken{}, err
		}
	}
	if audit {
		s.event(ctx, store.ExternalAccountEvent{AccountID: account.ID, Kind: "token_issued", SessionID: use.SessionID, DeviceID: use.DeviceID, Detail: s.formatTime(grant.AccessExpiresAt)})
	}
	return store.ExternalAccountToken{
		AccountID: account.ID, AccessToken: grant.AccessToken, TokenType: grant.TokenType,
		ExpiresAt: s.formatTime(grant.AccessExpiresAt), Scope: grant.Scope,
	}, nil
}

// RefreshNow refreshes regardless of the access token's remaining life,
// then reads the app's names if they are missing or stale.
func (s *Service) RefreshNow(ctx context.Context, account store.ExternalAccount, use Use) (store.ExternalAccount, error) {
	refreshed, err := s.refreshNow(ctx, account, use)
	if err != nil {
		return refreshed, err
	}
	// Outside the account's lock: the lookup must not hold up token mints.
	// A name that could not be read is asked for again at once: the person
	// may have just granted the app the scope it lacked.
	if app, err := s.store.GetExternalProviderApp(ctx, refreshed.AppID); err == nil && (app.NamesDetail != "" || s.appNamesStale(app)) {
		s.refreshAppNames(ctx, app, nil, "")
	}
	named := []store.ExternalAccount{refreshed}
	s.withAppNames(ctx, named)
	return named[0], nil
}

func (s *Service) refreshNow(ctx context.Context, account store.ExternalAccount, use Use) (store.ExternalAccount, error) {
	lock := s.lockFor(account.ID)
	lock.Lock()
	defer lock.Unlock()
	account, err := s.store.GetExternalAccount(ctx, account.ID)
	if err != nil {
		return account, err
	}
	if account.Mode != store.ExternalCredentialServerHeld || account.Status == store.ExternalAccountRevoked {
		return account, fmt.Errorf("%w: %s", ErrAccountUnusable, account.ID)
	}
	grant, err := s.loadGrant(ctx, account.ID)
	if err != nil {
		return account, err
	}
	if _, err := s.refreshLocked(ctx, &account, grant, use); err != nil {
		return s.withComputedStatus(account), err
	}
	saved, err := s.store.SaveExternalAccount(ctx, account)
	if err != nil {
		return account, err
	}
	return s.withComputedStatus(saved), nil
}

// refreshLocked spends the refresh token, reseals the rotated grant and
// updates the account in place (the caller saves it). A terminal failure
// marks the account needs_reauth so nothing retries a dead token.
func (s *Service) refreshLocked(ctx context.Context, account *store.ExternalAccount, grant Grant, use Use) (Grant, error) {
	if err := s.Integrations.Err(); err != nil {
		return Grant{}, fmt.Errorf("cannot refresh %s: %w", account.ID, err)
	}
	app, err := s.store.GetExternalProviderApp(ctx, account.AppID)
	if err != nil {
		return Grant{}, err
	}
	credentials, err := s.AppCredentials(ctx, app)
	if err != nil {
		return Grant{}, err
	}
	provider, err := s.serverHeld(account.Provider)
	if err != nil {
		return Grant{}, err
	}
	refreshed, err := provider.Refresh(ctx, credentials, grant)
	if err != nil {
		var refreshErr *RefreshError
		if errors.As(err, &refreshErr) && refreshErr.Terminal {
			account.Status = store.ExternalAccountNeedsReauth
			account.StatusDetail = refreshErr.Class()
			if _, saveErr := s.store.SaveExternalAccount(ctx, *account); saveErr != nil {
				s.Logf("external account %s: record needs_reauth: %v", account.ID, saveErr)
			}
			s.event(ctx, store.ExternalAccountEvent{AccountID: account.ID, Kind: "needs_reauth", Detail: refreshErr.Class(), SessionID: use.SessionID, DeviceID: use.DeviceID})
			s.changed(account.ID)
		}
		return Grant{}, err
	}
	refreshed.Generation = grant.Generation + 1
	if err := s.sealGrant(ctx, account.ID, refreshed); err != nil {
		// The provider rotated the token but the new one is not stored: the
		// old one is spent, so the account can only be re-authorized.
		account.Status = store.ExternalAccountNeedsReauth
		account.StatusDetail = "grant_not_stored"
		if _, saveErr := s.store.SaveExternalAccount(ctx, *account); saveErr != nil {
			s.Logf("external account %s: record grant_not_stored: %v", account.ID, saveErr)
		}
		s.changed(account.ID)
		return Grant{}, err
	}
	now := s.Now()
	account.Status = store.ExternalAccountReady
	account.StatusDetail = ""
	account.AccessExpiresAt = s.formatTime(refreshed.AccessExpiresAt)
	account.RefreshExpiresAt = s.formatTime(refreshed.RefreshExpiresAt)
	if !refreshed.AuthExpiresAt.IsZero() {
		account.AuthExpiresAt = s.formatTime(refreshed.AuthExpiresAt)
	}
	if scopes := refreshed.Scopes(); len(scopes) > 0 {
		account.GrantedScopes = scopes
	}
	account.LastRefreshedAt = s.formatTime(now)
	account.LastRefreshBy = use.By
	s.event(ctx, store.ExternalAccountEvent{AccountID: account.ID, Kind: "refreshed", Detail: use.By, SessionID: use.SessionID, DeviceID: use.DeviceID})
	s.changed(account.ID)
	return refreshed, nil
}

func (s *Service) sealGrant(ctx context.Context, accountID string, grant Grant) error {
	payload, err := json.Marshal(grant)
	if err != nil {
		return err
	}
	if err := s.secrets.PutSecret(ctx, GrantSecretID(accountID), payload, GrantSecretID(accountID)); err != nil {
		return fmt.Errorf("seal the grant of %s: %w", accountID, err)
	}
	return nil
}

func (s *Service) loadGrant(ctx context.Context, accountID string) (Grant, error) {
	if !s.SecretsConfigured() {
		return Grant{}, ErrSecretsNotConfigured
	}
	payload, err := s.secrets.GetSecret(ctx, GrantSecretID(accountID))
	if err != nil {
		return Grant{}, fmt.Errorf("unseal the grant of %s: %w", accountID, err)
	}
	var grant Grant
	if err := json.Unmarshal(payload, &grant); err != nil {
		return Grant{}, fmt.Errorf("decode the grant of %s: %w", accountID, err)
	}
	return grant, nil
}

// --- Keep-alive --------------------------------------------------------------

// RunKeepAlive sweeps every KeepAliveInterval until ctx ends, and reads
// app names that are missing or stale (at once, then with each sweep); with
// integrations off it returns at once.
func (s *Service) RunKeepAlive(ctx context.Context) {
	if !s.Integrations.On() {
		return
	}
	ticker := time.NewTicker(s.KeepAliveInterval)
	defer ticker.Stop()
	s.RefreshStaleAppNames(ctx)
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.KeepAliveSweep(ctx)
			s.RefreshStaleAppNames(ctx)
		}
	}
}

// KeepAliveSweep refreshes, once, every account that asked to be kept alive
// whose refresh token is within KeepAliveLead of expiring, so an idle
// account does not die at day 7. Accounts that did not ask are left to
// expire and show "expiring" instead. It reports how many were refreshed.
func (s *Service) KeepAliveSweep(ctx context.Context) int {
	if !s.SecretsConfigured() || !s.Integrations.On() {
		return 0
	}
	accounts, err := s.store.ListExternalAccounts(ctx, "")
	if err != nil {
		s.Logf("external accounts keep-alive: list: %v", err)
		return 0
	}
	refreshed := 0
	now := s.Now()
	for _, account := range accounts {
		if !account.KeepAlive || account.Mode != store.ExternalCredentialServerHeld {
			continue
		}
		if account.Status != store.ExternalAccountReady && account.Status != store.ExternalAccountExpiring {
			continue
		}
		refreshExpiry, ok := parseTime(account.RefreshExpiresAt)
		if !ok || refreshExpiry.Sub(now) > s.KeepAliveLead || !now.Before(refreshExpiry) {
			continue
		}
		if authExpiry, ok := parseTime(account.AuthExpiresAt); ok && !now.Before(authExpiry) {
			continue
		}
		if _, err := s.RefreshNow(ctx, account, Use{By: "keep_alive"}); err != nil {
			s.Logf("external account %s keep-alive refresh: %v", account.ID, err)
			continue
		}
		refreshed++
	}
	return refreshed
}
