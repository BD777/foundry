package externalaccounts

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"strings"
	"sync"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/integrations"
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

// ErrDifferentIdentity: a re-authorization signed in as another provider user.
var ErrDifferentIdentity = errors.New("signed in as a different user than the account being re-authorized; connect that user as a new account instead")

// ErrAppInUse: a provider app still has accounts connected through it.
var ErrAppInUse = errors.New("accounts are still connected through this app; disconnect them first")

// HandleRequest names the session and account a gateway grant is for.
type HandleRequest struct {
	SessionID   string
	DeviceID    string
	WorkspaceID string
	UserID      string
	Account     store.ExternalAccount
	App         store.ExternalProviderApp
}

// HandleIssuer is the provider gateway: it issues a session's stand-in
// handles for one account (feishugateway.Gateway).
type HandleIssuer interface {
	IssueHandles(ctx context.Context, request HandleRequest) (store.ExternalAccountGateway, error)
}

// rotationList is the store's list of apps whose secret devices held
// before the gateway (store.FeishuGatewayStore).
type rotationList interface {
	FeishuAppsToRotate(ctx context.Context) (map[string]string, error)
	ClearFeishuAppRotation(ctx context.Context, appID string) error
}

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
	// Integrations off: nothing reaches a provider (login, refresh, revoke,
	// keep-alive); those answer integrations.ErrOff. An access token that
	// is still fresh is handed out as before. Nil is on.
	Integrations *integrations.Switch
	// Handles issues the gateway handles a session's device holds in place
	// of the app secret and the access token; nil gives sessions nothing.
	Handles HandleIssuer

	loginsMu sync.Mutex
	logins   map[string]*pendingLogin
	locksMu  sync.Mutex
	locks    map[string]*sync.Mutex
}

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
	if rotation, ok := s.store.(rotationList); ok {
		if err := rotation.ClearFeishuAppRotation(ctx, app.ID); err != nil {
			s.Logf("external accounts: forget the rotation advice of %s: %v", app.ID, err)
		}
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
	rotate := map[string]string{}
	if rotation, ok := s.store.(rotationList); ok {
		if rotate, err = rotation.FeishuAppsToRotate(ctx); err != nil {
			return nil, err
		}
	}
	accounts, err := s.store.ListExternalAccounts(ctx, userID)
	if err != nil {
		return nil, err
	}
	for index := range apps {
		apps[index].HasSecret = s.hasSecret(ctx, AppSecretID(apps[index].ID))
		_, apps[index].RotateSecret = rotate[apps[index].ID]
		for _, account := range accounts {
			if account.AppID == apps[index].ID {
				apps[index].AccountNames = append(apps[index].AccountNames, accountPersonName(account))
			}
		}
	}
	return apps, nil
}

// accountPersonName is who the account is: the provider's name for the
// person, else the label it was given.
func accountPersonName(account store.ExternalAccount) string {
	if account.DisplayName != "" {
		return account.DisplayName
	}
	return account.Label
}

// --- App names ---------------------------------------------------------------

// appNamesTTL is how long read names count as current; a lookup that could
// not read a name is tried again after appNamesRetry.
const (
	appNamesTTL   = 24 * time.Hour
	appNamesRetry = time.Hour
)

func (s *Service) appNamesStale(app store.ExternalProviderApp) bool {
	checked, ok := parseTime(app.NamesCheckedAt)
	if !ok {
		return true
	}
	age := s.Now().Sub(checked)
	return age >= appNamesTTL || (app.NamesDetail != "" && age >= appNamesRetry)
}

// refreshAppNames asks the provider what the app and its organisation are
// called and records it. A name the provider will not give keeps its last
// known value, and the reason goes into NamesDetail; the app is returned as
// recorded. Integrations off, or a provider that cannot say, changes nothing.
// Without the organisation's name, its email domain is read with userToken,
// else with a live token of an account connected through the app.
func (s *Service) refreshAppNames(ctx context.Context, app store.ExternalProviderApp, credentials *AppCredentials, userToken string) store.ExternalProviderApp {
	if !s.Integrations.On() {
		return app
	}
	provider, ok := s.registry.Lookup(app.Provider)
	if !ok {
		return app
	}
	reader, ok := provider.(AppNameReader)
	if !ok {
		return app
	}
	if credentials == nil {
		unsealed, err := s.AppCredentials(ctx, app)
		if err != nil {
			s.Logf("external accounts: names of %s: %v", app.ID, err)
			return app
		}
		credentials = &unsealed
	}
	read := reader.ReadAppNames(ctx, *credentials)
	names := store.ExternalAppNames{AppName: app.AppName, TenantName: app.TenantName, OrgDomain: app.OrgDomain, CheckedAt: s.formatTime(s.Now()), Detail: read.Detail}
	if read.AppName != "" {
		names.AppName = read.AppName
	}
	if read.TenantName != "" {
		names.TenantName = read.TenantName
	}
	if domainReader, ok := provider.(OrgDomainReader); ok && read.TenantName == "" {
		if userToken == "" {
			userToken = s.liveAccessToken(ctx, app.ID)
		}
		if userToken != "" {
			domain, err := domainReader.ReadOrgDomain(ctx, *credentials, userToken)
			if domain != "" {
				names.OrgDomain = domain
			} else {
				problem := "org domain: " + err.Error()
				if names.Detail != "" {
					problem = names.Detail + "; " + problem
				}
				names.Detail = problem
			}
		}
	}
	if err := s.store.SetExternalProviderAppNames(ctx, app.ID, names); err != nil {
		s.Logf("external accounts: record names of %s: %v", app.ID, err)
		return app
	}
	if names.Detail != "" {
		s.Logf("external accounts: names of %s (%s): %s", app.ID, app.ClientID, names.Detail)
	}
	app.AppName, app.TenantName, app.OrgDomain, app.NamesCheckedAt, app.NamesDetail = names.AppName, names.TenantName, names.OrgDomain, names.CheckedAt, names.Detail
	return app
}

// liveAccessToken is the unexpired access token of a ready account
// connected through the app, read without refreshing it or marking the
// account used; empty when there is none.
func (s *Service) liveAccessToken(ctx context.Context, appID string) string {
	accounts, err := s.store.ListExternalAccounts(ctx, "")
	if err != nil {
		return ""
	}
	for _, account := range accounts {
		if account.AppID != appID || account.Mode != store.ExternalCredentialServerHeld || account.Status != store.ExternalAccountReady {
			continue
		}
		if grant, err := s.loadGrant(ctx, account.ID); err == nil && grant.AccessToken != "" && grant.AccessExpiresAt.After(s.Now().Add(time.Minute)) {
			return grant.AccessToken
		}
	}
	return ""
}

// RefreshStaleAppNames reads the names of every app accounts connect
// through, and every organisation-wide app, whose names are missing or
// older than a day. RunKeepAlive calls it, so existing apps get names on
// the first sweep.
func (s *Service) RefreshStaleAppNames(ctx context.Context) int {
	if !s.SecretsConfigured() || !s.Integrations.On() {
		return 0
	}
	ids := map[string]bool{}
	accounts, err := s.store.ListExternalAccounts(ctx, "")
	if err != nil {
		s.Logf("external accounts names: list accounts: %v", err)
		return 0
	}
	for _, account := range accounts {
		ids[account.AppID] = true
	}
	shared, err := s.store.ListExternalProviderApps(ctx, "")
	if err != nil {
		s.Logf("external accounts names: list apps: %v", err)
		return 0
	}
	for _, app := range shared {
		ids[app.ID] = true
	}
	refreshed := 0
	for id := range ids {
		if s.refreshStaleAppNames(ctx, id) {
			refreshed++
		}
	}
	return refreshed
}

func (s *Service) refreshStaleAppNames(ctx context.Context, appID string) bool {
	app, err := s.store.GetExternalProviderApp(ctx, appID)
	if err != nil || !s.appNamesStale(app) {
		return false
	}
	s.refreshAppNames(ctx, app, nil, "")
	return true
}

// withAppNames copies each account's app and organisation names from its app.
func (s *Service) withAppNames(ctx context.Context, accounts []store.ExternalAccount) {
	apps := map[string]store.ExternalProviderApp{}
	for index := range accounts {
		app, ok := apps[accounts[index].AppID]
		if !ok {
			var err error
			if app, err = s.store.GetExternalProviderApp(ctx, accounts[index].AppID); err != nil {
				continue
			}
			apps[app.ID] = app
		}
		accounts[index].AppName, accounts[index].TenantName, accounts[index].OrgDomain = app.AppName, app.TenantName, app.OrgDomain
	}
}

// ReplaceAppSecret seals a new client secret for app, after the person
// rotated it at the provider. With integrations on, the provider must
// accept it first (SecretChecker), so a typo does not break every account
// connected through the app.
func (s *Service) ReplaceAppSecret(ctx context.Context, app store.ExternalProviderApp, clientSecret string) (store.ExternalProviderApp, error) {
	if !s.SecretsConfigured() {
		return store.ExternalProviderApp{}, ErrSecretsNotConfigured
	}
	clientSecret = strings.TrimSpace(clientSecret)
	if clientSecret == "" {
		return store.ExternalProviderApp{}, errors.New("clientSecret is required")
	}
	if provider, ok := s.registry.Lookup(app.Provider); ok && s.Integrations.On() {
		if checker, ok := provider.(SecretChecker); ok {
			if err := checker.CheckAppSecret(ctx, AppCredentials{ClientID: app.ClientID, ClientSecret: clientSecret, BaseURL: app.BaseURL}); err != nil {
				return store.ExternalProviderApp{}, err
			}
		}
	}
	if err := s.secrets.PutSecret(ctx, AppSecretID(app.ID), []byte(clientSecret), AppSecretID(app.ID)); err != nil {
		return store.ExternalProviderApp{}, fmt.Errorf("seal the app secret: %w", err)
	}
	if rotation, ok := s.store.(rotationList); ok {
		if err := rotation.ClearFeishuAppRotation(ctx, app.ID); err != nil {
			return store.ExternalProviderApp{}, err
		}
	}
	app.HasSecret, app.RotateSecret = true, false
	return app, nil
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

// TenantAccessToken is the app's own token (a Feishu app's bot), fetched
// with the sealed secret; the caller caches it. Integrations off refuse.
func (s *Service) TenantAccessToken(ctx context.Context, app store.ExternalProviderApp) (string, time.Duration, error) {
	if err := s.Integrations.Err(); err != nil {
		return "", 0, err
	}
	provider, ok := s.registry.Lookup(app.Provider)
	if !ok {
		return "", 0, fmt.Errorf("unknown provider %q", app.Provider)
	}
	issuer, ok := provider.(TenantTokenIssuer)
	if !ok {
		return "", 0, fmt.Errorf("provider %q has no app token", app.Provider)
	}
	credentials, err := s.AppCredentials(ctx, app)
	if err != nil {
		return "", 0, err
	}
	return issuer.TenantAccessToken(ctx, credentials)
}

// --- Logins ------------------------------------------------------------------

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

// ProfileName is the tool profile a worker writes for an account in one
// session: "foundry-<account id>-<session digest>", within feishu-cli's
// [A-Za-z0-9_-]{1,64}. Each session has its own profile, since its handles
// die with it.
func ProfileName(accountID, sessionID string) string {
	id := strings.TrimPrefix(accountID, "xacc_")
	var clean strings.Builder
	for _, r := range id {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '_', r == '-':
			clean.WriteRune(r)
		}
	}
	name := "foundry-" + clean.String()
	if len(name) > 53 {
		name = name[:53]
	}
	digest := sha256.Sum256([]byte(sessionID))
	return name + "-" + hex.EncodeToString(digest[:])[:10]
}

// sessionHandleLifetime is the expiry the tool is told its handles have;
// the gateway refuses them as soon as the session ends, whatever it says.
const sessionHandleLifetime = 30 * 24 * time.Hour

// SessionMaterials is what a session may act with: for every account bound
// to its workspace that Eligible allows, the gateway handles standing in for
// the app secret and the access token. Accounts whose handles cannot be
// issued are left out and logged; the session still starts.
func (s *Service) SessionMaterials(ctx context.Context, workspaceID, sessionID, deviceID, sessionOwner, deviceOwner string) ([]store.ExternalAccountMaterial, error) {
	accounts, err := s.SessionAccounts(ctx, workspaceID, sessionOwner, deviceOwner)
	if err != nil {
		return nil, err
	}
	var materials []store.ExternalAccountMaterial
	for _, account := range accounts {
		material, err := s.material(ctx, account, HandleRequest{SessionID: sessionID, DeviceID: deviceID, WorkspaceID: workspaceID, UserID: sessionOwner, Account: account})
		if err != nil {
			s.Logf("external account %s for session %s: %v", account.ID, sessionID, err)
			continue
		}
		materials = append(materials, material)
	}
	return materials, nil
}

// SessionAccounts lists the accounts bound to workspaceID that a session
// sessionOwner started on a device deviceOwner owns may act as now.
func (s *Service) SessionAccounts(ctx context.Context, workspaceID, sessionOwner, deviceOwner string) ([]store.ExternalAccount, error) {
	if !s.SecretsConfigured() || sessionOwner == "" || deviceOwner == "" {
		return nil, nil
	}
	bindings, err := s.store.ListWorkspaceExternalAccounts(ctx, workspaceID)
	if err != nil {
		return nil, err
	}
	var accounts []store.ExternalAccount
	for _, binding := range bindings {
		account, err := s.store.GetExternalAccount(ctx, binding.AccountID)
		if err != nil {
			continue
		}
		account = s.withComputedStatus(account)
		if Eligible(account, account.WorkspaceIDs, workspaceID, sessionOwner, deviceOwner) {
			accounts = append(accounts, account)
		}
	}
	return accounts, nil
}

func (s *Service) material(ctx context.Context, account store.ExternalAccount, request HandleRequest) (store.ExternalAccountMaterial, error) {
	if s.Handles == nil {
		return store.ExternalAccountMaterial{}, errors.New("this server has no gateway for the account's provider")
	}
	app, err := s.store.GetExternalProviderApp(ctx, account.AppID)
	if err != nil {
		return store.ExternalAccountMaterial{}, err
	}
	request.App = app
	gateway, err := s.Handles.IssueHandles(ctx, request)
	if err != nil {
		return store.ExternalAccountMaterial{}, err
	}
	provider, _ := s.registry.Lookup(account.Provider)
	tool := ""
	if provider != nil && len(provider.Describe().Tools) > 0 {
		tool = provider.Describe().Tools[0]
	}
	return store.ExternalAccountMaterial{
		AccountID: account.ID, Provider: account.Provider, Label: account.Label, Tool: tool, ProfileName: ProfileName(account.ID, request.SessionID),
		ClientID: app.ClientID, Gateway: &gateway, ExpiresAt: s.formatTime(s.Now().Add(sessionHandleLifetime)),
		Scope: strings.Join(account.GrantedScopes, " "), Subject: account.Subject, DisplayName: account.DisplayName,
	}, nil
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
