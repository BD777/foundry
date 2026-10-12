package externalaccounts

import (
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// awaitPhase waits until the login reaches phase or finishes.
func (h *harness) awaitPhase(id, phase string) store.ExternalAccountLogin {
	h.t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		view, ok := h.service.Login(id, "user_owner")
		if !ok {
			h.t.Fatal("login vanished")
		}
		if view.Phase == phase || view.Status != "pending" {
			return view
		}
		time.Sleep(5 * time.Millisecond)
	}
	h.t.Fatalf("login did not reach phase %s", phase)
	return store.ExternalAccountLogin{}
}

func requested(scope string) map[string]bool {
	set := map[string]bool{}
	for _, entry := range strings.Fields(scope) {
		set[entry] = true
	}
	return set
}

func TestSetupCreatesAppThenAuthorizesItWithThePreset(t *testing.T) {
	h := newHarness(t)
	login, err := h.service.BeginSetup(h.ctx, "user_owner", store.SetupExternalAccountInput{Provider: "feishu"})
	if err != nil {
		t.Fatalf("begin setup: %v", err)
	}
	if login.Status != "pending" || login.Phase != "register" || login.AppID != "" ||
		login.VerificationURIComplete != h.fake.BaseURL()+"/page/cli?user_code=REG-0001" || login.UserCode != "REG-0001" {
		t.Fatalf("setup did not start at registration: %+v", login)
	}

	h.fake.ApproveRegistration()
	authorizing := h.awaitPhase(login.ID, "authorize")
	if authorizing.Status != "pending" || authorizing.App == nil || authorizing.AppID != authorizing.App.ID {
		t.Fatalf("setup did not move on to authorization: %+v", authorizing)
	}
	if !strings.HasPrefix(authorizing.VerificationURIComplete, h.fake.BaseURL()+"/verify?user_code=FAKE-") {
		t.Fatalf("authorization shows the registration page again: %+v", authorizing)
	}
	app, err := h.store.GetExternalProviderApp(h.ctx, authorizing.AppID)
	if err != nil {
		t.Fatalf("registered app not saved: %v", err)
	}
	if app.OwnerUserID != "user_owner" || app.Visibility != store.ExternalAppPersonal || app.CreatedVia != "registered" ||
		app.ClientID != "cli_fake" || app.BaseURL != h.fake.BaseURL() || !h.service.hasSecret(h.ctx, AppSecretID(app.ID)) {
		t.Fatalf("registered app saved wrongly: %+v", app)
	}
	asked := requested(h.fake.RequestedScope())
	for _, want := range []string{"offline_access", "auth:user.id:read", "docx:document:create", "search:docs:read", "im:chat:create", "base:record:read"} {
		if !asked[want] {
			t.Fatalf("authorization did not ask for %s: %q", want, h.fake.RequestedScope())
		}
	}
	for _, approval := range feishuApprovalScopes {
		if asked[approval] {
			t.Fatalf("authorization asked for approval scope %s without opt-in", approval)
		}
	}

	h.fake.Approve()
	done := h.awaitLogin(login.ID)
	account := done.Account.deref(t)
	if done.Status != "complete" || account.AppID != app.ID || account.Status != store.ExternalAccountReady || len(done.MissingScopes) != 0 || done.ScopeApplyURL != "" {
		t.Fatalf("setup did not connect the account through the new app: %+v", done.ExternalAccountLogin)
	}
}

func TestSetupFollowsALarkTenant(t *testing.T) {
	h := newHarness(t)
	h.fake.RegistrationTenantBrand = "lark"
	login, err := h.service.BeginSetup(h.ctx, "user_owner", store.SetupExternalAccountInput{Provider: "feishu", Brand: "lark"})
	if err != nil {
		t.Fatalf("begin setup: %v", err)
	}
	if !strings.HasPrefix(login.VerificationURIComplete, h.fake.BaseURL()+"/lark/page/cli?") {
		t.Fatalf("a Lark setup should show the Lark page: %s", login.VerificationURIComplete)
	}
	h.fake.ApproveRegistration()
	authorizing := h.awaitPhase(login.ID, "authorize")
	if authorizing.App == nil || authorizing.App.BaseURL != h.fake.BaseURL()+"/lark" {
		t.Fatalf("Lark app should keep the Lark base URL: %+v", authorizing)
	}
	if h.fake.RegistrationPolls(FeishuBrandFeishu) == 0 || h.fake.RegistrationPolls(FeishuBrandLark) == 0 {
		t.Fatalf("polling should start on Feishu and move to Lark: feishu=%d lark=%d",
			h.fake.RegistrationPolls(FeishuBrandFeishu), h.fake.RegistrationPolls(FeishuBrandLark))
	}
	h.fake.Approve()
	if done := h.awaitLogin(login.ID); done.Status != "complete" {
		t.Fatalf("Lark setup did not complete: %+v", done.ExternalAccountLogin)
	}
}

func TestSetupDeclinedCreatesNoApp(t *testing.T) {
	h := newHarness(t)
	h.fake.RegistrationDenied = true
	login, err := h.service.BeginSetup(h.ctx, "user_owner", store.SetupExternalAccountInput{Provider: "feishu"})
	if err != nil {
		t.Fatalf("begin setup: %v", err)
	}
	done := h.awaitLogin(login.ID)
	if done.Status != "failed" || done.Error != ErrRegistrationDenied.Error() || done.App != nil {
		t.Fatalf("a declined setup should fail without an app: %+v", done.ExternalAccountLogin)
	}
	apps, err := h.service.ListApps(h.ctx, "user_owner")
	if err != nil || len(apps) != 1 {
		t.Fatalf("a declined setup left apps behind: %v %+v", err, apps)
	}
}

func TestSetupNeedsTheSecretStoreAndIntegrations(t *testing.T) {
	h := newHarness(t)
	h.service.secrets = nil
	if _, err := h.service.BeginSetup(h.ctx, "user_owner", store.SetupExternalAccountInput{Provider: "feishu"}); !errors.Is(err, ErrSecretsNotConfigured) {
		t.Fatalf("setup without a secret store: %v", err)
	}
}

func TestLoginWithoutScopesAsksForThePresetAndOptInApprovalScopes(t *testing.T) {
	h := newHarness(t)
	login, err := h.service.BeginLogin(h.ctx, "user_owner", h.app, store.ConnectExternalAccountInput{AppID: h.app.ID, IncludeApprovalScopes: true})
	if err != nil {
		t.Fatalf("begin login: %v", err)
	}
	asked := requested(h.fake.RequestedScope())
	for _, want := range append(FeishuPresetScopes(true), feishuAlwaysScopes...) {
		if !asked[want] {
			t.Fatalf("login did not ask for %s", want)
		}
	}
	if len(login.RequestedScopes) != len(asked) {
		t.Fatalf("view lists %d scopes, request had %d", len(login.RequestedScopes), len(asked))
	}
}

func TestLoginReportsScopesFeishuDidNotGrant(t *testing.T) {
	h := newHarness(t)
	h.fake.GrantScopes = []string{"auth:user.id:read", "docx:document:readonly"}
	login, err := h.service.BeginLogin(h.ctx, "user_owner", h.app, store.ConnectExternalAccountInput{
		AppID: h.app.ID, Scopes: []string{"docx:document:readonly", "search:docs:read", "im:message"},
	})
	if err != nil {
		t.Fatalf("begin login: %v", err)
	}
	h.fake.Approve()
	done := h.awaitLogin(login.ID)
	if done.Status != "complete" || strings.Join(done.MissingScopes, " ") != "search:docs:read im:message" {
		t.Fatalf("missing scopes not reported: %+v", done.ExternalAccountLogin)
	}
	want := h.fake.BaseURL() + "/page/scope-apply?clientID=cli_fake&scopes=search%3Adocs%3Aread%2Cim%3Amessage"
	if done.ScopeApplyURL != want {
		t.Fatalf("scope apply link %q, want %q", done.ScopeApplyURL, want)
	}
}

func TestFeishuPresetIsDistinctAndDescribed(t *testing.T) {
	seen := map[string]bool{}
	for _, scope := range FeishuPresetScopes(true) {
		if seen[scope] || strings.TrimSpace(scope) != scope || scope == "" {
			t.Fatalf("preset scope %q repeated or malformed", scope)
		}
		seen[scope] = true
	}
	described := (&Feishu{}).Describe()
	if !described.RegistersApps || described.ScopePreset == nil || len(described.ScopePreset.Scopes) != len(FeishuPresetScopes(false)) ||
		len(described.ScopePreset.ApprovalScopes) != len(feishuApprovalScopes) || described.ScopePreset.Source == "" {
		t.Fatalf("provider description lacks the preset: %+v", described)
	}
}

func TestSetupWithNamedScopesAsksForThoseOnly(t *testing.T) {
	h := newHarness(t)
	login, err := h.service.BeginSetup(h.ctx, "user_owner", store.SetupExternalAccountInput{Provider: "feishu", Scopes: []string{"docx:document:readonly"}})
	if err != nil {
		t.Fatalf("begin setup: %v", err)
	}
	h.fake.ApproveRegistration()
	if view := h.awaitPhase(login.ID, "authorize"); view.Phase != "authorize" {
		t.Fatalf("setup did not reach authorization: %+v", view)
	}
	if got := h.fake.RequestedScope(); got != "docx:document:readonly offline_access auth:user.id:read" {
		t.Fatalf("setup asked for %q", got)
	}
}
