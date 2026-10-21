package externalaccounts

import (
	"context"
	"errors"
	"fmt"
	"log"
	"sync"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/integrations"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
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

	authorizationEpochs sync.Map
	loginsMu            sync.Mutex
	logins              map[string]*pendingLogin
	locksMu             sync.Mutex
	locks               map[string]*sync.Mutex
}

// NewService builds a service over the store, the secret keeper (nil when
// the server has none) and the providers.
func NewService(st store.ExternalAccountStore, secrets SecretKeeper, registry *Registry) *Service {
	if registry == nil {
		registry = NewRegistry(&Feishu{}, NewCloudflare())
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

func (s *Service) event(ctx context.Context, event store.ExternalAccountEvent) {
	if err := s.store.AppendExternalAccountEvent(ctx, event); err != nil {
		s.Logf("external account %s: record %s: %v", event.AccountID, event.Kind, err)
	}
}
