package externalaccounts

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"strings"
	"sync"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"github.com/google/uuid"
)

// SecretKeeper is the sealed secret store the service keeps grants and app
// secrets in. The record id doubles as the additional data, so a row moved
// to another id fails to unseal (the convention of httpapi/secrets.go).
type SecretKeeper interface {
	PutSecret(ctx context.Context, id string, plaintext []byte, additionalData string) error
	GetSecret(ctx context.Context, id string) ([]byte, error)
	HasSecret(ctx context.Context, id string) (bool, error)
	DeleteSecret(ctx context.Context, id string) error
	SecretKEKFingerprint() string
}

// ErrSecretsNotConfigured: the server has no secret store key, so it cannot
// hold a grant. Nothing degrades to plaintext.
var ErrSecretsNotConfigured = errors.New("server secret store is not configured; set FOUNDRY_SECRET_KEY_PATH to hold external account logins server-side")

// ErrAccountUnusable: the account's grant cannot produce a token (needs
// re-authorization, revoked, or device-local).
var ErrAccountUnusable = errors.New("external account cannot issue a token")

// ErrAppInUse: a provider app still has accounts connected through it.
var ErrAppInUse = errors.New("accounts are still connected through this app; disconnect them first")

// AppSecretID is the secret record of a provider app's client secret.
func AppSecretID(appID string) string { return "external-app:" + appID }

// GrantSecretID is the secret record of an account's grant.
func GrantSecretID(accountID string) string { return "external-account:" + accountID }

// Service owns external accounts: logins, the single refresh path, revoke,
// keep-alive and the materials sessions receive.
type Service struct {
	store    store.ExternalAccountStore
	secrets  SecretKeeper
	registry *Registry
	// Now is the clock; tests move it.
	Now func() time.Time
	// RefreshLead: a mint refreshes when the access token has less than
	// this left, so a session gets a token that outlives its first commands.
	RefreshLead time.Duration
	// KeepAliveLead: keep-alive refreshes an account whose refresh token has
	// less than this left; without keep-alive the account shows "expiring"
	// from twice this lead.
	KeepAliveLead time.Duration
	// KeepAliveInterval is how often RunKeepAlive sweeps.
	KeepAliveInterval time.Duration
	// MinPollInterval bounds how fast a login polls the provider.
	MinPollInterval time.Duration
	// LoginGrace is how long a finished login stays readable.
	LoginGrace time.Duration
	// OnChanged, when set, is told the id of an account whose record
	// changed, so a server can announce it.
	OnChanged func(accountID string)
	Logf      func(format string, args ...any)

	loginsMu sync.Mutex
	logins   map[string]*pendingLogin
	locksMu  sync.Mutex
	locks    map[string]*sync.Mutex
}

type pendingLogin struct {
	mu      sync.Mutex
	view    store.ExternalAccountLogin
	owner   string
	scopes  []string
	label   string
	app     store.ExternalProviderApp
	login   DeviceLogin
	doneAt  time.Time
	elapsed bool
}

// NewService builds a service over the store, the secret keeper (nil when
// the server has none) and the providers.
func NewService(st store.ExternalAccountStore, secrets SecretKeeper, registry *Registry) *Service {
	if registry == nil {
		registry = NewRegistry(&Feishu{})
	}
	return &Service{
		store:             st,
		secrets:           secrets,
		registry:          registry,
		Now:               time.Now,
		RefreshLead:       30 * time.Minute,
		KeepAliveLead:     24 * time.Hour,
		KeepAliveInterval: time.Hour,
		MinPollInterval:   time.Second,
		LoginGrace:        10 * time.Minute,
		Logf:              log.Printf,
		logins:            map[string]*pendingLogin{},
		locks:             map[string]*sync.Mutex{},
	}
}

// SecretsConfigured reports whether the server can hold grants.
func (s *Service) SecretsConfigured() bool {
	return s.secrets != nil && s.secrets.SecretKEKFingerprint() != ""
}

// Providers lists the adapters.
func (s *Service) Providers() []store.ExternalProvider { return s.registry.Describe() }

func (s *Service) serverHeld(kind string) (ServerHeldProvider, error) {
	provider, ok := s.registry.Lookup(kind)
	if !ok {
		return nil, fmt.Errorf("unknown provider %q", kind)
	}
	held, ok := provider.(ServerHeldProvider)
	if !ok {
		return nil, fmt.Errorf("provider %q does not hold logins on the server", kind)
	}
	return held, nil
}

func (s *Service) changed(accountID string) {
	if s.OnChanged != nil {
		s.OnChanged(accountID)
	}
}

func (s *Service) formatTime(value time.Time) string {
	if value.IsZero() {
		return ""
	}
	return value.UTC().Format(time.RFC3339)
}

// --- Provider apps ---------------------------------------------------------

// CreateApp stores a pasted OAuth client registration. The secret is sealed
// right after the row exists; a failed seal removes the row so no app is
// left that cannot authenticate.
func (s *Service) CreateApp(ctx context.Context, ownerUserID string, input store.SaveExternalProviderAppInput) (store.ExternalProviderApp, error) {
	if !s.SecretsConfigured() {
		return store.ExternalProviderApp{}, ErrSecretsNotConfigured
	}
	provider, err := s.serverHeld(strings.TrimSpace(input.Provider))
	if err != nil {
		return store.ExternalProviderApp{}, err
	}
	clientID, clientSecret := strings.TrimSpace(input.ClientID), strings.TrimSpace(input.ClientSecret)
	if clientID == "" || clientSecret == "" {
		return store.ExternalProviderApp{}, errors.New("clientId and clientSecret are required")
	}
	visibility := input.Visibility
	if visibility == "" {
		visibility = store.ExternalAppPersonal
	}
	if visibility != store.ExternalAppPersonal && visibility != store.ExternalAppInstance {
		return store.ExternalProviderApp{}, errors.New("visibility must be personal or instance")
	}
	label := strings.TrimSpace(input.Label)
	if label == "" {
		label = provider.Describe().Label + " app " + clientID
	}
	app, err := s.store.CreateExternalProviderApp(ctx, store.ExternalProviderApp{
		ID: "xapp_" + uuid.NewString(), Provider: provider.Describe().Kind, OwnerUserID: ownerUserID, Visibility: visibility,
		Label: label, ClientID: clientID, BaseURL: strings.TrimRight(strings.TrimSpace(input.BaseURL), "/"), CreatedVia: "pasted",
	})
	if err != nil {
		return store.ExternalProviderApp{}, err
	}
	if err := s.secrets.PutSecret(ctx, AppSecretID(app.ID), []byte(clientSecret), AppSecretID(app.ID)); err != nil {
		if rollbackErr := s.store.DeleteExternalProviderApp(ctx, app.ID); rollbackErr != nil {
			return store.ExternalProviderApp{}, errors.Join(fmt.Errorf("seal the app secret: %w", err), fmt.Errorf("remove the unsealed app %s: %w", app.ID, rollbackErr))
		}
		return store.ExternalProviderApp{}, fmt.Errorf("seal the app secret: %w", err)
	}
	app.HasSecret = true
	return app, nil
}

// DeleteApp removes an app nobody is connected through, and its secret.
func (s *Service) DeleteApp(ctx context.Context, app store.ExternalProviderApp) error {
	accounts, err := s.store.ListExternalAccounts(ctx, "")
	if err != nil {
		return err
	}
	for _, account := range accounts {
		if account.AppID == app.ID {
			return ErrAppInUse
		}
	}
	if err := s.store.DeleteExternalProviderApp(ctx, app.ID); err != nil {
		return err
	}
	if s.secrets != nil {
		if err := s.secrets.DeleteSecret(ctx, AppSecretID(app.ID)); err != nil && !errors.Is(err, store.ErrNotFound) {
			return fmt.Errorf("delete the app secret: %w", err)
		}
	}
	return nil
}

// ListApps lists the apps the person may connect through, marking which
// hold a secret.
func (s *Service) ListApps(ctx context.Context, userID string) ([]store.ExternalProviderApp, error) {
	apps, err := s.store.ListExternalProviderApps(ctx, userID)
	if err != nil {
		return nil, err
	}
	for index := range apps {
		apps[index].HasSecret = s.hasSecret(ctx, AppSecretID(apps[index].ID))
	}
	return apps, nil
}

func (s *Service) hasSecret(ctx context.Context, id string) bool {
	if !s.SecretsConfigured() {
		return false
	}
	stored, err := s.secrets.HasSecret(ctx, id)
	if err != nil {
		s.Logf("external accounts: read secret %s: %v", id, err)
		return false
	}
	return stored
}

// AppCredentials unseals an app's client secret for one call.
func (s *Service) AppCredentials(ctx context.Context, app store.ExternalProviderApp) (AppCredentials, error) {
	if !s.SecretsConfigured() {
		return AppCredentials{}, ErrSecretsNotConfigured
	}
	secret, err := s.secrets.GetSecret(ctx, AppSecretID(app.ID))
	if err != nil {
		return AppCredentials{}, fmt.Errorf("unseal the app secret of %s: %w", app.ID, err)
	}
	return AppCredentials{ClientID: app.ClientID, ClientSecret: string(secret), BaseURL: app.BaseURL}, nil
}

// --- Logins ------------------------------------------------------------------

// BeginLogin starts a device-flow login through app for ownerUserID and
// polls the provider in the background until the person approves or the
// code expires. The returned view holds what to show the person.
func (s *Service) BeginLogin(ctx context.Context, ownerUserID string, app store.ExternalProviderApp, input store.ConnectExternalAccountInput) (store.ExternalAccountLogin, error) {
	if !s.SecretsConfigured() {
		return store.ExternalAccountLogin{}, ErrSecretsNotConfigured
	}
	provider, err := s.serverHeld(app.Provider)
	if err != nil {
		return store.ExternalAccountLogin{}, err
	}
	credentials, err := s.AppCredentials(ctx, app)
	if err != nil {
		return store.ExternalAccountLogin{}, err
	}
	login, err := provider.BeginDeviceLogin(ctx, credentials, input.Scopes)
	if err != nil {
		return store.ExternalAccountLogin{}, err
	}
	pending := &pendingLogin{
		owner: ownerUserID, scopes: input.Scopes, label: strings.TrimSpace(input.Label), app: app, login: login,
		view: store.ExternalAccountLogin{
			ID: "xlogin_" + uuid.NewString(), Provider: app.Provider, AppID: app.ID, Status: "pending",
			VerificationURI: login.VerificationURI, VerificationURIComplete: login.VerificationURIComplete, UserCode: login.UserCode,
			ExpiresAt: s.formatTime(login.ExpiresAt), IntervalSeconds: int(login.Interval / time.Second), RequestedScopes: login.RequestedScopes,
		},
	}
	s.loginsMu.Lock()
	s.pruneLoginsLocked()
	s.logins[pending.view.ID] = pending
	s.loginsMu.Unlock()
	go s.pollLogin(pending, provider, credentials)
	return pending.view, nil
}

// Login reads a login the owner started.
func (s *Service) Login(loginID, ownerUserID string) (store.ExternalAccountLogin, bool) {
	s.loginsMu.Lock()
	pending, ok := s.logins[loginID]
	s.loginsMu.Unlock()
	if !ok || pending.owner != ownerUserID {
		return store.ExternalAccountLogin{}, false
	}
	pending.mu.Lock()
	defer pending.mu.Unlock()
	return pending.view, true
}

func (s *Service) pruneLoginsLocked() {
	now := s.Now()
	for id, pending := range s.logins {
		pending.mu.Lock()
		expired := !pending.doneAt.IsZero() && now.Sub(pending.doneAt) > s.LoginGrace
		pending.mu.Unlock()
		if expired {
			delete(s.logins, id)
		}
	}
}

func (s *Service) finishLogin(pending *pendingLogin, account *store.ExternalAccount, err error) {
	pending.mu.Lock()
	defer pending.mu.Unlock()
	pending.doneAt = s.Now()
	if err != nil {
		pending.view.Status = "failed"
		pending.view.Error = err.Error()
		return
	}
	pending.view.Status = "complete"
	pending.view.Account = account
}

func (s *Service) pollLogin(pending *pendingLogin, provider ServerHeldProvider, credentials AppCredentials) {
	// The deadline follows the service clock, so the provider's expiry and
	// the server's own clock agree (tests move both).
	ctx, cancel := context.WithTimeout(context.Background(), pending.login.ExpiresAt.Sub(s.Now())+30*time.Second)
	defer cancel()
	interval := pending.login.Interval
	if interval < s.MinPollInterval {
		interval = s.MinPollInterval
	}
	for {
		select {
		case <-ctx.Done():
			s.finishLogin(pending, nil, ErrLoginExpired)
			return
		case <-time.After(interval):
		}
		if s.Now().After(pending.login.ExpiresAt) {
			s.finishLogin(pending, nil, ErrLoginExpired)
			return
		}
		grant, outcome, err := provider.PollDeviceLogin(ctx, credentials, pending.login)
		switch outcome {
		case PollPending:
			continue
		case PollSlowDown:
			interval += 5 * time.Second
			continue
		}
		if err != nil {
			s.finishLogin(pending, nil, err)
			return
		}
		account, err := s.completeLogin(ctx, pending, provider, credentials, grant)
		if err != nil {
			s.finishLogin(pending, nil, err)
			return
		}
		s.finishLogin(pending, &account, nil)
		return
	}
}

// completeLogin turns a finished device flow into an account: refuse a
// grant without a refresh token (it would die within hours), read the
// identity, save the row, seal the grant.
func (s *Service) completeLogin(ctx context.Context, pending *pendingLogin, provider ServerHeldProvider, credentials AppCredentials, grant Grant) (store.ExternalAccount, error) {
	if grant.RefreshToken == "" {
		return store.ExternalAccount{}, ErrMissingRefreshToken
	}
	identity, identityErr := provider.Identity(ctx, credentials, grant.AccessToken)
	now := s.Now()
	grant.Generation = 1
	label := pending.label
	if label == "" {
		label = identity.DisplayName
	}
	if label == "" {
		label = provider.Describe().Label + " account"
	}
	account := store.ExternalAccount{
		ID: "xacc_" + uuid.NewString(), Provider: pending.app.Provider, AppID: pending.app.ID, OwnerUserID: pending.owner, Label: label,
		Mode: store.ExternalCredentialServerHeld, Status: store.ExternalAccountReady, Subject: identity.Subject,
		DisplayName: identity.DisplayName, Tenant: identity.Tenant, GrantedScopes: grant.Scopes(), KeepAlive: true,
		AuthTime: s.formatTime(grant.AuthTime), AuthExpiresAt: s.formatTime(grant.AuthExpiresAt),
		AccessExpiresAt: s.formatTime(grant.AccessExpiresAt), RefreshExpiresAt: s.formatTime(grant.RefreshExpiresAt),
		LastRefreshedAt: s.formatTime(now), LastRefreshBy: "login",
	}
	if identityErr != nil {
		account.StatusDetail = "identity_unread"
	}
	saved, err := s.store.SaveExternalAccount(ctx, account)
	if err != nil {
		return store.ExternalAccount{}, err
	}
	if err := s.sealGrant(ctx, saved.ID, grant); err != nil {
		if rollbackErr := s.store.DeleteExternalAccount(ctx, saved.ID); rollbackErr != nil {
			return store.ExternalAccount{}, errors.Join(err, fmt.Errorf("remove the account %s whose grant was not sealed: %w", saved.ID, rollbackErr))
		}
		return store.ExternalAccount{}, err
	}
	s.event(ctx, store.ExternalAccountEvent{AccountID: saved.ID, Kind: "connected", Detail: strings.Join(grant.Scopes(), " "), ActorID: pending.owner})
	s.changed(saved.ID)
	return saved, nil
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

func (s *Service) event(ctx context.Context, event store.ExternalAccountEvent) {
	if err := s.store.AppendExternalAccountEvent(ctx, event); err != nil {
		s.Logf("external account %s: record %s: %v", event.AccountID, event.Kind, err)
	}
}

// --- Accounts ---------------------------------------------------------------

// Accounts lists the person's accounts with their status brought up to date.
func (s *Service) Accounts(ctx context.Context, userID string) ([]store.ExternalAccount, error) {
	accounts, err := s.store.ListExternalAccounts(ctx, userID)
	if err != nil {
		return nil, err
	}
	for index := range accounts {
		accounts[index] = s.withComputedStatus(accounts[index])
	}
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

func parseTime(value string) (time.Time, bool) {
	if value == "" {
		return time.Time{}, false
	}
	parsed, err := time.Parse(time.RFC3339, value)
	if err != nil {
		parsed, err = time.Parse(time.RFC3339Nano, value)
	}
	return parsed, err == nil
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

func (s *Service) lockFor(accountID string) *sync.Mutex {
	s.locksMu.Lock()
	defer s.locksMu.Unlock()
	lock, ok := s.locks[accountID]
	if !ok {
		lock = &sync.Mutex{}
		s.locks[accountID] = lock
	}
	return lock
}

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
// refresh token once.
func (s *Service) Mint(ctx context.Context, account store.ExternalAccount, use Use) (store.ExternalAccountToken, error) {
	lock := s.lockFor(account.ID)
	lock.Lock()
	defer lock.Unlock()
	// The caller's copy may predate a refresh another mint just made.
	account, err := s.store.GetExternalAccount(ctx, account.ID)
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
	if grant.AccessExpiresAt.Sub(now) < s.RefreshLead {
		grant, err = s.refreshLocked(ctx, &account, grant, use)
		if err != nil {
			return store.ExternalAccountToken{}, err
		}
	}
	account.LastUsedAt = s.formatTime(now)
	if _, err := s.store.SaveExternalAccount(ctx, account); err != nil {
		return store.ExternalAccountToken{}, err
	}
	s.event(ctx, store.ExternalAccountEvent{AccountID: account.ID, Kind: "token_issued", SessionID: use.SessionID, DeviceID: use.DeviceID, Detail: s.formatTime(grant.AccessExpiresAt)})
	return store.ExternalAccountToken{
		AccountID: account.ID, AccessToken: grant.AccessToken, TokenType: grant.TokenType,
		ExpiresAt: s.formatTime(grant.AccessExpiresAt), Scope: grant.Scope,
	}, nil
}

// RefreshNow refreshes regardless of the access token's remaining life.
func (s *Service) RefreshNow(ctx context.Context, account store.ExternalAccount, use Use) (store.ExternalAccount, error) {
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

// Revoke is "stop using now": the grant is revoked at the provider and
// deleted here; the account stays, marked revoked, until disconnected.
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

// --- Sessions ----------------------------------------------------------------

// Eligible says whether sessionOwner's session on a device owned by
// deviceOwner may act as account now: Permitted, and the account usable.
func Eligible(account store.ExternalAccount, boundWorkspaces []string, workspaceID, sessionOwner, deviceOwner string) bool {
	return Permitted(account, boundWorkspaces, workspaceID, sessionOwner, deviceOwner) &&
		(account.Status == store.ExternalAccountReady || account.Status == store.ExternalAccountExpiring)
}

// Permitted says whether sessionOwner's session on a device owned by
// deviceOwner may act as account at all, whatever the account's status: in
// the MVP only the account's owner, on their own devices, with the account
// bound to the session's workspace. This mirrors the UserFiles rule for
// Issues (daemon_ws.go). A permitted session whose account is revoked or
// needs re-auth is refused by Mint with ErrAccountUnusable, not forbidden.
func Permitted(account store.ExternalAccount, boundWorkspaces []string, workspaceID, sessionOwner, deviceOwner string) bool {
	if account.OwnerUserID == "" || sessionOwner != account.OwnerUserID || deviceOwner != account.OwnerUserID {
		return false
	}
	if account.Mode != store.ExternalCredentialServerHeld {
		return false
	}
	for _, bound := range boundWorkspaces {
		if bound == workspaceID {
			return true
		}
	}
	return false
}

// ProfileName is the tool profile a worker writes for an account:
// "foundry-<id>", within feishu-cli's [A-Za-z0-9_-]{1,64}.
func ProfileName(accountID string) string {
	id := strings.TrimPrefix(accountID, "xacc_")
	var clean strings.Builder
	for _, r := range id {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '_', r == '-':
			clean.WriteRune(r)
		}
	}
	name := "foundry-" + clean.String()
	if len(name) > 64 {
		name = name[:64]
	}
	return name
}

// SessionMaterials mints what a session may act with: for every account
// bound to its workspace that Eligible allows, an access token and the
// app's credentials for the tool. Accounts whose mint fails are left out
// and logged; the session still starts.
func (s *Service) SessionMaterials(ctx context.Context, workspaceID, sessionID, deviceID, sessionOwner, deviceOwner string) ([]store.ExternalAccountMaterial, error) {
	if !s.SecretsConfigured() || sessionOwner == "" || deviceOwner == "" {
		return nil, nil
	}
	bindings, err := s.store.ListWorkspaceExternalAccounts(ctx, workspaceID)
	if err != nil {
		return nil, err
	}
	var materials []store.ExternalAccountMaterial
	for _, binding := range bindings {
		account, err := s.store.GetExternalAccount(ctx, binding.AccountID)
		if err != nil {
			continue
		}
		account = s.withComputedStatus(account)
		if !Eligible(account, account.WorkspaceIDs, workspaceID, sessionOwner, deviceOwner) {
			continue
		}
		material, err := s.material(ctx, account, Use{SessionID: sessionID, DeviceID: deviceID, By: "session"})
		if err != nil {
			s.Logf("external account %s for session %s: %v", account.ID, sessionID, err)
			continue
		}
		materials = append(materials, material)
	}
	return materials, nil
}

func (s *Service) material(ctx context.Context, account store.ExternalAccount, use Use) (store.ExternalAccountMaterial, error) {
	app, err := s.store.GetExternalProviderApp(ctx, account.AppID)
	if err != nil {
		return store.ExternalAccountMaterial{}, err
	}
	credentials, err := s.AppCredentials(ctx, app)
	if err != nil {
		return store.ExternalAccountMaterial{}, err
	}
	token, err := s.Mint(ctx, account, use)
	if err != nil {
		return store.ExternalAccountMaterial{}, err
	}
	provider, _ := s.registry.Lookup(account.Provider)
	tool := ""
	if provider != nil && len(provider.Describe().Tools) > 0 {
		tool = provider.Describe().Tools[0]
	}
	return store.ExternalAccountMaterial{
		AccountID: account.ID, Provider: account.Provider, Label: account.Label, Tool: tool, ProfileName: ProfileName(account.ID),
		ClientID: credentials.ClientID, ClientSecret: credentials.ClientSecret, BaseURL: app.BaseURL,
		AccessToken: token.AccessToken, TokenType: token.TokenType, ExpiresAt: token.ExpiresAt, Scope: token.Scope,
		Subject: account.Subject, DisplayName: account.DisplayName,
	}, nil
}

// --- Keep-alive --------------------------------------------------------------

// RunKeepAlive sweeps every KeepAliveInterval until ctx ends.
func (s *Service) RunKeepAlive(ctx context.Context) {
	ticker := time.NewTicker(s.KeepAliveInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.KeepAliveSweep(ctx)
		}
	}
}

// KeepAliveSweep refreshes, once, every account that asked to be kept alive
// whose refresh token is within KeepAliveLead of expiring, so an idle
// account does not die at day 7. Accounts that did not ask are left to
// expire and show "expiring" instead. It reports how many were refreshed.
func (s *Service) KeepAliveSweep(ctx context.Context) int {
	if !s.SecretsConfigured() {
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
