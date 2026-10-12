package httpapi

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/externalaccounts"
	"github.com/foundry-dev/foundry/apps/server/internal/integrations"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// External accounts: a person's logins at third-party platforms (Feishu
// through feishu-cli), connected and refreshed by the server, bound to
// workspaces, and handed to sessions as short-lived access tokens. The
// rules a request must pass:
//
//   - an account is personal: only its owner sees, changes, binds or
//     disconnects it (externalAccountOwner);
//   - a workspace's bindings are read by viewers and set by maintainers,
//     and a person binds only their own accounts;
//   - a session gets an account only when the account owner started it on
//     a device the owner owns (externalaccounts.Eligible), the UserFiles
//     rule of Issues;
//   - no credential reaches a device: run_session carries gateway handles
//     that stand in for the app secret and the access token, and feishu-cli
//     reaches Feishu through the server's gateway
//     (external_accounts_gateway.go), which holds the real ones.

// newExternalAccountService wires the service over the store when it keeps
// external accounts; nil otherwise (the routes then answer 503).
func newExternalAccountService(st store.Store, secrets secretKeeper, sw *integrations.Switch) *externalaccounts.Service {
	accounts, ok := st.(store.ExternalAccountStore)
	if !ok {
		return nil
	}
	var keeper externalaccounts.SecretKeeper
	if secrets != nil {
		keeper = secrets
	}
	service := externalaccounts.NewService(accounts, keeper, nil)
	service.Integrations = sw
	return service
}

// RunExternalAccountKeepAlive refreshes, until ctx ends, the accounts that
// asked to be kept alive before their refresh tokens expire.
func (s *Server) RunExternalAccountKeepAlive(ctx context.Context) {
	if s.externalAccounts == nil {
		return
	}
	s.externalAccounts.RunKeepAlive(ctx)
}

var errExternalAccountsUnavailable = errors.New("external accounts are not available on this server")

func (s *Server) externalAccountService(w http.ResponseWriter) (*externalaccounts.Service, bool) {
	if s.externalAccounts == nil {
		writeError(w, http.StatusServiceUnavailable, errExternalAccountsUnavailable.Error())
		return nil, false
	}
	return s.externalAccounts, true
}

// personActor is the signed-in person behind a request; devices and agents
// cannot manage accounts.
func personActor(w http.ResponseWriter, r *http.Request) (Actor, bool) {
	actor := actorFromContext(r.Context())
	if actor.Kind != ActorAccount || actor.AccountID() == "" {
		writeForbidden(w, "Connectors are managed by a signed-in person.")
		return Actor{}, false
	}
	return actor, true
}

// externalAccountOwner guards an account by its owner; anyone else sees 404.
func externalAccountOwner(name string) accessRule {
	return accessRule{kind: "external-account-owner", check: func(s *Server, w http.ResponseWriter, r *http.Request) bool {
		_, ok := s.requireExternalAccountOwner(w, r, strings.TrimSpace(r.PathValue(name)))
		return ok
	}}
}

func (s *Server) requireExternalAccountOwner(w http.ResponseWriter, r *http.Request, accountID string) (store.ExternalAccount, bool) {
	accounts, ok := s.store.(store.ExternalAccountStore)
	if !ok || s.externalAccounts == nil {
		writeError(w, http.StatusServiceUnavailable, errExternalAccountsUnavailable.Error())
		return store.ExternalAccount{}, false
	}
	actor := actorFromContext(r.Context())
	account, err := accounts.GetExternalAccount(r.Context(), accountID)
	if err != nil || actor.Kind != ActorAccount || actor.AccountID() == "" || account.OwnerUserID != actor.AccountID() {
		writeError(w, http.StatusNotFound, "external account not found")
		return store.ExternalAccount{}, false
	}
	return account, true
}

func writeExternalAccountError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, externalaccounts.ErrSecretsNotConfigured):
		writeError(w, http.StatusPreconditionFailed, err.Error())
	case errors.Is(err, integrations.ErrOff):
		writeError(w, http.StatusServiceUnavailable, err.Error())
	case errors.Is(err, externalaccounts.ErrAppInUse), errors.Is(err, externalaccounts.ErrAccountUnusable):
		writeError(w, http.StatusConflict, err.Error())
	case errors.Is(err, store.ErrExternalAppNotFound), errors.Is(err, store.ErrExternalAccountNotFound):
		writeError(w, http.StatusNotFound, err.Error())
	default:
		var refreshErr *externalaccounts.RefreshError
		if errors.As(err, &refreshErr) {
			writeError(w, http.StatusBadGateway, err.Error())
			return
		}
		writeResult(w, nil, err)
	}
}

// handleExternalAccountsView is the External accounts page: the providers,
// the apps the person may connect through, and their own accounts.
func (s *Server) handleExternalAccountsView(w http.ResponseWriter, r *http.Request) {
	service, ok := s.externalAccountService(w)
	if !ok {
		return
	}
	actor, ok := personActor(w, r)
	if !ok {
		return
	}
	apps, err := service.ListApps(r.Context(), actor.AccountID())
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	accounts, err := service.Accounts(r.Context(), actor.AccountID())
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	writeJSON(w, http.StatusOK, store.ExternalAccountsView{
		Providers: service.Providers(), Apps: apps, Accounts: accounts, SecretsConfigured: service.SecretsConfigured(),
	})
}

// handleCreateExternalApp stores a pasted provider app. An instance-wide
// app (every account may connect through it) needs the Admin role.
func (s *Server) handleCreateExternalApp(w http.ResponseWriter, r *http.Request) {
	service, ok := s.externalAccountService(w)
	if !ok {
		return
	}
	actor, ok := personActor(w, r)
	if !ok {
		return
	}
	var input store.SaveExternalProviderAppInput
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	if input.Visibility == store.ExternalAppInstance {
		scope, err := s.requestScope(r)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "resolve access")
			return
		}
		if !scope.admin {
			writeForbidden(w, "An instance-wide app needs the instance Admin role.")
			return
		}
	}
	app, err := service.CreateApp(r.Context(), actor.AccountID(), input)
	if err != nil {
		if errors.Is(err, externalaccounts.ErrSecretsNotConfigured) {
			writeExternalAccountError(w, err)
			return
		}
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, app)
}

// handleDeleteExternalApp removes an app its owner (or an admin, for an
// instance app) no longer wants; apps with accounts stay.
func (s *Server) handleDeleteExternalApp(w http.ResponseWriter, r *http.Request) {
	service, ok := s.externalAccountService(w)
	if !ok {
		return
	}
	actor, ok := personActor(w, r)
	if !ok {
		return
	}
	accounts := s.store.(store.ExternalAccountStore)
	app, err := accounts.GetExternalProviderApp(r.Context(), strings.TrimSpace(r.PathValue("id")))
	if err != nil {
		writeError(w, http.StatusNotFound, "external provider app not found")
		return
	}
	scope, err := s.requestScope(r)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "resolve access")
		return
	}
	if app.OwnerUserID != actor.AccountID() && !(scope.admin && app.Visibility == store.ExternalAppInstance) {
		writeError(w, http.StatusNotFound, "external provider app not found")
		return
	}
	routes, err := s.store.ListFeishuBotRoutes(r.Context(), store.FeishuBotRouteFilter{AppID: app.ID})
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	if len(routes) > 0 {
		writeError(w, http.StatusConflict, "workspace Feishu bots run on this app; remove them from those workspaces first")
		return
	}
	if err := service.DeleteApp(r.Context(), app); err != nil {
		writeExternalAccountError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}

// handleConnectExternalAccount starts a device-flow login through one of
// the apps the person may use. The answer is what to show: the link, the
// code, the expiry; the person polls the login route for the outcome.
func (s *Server) handleConnectExternalAccount(w http.ResponseWriter, r *http.Request) {
	service, ok := s.externalAccountService(w)
	if !ok {
		return
	}
	actor, ok := personActor(w, r)
	if !ok {
		return
	}
	var input store.ConnectExternalAccountInput
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	accounts := s.store.(store.ExternalAccountStore)
	app, err := accounts.GetExternalProviderApp(r.Context(), strings.TrimSpace(input.AppID))
	if err != nil || (app.OwnerUserID != actor.AccountID() && app.Visibility != store.ExternalAppInstance) {
		writeError(w, http.StatusNotFound, "external provider app not found")
		return
	}
	login, err := service.BeginLogin(r.Context(), actor.AccountID(), app, input)
	if err != nil {
		if errors.Is(err, externalaccounts.ErrSecretsNotConfigured) || errors.Is(err, integrations.ErrOff) {
			writeExternalAccountError(w, err)
			return
		}
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusAccepted, login)
}

// handleSetupExternalAccount starts a sign-in that first has the provider
// create an app for the person, then authorizes it; nothing is pasted.
// The person polls the login route through both phases.
func (s *Server) handleSetupExternalAccount(w http.ResponseWriter, r *http.Request) {
	service, ok := s.externalAccountService(w)
	if !ok {
		return
	}
	actor, ok := personActor(w, r)
	if !ok {
		return
	}
	var input store.SetupExternalAccountInput
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	registers := false
	for _, provider := range service.Providers() {
		registers = registers || (provider.Kind == strings.TrimSpace(input.Provider) && provider.RegistersApps)
	}
	if !registers {
		writeError(w, http.StatusBadRequest, "that provider cannot create an app during sign-in")
		return
	}
	login, err := service.BeginSetup(r.Context(), actor.AccountID(), input)
	if err != nil {
		if errors.Is(err, externalaccounts.ErrSecretsNotConfigured) || errors.Is(err, integrations.ErrOff) {
			writeExternalAccountError(w, err)
			return
		}
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusAccepted, login)
}

// handleExternalAccountLogin reads a login the person started.
func (s *Server) handleExternalAccountLogin(w http.ResponseWriter, r *http.Request) {
	service, ok := s.externalAccountService(w)
	if !ok {
		return
	}
	actor, ok := personActor(w, r)
	if !ok {
		return
	}
	login, found := service.Login(strings.TrimSpace(r.PathValue("id")), actor.AccountID())
	if !found {
		writeError(w, http.StatusNotFound, "login not found")
		return
	}
	writeJSON(w, http.StatusOK, login)
}

func (s *Server) handleGetExternalAccount(w http.ResponseWriter, r *http.Request) {
	service, ok := s.externalAccountService(w)
	if !ok {
		return
	}
	account, ok := s.requireExternalAccountOwner(w, r, strings.TrimSpace(r.PathValue("id")))
	if !ok {
		return
	}
	events, err := s.store.(store.ExternalAccountStore).ListExternalAccountEvents(r.Context(), account.ID, 30)
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	accounts, err := service.Accounts(r.Context(), account.OwnerUserID)
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	for _, current := range accounts {
		if current.ID == account.ID {
			account = current
		}
	}
	writeJSON(w, http.StatusOK, store.ExternalAccountDetail{Account: account, Events: events})
}

// handleUpdateExternalAccount renames or switches keep-alive.
func (s *Server) handleUpdateExternalAccount(w http.ResponseWriter, r *http.Request) {
	service, ok := s.externalAccountService(w)
	if !ok {
		return
	}
	account, ok := s.requireExternalAccountOwner(w, r, strings.TrimSpace(r.PathValue("id")))
	if !ok {
		return
	}
	var update store.ExternalAccountUpdate
	if !decodeJSONRequest(w, r, &update) {
		return
	}
	saved, err := service.Update(r.Context(), account, update, account.OwnerUserID)
	if err != nil {
		writeExternalAccountError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, saved)
}

// handleRefreshExternalAccount refreshes now, visibly, at the owner's request.
func (s *Server) handleRefreshExternalAccount(w http.ResponseWriter, r *http.Request) {
	service, ok := s.externalAccountService(w)
	if !ok {
		return
	}
	account, ok := s.requireExternalAccountOwner(w, r, strings.TrimSpace(r.PathValue("id")))
	if !ok {
		return
	}
	refreshed, err := service.RefreshNow(r.Context(), account, externalaccounts.Use{By: "manual"})
	if err != nil {
		writeExternalAccountError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, refreshed)
}

// handleRevokeExternalAccount is "stop using now": the grant is revoked at
// the provider and no new token is minted; a token a session already holds
// lives until it expires (at most 2 hours for Feishu).
func (s *Server) handleRevokeExternalAccount(w http.ResponseWriter, r *http.Request) {
	service, ok := s.externalAccountService(w)
	if !ok {
		return
	}
	account, ok := s.requireExternalAccountOwner(w, r, strings.TrimSpace(r.PathValue("id")))
	if !ok {
		return
	}
	revoked, err := service.Revoke(r.Context(), account, account.OwnerUserID)
	if err != nil {
		writeExternalAccountError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, revoked)
}

// handleDisconnectExternalAccount revokes what is still held and removes
// the account with its bindings.
func (s *Server) handleDisconnectExternalAccount(w http.ResponseWriter, r *http.Request) {
	service, ok := s.externalAccountService(w)
	if !ok {
		return
	}
	account, ok := s.requireExternalAccountOwner(w, r, strings.TrimSpace(r.PathValue("id")))
	if !ok {
		return
	}
	if err := service.Disconnect(r.Context(), account, account.OwnerUserID); err != nil {
		writeExternalAccountError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "disconnected"})
}

// handleReplaceExternalAppSecret seals the secret the person rotated at
// the provider: the app's owner, or an admin for an instance app.
func (s *Server) handleReplaceExternalAppSecret(w http.ResponseWriter, r *http.Request) {
	service, ok := s.externalAccountService(w)
	if !ok {
		return
	}
	actor, ok := personActor(w, r)
	if !ok {
		return
	}
	var input struct {
		ClientSecret string `json:"clientSecret"`
	}
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	app, err := s.store.(store.ExternalAccountStore).GetExternalProviderApp(r.Context(), strings.TrimSpace(r.PathValue("id")))
	if err != nil {
		writeError(w, http.StatusNotFound, "external provider app not found")
		return
	}
	scope, err := s.requestScope(r)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "resolve access")
		return
	}
	if app.OwnerUserID != actor.AccountID() && !(scope.admin && app.Visibility == store.ExternalAppInstance) {
		writeError(w, http.StatusNotFound, "external provider app not found")
		return
	}
	saved, err := service.ReplaceAppSecret(r.Context(), app, input.ClientSecret)
	if err != nil {
		if errors.Is(err, externalaccounts.ErrSecretsNotConfigured) {
			writeExternalAccountError(w, err)
			return
		}
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if s.feishuGateway != nil {
		s.feishuGateway.ForgetApp(app.ID)
	}
	// Bots running on the app reply with the new secret.
	s.feishuBotsChanged(r.Context())
	writeJSON(w, http.StatusOK, saved)
}

// handleWorkspaceExternalAccounts is a workspace's Accounts tab: the bound
// accounts, and the caller's own unbound ones so they can be bound. Other
// people's accounts show without their provider identity.
func (s *Server) handleWorkspaceExternalAccounts(w http.ResponseWriter, r *http.Request) {
	service, ok := s.externalAccountService(w)
	if !ok {
		return
	}
	workspaceID := strings.TrimSpace(r.PathValue("id"))
	view, err := s.workspaceExternalAccounts(r.Context(), service, workspaceID, actorFromContext(r.Context()).AccountID())
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	writeJSON(w, http.StatusOK, view)
}

func (s *Server) workspaceExternalAccounts(ctx context.Context, service *externalaccounts.Service, workspaceID, viewerID string) (store.WorkspaceExternalAccounts, error) {
	accounts := s.store.(store.ExternalAccountStore)
	bindings, err := accounts.ListWorkspaceExternalAccounts(ctx, workspaceID)
	if err != nil {
		return store.WorkspaceExternalAccounts{}, err
	}
	view := store.WorkspaceExternalAccounts{WorkspaceID: workspaceID, Bindings: bindings, Accounts: []store.ExternalAccount{}}
	seen := map[string]bool{}
	for _, binding := range bindings {
		account, err := accounts.GetExternalAccount(ctx, binding.AccountID)
		if err != nil {
			continue
		}
		seen[account.ID] = true
		view.Accounts = append(view.Accounts, accountForViewer(service, account, viewerID))
	}
	if viewerID != "" {
		own, err := service.Accounts(ctx, viewerID)
		if err != nil {
			return store.WorkspaceExternalAccounts{}, err
		}
		for _, account := range own {
			if !seen[account.ID] {
				view.Accounts = append(view.Accounts, account)
			}
		}
	}
	return view, nil
}

// accountForViewer is the account as viewerID may see it: the owner sees
// it whole; others see what it is, not who, nor its expiries.
func accountForViewer(service *externalaccounts.Service, account store.ExternalAccount, viewerID string) store.ExternalAccount {
	all, _ := service.Accounts(context.Background(), account.OwnerUserID)
	for _, current := range all {
		if current.ID == account.ID {
			account = current
		}
	}
	if account.OwnerUserID == viewerID {
		return account
	}
	return store.ExternalAccount{
		ID: account.ID, Provider: account.Provider, AppID: account.AppID, OwnerUserID: account.OwnerUserID, Label: account.Label,
		Mode: account.Mode, Status: account.Status, KeepAlive: account.KeepAlive, WorkspaceIDs: account.WorkspaceIDs,
		CreatedAt: account.CreatedAt, UpdatedAt: account.UpdatedAt,
	}
}

// handleSetWorkspaceExternalAccounts replaces the caller's bindings in the
// workspace (a maintainer, by the route; their own accounts, by the store).
func (s *Server) handleSetWorkspaceExternalAccounts(w http.ResponseWriter, r *http.Request) {
	service, ok := s.externalAccountService(w)
	if !ok {
		return
	}
	actor, ok := personActor(w, r)
	if !ok {
		return
	}
	var input store.SetWorkspaceExternalAccountsInput
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	workspaceID := strings.TrimSpace(r.PathValue("id"))
	accounts := s.store.(store.ExternalAccountStore)
	before, err := accounts.ListWorkspaceExternalAccounts(r.Context(), workspaceID)
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	if err := accounts.SetWorkspaceExternalAccounts(r.Context(), workspaceID, actor.AccountID(), input.AccountIDs); err != nil {
		if errors.Is(err, store.ErrExternalAccountNotFound) {
			writeError(w, http.StatusNotFound, err.Error())
			return
		}
		writeResult(w, nil, err)
		return
	}
	wanted := map[string]bool{}
	for _, id := range input.AccountIDs {
		wanted[id] = true
	}
	had := map[string]bool{}
	for _, binding := range before {
		had[binding.AccountID] = true
		if !wanted[binding.AccountID] && binding.GrantedBy == actor.AccountID() {
			if err := accounts.AppendExternalAccountEvent(r.Context(), store.ExternalAccountEvent{AccountID: binding.AccountID, Kind: "unbound", Detail: workspaceID, ActorID: actor.AccountID()}); err != nil {
				service.Logf("external account binding audit in %s: %v", workspaceID, err)
			}
		}
	}
	for id := range wanted {
		if !had[id] {
			if err := accounts.AppendExternalAccountEvent(r.Context(), store.ExternalAccountEvent{AccountID: id, Kind: "bound", Detail: workspaceID, ActorID: actor.AccountID()}); err != nil {
				service.Logf("external account binding audit in %s: %v", workspaceID, err)
			}
		}
	}
	view, err := s.workspaceExternalAccounts(r.Context(), service, workspaceID, actor.AccountID())
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	writeJSON(w, http.StatusOK, view)
}

// sessionExternalAccounts is what run_session carries for a session: per
// account the session may act as, the gateway handles feishu-cli holds in
// place of the app secret and the access token. The device owner is the
// account behind the daemon socket; the session owner is who started it.
// Sandboxed roles (an Issue's execution, a clarification) get nothing: their
// private HOME holds no tool profile the worker writes for them. A worker
// without the gateway forwarder (gateway false) gets nothing either, and
// the session's transcript says why, once.
func (h *DaemonHub) sessionExternalAccounts(ctx context.Context, session store.AgentSession, device Actor, gateway bool) []store.ExternalAccountMaterial {
	if h.externalAccounts == nil || session.Role == store.AgentSessionRoleIssueExecution || session.Role == store.AgentSessionRoleIssueClarification {
		return nil
	}
	if !gateway {
		accounts, err := h.externalAccounts.SessionAccounts(ctx, session.WorkspaceID, session.CreatedByUserID, device.AccountID())
		if err == nil && len(accounts) > 0 {
			h.noticeWorkerWithoutGateway(ctx, session)
		}
		return nil
	}
	materials, err := h.externalAccounts.SessionMaterials(ctx, session.WorkspaceID, session.ID, session.DeviceID, session.CreatedByUserID, device.AccountID())
	if err != nil {
		h.externalAccounts.Logf("external accounts for session %s: %v", session.ID, err)
		return nil
	}
	return materials
}

// noticeWorkerWithoutGateway tells the session's transcript, once, that its
// device's worker is too old to use the Feishu accounts bound to the
// workspace.
func (h *DaemonHub) noticeWorkerWithoutGateway(ctx context.Context, session store.AgentSession) {
	event := store.AgentSessionEvent{
		ID:        "evt_" + session.ID + "_feishu_needs_worker_update",
		SessionID: session.ID,
		At:        time.Now().UTC().Format(time.RFC3339Nano),
		Label:     "Feishu unavailable",
		Detail:    "This session has no Feishu account: the worker on its device predates Foundry's Feishu gateway, and Foundry no longer sends app secrets or tokens to devices. Update the worker (Devices → this device → Update), then start the session again.",
		Level:     "warning",
	}
	recorder, ok := h.store.(interface {
		RecordAgentSessionEvent(context.Context, store.AgentSessionEvent) (bool, error)
	})
	if !ok {
		return
	}
	stored, err := recorder.RecordAgentSessionEvent(ctx, event)
	if err != nil {
		h.externalAccounts.Logf("note the outdated worker on session %s: %v", session.ID, err)
		return
	}
	if stored {
		h.sessions.recorded(ctx, session.WorkspaceID, event)
	}
}
