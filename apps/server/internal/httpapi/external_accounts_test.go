package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/externalaccounts"
	"github.com/foundry-dev/foundry/apps/server/internal/sqlitestore"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// externalAccountsFixture: alice (the first admin) and bob (a member) each
// paired a device with one workspace; the server holds a secret store key
// and talks to a fake Feishu.
type externalAccountsFixture struct {
	t              *testing.T
	server         *Server
	handler        http.Handler
	db             *sqlitestore.Store
	fake           *externalaccounts.FakeFeishu
	alice, bob     string
	aliceID, bobID string
	aliceDevice    string
	bobDevice      string
}

func newExternalAccountsFixture(t *testing.T) *externalAccountsFixture {
	t.Helper()
	dir := t.TempDir()
	db, err := sqlitestore.OpenWithOptions(filepath.Join(dir, "foundry.db"), sqlitestore.Options{SecretKeyPath: filepath.Join(dir, "secret.key")})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	server := NewServerWithOptions(db, ServerOptions{AllowedOrigin: accountsTestOrigin})
	handler := server.Routes()
	f := &externalAccountsFixture{t: t, server: server, handler: handler, db: db}
	f.alice = setupOwner(t, server, handler)
	f.bob = inviteAndJoin(t, handler, f.alice, store.RoleMember, "bob")
	_, f.aliceDevice = pairOverHTTP(t, handler, f.alice, "machine-alice", "dev_alice")
	_, f.bobDevice = pairOverHTTP(t, handler, f.bob, "machine-bob", "dev_bob")
	ctx := context.Background()
	for _, register := range []struct{ device, workspace, agent string }{
		{"dev_alice", "ws_alice", "agent_alice"}, {"dev_bob", "ws_bob", "agent_bob"},
	} {
		if err := db.RegisterDaemon(ctx, store.DaemonRegistration{
			Device:    store.DeviceProjection{ID: register.device, Label: "Device", Status: "connected", LastSeenLabel: "online"},
			Workspace: store.WorkspaceProjection{ID: register.workspace, Name: "W", LocalPath: "/tmp/" + register.workspace},
			Agents: []store.AgentProjection{{
				ID: register.agent, WorkspaceID: register.workspace, DeviceID: register.device, Provider: "claude", Status: "healthy",
				AuthMode: "local_config", SecretStored: "local", ConfigScope: "workspace", ConfigLabel: "local", LastSeenLabel: "online",
			}},
		}); err != nil {
			t.Fatal(err)
		}
	}
	var users []store.User
	_ = json.Unmarshal(doAuthCall(t, handler, authCall{method: http.MethodGet, path: "/api/users", cookie: f.alice, origin: accountsTestOrigin}).Body.Bytes(), &users)
	for _, user := range users {
		switch user.Username {
		case "owner":
			f.aliceID = user.ID
		case "bob":
			f.bobID = user.ID
		}
	}
	f.fake = externalaccounts.NewFakeFeishu("cli_fake", "secret_fake")
	t.Cleanup(f.fake.Close)
	service := externalaccounts.NewService(db, db, externalaccounts.NewRegistry(f.fake.Adapter()))
	service.MinPollInterval = 5 * time.Millisecond
	service.Logf = t.Logf
	server.externalAccounts = service
	server.hub.externalAccounts = service
	return f
}

func (f *externalAccountsFixture) as(session, method, path, body string) authCall {
	return authCall{method: method, path: path, body: body, cookie: session, origin: accountsTestOrigin}
}

func (f *externalAccountsFixture) call(session, method, path, body string, want int, label string, into any) {
	f.t.Helper()
	recorder := doAuthCall(f.t, f.handler, f.as(session, method, path, body))
	expectStatus(f.t, recorder, want, label)
	if into != nil {
		// Decode into a zero value: json.Unmarshal merges into a reused
		// struct, keeping fields the answer omits.
		target := reflect.ValueOf(into).Elem()
		target.Set(reflect.Zero(target.Type()))
		if err := json.Unmarshal(recorder.Body.Bytes(), into); err != nil {
			f.t.Fatalf("%s: decode %s: %v", label, recorder.Body.String(), err)
		}
	}
}

// createApp pastes the fake app for alice.
func (f *externalAccountsFixture) createApp(session string, visibility string) store.ExternalProviderApp {
	f.t.Helper()
	var app store.ExternalProviderApp
	body := `{"provider":"feishu","label":"Org app","clientId":"cli_fake","clientSecret":"secret_fake","baseUrl":"` + f.fake.BaseURL() + `"`
	if visibility != "" {
		body += `,"visibility":"` + visibility + `"`
	}
	f.call(session, http.MethodPost, "/api/external-apps", body+"}", http.StatusCreated, "create app", &app)
	return app
}

// connect runs the login for session through app and returns the account.
func (f *externalAccountsFixture) connect(session string, app store.ExternalProviderApp) store.ExternalAccount {
	f.t.Helper()
	f.fake.Approved = false
	var login store.ExternalAccountLogin
	f.call(session, http.MethodPost, "/api/external-accounts/connect",
		`{"appId":"`+app.ID+`","scopes":["docx:document:readonly"]}`, http.StatusAccepted, "connect", &login)
	if login.Status != "pending" || login.UserCode == "" || !strings.Contains(login.VerificationURIComplete, login.UserCode) {
		f.t.Fatalf("login not pending with a code: %+v", login)
	}
	f.fake.Approve()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		var current store.ExternalAccountLogin
		f.call(session, http.MethodGet, "/api/external-accounts/logins/"+login.ID, "", http.StatusOK, "poll login", &current)
		if current.Status == "complete" && current.Account != nil {
			return *current.Account
		}
		if current.Status == "failed" {
			f.t.Fatalf("login failed: %s", current.Error)
		}
		time.Sleep(5 * time.Millisecond)
	}
	f.t.Fatal("login did not complete")
	return store.ExternalAccount{}
}

func TestExternalAccountsConnectFlowAndOwnership(t *testing.T) {
	f := newExternalAccountsFixture(t)
	created := doAuthCall(t, f.handler, f.as(f.alice, http.MethodPost, "/api/external-apps",
		`{"provider":"feishu","label":"Org app","clientId":"cli_fake","clientSecret":"secret_fake","baseUrl":"`+f.fake.BaseURL()+`"}`))
	expectStatus(t, created, http.StatusCreated, "create app")
	if strings.Contains(created.Body.String(), "secret_fake") || !strings.Contains(created.Body.String(), `"hasSecret":true`) {
		t.Fatalf("app response leaks or lacks the secret flag: %s", created.Body.String())
	}
	var app store.ExternalProviderApp
	_ = json.Unmarshal(created.Body.Bytes(), &app)

	var view store.ExternalAccountsView
	f.call(f.alice, http.MethodGet, "/api/external-accounts", "", http.StatusOK, "alice's view", &view)
	if !view.SecretsConfigured || len(view.Apps) != 1 || len(view.Accounts) != 0 || len(view.Providers) != 1 || view.Providers[0].Kind != "feishu" {
		t.Fatalf("view before connecting: %+v", view)
	}
	// Bob cannot see or use alice's personal app.
	f.call(f.bob, http.MethodGet, "/api/external-accounts", "", http.StatusOK, "bob's view", &view)
	if len(view.Apps) != 0 {
		t.Fatalf("bob sees alice's app: %+v", view.Apps)
	}
	f.call(f.bob, http.MethodPost, "/api/external-accounts/connect", `{"appId":"`+app.ID+`"}`, http.StatusNotFound, "bob connects through alice's app", nil)

	account := f.connect(f.alice, app)
	if account.OwnerUserID != f.aliceID || account.Status != store.ExternalAccountReady || account.DisplayName != "Fake Person" {
		t.Fatalf("account: %+v", account)
	}
	if scope := f.fake.RequestedScope(); !strings.Contains(scope, "offline_access") || !strings.Contains(scope, "docx:document:readonly") {
		t.Fatalf("scope requested: %q", scope)
	}
	// No response of the person-facing routes carries a token.
	recorder := doAuthCall(t, f.handler, f.as(f.alice, http.MethodGet, "/api/external-accounts/"+account.ID, ""))
	expectStatus(t, recorder, http.StatusOK, "detail")
	if strings.Contains(recorder.Body.String(), "fake-signature") {
		t.Fatal("detail carries a token")
	}
	var detail store.ExternalAccountDetail
	_ = json.Unmarshal(recorder.Body.Bytes(), &detail)
	if len(detail.Events) == 0 || detail.Events[0].Kind != "connected" {
		t.Fatalf("detail events: %+v", detail.Events)
	}
	// Others see nothing of it.
	f.call(f.bob, http.MethodGet, "/api/external-accounts/"+account.ID, "", http.StatusNotFound, "bob reads alice's account", nil)
	f.call(f.bob, http.MethodPatch, "/api/external-accounts/"+account.ID, `{"keepAlive":false}`, http.StatusNotFound, "bob edits alice's account", nil)
	f.call(f.bob, http.MethodDelete, "/api/external-accounts/"+account.ID, "", http.StatusNotFound, "bob disconnects alice's account", nil)

	var updated store.ExternalAccount
	f.call(f.alice, http.MethodPatch, "/api/external-accounts/"+account.ID, `{"keepAlive":false,"label":"Work Feishu"}`, http.StatusOK, "keep-alive off", &updated)
	if updated.KeepAlive || updated.Label != "Work Feishu" {
		t.Fatalf("update not applied: %+v", updated)
	}
	f.call(f.alice, http.MethodPost, "/api/external-accounts/"+account.ID+"/refresh", "{}", http.StatusOK, "refresh now", &updated)
	if updated.LastRefreshBy != "manual" || f.fake.Refreshes() != 1 {
		t.Fatalf("manual refresh: %+v refreshes=%d", updated, f.fake.Refreshes())
	}
}

func TestExternalAccountWorkspaceBindingsAndVisibility(t *testing.T) {
	f := newExternalAccountsFixture(t)
	app := f.createApp(f.alice, "")
	account := f.connect(f.alice, app)

	var view store.WorkspaceExternalAccounts
	f.call(f.alice, http.MethodGet, "/api/workspaces/ws_alice/external-accounts", "", http.StatusOK, "alice's tab", &view)
	if len(view.Bindings) != 0 || len(view.Accounts) != 1 || view.Accounts[0].ID != account.ID {
		t.Fatalf("tab before binding should offer alice's unbound account: %+v", view)
	}
	f.call(f.alice, http.MethodPut, "/api/workspaces/ws_alice/external-accounts", `{"accountIds":["`+account.ID+`"]}`, http.StatusOK, "bind", &view)
	if len(view.Bindings) != 1 || view.Bindings[0].AccountID != account.ID || view.Bindings[0].GrantedBy != f.aliceID {
		t.Fatalf("binding: %+v", view)
	}
	// Bob is not in ws_alice: nothing. As a viewer he sees what is bound,
	// without the identity, and cannot bind.
	f.call(f.bob, http.MethodGet, "/api/workspaces/ws_alice/external-accounts", "", http.StatusNotFound, "stranger reads the tab", nil)
	f.call(f.alice, http.MethodPost, "/api/workspaces/ws_alice/members", `{"username":"bob","role":"viewer"}`, http.StatusNoContent, "add bob", nil)
	f.call(f.bob, http.MethodGet, "/api/workspaces/ws_alice/external-accounts", "", http.StatusOK, "viewer reads the tab", &view)
	if len(view.Accounts) != 1 || view.Accounts[0].Subject != "" || view.Accounts[0].DisplayName != "" || view.Accounts[0].Label != account.Label {
		t.Fatalf("viewer sees the identity: %+v", view.Accounts)
	}
	f.call(f.bob, http.MethodPut, "/api/workspaces/ws_alice/external-accounts", `{"accountIds":[]}`, http.StatusForbidden, "viewer binds", nil)
	// Bob cannot bind alice's account into his own workspace either.
	f.call(f.bob, http.MethodPut, "/api/workspaces/ws_bob/external-accounts", `{"accountIds":["`+account.ID+`"]}`, http.StatusNotFound, "bob binds alice's account", nil)
	// Unbinding records an audit line.
	f.call(f.alice, http.MethodPut, "/api/workspaces/ws_alice/external-accounts", `{"accountIds":[]}`, http.StatusOK, "unbind", &view)
	events, _ := f.db.ListExternalAccountEvents(context.Background(), account.ID, 10)
	if events[0].Kind != "unbound" || events[1].Kind != "bound" || events[0].Detail != "ws_alice" {
		t.Fatalf("binding audit: %+v", events)
	}
}

func TestExternalAccountDispatchAndMintFollowOwnerDeviceRule(t *testing.T) {
	f := newExternalAccountsFixture(t)
	app := f.createApp(f.alice, "")
	account := f.connect(f.alice, app)
	ctx := context.Background()
	if err := f.db.SetWorkspaceExternalAccounts(ctx, "ws_alice", f.aliceID, []string{account.ID}); err != nil {
		t.Fatal(err)
	}
	session, err := f.db.CreateAgentSession(ctx, store.CreateAgentSessionInput{
		CreatedByUserID: f.aliceID, WorkspaceID: "ws_alice", AgentID: "agent_alice", Provider: "claude", Prompt: "export the doc", Source: "chat",
	})
	if err != nil {
		t.Fatal(err)
	}
	alice, _ := f.server.accounts.GetUser(ctx, f.aliceID)
	bob, _ := f.server.accounts.GetUser(ctx, f.bobID)

	// Dispatch: alice's device carries the material; bob's device (were the
	// session ever there) gets nothing; a sandboxed role gets nothing.
	materials := f.server.hub.sessionExternalAccounts(ctx, session, Actor{Kind: ActorDaemon, DeviceID: "dev_alice", Account: &alice})
	if len(materials) != 1 || materials[0].AccountID != account.ID || materials[0].AccessToken == "" || materials[0].ClientSecret != "secret_fake" || materials[0].Tool != "feishu-cli" {
		t.Fatalf("materials for the owner's device: %+v", materials)
	}
	if got := f.server.hub.sessionExternalAccounts(ctx, session, Actor{Kind: ActorDaemon, DeviceID: "dev_bob", Account: &bob}); len(got) != 0 {
		t.Fatalf("bob's device received alice's account: %+v", got)
	}
	execution := session
	execution.Role = store.AgentSessionRoleIssueExecution
	if got := f.server.hub.sessionExternalAccounts(ctx, execution, Actor{Kind: ActorDaemon, DeviceID: "dev_alice", Account: &alice}); len(got) != 0 {
		t.Fatalf("a sandboxed role received materials: %+v", got)
	}
	bobsSession := session
	bobsSession.CreatedByUserID = f.bobID
	if got := f.server.hub.sessionExternalAccounts(ctx, bobsSession, Actor{Kind: ActorDaemon, DeviceID: "dev_alice", Account: &alice}); len(got) != 0 {
		t.Fatalf("another person's session on alice's device received her account: %+v", got)
	}

	// Re-mint over HTTP: the device that runs the session, for its session.
	mint := func(credential, sessionID string) *httptest.ResponseRecorder {
		return doAuthCall(t, f.handler, deviceCall(http.MethodPost, "/api/external-accounts/"+account.ID+"/mint", `{"sessionId":"`+sessionID+`"}`, credential))
	}
	minted := mint(f.aliceDevice, session.ID)
	expectStatus(t, minted, http.StatusOK, "alice's device re-mints")
	var token store.ExternalAccountToken
	_ = json.Unmarshal(minted.Body.Bytes(), &token)
	if token.AccessToken == "" || !f.fake.AccessTokenValid(token.AccessToken) || strings.Contains(minted.Body.String(), f.fake.CurrentRefreshToken()) {
		t.Fatalf("mint answer: %s", minted.Body.String())
	}
	expectStatus(t, mint(f.bobDevice, session.ID), http.StatusForbidden, "bob's device re-mints alice's session")
	expectStatus(t, mint(f.aliceDevice, "sess_missing"), http.StatusNotFound, "re-mint for an unknown session")
	expectStatus(t, doAuthCall(t, f.handler, f.as(f.alice, http.MethodPost, "/api/external-accounts/"+account.ID+"/mint", `{"sessionId":"`+session.ID+`"}`)),
		http.StatusUnauthorized, "a person calls the device route")

	// Stop using now: the grant (its refresh token) is revoked at Feishu and
	// re-mints fail; a token a running session already holds lives until it
	// expires (design: "Sessions lose access within 2 hours").
	var revoked store.ExternalAccount
	f.call(f.alice, http.MethodPost, "/api/external-accounts/"+account.ID+"/revoke", "{}", http.StatusOK, "revoke", &revoked)
	if revoked.Status != store.ExternalAccountRevoked || len(f.fake.Revoked()) != 1 {
		t.Fatalf("revoke: %+v revoked=%v", revoked, f.fake.Revoked())
	}
	expectStatus(t, mint(f.aliceDevice, session.ID), http.StatusConflict, "re-mint after revoke")
	f.call(f.alice, http.MethodDelete, "/api/external-accounts/"+account.ID, "", http.StatusOK, "disconnect", nil)
	f.call(f.alice, http.MethodGet, "/api/external-accounts/"+account.ID, "", http.StatusNotFound, "read after disconnect", nil)
	if bindings, _ := f.db.ListWorkspaceExternalAccounts(ctx, "ws_alice"); len(bindings) != 0 {
		t.Fatalf("bindings outlived the account: %+v", bindings)
	}
}

func TestExternalAccountInstanceAppNeedsAdmin(t *testing.T) {
	f := newExternalAccountsFixture(t)
	f.call(f.bob, http.MethodPost, "/api/external-apps",
		`{"provider":"feishu","clientId":"cli_fake","clientSecret":"secret_fake","visibility":"instance","baseUrl":"`+f.fake.BaseURL()+`"}`,
		http.StatusForbidden, "member creates an instance app", nil)
	app := f.createApp(f.alice, "instance")
	var view store.ExternalAccountsView
	f.call(f.bob, http.MethodGet, "/api/external-accounts", "", http.StatusOK, "bob's view", &view)
	if len(view.Apps) != 1 || view.Apps[0].ID != app.ID {
		t.Fatalf("bob does not see the instance app: %+v", view.Apps)
	}
	account := f.connect(f.bob, app)
	if account.OwnerUserID != f.bobID {
		t.Fatalf("bob's account owned by %s", account.OwnerUserID)
	}
	f.call(f.alice, http.MethodDelete, "/api/external-apps/"+app.ID, "", http.StatusConflict, "delete an app in use", nil)
	f.call(f.bob, http.MethodDelete, "/api/external-accounts/"+account.ID, "", http.StatusOK, "bob disconnects", nil)
	f.call(f.bob, http.MethodDelete, "/api/external-apps/"+app.ID, "", http.StatusNotFound, "member deletes the admin's app", nil)
	f.call(f.alice, http.MethodDelete, "/api/external-apps/"+app.ID, "", http.StatusOK, "admin deletes the unused app", nil)
}

func TestExternalAccountsWithoutSecretStore(t *testing.T) {
	server, handler := newAccountsTestServer(t)
	alice := setupOwner(t, server, handler)
	var view store.ExternalAccountsView
	recorder := doAuthCall(t, handler, authCall{method: http.MethodGet, path: "/api/external-accounts", cookie: alice, origin: accountsTestOrigin})
	expectStatus(t, recorder, http.StatusOK, "view without a key")
	_ = json.Unmarshal(recorder.Body.Bytes(), &view)
	if view.SecretsConfigured {
		t.Fatal("secrets reported configured without a key")
	}
	recorder = doAuthCall(t, handler, authCall{method: http.MethodPost, path: "/api/external-apps", cookie: alice, origin: accountsTestOrigin,
		body: `{"provider":"feishu","clientId":"cli","clientSecret":"sec"}`})
	expectStatus(t, recorder, http.StatusPreconditionFailed, "app without a key is refused, not stored in the clear")
}
