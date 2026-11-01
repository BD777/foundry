package externalaccounts

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"github.com/google/uuid"
)

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
	if err := s.store.ClearFeishuAppRotation(ctx, app.ID); err != nil {
		s.Logf("external accounts: forget the rotation advice of %s: %v", app.ID, err)
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
	rotate, err := s.store.FeishuAppsToRotate(ctx)
	if err != nil {
		return nil, err
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
	if err := s.store.ClearFeishuAppRotation(ctx, app.ID); err != nil {
		return store.ExternalProviderApp{}, err
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
	if provider, ok := s.registry.Lookup(app.Provider); ok {
		if _, public := provider.(AuthorizationCodeProvider); public && app.CreatedVia == "dynamic_registration" {
			return AppCredentials{ClientID: app.ClientID, BaseURL: app.BaseURL}, nil
		}
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
