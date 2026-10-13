package externalaccounts

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"github.com/google/uuid"
)

type pendingLogin struct {
	mu    sync.Mutex
	view  store.ExternalAccountLogin
	owner string
	label string
	// replace is the account a re-authorization renews; nil connects a new one.
	replace *store.ExternalAccount
	app     store.ExternalProviderApp
	login   DeviceLogin
	doneAt  time.Time
	elapsed bool
}

// BeginLogin starts a device-flow login through app for ownerUserID and
// polls the provider in the background until the person approves or the
// code expires. The returned view holds what to show the person. Without
// scopes named the login asks for the provider's preset.
func (s *Service) BeginLogin(ctx context.Context, ownerUserID string, app store.ExternalProviderApp, input store.ConnectExternalAccountInput) (store.ExternalAccountLogin, error) {
	if !s.SecretsConfigured() {
		return store.ExternalAccountLogin{}, ErrSecretsNotConfigured
	}
	if err := s.Integrations.Err(); err != nil {
		return store.ExternalAccountLogin{}, err
	}
	provider, err := s.serverHeld(app.Provider)
	if err != nil {
		return store.ExternalAccountLogin{}, err
	}
	credentials, err := s.AppCredentials(ctx, app)
	if err != nil {
		return store.ExternalAccountLogin{}, err
	}
	var replace *store.ExternalAccount
	if accountID := strings.TrimSpace(input.AccountID); accountID != "" {
		account, err := s.store.GetExternalAccount(ctx, accountID)
		if err != nil || account.OwnerUserID != ownerUserID || account.AppID != app.ID {
			return store.ExternalAccountLogin{}, store.ErrExternalAccountNotFound
		}
		replace = &account
	}
	scopes := input.Scopes
	if len(scopes) == 0 {
		scopes = provider.PresetScopes(input.IncludeApprovalScopes)
	}
	login, err := provider.BeginDeviceLogin(ctx, credentials, scopes)
	if err != nil {
		return store.ExternalAccountLogin{}, err
	}
	pending := &pendingLogin{
		owner: ownerUserID, label: strings.TrimSpace(input.Label), replace: replace,
		view: store.ExternalAccountLogin{ID: "xlogin_" + uuid.NewString(), Provider: app.Provider, Status: "pending"},
	}
	pending.authorize(s, app, login, "")
	s.track(pending)
	go s.pollLogin(pending, provider, credentials)
	return pending.view, nil
}

// BeginSetup starts a sign-in that needs no pasted app: the provider first
// creates an app for whoever confirms the shown page (phase "register"),
// then the same login asks them to authorize it (phase "authorize"). One
// login id follows both phases; the app is saved as the person's own.
func (s *Service) BeginSetup(ctx context.Context, ownerUserID string, input store.SetupExternalAccountInput) (store.ExternalAccountLogin, error) {
	if !s.SecretsConfigured() {
		return store.ExternalAccountLogin{}, ErrSecretsNotConfigured
	}
	if err := s.Integrations.Err(); err != nil {
		return store.ExternalAccountLogin{}, err
	}
	provider, err := s.serverHeld(strings.TrimSpace(input.Provider))
	if err != nil {
		return store.ExternalAccountLogin{}, err
	}
	registrar, ok := provider.(AppRegistrar)
	if !ok {
		return store.ExternalAccountLogin{}, fmt.Errorf("provider %q cannot create apps; add an app and connect through it", input.Provider)
	}
	registration, err := registrar.BeginAppRegistration(ctx, input.Brand)
	if err != nil {
		return store.ExternalAccountLogin{}, err
	}
	pending := &pendingLogin{
		owner: ownerUserID, label: strings.TrimSpace(input.Label),
		view: store.ExternalAccountLogin{
			ID: "xlogin_" + uuid.NewString(), Provider: provider.Describe().Kind, Status: "pending", Phase: "register",
			VerificationURI: registration.VerificationURL, VerificationURIComplete: registration.VerificationURL, UserCode: registration.UserCode,
			ExpiresAt: s.formatTime(registration.ExpiresAt), IntervalSeconds: int(registration.Interval / time.Second),
		},
	}
	s.track(pending)
	scopes := input.Scopes
	if len(scopes) == 0 {
		scopes = registrar.PresetScopes(input.IncludeApprovalScopes)
	}
	go s.runSetup(pending, registrar, registration, scopes)
	return pending.view, nil
}

// runSetup waits for the app, saves it, then authorizes it as a login.
func (s *Service) runSetup(pending *pendingLogin, registrar AppRegistrar, registration AppRegistration, scopes []string) {
	ctx, cancel := context.WithTimeout(context.Background(), registration.ExpiresAt.Sub(s.Now())+30*time.Second)
	defer cancel()
	registered, err := s.awaitRegistration(ctx, registrar, registration)
	if err != nil {
		s.finishLogin(pending, nil, err)
		return
	}
	app, err := s.saveRegisteredApp(ctx, pending.owner, registrar.Describe(), registered)
	if err != nil {
		s.finishLogin(pending, nil, err)
		return
	}
	s.Logf("external accounts: %s created %s app %s for %s", app.ID, app.Provider, app.ClientID, pending.owner)
	credentials := AppCredentials{ClientID: registered.ClientID, ClientSecret: registered.ClientSecret, BaseURL: registered.BaseURL}
	login, err := registrar.BeginDeviceLogin(ctx, credentials, scopes)
	if err != nil {
		// The app exists; the person can authorize it again from the dialog.
		pending.mu.Lock()
		pending.view.AppID, pending.view.App = app.ID, &app
		pending.mu.Unlock()
		s.finishLogin(pending, nil, err)
		return
	}
	pending.mu.Lock()
	pending.authorize(s, app, login, "authorize")
	pending.mu.Unlock()
	s.pollLogin(pending, registrar, credentials)
}

func (s *Service) awaitRegistration(ctx context.Context, registrar AppRegistrar, registration AppRegistration) (RegisteredApp, error) {
	interval := registration.Interval
	if interval < s.MinPollInterval {
		interval = s.MinPollInterval
	}
	for {
		select {
		case <-ctx.Done():
			return RegisteredApp{}, ErrLoginExpired
		case <-time.After(interval):
		}
		if s.Now().After(registration.ExpiresAt) {
			return RegisteredApp{}, ErrLoginExpired
		}
		registered, next, outcome, err := registrar.PollAppRegistration(ctx, registration)
		registration = next
		switch outcome {
		case PollPending:
			continue
		case PollSlowDown:
			interval += 5 * time.Second
			continue
		}
		return registered, err
	}
}

// saveRegisteredApp stores the created app as the owner's personal app and
// seals its secret, like a pasted one.
func (s *Service) saveRegisteredApp(ctx context.Context, ownerUserID string, provider store.ExternalProvider, registered RegisteredApp) (store.ExternalProviderApp, error) {
	app, err := s.store.CreateExternalProviderApp(ctx, store.ExternalProviderApp{
		ID: "xapp_" + uuid.NewString(), Provider: provider.Kind, OwnerUserID: ownerUserID, Visibility: store.ExternalAppPersonal,
		Label: provider.Label + " app " + registered.ClientID, ClientID: registered.ClientID, BaseURL: registered.BaseURL, CreatedVia: "registered",
	})
	if err != nil {
		return store.ExternalProviderApp{}, err
	}
	if err := s.secrets.PutSecret(ctx, AppSecretID(app.ID), []byte(registered.ClientSecret), AppSecretID(app.ID)); err != nil {
		if rollbackErr := s.store.DeleteExternalProviderApp(ctx, app.ID); rollbackErr != nil {
			return store.ExternalProviderApp{}, errors.Join(fmt.Errorf("seal the app secret: %w", err), fmt.Errorf("remove the unsealed app %s: %w", app.ID, rollbackErr))
		}
		return store.ExternalProviderApp{}, fmt.Errorf("seal the app secret: %w", err)
	}
	app.HasSecret = true
	return app, nil
}

// authorize points the login at app's device authorization; the caller
// holds p.mu once the login is shared.
func (p *pendingLogin) authorize(s *Service, app store.ExternalProviderApp, login DeviceLogin, phase string) {
	p.app, p.login = app, login
	p.view.AppID, p.view.Phase = app.ID, phase
	if phase != "" {
		p.view.App = &app
	}
	p.view.VerificationURI, p.view.VerificationURIComplete, p.view.UserCode = login.VerificationURI, login.VerificationURIComplete, login.UserCode
	p.view.ExpiresAt, p.view.IntervalSeconds = s.formatTime(login.ExpiresAt), int(login.Interval/time.Second)
	p.view.RequestedScopes = login.RequestedScopes
}

func (s *Service) track(pending *pendingLogin) {
	s.loginsMu.Lock()
	s.pruneLoginsLocked()
	s.logins[pending.view.ID] = pending
	s.loginsMu.Unlock()
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

// missingScopes is what was asked for and not granted. offline_access is
// left out: it shows as the refresh token, not in the granted list.
func missingScopes(requested, granted []string) []string {
	have := map[string]bool{"offline_access": true}
	for _, scope := range granted {
		have[scope] = true
	}
	var missing []string
	for _, scope := range requested {
		if !have[scope] {
			missing = append(missing, scope)
		}
	}
	return missing
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
		// Every sign-in reads the names afresh: a new app has none yet, and
		// the app or organisation may have been renamed.
		app := s.refreshAppNames(ctx, pending.app, &credentials, grant.AccessToken)
		account.AppName, account.TenantName, account.OrgDomain = app.AppName, app.TenantName, app.OrgDomain
		if missing := missingScopes(pending.login.RequestedScopes, grant.Scopes()); len(missing) > 0 {
			pending.mu.Lock()
			pending.view.MissingScopes = missing
			pending.view.ScopeApplyURL = provider.ScopeApplyURL(credentials, missing)
			pending.mu.Unlock()
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
	if pending.replace != nil {
		return s.renewAccount(ctx, pending, account, grant)
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

// renewAccount writes a re-authorization onto the account it renews: the
// same id, label, keep-alive and workspace bindings, the new identity
// fields and grant. A different provider user is refused.
func (s *Service) renewAccount(ctx context.Context, pending *pendingLogin, fresh store.ExternalAccount, grant Grant) (store.ExternalAccount, error) {
	previous := *pending.replace
	if previous.Subject != "" && fresh.Subject != "" && previous.Subject != fresh.Subject {
		return store.ExternalAccount{}, ErrDifferentIdentity
	}
	lock := s.lockFor(previous.ID)
	lock.Lock()
	defer lock.Unlock()
	fresh.ID, fresh.CreatedAt, fresh.KeepAlive, fresh.LastUsedAt = previous.ID, previous.CreatedAt, previous.KeepAlive, previous.LastUsedAt
	if pending.label == "" {
		fresh.Label = previous.Label
	}
	if fresh.Subject == "" {
		fresh.Subject, fresh.DisplayName, fresh.Tenant = previous.Subject, previous.DisplayName, previous.Tenant
	}
	// The grant first: a row saved as ready must have a grant behind it.
	if err := s.sealGrant(ctx, fresh.ID, grant); err != nil {
		return store.ExternalAccount{}, err
	}
	saved, err := s.store.SaveExternalAccount(ctx, fresh)
	if err != nil {
		return store.ExternalAccount{}, err
	}
	s.event(ctx, store.ExternalAccountEvent{AccountID: saved.ID, Kind: "reauthorized", Detail: strings.Join(grant.Scopes(), " "), ActorID: pending.owner})
	s.changed(saved.ID)
	return saved, nil
}
