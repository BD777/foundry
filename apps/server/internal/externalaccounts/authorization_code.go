package externalaccounts

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"github.com/google/uuid"
)

var ErrAuthorizationInProgress = errors.New("another authorization is already pending; finish or close it before connecting a different identity")

type pendingCodeFlow struct {
	requestID, verifier, redirectURI, issuer string
	targetAccountID                          string
	consumed                                 bool
	epoch                                    uint64
	grant                                    *Grant
	verifying                                bool
	retryAt                                  time.Time
}

// BeginAuthorizationCode returns an idempotent receipt before contacting the
// provider. Redirect URLs and PKCE material never come from browser input.
func (s *Service) BeginAuthorizationCode(ctx context.Context, owner, kind, requestID, redirectURI string, accountID ...string) (store.ExternalAccountLogin, error) {
	if !s.SecretsConfigured() {
		return store.ExternalAccountLogin{}, ErrSecretsNotConfigured
	}
	if err := s.Integrations.Err(); err != nil {
		return store.ExternalAccountLogin{}, err
	}
	if requestID == "" || len(requestID) > 100 {
		return store.ExternalAccountLogin{}, errors.New("request ID is required")
	}
	held, err := s.serverHeld(kind)
	if err != nil {
		return store.ExternalAccountLogin{}, err
	}
	provider, ok := held.(AuthorizationCodeProvider)
	if !ok {
		return store.ExternalAccountLogin{}, errors.New("browser authorization is unsupported")
	}
	var replace *store.ExternalAccount
	if len(accountID) > 0 && accountID[0] != "" {
		account, err := s.store.GetExternalAccount(ctx, accountID[0])
		if err != nil || account.OwnerUserID != owner || account.Provider != kind {
			return store.ExternalAccountLogin{}, store.ErrExternalAccountNotFound
		}
		if account.StatusDetail == "provider_revoke_pending" {
			return store.ExternalAccountLogin{}, fmt.Errorf("%w: retry the pending disconnect first", ErrAccountUnusable)
		}
		replace = &account
	}
	s.loginsMu.Lock()
	s.pruneLoginsLocked()
	target := ""
	if replace != nil {
		target = replace.ID
	}
	for _, p := range s.logins {
		p.mu.Lock()
		same := p.owner == owner && p.app.Provider == kind && p.codeFlow != nil && p.codeFlow.epoch == s.authorizationEpoch(owner, kind).Load() && (p.codeFlow.requestID == requestID || p.view.Status == "pending") && !s.Now().After(p.login.ExpiresAt)
		if same && p.codeFlow.targetAccountID != target {
			p.mu.Unlock()
			s.loginsMu.Unlock()
			return store.ExternalAccountLogin{}, ErrAuthorizationInProgress
		}
		if same && p.view.Status == "pending" {
			p.codeFlow.requestID = requestID
		}
		view := p.view
		p.mu.Unlock()
		if same {
			s.loginsMu.Unlock()
			return view, nil
		}
	}

	seed := make([]byte, 32)
	if _, err = rand.Read(seed); err != nil {
		s.loginsMu.Unlock()
		return store.ExternalAccountLogin{}, err
	}
	verifier := base64.RawURLEncoding.EncodeToString(seed)
	expires := s.Now().Add(10 * time.Minute)
	p := &pendingLogin{owner: owner, replace: replace, app: store.ExternalProviderApp{Provider: kind}, login: DeviceLogin{ExpiresAt: expires, Interval: 2 * time.Second, RequestedScopes: provider.PresetScopes(false)}, view: store.ExternalAccountLogin{ID: "xlogin_" + uuid.NewString(), Provider: kind, Status: "pending", Phase: "register", ExpiresAt: s.formatTime(expires), IntervalSeconds: 2}, codeFlow: &pendingCodeFlow{requestID: requestID, targetAccountID: target, verifier: verifier, redirectURI: redirectURI, issuer: provider.OAuthIssuer(), epoch: s.authorizationEpoch(owner, kind).Load()}}
	s.logins[p.view.ID] = p
	view := p.view
	s.loginsMu.Unlock()
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		clientID, err := provider.RegisterPublicClient(ctx, redirectURI)
		if err != nil {
			s.finishLogin(p, nil, fmt.Errorf("Cloudflare authorization could not be prepared: %w", err))
			return
		}
		app, err := s.store.CreateExternalProviderApp(ctx, store.ExternalProviderApp{ID: "xapp_" + uuid.NewString(), Provider: kind, OwnerUserID: owner, Visibility: store.ExternalAppPersonal, Label: "Foundry · " + provider.Describe().Label, ClientID: clientID, BaseURL: provider.OAuthIssuer(), CreatedVia: "dynamic_registration"})
		if err != nil {
			s.finishLogin(p, nil, errors.New("authorization client could not be saved"))
			return
		}
		digest := sha256.Sum256([]byte(verifier))
		p.mu.Lock()
		defer p.mu.Unlock()
		if p.view.Status != "pending" || s.Now().After(expires) {
			return
		}
		p.app = app
		p.view.AppID = app.ID
		p.view.Phase = "authorize"
		p.view.RequestedScopes = p.login.RequestedScopes
		p.view.VerificationURI = provider.AuthorizationURL(clientID, redirectURI, p.view.ID, base64.RawURLEncoding.EncodeToString(digest[:]), p.login.RequestedScopes)
		p.view.VerificationURIComplete = p.view.VerificationURI
	}()
	return view, nil
}

// CompleteAuthorizationCode requires the same signed-in owner and a single-use
// state. A missing exchange receipt is not replayed with a possibly spent code.
func (s *Service) CompleteAuthorizationCode(ctx context.Context, owner, state, code, issuer, denied string) error {
	s.loginsMu.Lock()
	p := s.logins[state]
	s.loginsMu.Unlock()
	if p == nil {
		return errors.New("authorization is unknown or expired")
	}
	p.mu.Lock()
	if p.owner != owner || p.codeFlow == nil || p.codeFlow.consumed || p.view.Status != "pending" || p.view.Phase != "authorize" || p.codeFlow.epoch != s.authorizationEpoch(p.owner, p.app.Provider).Load() || s.Now().After(p.login.ExpiresAt) || issuer != p.codeFlow.issuer {
		p.mu.Unlock()
		return errors.New("authorization is unknown or expired")
	}
	p.codeFlow.consumed = true
	flow := *p.codeFlow
	p.codeFlow.verifier = ""
	p.view.VerificationURI = ""
	p.view.VerificationURIComplete = ""
	p.view.Phase = "verifying"
	app := p.app
	p.mu.Unlock()
	if denied != "" || strings.TrimSpace(code) == "" {
		s.finishLogin(p, nil, ErrLoginDenied)
		return ErrLoginDenied
	}
	held, err := s.serverHeld(app.Provider)
	if err != nil {
		return err
	}
	provider := held.(AuthorizationCodeProvider)
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	creds := AppCredentials{ClientID: app.ClientID, BaseURL: app.BaseURL}
	grant, err := provider.ExchangeCode(ctx, creds, code, flow.redirectURI, flow.verifier)
	if err != nil {
		s.finishLogin(p, nil, fmt.Errorf("Cloudflare authorization exchange was not confirmed: %w", err))
		return errors.New("Cloudflare authorization was not confirmed")
	}
	p.mu.Lock()
	if p.view.Status != "pending" || s.Now().After(p.login.ExpiresAt) || p.codeFlow.epoch != s.authorizationEpoch(p.owner, p.app.Provider).Load() {
		p.mu.Unlock()
		return ErrLoginExpired
	}
	p.codeFlow.grant = &grant
	p.codeFlow.verifying = true
	p.mu.Unlock()
	go s.verifyCodeLogin(p)
	return nil
}

func (s *Service) CancelAuthorizationCode(owner, id string, requestID ...string) error {
	s.loginsMu.Lock()
	p := s.logins[id]
	s.loginsMu.Unlock()
	if p == nil {
		return store.ErrNotFound
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.owner != owner || p.codeFlow == nil || (len(requestID) > 0 && requestID[0] != p.codeFlow.requestID) {
		return store.ErrNotFound
	}
	if p.codeFlow.consumed && p.view.Phase == "verifying" {
		return nil
	}
	p.codeFlow.consumed = true
	p.codeFlow.verifier = ""
	p.view.VerificationURI = ""
	p.view.VerificationURIComplete = ""
	p.view.Status = "failed"
	p.view.Error = "Authorization closed."
	p.doneAt = s.Now()
	return nil
}

// AuthorizationCodeCallbackAllowed is a narrow provenance exception for the
// canonical top-level OAuth callback; the callback atomically rechecks it.
func (s *Service) AuthorizationCodeCallbackAllowed(owner, state, issuer string) bool {
	s.loginsMu.Lock()
	p := s.logins[state]
	s.loginsMu.Unlock()
	if p == nil {
		return false
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	return owner != "" && p.owner == owner && p.codeFlow != nil && !p.codeFlow.consumed && p.view.Status == "pending" && p.view.Phase == "authorize" && !s.Now().After(p.login.ExpiresAt) && issuer == p.codeFlow.issuer && p.codeFlow.epoch == s.authorizationEpoch(p.owner, p.app.Provider).Load()
}

func (s *Service) authorizationEpoch(owner, provider string) *atomic.Uint64 {
	value, _ := s.authorizationEpochs.LoadOrStore(owner+"\x00"+provider, &atomic.Uint64{})
	return value.(*atomic.Uint64)
}
func (s *Service) codeCommitLock(owner, provider string) *sync.Mutex {
	return s.lockFor("code-authorization:" + owner + "\x00" + provider)
}
func (s *Service) verifyCodeLogin(p *pendingLogin) {
	p.mu.Lock()
	if p.codeFlow == nil || p.codeFlow.grant == nil || p.view.Status != "pending" {
		if p.codeFlow != nil {
			p.codeFlow.verifying = false
		}
		p.mu.Unlock()
		return
	}
	grant := *p.codeFlow.grant
	app := p.app
	p.mu.Unlock()
	provider, err := s.serverHeld(app.Provider)
	if err != nil {
		s.finishLogin(p, nil, err)
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	account, err := s.completeLogin(ctx, p, provider, AppCredentials{ClientID: app.ClientID, BaseURL: app.BaseURL}, grant)
	p.mu.Lock()
	p.codeFlow.verifying = false
	if err == nil {
		p.codeFlow.grant = nil
		p.mu.Unlock()
		s.finishLogin(p, &account, nil)
		return
	}
	if p.view.Status != "pending" {
		p.codeFlow.grant = nil
		p.mu.Unlock()
		return
	}
	if errors.Is(err, ErrLoginExpired) || errors.Is(err, ErrDifferentIdentity) || errors.Is(err, ErrAccountUnusable) || errors.Is(err, store.ErrExternalAccountNotFound) {
		p.codeFlow.grant = nil
		p.mu.Unlock()
		s.finishLogin(p, nil, err)
		return
	}
	s.Logf("connector authorization provider=%s operation=%s stage=verification: %v", p.app.Provider, p.view.ID, err)
	p.view.Error = "Cloudflare approval was received, but identity verification or saving is not confirmed yet. Check this operation again; do not authorize again."
	p.codeFlow.retryAt = s.Now().Add(3 * time.Second)
	p.mu.Unlock()
}
