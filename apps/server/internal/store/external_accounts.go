package store

import (
	"context"
	"errors"
)

// External accounts: a person's logins at third-party platforms (first:
// Feishu, used by feishu-cli) that sessions may act with.
//
// The model has four objects. A provider is code (an adapter). A provider
// app is the OAuth client registration at the provider; an account is one
// person's identity at the provider, obtained through one app; a binding
// lets a workspace use an account. The credential itself never sits in
// these records: a server-held grant is sealed in the secret store under
// "external-account:<accountID>", and a device-local account holds no
// server credential at all.

// ExternalCredentialMode says who holds an account's credential.
type ExternalCredentialMode string

const (
	// ExternalCredentialServerHeld: the server holds the grant, refreshes
	// it, and hands sessions short-lived access tokens.
	ExternalCredentialServerHeld ExternalCredentialMode = "server_held"
	// ExternalCredentialDeviceLocal: the provider's CLI on each device owns
	// the login; the server keeps only the account and per-device state.
	ExternalCredentialDeviceLocal ExternalCredentialMode = "device_local"
)

// ExternalAccountStatus is where an account's grant stands.
type ExternalAccountStatus string

const (
	ExternalAccountReady       ExternalAccountStatus = "ready"
	ExternalAccountExpiring    ExternalAccountStatus = "expiring"
	ExternalAccountNeedsReauth ExternalAccountStatus = "needs_reauth"
	ExternalAccountRevoked     ExternalAccountStatus = "revoked"
)

// ExternalAppVisibility says who may connect accounts through a provider app.
type ExternalAppVisibility string

const (
	// ExternalAppPersonal: only the app's owner.
	ExternalAppPersonal ExternalAppVisibility = "personal"
	// ExternalAppInstance: every account on this server (an admin-configured
	// organisation app).
	ExternalAppInstance ExternalAppVisibility = "instance"
)

var (
	ErrExternalAppNotFound     = errors.New("external provider app not found")
	ErrExternalAccountNotFound = errors.New("external account not found")
)

// ExternalProvider describes a provider adapter to clients.
type ExternalProvider struct {
	Kind  string `json:"kind"`
	Label string `json:"label"`
	// CredentialMode is how accounts of this provider are held.
	CredentialMode ExternalCredentialMode `json:"credentialMode"`
	// AuthMethods are the ways an account can be connected
	// ("oauth_device", "device_login", "api_key").
	AuthMethods []string `json:"authMethods"`
	// Tools are the programs sessions use the account through (feishu-cli).
	Tools []string `json:"tools"`
	// DefaultBaseURL is the provider's default API base.
	DefaultBaseURL string `json:"defaultBaseUrl,omitempty"`
	// AlwaysScopes are added to every login request (offline_access…).
	AlwaysScopes []string `json:"alwaysScopes,omitempty"`
	// ScopePreset is what a login asks for when it names no scopes.
	ScopePreset *ExternalScopePreset `json:"scopePreset,omitempty"`
	// RegistersApps: the provider can create an app for the person during
	// sign-in (POST /api/external-accounts/setup), so no app ID or secret
	// has to be pasted.
	RegistersApps bool `json:"registersApps,omitempty"`
}

// ExternalScopePreset is a provider's default scope list and its source.
type ExternalScopePreset struct {
	Name   string   `json:"name"`
	Source string   `json:"source"`
	Scopes []string `json:"scopes"`
	// ApprovalScopes are asked for only on request: a tenant administrator
	// may have to approve them.
	ApprovalScopes []string `json:"approvalScopes,omitempty"`
}

// ExternalProviderApp is an OAuth client registration at a provider. The
// client secret is sealed under "external-app:<id>" and never returned.
type ExternalProviderApp struct {
	ID          string                `json:"id"`
	Provider    string                `json:"provider"`
	OwnerUserID string                `json:"ownerUserId"`
	Visibility  ExternalAppVisibility `json:"visibility"`
	Label       string                `json:"label"`
	ClientID    string                `json:"clientId"`
	BaseURL     string                `json:"baseUrl,omitempty"`
	HasSecret   bool                  `json:"hasSecret"`
	// CreatedVia is how the registration got here: "pasted" today.
	CreatedVia string `json:"createdVia"`
	// RotateSecret: devices held this app's secret before sessions reached
	// the provider through the server's gateway; rotate it at the provider
	// and replace it here. Cleared when the secret is replaced.
	RotateSecret bool `json:"rotateSecret,omitempty"`
	// AppName and TenantName are the app's own name and its organisation's
	// at the provider, read with the app's token (ExternalAppNames); empty
	// until read or when the provider refuses.
	AppName    string `json:"appName,omitempty"`
	TenantName string `json:"tenantName,omitempty"`
	// OrgDomain is the domain of a connected person's enterprise email
	// ("example.com"), read with their own token: the organisation's label
	// when TenantName needs an app permission the app lacks.
	OrgDomain string `json:"orgDomain,omitempty"`
	// NamesCheckedAt is when the names were last asked for; NamesDetail
	// says why one could not be read (an error class and code, never a token).
	NamesCheckedAt string `json:"namesCheckedAt,omitempty"`
	NamesDetail    string `json:"namesDetail,omitempty"`
	// AccountNames are the names of the reader's own accounts connected
	// through the app, filled when listed for that reader (not stored).
	AccountNames []string `json:"accountNames,omitempty"`
	CreatedAt    string   `json:"createdAt"`
	UpdatedAt    string   `json:"updatedAt"`
}

// ExternalAppNames is what the provider says an app and its organisation
// are called, as of CheckedAt.
type ExternalAppNames struct {
	AppName    string
	TenantName string
	OrgDomain  string
	CheckedAt  string
	Detail     string
}

// SaveExternalProviderAppInput creates a provider app. ClientSecret is
// write-only: sealed on arrival, never read back.
type SaveExternalProviderAppInput struct {
	Provider     string                `json:"provider"`
	Label        string                `json:"label"`
	ClientID     string                `json:"clientId"`
	ClientSecret string                `json:"clientSecret"`
	BaseURL      string                `json:"baseUrl,omitempty"`
	Visibility   ExternalAppVisibility `json:"visibility,omitempty"`
}

// ExternalAccount is one person's identity at a provider.
type ExternalAccount struct {
	ID          string                 `json:"id"`
	Provider    string                 `json:"provider"`
	AppID       string                 `json:"appId"`
	OwnerUserID string                 `json:"ownerUserId"`
	Label       string                 `json:"label"`
	Mode        ExternalCredentialMode `json:"mode"`
	Status      ExternalAccountStatus  `json:"status"`
	// StatusDetail says why the account needs attention (a refresh error
	// class, never a token).
	StatusDetail string `json:"statusDetail,omitempty"`
	// Subject is the provider's stable id of the person (Feishu open_id).
	Subject     string `json:"subject,omitempty"`
	DisplayName string `json:"displayName,omitempty"`
	Tenant      string `json:"tenant,omitempty"`
	// AppName and TenantName are the names of the account's app and its
	// organisation, copied from the app when the account is read (not stored).
	AppName    string `json:"appName,omitempty"`
	TenantName string `json:"tenantName,omitempty"`
	OrgDomain  string `json:"orgDomain,omitempty"`
	// GrantedScopes are what the provider granted at the last login.
	GrantedScopes []string `json:"grantedScopes,omitempty"`
	// KeepAlive: the server refreshes the grant before its refresh token
	// expires so an idle account does not die; visible and per account.
	KeepAlive        bool   `json:"keepAlive"`
	AuthTime         string `json:"authTime,omitempty"`
	AuthExpiresAt    string `json:"authExpiresAt,omitempty"`
	AccessExpiresAt  string `json:"accessExpiresAt,omitempty"`
	RefreshExpiresAt string `json:"refreshExpiresAt,omitempty"`
	LastRefreshedAt  string `json:"lastRefreshedAt,omitempty"`
	// LastRefreshBy says what refreshed last: "login", "session", "keep_alive", "manual".
	LastRefreshBy string `json:"lastRefreshBy,omitempty"`
	LastUsedAt    string `json:"lastUsedAt,omitempty"`
	// WorkspaceIDs are the workspaces the account is bound to.
	WorkspaceIDs []string `json:"workspaceIds,omitempty"`
	CreatedAt    string   `json:"createdAt"`
	UpdatedAt    string   `json:"updatedAt"`
}

// ExternalAccountBinding lets a workspace use an account. In the MVP only
// sessions the account owner started, on devices the owner owns, get it.
type ExternalAccountBinding struct {
	// ResourceIDs restrict a binding to explicitly selected provider resources.
	ResourceIDs []string `json:"resourceIds,omitempty"`
	WorkspaceID string   `json:"workspaceId"`
	AccountID   string   `json:"accountId"`
	GrantedBy   string   `json:"grantedBy"`
	CreatedAt   string   `json:"createdAt"`
}

// ExternalAccountEvent is one line of an account's audit trail. It never
// holds a token.
type ExternalAccountEvent struct {
	ID        int64  `json:"id"`
	AccountID string `json:"accountId"`
	// Kind: connected, refreshed, needs_reauth, revoked, disconnected,
	// bound, unbound, token_issued, keep_alive_changed.
	Kind      string `json:"kind"`
	Detail    string `json:"detail,omitempty"`
	SessionID string `json:"sessionId,omitempty"`
	DeviceID  string `json:"deviceId,omitempty"`
	ActorID   string `json:"actorId,omitempty"`
	CreatedAt string `json:"createdAt"`
}

// ExternalAccountUpdate changes what a person may change about an account.
type ExternalAccountUpdate struct {
	Label     *string `json:"label,omitempty"`
	KeepAlive *bool   `json:"keepAlive,omitempty"`
}

// ConnectExternalAccountInput starts a login through a provider app.
type ConnectExternalAccountInput struct {
	AppID string `json:"appId"`
	// AccountID re-authorizes that account in place: same id, bindings and
	// settings, a new grant. The sign-in must be the same provider user.
	AccountID string `json:"accountId,omitempty"`
	Label     string `json:"label,omitempty"`
	// Scopes, when given, replace the provider's preset.
	Scopes []string `json:"scopes,omitempty"`
	// IncludeApprovalScopes adds the preset's approval scopes.
	IncludeApprovalScopes bool `json:"includeApprovalScopes,omitempty"`
}

// SetupExternalAccountInput starts a sign-in that first creates an app for
// the person at the provider, then authorizes it.
type SetupExternalAccountInput struct {
	Provider string `json:"provider"`
	// Brand picks the provider's region where it has several ("feishu",
	// "lark"); empty is the provider's default.
	Brand string `json:"brand,omitempty"`
	Label string `json:"label,omitempty"`
	// Scopes, when given, replace the provider's preset.
	Scopes                []string `json:"scopes,omitempty"`
	IncludeApprovalScopes bool     `json:"includeApprovalScopes,omitempty"`
}

// ExternalAccountLogin is a device-flow login in progress: what the person
// opens and types, then its outcome. It never carries a token.
type ExternalAccountLogin struct {
	ID       string `json:"id"`
	Provider string `json:"provider"`
	AppID    string `json:"appId"`
	// Status: pending, complete, failed.
	Status string `json:"status"`
	// Phase of a pending setup: "register" (the person confirms the new
	// app) then "authorize" (the person authorizes it). Empty for a plain
	// login, which only authorizes.
	Phase                   string   `json:"phase,omitempty"`
	VerificationURI         string   `json:"verificationUri,omitempty"`
	VerificationURIComplete string   `json:"verificationUriComplete,omitempty"`
	UserCode                string   `json:"userCode,omitempty"`
	ExpiresAt               string   `json:"expiresAt,omitempty"`
	IntervalSeconds         int      `json:"intervalSeconds,omitempty"`
	RequestedScopes         []string `json:"requestedScopes,omitempty"`
	Error                   string   `json:"error,omitempty"`
	// App is the app a setup created, once it exists.
	App *ExternalProviderApp `json:"app,omitempty"`
	// Account is the connected account once Status is complete.
	Account *ExternalAccount `json:"account,omitempty"`
	// MissingScopes: asked for but not granted, once Status is complete.
	MissingScopes []string `json:"missingScopes,omitempty"`
	// ScopeApplyURL opens the provider's page to enable MissingScopes on
	// the app.
	ScopeApplyURL string `json:"scopeApplyUrl,omitempty"`
}

// ExternalAccountToken is a short-lived access token minted for one session
// process. The refresh token never leaves the server.
type ExternalAccountToken struct {
	AccountID   string `json:"accountId"`
	AccessToken string `json:"accessToken"`
	TokenType   string `json:"tokenType"`
	ExpiresAt   string `json:"expiresAt"`
	Scope       string `json:"scope,omitempty"`
}

// ExternalAccountMaterial is what a worker needs to let one tool act as an
// account for one session: the identity, the tool's profile and the
// gateway handles that stand in for the app secret and the access token.
// No secret and no real token ever rides it: the tool reaches the provider
// through the server's gateway (internal/feishugateway), which swaps the
// handles for the real credentials. It rides run_session and is written
// into a tool profile the worker removes when the session ends.
type ExternalAccountMaterial struct {
	AccountID string `json:"accountId"`
	Provider  string `json:"provider"`
	Label     string `json:"label"`
	// Tool is the program the material is for (feishu-cli); ProfileName the
	// profile the worker writes and selects for the session.
	Tool        string `json:"tool"`
	ProfileName string `json:"profileName"`
	ClientID    string `json:"clientId"`
	// Gateway is how the tool reaches the provider through Foundry.
	Gateway *ExternalAccountGateway `json:"gateway,omitempty"`
	// ExpiresAt bounds the handles for the tool's own expiry checks; the
	// server stops honouring them as soon as the session ends.
	ExpiresAt   string `json:"expiresAt"`
	Scope       string `json:"scope,omitempty"`
	Subject     string `json:"subject,omitempty"`
	DisplayName string `json:"displayName,omitempty"`
}

// ExternalAccountGateway is a session's way through the server's gateway
// for one account: the server path the device's loopback forwarder sends
// the tool's requests under, and the opaque handles the tool holds in place
// of the app secret, the user access token and the user refresh token. A handle is useless without
// the device's credential and dies with the session.
type ExternalAccountGateway struct {
	ExpiresAt     string `json:"expiresAt,omitempty"`
	Path          string `json:"path"`
	AppHandle     string `json:"appHandle"`
	UserHandle    string `json:"userHandle"`
	RefreshHandle string `json:"refreshHandle,omitempty"`
}

// WorkspaceExternalAccounts is a workspace's accounts tab: the bindings
// with the accounts the caller may see.
type WorkspaceExternalAccounts struct {
	WorkspaceID string                   `json:"workspaceId"`
	Bindings    []ExternalAccountBinding `json:"bindings"`
	// Accounts are the bound accounts, plus the caller's own unbound ones
	// so they can be bound.
	Accounts []ExternalAccount `json:"accounts"`
}

// SetWorkspaceExternalAccountsInput replaces the caller's bindings.
type SetWorkspaceExternalAccountsInput struct {
	Resources  map[string][]string `json:"resources,omitempty"`
	AccountIDs []string            `json:"accountIds"`
}

// ExternalAccountsView is the External accounts page.
type ExternalAccountsView struct {
	Providers []ExternalProvider    `json:"providers"`
	Apps      []ExternalProviderApp `json:"apps"`
	Accounts  []ExternalAccount     `json:"accounts"`
	// SecretsConfigured is false when the server has no secret store key:
	// nothing can be connected until it has one.
	SecretsConfigured bool `json:"secretsConfigured"`
}

// ExternalAccountDetail is one account with its recent audit lines.
type ExternalAccountDetail struct {
	Account ExternalAccount        `json:"account"`
	Events  []ExternalAccountEvent `json:"events"`
}

// ExternalAccountStore keeps provider apps, accounts, their bindings and
// audit lines. Credentials live in the secret store, not here.
type ExternalAccountStore interface {
	CreateExternalProviderApp(ctx context.Context, app ExternalProviderApp) (ExternalProviderApp, error)
	GetExternalProviderApp(ctx context.Context, id string) (ExternalProviderApp, error)
	// ListExternalProviderApps lists the apps userID may connect through:
	// their own and every instance-wide one.
	ListExternalProviderApps(ctx context.Context, userID string) ([]ExternalProviderApp, error)
	DeleteExternalProviderApp(ctx context.Context, id string) error
	// SetExternalProviderAppNames records what the provider calls the app
	// and its organisation.
	SetExternalProviderAppNames(ctx context.Context, id string, names ExternalAppNames) error

	SaveExternalAccount(ctx context.Context, account ExternalAccount) (ExternalAccount, error)
	GetExternalAccount(ctx context.Context, id string) (ExternalAccount, error)
	// ListExternalAccounts lists the accounts userID owns; "" lists every
	// account (the refresh scheduler).
	ListExternalAccounts(ctx context.Context, userID string) ([]ExternalAccount, error)
	DeleteExternalAccount(ctx context.Context, id string) error

	// SetWorkspaceExternalAccounts replaces the workspace's bindings for the
	// accounts userID owns; other owners' bindings stay.
	SetWorkspaceExternalAccounts(ctx context.Context, workspaceID, userID string, accountIDs []string, resources ...map[string][]string) error
	ListWorkspaceExternalAccounts(ctx context.Context, workspaceID string) ([]ExternalAccountBinding, error)

	AppendExternalAccountEvent(ctx context.Context, event ExternalAccountEvent) error
	ListExternalAccountEvents(ctx context.Context, accountID string, limit int) ([]ExternalAccountEvent, error)
}
