package feishuevents

import (
	"context"
	"errors"
	"fmt"

	"github.com/foundry-dev/foundry/apps/server/internal/externalaccounts"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// ConnectedApp is a Feishu app a person connected an account through in
// Connectors.
type ConnectedApp struct {
	// AppID is Feishu's id of the app (cli_…).
	AppID string
	// ConnectorAppID is the Connectors record (xapp_…).
	ConnectorAppID string
	Label          string
}

func (a ConnectedApp) String() string {
	if a.Label == "" {
		return a.AppID
	}
	return fmt.Sprintf("%s (%s)", a.AppID, a.Label)
}

// Access says which Feishu apps a person may receive events of: the ones
// they connected in Connectors.
type Access interface {
	ConnectedApps(ctx context.Context, userID string) ([]ConnectedApp, error)
}

// appStore is what ServerApps reads: Connectors apps and accounts.
type appStore interface {
	store.ExternalAccountStore
	FeishuProviderAppsByClientID(ctx context.Context, clientID string) ([]store.ExternalProviderApp, error)
}

// SecretReader unseals a secret record.
type SecretReader interface {
	GetSecret(ctx context.Context, id string) ([]byte, error)
}

// ServerApps is the one accessor for where the server holds a Feishu app's
// secret: the Connectors apps registered for it (external_provider_apps,
// sealed under externalaccounts.AppSecretID). Workspace Bots run on
// Connectors apps too.
type ServerApps struct {
	Store   appStore
	Secrets SecretReader
}

var _ CredentialSource = ServerApps{}
var _ Access = ServerApps{}

const feishuProvider = "feishu"

// ConnectedApps lists the Feishu apps userID has a live (not revoked)
// account through, once per Feishu app.
func (a ServerApps) ConnectedApps(ctx context.Context, userID string) ([]ConnectedApp, error) {
	if userID == "" {
		return nil, nil
	}
	accounts, err := a.Store.ListExternalAccounts(ctx, userID)
	if err != nil {
		return nil, err
	}
	apps := []ConnectedApp{}
	seen := map[string]bool{}
	for _, account := range accounts {
		if account.Provider != feishuProvider || account.Status == store.ExternalAccountRevoked || seen[account.AppID] {
			continue
		}
		seen[account.AppID] = true
		app, err := a.Store.GetExternalProviderApp(ctx, account.AppID)
		if err != nil || seen[app.ClientID] {
			continue
		}
		seen[app.ClientID] = true
		apps = append(apps, ConnectedApp{AppID: app.ClientID, ConnectorAppID: app.ID, Label: app.Label})
	}
	return apps, nil
}

// AppCredentials finds appID's secret: the newest Connectors app of that
// Feishu app id that holds one.
func (a ServerApps) AppCredentials(ctx context.Context, appID string) (Credentials, error) {
	if a.Secrets == nil {
		return Credentials{}, errors.New("the server holds no secrets (no secret store key)")
	}
	apps, err := a.Store.FeishuProviderAppsByClientID(ctx, appID)
	if err != nil {
		return Credentials{}, err
	}
	for _, app := range apps {
		if secret, err := a.Secrets.GetSecret(ctx, externalaccounts.AppSecretID(app.ID)); err == nil && len(secret) > 0 {
			return Credentials{AppID: appID, AppSecret: string(secret), BaseURL: app.BaseURL}, nil
		}
	}
	return Credentials{}, fmt.Errorf("the server holds no secret for Feishu app %s: paste it in Connectors", appID)
}
