// Package externalaccounts lets sessions act with a person's logins at
// third-party platforms (first: Feishu, through feishu-cli).
//
// A Provider is an adapter for one platform. A server-held provider runs
// the platform's login itself (OAuth device flow), keeps the grant sealed in
// the secret store, is the only party that refreshes it (Feishu refresh
// tokens are single-use and rotate), and hands sessions short-lived access
// tokens. A device-local provider would leave the login to the platform's
// CLI on each device; the model names that mode, but no such provider is
// implemented yet.
package externalaccounts

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// AppCredentials is a provider app's OAuth client registration, unsealed
// for one call. It is never persisted outside the secret store.
type AppCredentials struct {
	ClientID     string
	ClientSecret string
	BaseURL      string
}

// DeviceLogin is step one of a device authorization grant: what the person
// opens and types, and how to poll for the result.
type DeviceLogin struct {
	DeviceCode              string
	UserCode                string
	VerificationURI         string
	VerificationURIComplete string
	ExpiresAt               time.Time
	Interval                time.Duration
	// RequestedScopes is what was asked for, including the scopes the
	// provider always adds (offline_access).
	RequestedScopes []string
}

// PollOutcome is the result of one poll of the token endpoint.
type PollOutcome int

const (
	// PollPending: the person has not approved yet.
	PollPending PollOutcome = iota
	// PollSlowDown: pending, and the provider asked for a longer interval.
	PollSlowDown
	// PollDone: Grant holds the tokens.
	PollDone
)

// Identity is who the account is at the provider.
type Identity struct {
	Subject     string
	DisplayName string
	Tenant      string
}

// RefreshError classifies a failed refresh the way feishu-cli does: a
// terminal failure means the grant is dead (re-authorize); a retryable one
// was a transient fault; an uncertain one was sent but got no readable
// answer, so the refresh token may already have been spent.
type RefreshError struct {
	Code        int
	OAuthError  string
	Description string
	HTTPStatus  int
	Terminal    bool
	Retryable   bool
	Uncertain   bool
	Cause       error
}

func (e *RefreshError) Error() string {
	detail := e.Description
	if detail == "" && e.Cause != nil {
		detail = e.Cause.Error()
	}
	switch {
	case e.Code != 0:
		return fmt.Sprintf("refresh failed (code %d): %s", e.Code, detail)
	case e.OAuthError != "":
		return fmt.Sprintf("refresh failed (%s): %s", e.OAuthError, detail)
	case e.HTTPStatus != 0:
		return fmt.Sprintf("refresh failed (HTTP %d): %s", e.HTTPStatus, detail)
	}
	return "refresh failed: " + detail
}

func (e *RefreshError) Unwrap() error { return e.Cause }

// Class is the short, token-free name shown as an account's status detail.
func (e *RefreshError) Class() string {
	switch {
	case e.Code == 20073:
		return "refresh_token_reused"
	case e.Code == 20037:
		return "refresh_token_expired"
	case e.Code == 20064:
		return "refresh_token_revoked"
	case e.Code == 20026:
		return "refresh_token_invalid"
	case e.OAuthError == "invalid_grant":
		return "invalid_grant"
	case e.Uncertain:
		return "refresh_uncertain"
	case e.Retryable:
		return "refresh_transient"
	}
	return "refresh_failed"
}

// ErrLoginDenied: the person refused the authorization.
var ErrLoginDenied = errors.New("the person denied the authorization")

// ErrLoginExpired: the device code expired before the person approved.
var ErrLoginExpired = errors.New("the authorization request expired")

// ErrMissingRefreshToken: the provider issued no refresh token, so the
// login would die within hours; the app must allow offline_access.
var ErrMissingRefreshToken = errors.New("the provider issued no refresh token: enable offline_access for the app and connect again")

// Provider is one platform adapter.
type Provider interface {
	Describe() store.ExternalProvider
}

// ServerHeldProvider runs the platform's login and refresh on the server.
type ServerHeldProvider interface {
	Provider
	BeginDeviceLogin(ctx context.Context, app AppCredentials, scopes []string) (DeviceLogin, error)
	// PollDeviceLogin asks once whether the person approved.
	PollDeviceLogin(ctx context.Context, app AppCredentials, login DeviceLogin) (Grant, PollOutcome, error)
	// Refresh spends grant's refresh token for a new access token (and, for
	// rotating providers, a new refresh token). Failures are *RefreshError.
	Refresh(ctx context.Context, app AppCredentials, grant Grant) (Grant, error)
	// Revoke invalidates the grant at the provider, refresh token first.
	Revoke(ctx context.Context, app AppCredentials, grant Grant) error
	Identity(ctx context.Context, app AppCredentials, accessToken string) (Identity, error)
	// PresetScopes is what a login asks for when it names no scopes.
	PresetScopes(includeApproval bool) []string
	// ScopeApplyURL is the provider page where the app's owner enables
	// scopes the app lacks; empty when there is none.
	ScopeApplyURL(app AppCredentials, scopes []string) string
}

// TenantTokenIssuer is a provider whose apps also act as themselves (a
// Feishu app's bot): it exchanges the app's credentials for an app token.
type TenantTokenIssuer interface {
	TenantAccessToken(ctx context.Context, app AppCredentials) (token string, expiresIn time.Duration, err error)
}

// SecretChecker is a provider that can tell whether an app secret is
// valid before it replaces the sealed one.
type SecretChecker interface {
	CheckAppSecret(ctx context.Context, app AppCredentials) error
}

// AppRegistration is step one of creating an app for the person: the page
// they open to confirm it, and how to poll for the result.
type AppRegistration struct {
	DeviceCode      string
	UserCode        string
	VerificationURL string
	ExpiresAt       time.Time
	Interval        time.Duration
	// Brand is the region the registration is polled on; a poll may move
	// it when the person's tenant turns out to be elsewhere.
	Brand      string
	brandMoved bool
}

// RegisteredApp is the app the provider created for the person.
type RegisteredApp struct {
	ClientID     string
	ClientSecret string
	// BaseURL is the app's open-API base; empty is the provider default.
	BaseURL string
}

// ErrRegistrationDenied: the person declined to create the app.
var ErrRegistrationDenied = errors.New("the person declined to create the app")

// AppRegistrar is a server-held provider that can create an app for the
// person during sign-in, so nobody pastes an app ID and secret.
type AppRegistrar interface {
	ServerHeldProvider
	BeginAppRegistration(ctx context.Context, brand string) (AppRegistration, error)
	// PollAppRegistration asks once whether the person confirmed; the
	// returned registration replaces the one passed (its brand may move).
	PollAppRegistration(ctx context.Context, registration AppRegistration) (RegisteredApp, AppRegistration, PollOutcome, error)
}

// Registry holds the providers by kind.
type Registry struct {
	providers map[string]Provider
}

// NewRegistry registers providers; the default registry holds Feishu.
func NewRegistry(providers ...Provider) *Registry {
	registry := &Registry{providers: map[string]Provider{}}
	for _, provider := range providers {
		registry.providers[provider.Describe().Kind] = provider
	}
	return registry
}

// Lookup finds a provider by kind.
func (r *Registry) Lookup(kind string) (Provider, bool) {
	provider, ok := r.providers[kind]
	return provider, ok
}

// Describe lists every provider, sorted by kind.
func (r *Registry) Describe() []store.ExternalProvider {
	described := make([]store.ExternalProvider, 0, len(r.providers))
	for _, provider := range r.providers {
		described = append(described, provider.Describe())
	}
	sort.Slice(described, func(i, j int) bool { return described[i].Kind < described[j].Kind })
	return described
}
