package externalaccounts

import (
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/sqlitestore"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

type harness struct {
	t       *testing.T
	ctx     context.Context
	store   *sqlitestore.Store
	fake    *FakeFeishu
	service *Service
	app     store.ExternalProviderApp
	clock   time.Time
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	dir := t.TempDir()
	st, err := sqlitestore.OpenWithOptions(filepath.Join(dir, "foundry.db"), sqlitestore.Options{SecretKeyPath: filepath.Join(dir, "secret.key")})
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	fake := NewFakeFeishu("cli_fake", "secret_fake")
	t.Cleanup(fake.Close)
	h := &harness{t: t, ctx: context.Background(), store: st, fake: fake, clock: time.Date(2026, 10, 11, 9, 0, 0, 0, time.UTC)}
	adapter := fake.Adapter()
	adapter.Now = func() time.Time { return h.clock }
	h.service = NewService(st, st, NewRegistry(adapter))
	h.service.MinPollInterval = 5 * time.Millisecond
	h.service.Now = func() time.Time { return h.clock }
	h.service.Logf = t.Logf
	h.app, err = h.service.CreateApp(h.ctx, "user_owner", store.SaveExternalProviderAppInput{
		Provider: "feishu", Label: "Org app", ClientID: "cli_fake", ClientSecret: "secret_fake", BaseURL: fake.BaseURL(),
	})
	if err != nil {
		t.Fatalf("create app: %v", err)
	}
	return h
}

// connect runs a device login to completion for user_owner.
func (h *harness) connect(scopes ...string) store.ExternalAccount {
	h.t.Helper()
	login, err := h.service.BeginLogin(h.ctx, "user_owner", h.app, store.ConnectExternalAccountInput{AppID: h.app.ID, Scopes: scopes})
	if err != nil {
		h.t.Fatalf("begin login: %v", err)
	}
	if login.Status != "pending" || login.UserCode == "" || login.VerificationURIComplete == "" {
		h.t.Fatalf("login not pending with a code: %+v", login)
	}
	h.fake.Approve()
	return h.awaitLogin(login.ID).Account.deref(h.t)
}

type accountPtr struct{ *store.ExternalAccount }

func (p accountPtr) deref(t *testing.T) store.ExternalAccount {
	if p.ExternalAccount == nil {
		t.Fatal("login completed without an account")
	}
	return *p.ExternalAccount
}

type loginResult struct {
	store.ExternalAccountLogin
	Account accountPtr
}

func (h *harness) awaitLogin(id string) loginResult {
	h.t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		view, ok := h.service.Login(id, "user_owner")
		if !ok {
			h.t.Fatal("login vanished")
		}
		if view.Status != "pending" {
			return loginResult{view, accountPtr{view.Account}}
		}
		time.Sleep(5 * time.Millisecond)
	}
	h.t.Fatal("login did not finish")
	return loginResult{}
}

func TestLoginConnectsAccountAndSealsGrantOnly(t *testing.T) {
	h := newHarness(t)
	account := h.connect("docx:document:readonly", "search:docs:read")

	if account.Status != store.ExternalAccountReady || account.OwnerUserID != "user_owner" || account.AppID != h.app.ID {
		t.Fatalf("account not ready for its owner: %+v", account)
	}
	if account.Subject != "ou_fake" || account.DisplayName != "Fake Person" || account.Tenant != "tenant_fake" || account.Label != "Fake Person" {
		t.Fatalf("identity not read: %+v", account)
	}
	if !account.KeepAlive || account.LastRefreshBy != "login" || account.AccessExpiresAt == "" || account.RefreshExpiresAt == "" || account.AuthExpiresAt == "" {
		t.Fatalf("lifecycle fields missing: %+v", account)
	}
	scope := h.fake.RequestedScope()
	for _, want := range []string{"offline_access", "auth:user.id:read", "docx:document:readonly", "search:docs:read"} {
		if !strings.Contains(" "+scope+" ", " "+want+" ") {
			t.Fatalf("requested scope %q lacks %s", scope, want)
		}
	}
	if strings.Join(account.GrantedScopes, " ") != scope {
		t.Fatalf("granted scopes %v differ from requested %q", account.GrantedScopes, scope)
	}
	// The record holds no token; the sealed grant holds both tokens.
	record, _ := json.Marshal(account)
	if strings.Contains(string(record), h.fake.CurrentRefreshToken()) || strings.Contains(string(record), "fake-signature") {
		t.Fatal("account record carries a token")
	}
	grant, err := h.service.loadGrant(h.ctx, account.ID)
	if err != nil {
		t.Fatalf("load grant: %v", err)
	}
	if grant.RefreshToken != h.fake.CurrentRefreshToken() || grant.AccessToken == "" || grant.Generation != 1 {
		t.Fatalf("grant not sealed as issued: %+v", grant)
	}
	events, err := h.store.ListExternalAccountEvents(h.ctx, account.ID, 10)
	if err != nil || len(events) != 1 || events[0].Kind != "connected" {
		t.Fatalf("connected event missing: %v %v", events, err)
	}
}

func TestLoginWithoutRefreshTokenIsRefused(t *testing.T) {
	h := newHarness(t)
	h.fake.NoRefreshToken = true
	login, err := h.service.BeginLogin(h.ctx, "user_owner", h.app, store.ConnectExternalAccountInput{AppID: h.app.ID})
	if err != nil {
		t.Fatal(err)
	}
	h.fake.Approve()
	result := h.awaitLogin(login.ID)
	if result.Status != "failed" || !strings.Contains(result.Error, "offline_access") {
		t.Fatalf("login without refresh token not refused: %+v", result.ExternalAccountLogin)
	}
	accounts, _ := h.store.ListExternalAccounts(h.ctx, "")
	if len(accounts) != 0 {
		t.Fatalf("a 2-hour account was stored: %+v", accounts)
	}
}

func TestLoginDeniedAndUnknownOwner(t *testing.T) {
	h := newHarness(t)
	h.fake.Denied = true
	login, err := h.service.BeginLogin(h.ctx, "user_owner", h.app, store.ConnectExternalAccountInput{AppID: h.app.ID})
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := h.service.Login(login.ID, "someone_else"); ok {
		t.Fatal("another person could read the login")
	}
	if result := h.awaitLogin(login.ID); result.Status != "failed" || !errors.Is(ErrLoginDenied, ErrLoginDenied) || !strings.Contains(result.Error, "denied") {
		t.Fatalf("denied login not reported: %+v", result.ExternalAccountLogin)
	}
}

func TestMintServesAccessTokenAndRefreshesOnceUnderContention(t *testing.T) {
	h := newHarness(t)
	account := h.connect()
	token, err := h.service.Mint(h.ctx, account, Use{SessionID: "sess_1", DeviceID: "dev_1", By: "session"})
	if err != nil {
		t.Fatalf("mint: %v", err)
	}
	if token.AccessToken == "" || token.ExpiresAt == "" || !h.fake.AccessTokenValid(token.AccessToken) {
		t.Fatalf("mint did not return the live access token: %+v", token)
	}
	if h.fake.Refreshes() != 0 {
		t.Fatal("a fresh grant was refreshed needlessly")
	}
	if strings.Contains(token.AccessToken, h.fake.CurrentRefreshToken()) {
		t.Fatal("token response carries the refresh token")
	}

	// 1h50 later the access token has under 30 minutes left: one refresh
	// serves every concurrent mint.
	h.clock = h.clock.Add(110 * time.Minute)
	var wg sync.WaitGroup
	tokens := make([]string, 8)
	errs := make([]error, 8)
	for i := range tokens {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			minted, err := h.service.Mint(h.ctx, account, Use{By: "session"})
			tokens[i], errs[i] = minted.AccessToken, err
		}(i)
	}
	wg.Wait()
	for i, err := range errs {
		if err != nil {
			t.Fatalf("mint %d: %v", i, err)
		}
		if tokens[i] != tokens[0] {
			t.Fatalf("mints disagree: %q vs %q", tokens[i], tokens[0])
		}
	}
	if h.fake.Refreshes() != 1 {
		t.Fatalf("refresh token spent %d times, want once", h.fake.Refreshes())
	}
	refreshed, _ := h.store.GetExternalAccount(h.ctx, account.ID)
	if refreshed.LastRefreshBy != "session" || refreshed.Status != store.ExternalAccountReady {
		t.Fatalf("account not updated by refresh: %+v", refreshed)
	}
	grant, _ := h.service.loadGrant(h.ctx, account.ID)
	if grant.Generation != 2 || grant.RefreshToken != h.fake.CurrentRefreshToken() {
		t.Fatalf("rotated grant not sealed: %+v", grant)
	}
}

func TestTerminalRefreshFailureMarksNeedsReauth(t *testing.T) {
	h := newHarness(t)
	account := h.connect()
	h.clock = h.clock.Add(2 * time.Hour)
	h.fake.RefreshFailCode = 20073
	_, err := h.service.Mint(h.ctx, account, Use{By: "session"})
	var refreshErr *RefreshError
	if !errors.As(err, &refreshErr) || !refreshErr.Terminal {
		t.Fatalf("want a terminal refresh error, got %v", err)
	}
	after, _ := h.store.GetExternalAccount(h.ctx, account.ID)
	if after.Status != store.ExternalAccountNeedsReauth || after.StatusDetail != "refresh_token_reused" {
		t.Fatalf("account not marked needs_reauth: %+v", after)
	}
	// Nothing retries a dead grant.
	h.fake.RefreshFailCode = 0
	if _, err := h.service.Mint(h.ctx, after, Use{By: "session"}); !errors.Is(err, ErrAccountUnusable) {
		t.Fatalf("mint on a needs_reauth account: %v", err)
	}
	if h.fake.Refreshes() != 0 {
		t.Fatal("the dead grant was refreshed again")
	}
}

func TestTransientRefreshFailureIsRetriedAndNotTerminal(t *testing.T) {
	h := newHarness(t)
	account := h.connect()
	h.clock = h.clock.Add(2 * time.Hour)
	h.fake.RefreshFailCode = 20050
	_, err := h.service.Mint(h.ctx, account, Use{By: "session"})
	var refreshErr *RefreshError
	if !errors.As(err, &refreshErr) || refreshErr.Terminal || !refreshErr.Retryable {
		t.Fatalf("want a retryable error, got %v", err)
	}
	after, _ := h.store.GetExternalAccount(h.ctx, account.ID)
	if after.Status != store.ExternalAccountReady {
		t.Fatalf("transient failure changed status: %+v", after)
	}
}

func TestRevokeStopsUseAndDisconnectRemoves(t *testing.T) {
	h := newHarness(t)
	account := h.connect()
	refreshToken := h.fake.CurrentRefreshToken()
	revoked, err := h.service.Revoke(h.ctx, account, "user_owner")
	if err != nil {
		t.Fatalf("revoke: %v", err)
	}
	if revoked.Status != store.ExternalAccountRevoked {
		t.Fatalf("not marked revoked: %+v", revoked)
	}
	if list := h.fake.Revoked(); len(list) != 1 || list[0] != refreshToken {
		t.Fatalf("refresh token not revoked at the provider: %v", list)
	}
	if stored, _ := h.store.HasSecret(h.ctx, GrantSecretID(account.ID)); stored {
		t.Fatal("grant still sealed after revoke")
	}
	if _, err := h.service.Mint(h.ctx, revoked, Use{}); !errors.Is(err, ErrAccountUnusable) {
		t.Fatalf("mint after revoke: %v", err)
	}
	if err := h.service.Disconnect(h.ctx, revoked, "user_owner"); err != nil {
		t.Fatalf("disconnect: %v", err)
	}
	if _, err := h.store.GetExternalAccount(h.ctx, account.ID); !errors.Is(err, store.ErrExternalAccountNotFound) {
		t.Fatalf("account still stored: %v", err)
	}
	if err := h.service.DeleteApp(h.ctx, h.app); err != nil {
		t.Fatalf("delete app once unused: %v", err)
	}
}

func TestDisconnectOfLiveAccountRevokesFirst(t *testing.T) {
	h := newHarness(t)
	account := h.connect()
	if err := h.service.DeleteApp(h.ctx, h.app); !errors.Is(err, ErrAppInUse) {
		t.Fatalf("app deleted while in use: %v", err)
	}
	if err := h.service.Disconnect(h.ctx, account, "user_owner"); err != nil {
		t.Fatal(err)
	}
	if len(h.fake.Revoked()) != 1 {
		t.Fatalf("disconnect did not revoke: %v", h.fake.Revoked())
	}
}

func TestKeepAliveRefreshesOnlyOptedInAccountsNearExpiry(t *testing.T) {
	h := newHarness(t)
	kept := h.connect()
	h.fake.Approved = false
	loose := h.connect()
	loose, err := h.service.Update(h.ctx, loose, store.ExternalAccountUpdate{KeepAlive: boolPtr(false)}, "user_owner")
	if err != nil {
		t.Fatal(err)
	}
	if h.service.KeepAliveSweep(h.ctx) != 0 {
		t.Fatal("fresh grants were refreshed")
	}
	// Six and a half days on: both refresh tokens are within a day of dying.
	h.clock = h.clock.Add(6*24*time.Hour + 12*time.Hour)
	if refreshed := h.service.KeepAliveSweep(h.ctx); refreshed != 1 {
		t.Fatalf("keep-alive refreshed %d accounts, want 1", refreshed)
	}
	keptAfter, _ := h.store.GetExternalAccount(h.ctx, kept.ID)
	if keptAfter.LastRefreshBy != "keep_alive" || parseOrZero(keptAfter.RefreshExpiresAt).Sub(h.clock) < 6*24*time.Hour {
		t.Fatalf("kept account not refreshed: %+v", keptAfter)
	}
	looseAfter := h.service.withComputedStatus(mustGet(t, h, loose.ID))
	if looseAfter.LastRefreshBy != "login" || looseAfter.Status != store.ExternalAccountExpiring {
		t.Fatalf("account without keep-alive should be left expiring: %+v", looseAfter)
	}
	// Once its refresh token is gone it needs re-authorization.
	h.clock = h.clock.Add(24 * time.Hour)
	if gone := h.service.withComputedStatus(mustGet(t, h, loose.ID)); gone.Status != store.ExternalAccountNeedsReauth || gone.StatusDetail != "refresh_token_expired" {
		t.Fatalf("expired account not reported: %+v", gone)
	}
}

func TestRefreshExpiryFallsBackToTokenClaimNotAnOptimisticDefault(t *testing.T) {
	h := newHarness(t)
	h.fake.RefreshTokenExpiresIn = 0
	account := h.connect()
	expiry := parseOrZero(account.RefreshExpiresAt)
	if expiry.IsZero() {
		t.Fatal("no refresh expiry recorded")
	}
	// The fake's refresh JWT says 7 days from issue (real clock); the
	// account must not say 30.
	if until := time.Until(expiry); until > 7*24*time.Hour+time.Minute || until < 6*24*time.Hour {
		t.Fatalf("refresh expiry %s is not the token's 7 days", expiry)
	}
	plain := refreshTokenExpiry(h.clock, 0, "not-a-jwt", feishuRefreshFallback)
	if plain.Sub(h.clock) != feishuRefreshFallback {
		t.Fatalf("opaque token fallback %s, want 7 days", plain.Sub(h.clock))
	}
}

func TestSessionMaterialsFollowOwnerOnlyRule(t *testing.T) {
	h := newHarness(t)
	issuer := &recordingIssuer{}
	h.service.Handles = issuer
	account := h.connect()
	if err := h.store.SetWorkspaceExternalAccounts(h.ctx, "ws_1", "user_owner", []string{account.ID}); err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		name                       string
		workspace, session, device string
		want                       int
	}{
		{"owner on own device in bound workspace", "ws_1", "user_owner", "user_owner", 1},
		{"other person's session", "ws_1", "user_other", "user_owner", 0},
		{"owner's session on someone else's device", "ws_1", "user_owner", "user_other", 0},
		{"unbound workspace", "ws_2", "user_owner", "user_owner", 0},
	}
	for _, tc := range cases {
		materials, err := h.service.SessionMaterials(h.ctx, tc.workspace, "sess_1", "dev_1", tc.session, tc.device)
		if err != nil {
			t.Fatalf("%s: %v", tc.name, err)
		}
		if len(materials) != tc.want {
			t.Fatalf("%s: %d materials, want %d", tc.name, len(materials), tc.want)
		}
	}
	materials, _ := h.service.SessionMaterials(h.ctx, "ws_1", "sess_1", "dev_1", "user_owner", "user_owner")
	material := materials[0]
	if material.Tool != "feishu-cli" || material.ProfileName != ProfileName(account.ID, "sess_1") || !strings.HasPrefix(material.ProfileName, "foundry-") {
		t.Fatalf("material not for feishu-cli: %+v", material)
	}
	if material.ClientID != "cli_fake" || material.Gateway == nil || material.Gateway.AppHandle != "fsg_test" || material.Gateway.UserHandle != "fsu_test" || material.ExpiresAt == "" {
		t.Fatalf("material lacks the app id or the gateway handles: %+v", material)
	}
	if len(issuer.requests) != 2 || issuer.requests[1].SessionID != "sess_1" || issuer.requests[1].DeviceID != "dev_1" || issuer.requests[1].App.ID != h.app.ID {
		t.Fatalf("handles issued for: %+v", issuer.requests)
	}
	// Neither the app secret nor any token of the account reaches a device.
	grant, err := h.service.loadGrant(h.ctx, account.ID)
	if err != nil {
		t.Fatal(err)
	}
	encoded, _ := json.Marshal(material)
	for _, secret := range []string{"secret_fake", grant.AccessToken, grant.RefreshToken} {
		if strings.Contains(string(encoded), secret) {
			t.Fatalf("material carries a credential: %s", encoded)
		}
	}
}

type recordingIssuer struct{ requests []HandleRequest }

func (r *recordingIssuer) IssueHandles(_ context.Context, request HandleRequest) (store.ExternalAccountGateway, error) {
	r.requests = append(r.requests, request)
	return store.ExternalAccountGateway{Path: "/api/feishu-gw", AppHandle: "fsg_test", UserHandle: "fsu_test"}, nil
}

func TestProfileNameFitsFeishuCLI(t *testing.T) {
	name := ProfileName("xacc_0f3c1a2b-9d8e-4c7b-a6f5-123456789abc", "sess_7")
	if !strings.HasPrefix(name, "foundry-") || len(name) > 64 || strings.ContainsAny(name, ". /") || !regexp.MustCompile(`^foundry-[A-Za-z0-9_-]{1,56}$`).MatchString(name) {
		t.Fatalf("profile name %q", name)
	}
	if name == ProfileName("xacc_0f3c1a2b-9d8e-4c7b-a6f5-123456789abc", "sess_8") {
		t.Fatal("two sessions share a profile")
	}
}

func TestServiceWithoutSecretStoreRefuses(t *testing.T) {
	dir := t.TempDir()
	st, err := sqlitestore.Open(filepath.Join(dir, "foundry.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	fake := NewFakeFeishu("cli", "sec")
	defer fake.Close()
	service := NewService(st, st, NewRegistry(fake.Adapter()))
	if _, err := service.CreateApp(context.Background(), "u", store.SaveExternalProviderAppInput{Provider: "feishu", ClientID: "cli", ClientSecret: "sec"}); !errors.Is(err, ErrSecretsNotConfigured) {
		t.Fatalf("app created without a secret store: %v", err)
	}
}

func TestFeishuAccountsBaseDerivation(t *testing.T) {
	cases := map[string]string{
		"":                            "https://accounts.feishu.cn",
		"https://open.feishu.cn":      "https://accounts.feishu.cn",
		"https://open.larksuite.com/": "https://accounts.larksuite.com",
		"https://gateway.example.com": "https://gateway.example.com",
	}
	for in, want := range cases {
		if got := FeishuAccountsBase(in); got != want {
			t.Errorf("FeishuAccountsBase(%q) = %q, want %q", in, got, want)
		}
	}
}

func boolPtr(value bool) *bool { return &value }

func parseOrZero(value string) time.Time {
	parsed, _ := parseTime(value)
	return parsed
}

func mustGet(t *testing.T, h *harness, id string) store.ExternalAccount {
	t.Helper()
	account, err := h.store.GetExternalAccount(h.ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	return account
}
