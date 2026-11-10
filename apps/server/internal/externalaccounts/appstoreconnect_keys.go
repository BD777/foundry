package externalaccounts

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"github.com/google/uuid"
)

const appStoreConnectKeyPayloadVersion = 1

var (
	appStoreConnectKeyID         = regexp.MustCompile(`^[A-Za-z0-9]{8,16}$`)
	ErrInvalidAppStoreConnectKey = errors.New("invalid App Store Connect key")
)

// AppStoreConnectKeySecretID is the secret store record of one App Store
// Connect .p8. The record id is also its additional authenticated data.
func AppStoreConnectKeySecretID(appID string) string {
	return "external-app:" + appID + ":appstoreconnect-key"
}

// appStoreConnectKeyPayload is deliberately separate from Grant: a team key
// has no OAuth access/refresh token lifecycle.
type appStoreConnectKeyPayload struct {
	Version    int    `json:"version"`
	PrivateKey string `json:"private_key"`
}

var AppStoreConnectAccessLevels = []store.ExternalAccessLevel{
	{Name: "read"},
	{Name: "commerce"},
}

// AppStoreConnectAccessLevel validates a workspace level; "" is read.
func AppStoreConnectAccessLevel(name string) (string, bool) {
	if name == "" {
		name = "read"
	}
	for _, level := range AppStoreConnectAccessLevels {
		if level.Name == name {
			return name, true
		}
	}
	return "", false
}

func (s *Service) appStoreConnectStore() (store.AppStoreConnectStore, error) {
	st, ok := any(s.store).(store.AppStoreConnectStore)
	if !ok {
		return nil, errors.New("this server store does not hold App Store Connect keys")
	}
	return st, nil
}

func normalizeAppStoreConnectKey(input store.SaveAppStoreConnectKeyInput) (store.SaveAppStoreConnectKeyInput, error) {
	input.IssuerID = strings.TrimSpace(input.IssuerID)
	input.KeyID = strings.TrimSpace(input.KeyID)
	input.PrivateKey = strings.TrimSpace(input.PrivateKey)
	input.Label = strings.TrimSpace(input.Label)
	if _, err := uuid.Parse(input.IssuerID); err != nil {
		return input, fmt.Errorf("%w: issuerId must be Apple's issuer UUID", ErrInvalidAppStoreConnectKey)
	}
	if !appStoreConnectKeyID.MatchString(input.KeyID) {
		return input, fmt.Errorf("%w: keyId must be Apple's 8-16 character key id", ErrInvalidAppStoreConnectKey)
	}
	if input.PrivateKey == "" || len(input.PrivateKey) > 16*1024 || !strings.Contains(input.PrivateKey, "PRIVATE KEY") {
		return input, fmt.Errorf("%w: privateKey must be Apple's downloaded .p8 private key", ErrInvalidAppStoreConnectKey)
	}
	if len(input.Label) > 160 {
		return input, fmt.Errorf("%w: label is too long", ErrInvalidAppStoreConnectKey)
	}
	if input.Label == "" {
		input.Label = "App Store Connect " + input.KeyID
	}
	return input, nil
}

func (s *Service) checkAppStoreConnectKey(ctx context.Context, input store.SaveAppStoreConnectKeyInput) error {
	if err := s.Integrations.Err(); err != nil {
		return err
	}
	provider, ok := s.registry.Lookup("appstoreconnect")
	if !ok {
		return errors.New("App Store Connect is not available")
	}
	checker, ok := provider.(KeyProvider)
	if !ok {
		return errors.New("App Store Connect cannot validate API keys")
	}
	return checker.CheckKey(ctx, input.IssuerID, input.KeyID, input.PrivateKey)
}

// CreateAppStoreConnectKey validates and seals one team key, then creates the
// external account a workspace binds apps through.
func (s *Service) CreateAppStoreConnectKey(ctx context.Context, ownerUserID string, input store.SaveAppStoreConnectKeyInput) (store.AppStoreConnectConnection, error) {
	if !s.SecretsConfigured() {
		return store.AppStoreConnectConnection{}, ErrSecretsNotConfigured
	}
	keyStore, err := s.appStoreConnectStore()
	if err != nil {
		return store.AppStoreConnectConnection{}, err
	}
	input, err = normalizeAppStoreConnectKey(input)
	if err != nil {
		return store.AppStoreConnectConnection{}, err
	}
	if err := s.checkAppStoreConnectKey(ctx, input); err != nil {
		return store.AppStoreConnectConnection{}, err
	}
	app, err := s.store.CreateExternalProviderApp(ctx, store.ExternalProviderApp{
		Provider: "appstoreconnect", OwnerUserID: ownerUserID, Visibility: store.ExternalAppPersonal,
		Label: input.Label, ClientID: input.KeyID, BaseURL: AppStoreConnectAPIBaseURL, CreatedVia: "api_key",
	})
	if err != nil {
		return store.AppStoreConnectConnection{}, err
	}
	cleanupApp := func(cause error) error {
		var rollbackErrors []error
		if err := keyStore.DeleteAppStoreConnectKey(ctx, app.ID); err != nil && !errors.Is(err, store.ErrNotFound) {
			rollbackErrors = append(rollbackErrors, err)
		}
		if err := s.secrets.DeleteSecret(ctx, AppStoreConnectKeySecretID(app.ID)); err != nil && !errors.Is(err, store.ErrNotFound) {
			rollbackErrors = append(rollbackErrors, err)
		}
		accounts, _ := s.store.ListExternalAccounts(ctx, ownerUserID)
		for _, account := range accounts {
			if account.AppID == app.ID {
				if err := s.store.DeleteExternalAccount(ctx, account.ID); err != nil {
					rollbackErrors = append(rollbackErrors, err)
				}
			}
		}
		if err := s.store.DeleteExternalProviderApp(ctx, app.ID); err != nil {
			rollbackErrors = append(rollbackErrors, err)
		}
		return errors.Join(append([]error{cause}, rollbackErrors...)...)
	}
	if err := s.sealAppStoreConnectKey(ctx, app.ID, input.PrivateKey); err != nil {
		return store.AppStoreConnectConnection{}, cleanupApp(fmt.Errorf("seal the App Store Connect key: %w", err))
	}
	record := store.AppStoreConnectKeyRecord{AppID: app.ID, IssuerID: input.IssuerID, KeyID: input.KeyID}
	if err := keyStore.SaveAppStoreConnectKey(ctx, record); err != nil {
		return store.AppStoreConnectConnection{}, cleanupApp(err)
	}
	account, err := s.store.SaveExternalAccount(ctx, store.ExternalAccount{
		AppID: app.ID, Provider: "appstoreconnect", OwnerUserID: ownerUserID, Label: input.Label,
		Mode: store.ExternalCredentialServerHeld, Status: store.ExternalAccountReady,
		Subject: input.IssuerID, DisplayName: input.Label, Tenant: input.IssuerID, KeepAlive: false,
	})
	if err != nil {
		return store.AppStoreConnectConnection{}, cleanupApp(err)
	}
	s.event(ctx, store.ExternalAccountEvent{AccountID: account.ID, Kind: "appstoreconnect_key_added", ActorID: ownerUserID, Detail: input.KeyID})
	return s.appStoreConnectConnection(ctx, app.ID), nil
}

func (s *Service) ReplaceAppStoreConnectKey(ctx context.Context, ownerUserID, appID string, input store.SaveAppStoreConnectKeyInput) (store.AppStoreConnectConnection, error) {
	if !s.SecretsConfigured() {
		return store.AppStoreConnectConnection{}, ErrSecretsNotConfigured
	}
	keyStore, err := s.appStoreConnectStore()
	if err != nil {
		return store.AppStoreConnectConnection{}, err
	}
	app, err := s.store.GetExternalProviderApp(ctx, appID)
	if err != nil || app.Provider != "appstoreconnect" || app.OwnerUserID != ownerUserID {
		return store.AppStoreConnectConnection{}, store.ErrExternalAppNotFound
	}
	input, err = normalizeAppStoreConnectKey(input)
	if err != nil {
		return store.AppStoreConnectConnection{}, err
	}
	if err := s.checkAppStoreConnectKey(ctx, input); err != nil {
		return store.AppStoreConnectConnection{}, err
	}
	var old []byte
	old, oldErr := s.secrets.GetSecret(ctx, AppStoreConnectKeySecretID(app.ID))
	if oldErr != nil && !errors.Is(oldErr, store.ErrNotFound) {
		return store.AppStoreConnectConnection{}, oldErr
	}
	if err := s.sealAppStoreConnectKey(ctx, app.ID, input.PrivateKey); err != nil {
		return store.AppStoreConnectConnection{}, err
	}
	app.Label, app.ClientID, app.HasSecret = input.Label, input.KeyID, true
	record := store.AppStoreConnectKeyRecord{AppID: app.ID, IssuerID: input.IssuerID, KeyID: input.KeyID}
	if _, err := keyStore.UpdateAppStoreConnectKey(ctx, app, record); err != nil {
		if oldErr == nil {
			_ = s.secrets.PutSecret(ctx, AppStoreConnectKeySecretID(app.ID), old, AppStoreConnectKeySecretID(app.ID))
		} else {
			_ = s.secrets.DeleteSecret(ctx, AppStoreConnectKeySecretID(app.ID))
		}
		return store.AppStoreConnectConnection{}, err
	}
	s.forgetAppStoreConnectToken(app.ID)
	accounts, _ := s.store.ListExternalAccounts(ctx, ownerUserID)
	for _, account := range accounts {
		if account.AppID != app.ID {
			continue
		}
		account.Status, account.StatusDetail = store.ExternalAccountReady, ""
		saved, saveErr := s.store.SaveExternalAccount(ctx, account)
		if saveErr != nil {
			return store.AppStoreConnectConnection{}, saveErr
		}
		s.event(ctx, store.ExternalAccountEvent{AccountID: saved.ID, Kind: "appstoreconnect_key_replaced", ActorID: ownerUserID, Detail: input.KeyID})
		s.changed(saved.ID)
	}
	return s.appStoreConnectConnection(ctx, app.ID), nil
}

func (s *Service) RevokeAppStoreConnectKey(ctx context.Context, ownerUserID, appID string, actorID string) (store.AppStoreConnectConnection, error) {
	keyStore, err := s.appStoreConnectStore()
	if err != nil {
		return store.AppStoreConnectConnection{}, err
	}
	app, err := s.store.GetExternalProviderApp(ctx, appID)
	if err != nil || app.Provider != "appstoreconnect" || app.OwnerUserID != ownerUserID {
		return store.AppStoreConnectConnection{}, store.ErrExternalAppNotFound
	}
	if err := keyStore.RevokeAppStoreConnectKey(ctx, app.ID, s.Now()); err != nil {
		return store.AppStoreConnectConnection{}, err
	}
	s.forgetAppStoreConnectToken(app.ID)
	accounts, _ := s.store.ListExternalAccounts(ctx, ownerUserID)
	for _, account := range accounts {
		if account.AppID != app.ID {
			continue
		}
		account.Status, account.StatusDetail = store.ExternalAccountRevoked, "api_key_revoked"
		saved, saveErr := s.store.SaveExternalAccount(ctx, account)
		if saveErr != nil {
			return store.AppStoreConnectConnection{}, saveErr
		}
		s.event(ctx, store.ExternalAccountEvent{AccountID: saved.ID, Kind: "appstoreconnect_key_revoked", ActorID: actorID, Detail: app.ClientID})
		s.changed(saved.ID)
	}
	if s.secrets != nil {
		if err := s.secrets.DeleteSecret(ctx, AppStoreConnectKeySecretID(app.ID)); err != nil && !errors.Is(err, store.ErrNotFound) {
			return store.AppStoreConnectConnection{}, err
		}
	}
	return s.appStoreConnectConnection(ctx, app.ID), nil
}

func (s *Service) ListAppStoreConnectKeys(ctx context.Context, ownerUserID string) ([]store.AppStoreConnectConnection, error) {
	keyStore, err := s.appStoreConnectStore()
	if err != nil {
		return nil, err
	}
	keys, err := keyStore.ListAppStoreConnectKeys(ctx, ownerUserID)
	if err != nil {
		return nil, err
	}
	connections := make([]store.AppStoreConnectConnection, 0, len(keys))
	for _, key := range keys {
		connections = append(connections, s.appStoreConnectConnection(ctx, key.AppID))
	}
	return connections, nil
}

func (s *Service) appStoreConnectConnection(ctx context.Context, appID string) store.AppStoreConnectConnection {
	app, _ := s.store.GetExternalProviderApp(ctx, appID)
	connection := store.AppStoreConnectConnection{
		AppID: app.ID, Label: app.Label, KeyID: app.ClientID, CreatedAt: app.CreatedAt, UpdatedAt: app.UpdatedAt,
	}
	if keyStore, err := s.appStoreConnectStore(); err == nil {
		if key, err := keyStore.GetAppStoreConnectKey(ctx, appID); err == nil {
			connection.IssuerID, connection.KeyID = key.IssuerID, key.KeyID
			if key.RevokedAt != "" {
				connection.Status = string(store.ExternalAccountRevoked)
			}
		}
	}
	accounts, _ := s.store.ListExternalAccounts(ctx, app.OwnerUserID)
	for _, account := range accounts {
		if account.AppID == appID {
			connection.AccountID, connection.Status = account.ID, string(account.Status)
			if connection.Label == "" {
				connection.Label = account.Label
			}
		}
	}
	connection.HasKey = s.hasSecret(ctx, AppStoreConnectKeySecretID(appID))
	return connection
}

func (s *Service) sealAppStoreConnectKey(ctx context.Context, appID, privateKey string) error {
	payload, err := json.Marshal(appStoreConnectKeyPayload{Version: appStoreConnectKeyPayloadVersion, PrivateKey: privateKey})
	if err != nil {
		return err
	}
	return s.secrets.PutSecret(ctx, AppStoreConnectKeySecretID(appID), payload, AppStoreConnectKeySecretID(appID))
}

// AppStoreConnectCredentials unseals one key for an upstream request.
func (s *Service) AppStoreConnectCredentials(ctx context.Context, app store.ExternalProviderApp) (AppStoreConnectCredentials, error) {
	if app.Provider != "appstoreconnect" {
		return AppStoreConnectCredentials{}, errors.New("not an App Store Connect app")
	}
	keyStore, err := s.appStoreConnectStore()
	if err != nil {
		return AppStoreConnectCredentials{}, err
	}
	key, err := keyStore.GetAppStoreConnectKey(ctx, app.ID)
	if err != nil {
		return AppStoreConnectCredentials{}, err
	}
	if key.RevokedAt != "" {
		return AppStoreConnectCredentials{}, ErrAppStoreConnectKeyRevoked
	}
	payload, err := s.secrets.GetSecret(ctx, AppStoreConnectKeySecretID(app.ID))
	if err != nil {
		return AppStoreConnectCredentials{}, err
	}
	var stored appStoreConnectKeyPayload
	if err := json.Unmarshal(payload, &stored); err != nil || stored.Version != appStoreConnectKeyPayloadVersion || stored.PrivateKey == "" {
		return AppStoreConnectCredentials{}, errors.New("the sealed App Store Connect key is unreadable")
	}
	return AppStoreConnectCredentials{AppID: app.ID, IssuerID: key.IssuerID, KeyID: key.KeyID, PrivateKey: stored.PrivateKey}, nil
}

// DoAppStoreConnect makes one request with a cached team JWT. Audit lines stay
// with the gateway; lookup requests made by Classify do not add account events.
func (s *Service) DoAppStoreConnect(ctx context.Context, app store.ExternalProviderApp, method, path string, query url.Values, headers http.Header, body io.Reader) (*http.Response, error) {
	if err := s.Integrations.Err(); err != nil {
		return nil, err
	}
	credentials, err := s.AppStoreConnectCredentials(ctx, app)
	if err != nil {
		return nil, err
	}
	provider, ok := s.registry.Lookup("appstoreconnect")
	if !ok {
		return nil, errors.New("App Store Connect is not available")
	}
	client, ok := provider.(*AppStoreConnect)
	if !ok {
		return nil, errors.New("the App Store Connect adapter is unavailable")
	}
	return client.Do(ctx, credentials, method, path, query, headers, body)
}

func (s *Service) forgetAppStoreConnectToken(appID string) {
	provider, ok := s.registry.Lookup("appstoreconnect")
	if !ok {
		return
	}
	if client, ok := provider.(*AppStoreConnect); ok {
		client.ForgetApp(appID)
	}
}

// ListAppStoreApps reads the apps this team key can manage.
func (s *Service) ListAppStoreApps(ctx context.Context, app store.ExternalProviderApp) ([]store.AppStoreConnectApp, error) {
	response, err := s.DoAppStoreConnect(ctx, app, http.MethodGet, "/v1/apps", url.Values{"limit": {"200"}}, nil, nil)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, fmt.Errorf("App Store Connect apps read answered HTTP %d", response.StatusCode)
	}
	payload, err := io.ReadAll(io.LimitReader(response.Body, 4<<20))
	if err != nil {
		return nil, err
	}
	var document struct {
		Data []struct {
			ID         string `json:"id"`
			Attributes struct {
				Name     string `json:"name"`
				BundleID string `json:"bundleId"`
				SKU      string `json:"sku"`
			} `json:"attributes"`
		} `json:"data"`
	}
	if err := json.Unmarshal(payload, &document); err != nil {
		return nil, errors.New("App Store Connect returned an unreadable app list")
	}
	apps := make([]store.AppStoreConnectApp, 0, len(document.Data))
	for _, item := range document.Data {
		apps = append(apps, store.AppStoreConnectApp{ID: item.ID, Name: item.Attributes.Name, BundleID: item.Attributes.BundleID, Sku: item.Attributes.SKU})
	}
	return apps, nil
}
