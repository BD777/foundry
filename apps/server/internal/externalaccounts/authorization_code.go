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

// ErrLoginGone: the sign-in to close no longer exists for this caller (it
// expired, ended, belongs to someone else or another dialog adopted it).
var ErrLoginGone = errors.New("the authorization no longer exists")

// Why a provider callback cannot complete a sign-in (CallbackError).
const (
	CallbackUnknown      = "unknown"
	CallbackExpired      = "expired"
	CallbackUsed         = "used"
	CallbackClosed       = "closed"
	CallbackSuperseded   = "superseded"
	CallbackOtherAccount = "other_account"
	CallbackIssuer       = "issuer"
	CallbackNotReady     = "not_ready"
)

// CallbackError is a callback that matches no sign-in it may complete.
type CallbackError struct{ Problem string }

func (e *CallbackError) Error() string {
	return "authorization is unknown or expired (" + e.Problem + ")"
}

// codeVerificationWindow is how long a sign-in another process claimed is
// shown as still verifying; past it that process is taken to be gone.
const codeVerificationWindow = 90 * time.Second

// codeLoginSecretID is the sealed record of a browser sign-in's PKCE verifier.
func codeLoginSecretID(loginID string) string { return "external-login:" + loginID }

type pendingCodeFlow struct {
	requestID, verifier, redirectURI, issuer string
	targetAccountID                          string
	consumed                                 bool
	// ended is the Callback* reason a consumed flow can no longer complete.
	ended     string
	epoch     uint64
	grant     *Grant
	verifying bool
	retryAt   time.Time
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
	// A sign-in an earlier server process started is adopted, so a restart
	// neither forgets it nor lets a second one start beside it.
	s.restoreCodeLogins(ctx, owner, kind)
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
		adopted := same && p.view.Status == "pending" && p.codeFlow.requestID != requestID
		var record store.ExternalCodeLogin
		if adopted {
			p.codeFlow.requestID = requestID
			record = s.codeRecordLocked(p)
		}
		view := p.view
		p.mu.Unlock()
		if same {
			s.loginsMu.Unlock()
			if adopted {
				if err := s.store.SaveExternalCodeLogin(ctx, record); err != nil {
					s.Logf("connector authorization provider=%s operation=%s: save adopted request: %v", kind, view.ID, err)
				}
			}
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
	if err := s.persistCodeLogin(ctx, s.codeRecordLocked(p), verifier); err != nil {
		s.loginsMu.Unlock()
		return store.ExternalAccountLogin{}, err
	}
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
		authorizationURL := provider.AuthorizationURL(clientID, redirectURI, p.view.ID, base64.RawURLEncoding.EncodeToString(digest[:]), p.login.RequestedScopes)
		p.mu.Lock()
		if p.view.Status != "pending" || s.Now().After(expires) {
			p.mu.Unlock()
			return
		}
		record := s.codeRecordLocked(p)
		p.mu.Unlock()
		// Saved before the link is shown: a callback may then reach any
		// later server process.
		record.Phase, record.AppID, record.VerificationURI = "authorize", app.ID, authorizationURL
		if err := s.store.SaveExternalCodeLogin(ctx, record); err != nil {
			s.finishLogin(p, nil, errors.New("authorization could not be saved"))
			return
		}
		p.mu.Lock()
		defer p.mu.Unlock()
		if p.view.Status != "pending" || s.Now().After(expires) {
			return
		}
		p.app = app
		p.view.AppID = app.ID
		p.view.Phase = "authorize"
		p.view.RequestedScopes = p.login.RequestedScopes
		p.view.VerificationURI = authorizationURL
		p.view.VerificationURIComplete = p.view.VerificationURI
	}()
	return view, nil
}

// CompleteAuthorizationCode requires the same signed-in owner and a single-use
// state. A missing exchange receipt is not replayed with a possibly spent code.
// The database claim makes the state single-use across server processes
// (a handoff runs two for a moment); it is the commit point of the callback.
func (s *Service) CompleteAuthorizationCode(ctx context.Context, owner, state, code, issuer, denied string) error {
	p, record := s.lookupCodeLogin(ctx, state)
	if p == nil {
		return &CallbackError{Problem: s.recordProblem(record, owner)}
	}
	p.mu.Lock()
	if problem := s.codeProblemLocked(p, owner, issuer); problem != "" {
		p.mu.Unlock()
		return &CallbackError{Problem: problem}
	}
	claimed, err := s.store.EndExternalCodeLogin(ctx, state, []string{""}, "used", "", "")
	if err != nil {
		p.mu.Unlock()
		return fmt.Errorf("authorization could not be checked: %w", err)
	}
	if !claimed {
		current, err := s.store.GetExternalCodeLogin(ctx, state)
		problem := CallbackUnknown
		if err == nil {
			problem = s.recordProblem(&current, owner)
		}
		s.endCodeFlowLocked(p, problem, "Authorization was already used or closed.")
		p.mu.Unlock()
		return &CallbackError{Problem: problem}
	}
	p.codeFlow.consumed = true
	p.codeFlow.ended = CallbackUsed
	flow := *p.codeFlow
	p.codeFlow.verifier = ""
	p.view.VerificationURI = ""
	p.view.VerificationURIComplete = ""
	p.view.Phase = "verifying"
	app := p.app
	p.mu.Unlock()
	s.dropCodeVerifier(state)
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

// CancelAuthorizationCode closes the owner's pending sign-in; one that no
// longer exists for this owner and dialog answers ErrLoginGone.
func (s *Service) CancelAuthorizationCode(owner, id string, requestID ...string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	p, _ := s.lookupCodeLogin(ctx, id)
	if p == nil {
		return ErrLoginGone
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.owner != owner || p.codeFlow == nil || (len(requestID) > 0 && requestID[0] != p.codeFlow.requestID) {
		return ErrLoginGone
	}
	if p.codeFlow.consumed && p.view.Phase == "verifying" {
		return nil
	}
	if _, err := s.store.EndExternalCodeLogin(ctx, id, []string{""}, "closed", "", ""); err != nil {
		return err
	}
	s.dropCodeVerifier(id)
	p.codeFlow.ended = CallbackClosed
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
	return owner != "" && s.AuthorizationCodeCallbackProblem(owner, state, issuer) == ""
}

// AuthorizationCodeCallbackProblem is why owner's callback with state cannot
// complete a sign-in (a Callback* reason), "" when it can. It changes
// nothing a callback could use, so a refused request may ask it.
func (s *Service) AuthorizationCodeCallbackProblem(owner, state, issuer string) string {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	p, record := s.lookupCodeLogin(ctx, state)
	if p == nil {
		return s.recordProblem(record, owner)
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	return s.codeProblemLocked(p, owner, issuer)
}

// codeProblemLocked checks a sign-in this process holds; the caller holds
// p.mu. Another owner learns nothing more than that it is not theirs.
func (s *Service) codeProblemLocked(p *pendingLogin, owner, issuer string) string {
	switch {
	case owner == "" || p.owner != owner:
		return CallbackOtherAccount
	case p.codeFlow == nil:
		return CallbackUnknown
	case p.codeFlow.ended != "":
		return p.codeFlow.ended
	case p.codeFlow.consumed || p.view.Status != "pending":
		return CallbackUsed
	case s.Now().After(p.login.ExpiresAt):
		return CallbackExpired
	case p.codeFlow.epoch != s.authorizationEpoch(p.owner, p.app.Provider).Load():
		return CallbackSuperseded
	case p.view.Phase != "authorize":
		return CallbackNotReady
	case issuer != p.codeFlow.issuer:
		return CallbackIssuer
	}
	return ""
}

// recordProblem explains a sign-in only the database holds.
func (s *Service) recordProblem(record *store.ExternalCodeLogin, owner string) string {
	switch {
	case record == nil:
		return CallbackUnknown
	case owner == "" || record.OwnerUserID != owner:
		return CallbackOtherAccount
	case record.Outcome == "used" || record.Outcome == "complete" || record.Outcome == "failed":
		return CallbackUsed
	case record.Outcome == "closed":
		return CallbackClosed
	case record.Outcome == "superseded":
		return CallbackSuperseded
	case s.Now().After(record.ExpiresAt):
		return CallbackExpired
	}
	return CallbackUnknown
}

// endCodeFlowLocked fails a pending sign-in that can no longer complete;
// the caller holds p.mu.
func (s *Service) endCodeFlowLocked(p *pendingLogin, reason, message string) {
	p.codeFlow.consumed = true
	p.codeFlow.ended = reason
	p.codeFlow.verifier = ""
	p.codeFlow.grant = nil
	if p.view.Status == "pending" {
		p.view.Status = "failed"
		p.view.Error = message
		p.doneAt = s.Now()
	}
	p.view.VerificationURI = ""
	p.view.VerificationURIComplete = ""
}

// codeRecordLocked is the row that keeps p across a restart; the caller
// holds p.mu (or p is not shared yet).
func (s *Service) codeRecordLocked(p *pendingLogin) store.ExternalCodeLogin {
	return store.ExternalCodeLogin{
		ID: p.view.ID, Provider: p.view.Provider, OwnerUserID: p.owner, RequestID: p.codeFlow.requestID, TargetAccountID: p.codeFlow.targetAccountID,
		AppID: p.app.ID, RedirectURI: p.codeFlow.redirectURI, Issuer: p.codeFlow.issuer, VerificationURI: p.view.VerificationURI,
		Phase: p.view.Phase, RequestedScopes: p.login.RequestedScopes, ExpiresAt: p.login.ExpiresAt,
	}
}

// persistCodeLogin seals the verifier and saves the row: neither the
// verifier nor any code appears in the row or in a log line.
func (s *Service) persistCodeLogin(ctx context.Context, record store.ExternalCodeLogin, verifier string) error {
	id := codeLoginSecretID(record.ID)
	if err := s.secrets.PutSecret(ctx, id, []byte(verifier), id); err != nil {
		return fmt.Errorf("authorization could not be saved: %w", err)
	}
	if err := s.store.SaveExternalCodeLogin(ctx, record); err != nil {
		s.dropCodeVerifier(record.ID)
		return fmt.Errorf("authorization could not be saved: %w", err)
	}
	return nil
}

func (s *Service) dropCodeVerifier(loginID string) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := s.secrets.DeleteSecret(ctx, codeLoginSecretID(loginID)); err != nil {
		s.Logf("connector authorization operation=%s: remove the sealed verifier: %v", loginID, err)
	}
}

// recordCodeOutcome writes how a sign-in ended, for a later process to show.
func (s *Service) recordCodeOutcome(loginID string, account *store.ExternalAccount, failure error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	to, accountID, detail := "complete", "", ""
	if account != nil {
		accountID = account.ID
	}
	if failure != nil {
		to, detail = "failed", failure.Error()
	}
	if _, err := s.store.EndExternalCodeLogin(ctx, loginID, []string{"", "used"}, to, accountID, detail); err != nil {
		s.Logf("connector authorization operation=%s: record outcome: %v", loginID, err)
	}
	s.dropCodeVerifier(loginID)
}

// lookupCodeLogin finds a browser sign-in: the one this process holds, or
// one an earlier process saved, which it adopts while it may still
// complete. Otherwise record is the saved row (nil when there is none).
func (s *Service) lookupCodeLogin(ctx context.Context, id string) (*pendingLogin, *store.ExternalCodeLogin) {
	s.loginsMu.Lock()
	p := s.logins[id]
	s.loginsMu.Unlock()
	if p != nil {
		return p, nil
	}
	if !strings.HasPrefix(id, "xlogin_") {
		return nil, nil
	}
	record, err := s.store.GetExternalCodeLogin(ctx, id)
	if err != nil {
		return nil, nil
	}
	if adopted := s.adoptCodeLogin(ctx, &record); adopted != nil {
		return adopted, nil
	}
	return nil, &record
}

// adoptCodeLogin rebuilds a saved pending sign-in in this process. One
// whose client was never ready, or whose verifier, app or account is gone,
// is ended instead.
func (s *Service) adoptCodeLogin(ctx context.Context, record *store.ExternalCodeLogin) *pendingLogin {
	if record.Outcome != "" || s.Now().After(record.ExpiresAt) {
		return nil
	}
	end := func(outcome, detail string) *pendingLogin {
		if ended, err := s.store.EndExternalCodeLogin(ctx, record.ID, []string{""}, outcome, "", detail); err == nil && ended {
			record.Outcome, record.Detail = outcome, detail
			s.dropCodeVerifier(record.ID)
		}
		return nil
	}
	held, err := s.serverHeld(record.Provider)
	if err != nil {
		return nil
	}
	if _, ok := held.(AuthorizationCodeProvider); !ok {
		return nil
	}
	if record.Phase != "authorize" || record.AppID == "" || record.VerificationURI == "" {
		return end("failed", "Authorization was interrupted by a server restart before it could be opened. Start again.")
	}
	verifier, err := s.secrets.GetSecret(ctx, codeLoginSecretID(record.ID))
	if errors.Is(err, store.ErrNotFound) {
		return end("failed", "Authorization could not be resumed after a server restart. Start again.")
	}
	if err != nil {
		s.Logf("connector authorization provider=%s operation=%s: unseal the verifier: %v", record.Provider, record.ID, err)
		return nil
	}
	app, err := s.store.GetExternalProviderApp(ctx, record.AppID)
	if err != nil {
		return end("failed", "Authorization could not be resumed after a server restart. Start again.")
	}
	var replace *store.ExternalAccount
	if record.TargetAccountID != "" {
		account, err := s.store.GetExternalAccount(ctx, record.TargetAccountID)
		if err != nil || account.OwnerUserID != record.OwnerUserID || account.Provider != record.Provider {
			return end("superseded", "")
		}
		replace = &account
	}
	p := &pendingLogin{
		owner: record.OwnerUserID, replace: replace, app: app,
		login: DeviceLogin{ExpiresAt: record.ExpiresAt, Interval: 2 * time.Second, RequestedScopes: record.RequestedScopes},
		view: store.ExternalAccountLogin{
			ID: record.ID, Provider: record.Provider, AppID: app.ID, Status: "pending", Phase: "authorize",
			VerificationURI: record.VerificationURI, VerificationURIComplete: record.VerificationURI,
			ExpiresAt: s.formatTime(record.ExpiresAt), IntervalSeconds: 2, RequestedScopes: record.RequestedScopes,
		},
		codeFlow: &pendingCodeFlow{
			requestID: record.RequestID, targetAccountID: record.TargetAccountID, verifier: string(verifier),
			redirectURI: record.RedirectURI, issuer: record.Issuer, epoch: s.authorizationEpoch(record.OwnerUserID, record.Provider).Load(),
		},
	}
	s.loginsMu.Lock()
	defer s.loginsMu.Unlock()
	if existing := s.logins[record.ID]; existing != nil {
		return existing
	}
	s.logins[record.ID] = p
	return p
}

// restoreCodeLogins adopts the owner's saved pending sign-ins at provider
// and forgets saved ones long expired.
func (s *Service) restoreCodeLogins(ctx context.Context, owner, provider string) {
	pruned, err := s.store.PruneExternalCodeLogins(ctx, s.Now().Add(-s.LoginGrace))
	if err != nil {
		s.Logf("connector authorization provider=%s: prune saved sign-ins: %v", provider, err)
	}
	for _, id := range pruned {
		s.dropCodeVerifier(id)
	}
	records, err := s.store.ListPendingExternalCodeLogins(ctx, owner, provider)
	if err != nil {
		s.Logf("connector authorization provider=%s: list saved sign-ins: %v", provider, err)
		return
	}
	for _, record := range records {
		s.lookupCodeLogin(ctx, record.ID)
	}
}

// storedCodeLoginView shows a sign-in only the database holds: how it
// ended, or that another process is still verifying it.
func (s *Service) storedCodeLoginView(ctx context.Context, record store.ExternalCodeLogin) store.ExternalAccountLogin {
	view := store.ExternalAccountLogin{ID: record.ID, Provider: record.Provider, AppID: record.AppID, Status: "failed", ExpiresAt: s.formatTime(record.ExpiresAt), RequestedScopes: record.RequestedScopes}
	switch record.Outcome {
	case "complete":
		account, err := s.store.GetExternalAccount(ctx, record.AccountID)
		if err == nil && account.OwnerUserID == record.OwnerUserID {
			view.Status, view.Account = "complete", &account
		} else {
			view.Error = "The connected account is no longer available. Check Connectors."
		}
	case "used":
		if time.Since(record.UpdatedAt) < codeVerificationWindow {
			view.Status, view.Phase, view.IntervalSeconds = "pending", "verifying", 2
		} else {
			view.Error = "Cloudflare approval was received, but the server restarted before the connection was saved. Check Connectors; if the account is missing, connect again."
		}
	case "failed":
		view.Error = record.Detail
	case "closed":
		view.Error = "Authorization closed."
	case "superseded":
		view.Error = "Authorization expired or was superseded by a connection change."
	default:
		view.Error = "Authorization expired."
	}
	if view.Status == "failed" && view.Error == "" {
		view.Error = "Authorization was not completed."
	}
	return view
}

// supersedeCodeLogins ends the owner's saved pending sign-ins at provider,
// as the epoch does for those this process holds.
func (s *Service) supersedeCodeLogins(ctx context.Context, owner, provider string) {
	if err := s.store.SupersedeExternalCodeLogins(ctx, owner, provider); err != nil {
		s.Logf("connector authorization provider=%s: supersede saved sign-ins: %v", provider, err)
	}
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
