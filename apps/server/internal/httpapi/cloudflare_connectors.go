package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"github.com/foundry-dev/foundry/apps/server/internal/connectors"
	"github.com/foundry-dev/foundry/apps/server/internal/externalaccounts"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

const cloudflareOAuthCallbackPath = "/api/connectors/cloudflare/oauth/callback"

func (s *Server) handleCloudflareBegin(w http.ResponseWriter, r *http.Request) {
	actor, ok := personActor(w, r)
	if !ok {
		return
	}
	var input struct {
		RequestID string `json:"requestId"`
		AccountID string `json:"accountId"`
	}
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	view, err := s.connectors.ServerHeld.BeginAuthorizationCode(r.Context(), actor.AccountID(), "cloudflare", input.RequestID, s.options.AllowedOrigin+cloudflareOAuthCallbackPath, input.AccountID)
	if err != nil {
		writeExternalAccountError(w, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusAccepted, view)
}
func (s *Server) handleCloudflareCallback(w http.ResponseWriter, r *http.Request) {
	actor, ok := personActor(w, r)
	if !ok {
		return
	}
	query := r.URL.Query()
	r.URL.RawQuery = ""
	r.RequestURI = r.URL.Path
	if err := s.connectors.ServerHeld.CompleteAuthorizationCode(r.Context(), actor.AccountID(), query.Get("state"), query.Get("code"), query.Get("iss"), query.Get("error")); err != nil {
		writeCloudflareCallbackPage(w, r, http.StatusBadRequest, callbackOutcome(err))
		return
	}
	writeCloudflareCallbackPage(w, r, http.StatusOK, callbackReceived)
}

// handleCloudflareCancel closes a pending sign-in. One that is already
// gone (expired, ended, or lost before DEV-091 kept them across restarts)
// is not an error to the dialog closing it: it answers status "gone".
func (s *Server) handleCloudflareCancel(w http.ResponseWriter, r *http.Request) {
	actor, ok := personActor(w, r)
	if !ok {
		return
	}
	var input struct {
		RequestID string `json:"requestId"`
	}
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	if input.RequestID == "" {
		writeError(w, 400, "authorization request ID is required")
		return
	}
	err := s.connectors.ServerHeld.CancelAuthorizationCode(actor.AccountID(), r.PathValue("id"), input.RequestID)
	if errors.Is(err, externalaccounts.ErrLoginGone) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "gone"})
		return
	}
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
func (s *Server) handleCloudflareZones(w http.ResponseWriter, r *http.Request) {
	account, ok := s.requireExternalAccountOwner(w, r, r.PathValue("accountId"))
	if !ok {
		return
	}
	if account.Provider != "cloudflare" {
		writeError(w, 404, "Cloudflare account not found")
		return
	}
	page := 1
	if r.URL.Query().Get("page") != "" {
		n, err := strconv.Atoi(r.URL.Query().Get("page"))
		if err != nil || n < 1 || n > 1000 {
			writeError(w, 400, "invalid page")
			return
		}
		page = n
	}
	result, err := s.connectors.ServerHeld.CloudflareRead(r.Context(), account, "/zones", url.Values{"page": {strconv.Itoa(page)}, "per_page": {"50"}}, externalaccounts.Use{By: "manual"})
	_ = s.store.AppendExternalAccountEvent(r.Context(), store.ExternalAccountEvent{AccountID: account.ID, Kind: "cloudflare_discovery", ActorID: account.OwnerUserID, Detail: "GET /zones"})
	if err != nil {
		writeError(w, http.StatusBadGateway, "Cloudflare zone discovery failed. Check the connection and its granted permissions.")
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, 200, json.RawMessage(result))
}
func (s *Server) handleCloudflareSessionHandle(w http.ResponseWriter, r *http.Request) {
	actor := actorFromContext(r.Context())
	var input struct {
		SessionID string `json:"sessionId"`
		AccountID string `json:"accountId"`
	}
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	g := s.connectors.Cloudflare
	if g == nil {
		writeError(w, 503, "Cloudflare gateway unavailable")
		return
	}
	account, _, err := g.CheckSession(r.Context(), input.SessionID, actor.DeviceID, actor.AccountID(), input.AccountID)
	if err != nil {
		writeError(w, 403, err.Error())
		return
	}
	session, err := s.store.GetAgentSessionSummary(r.Context(), input.SessionID)
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	handle, err := g.IssueHandles(r.Context(), externalaccounts.HandleRequest{SessionID: session.ID, DeviceID: session.DeviceID, WorkspaceID: session.WorkspaceID, UserID: actor.AccountID(), Account: account})
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, 200, handle)
}
func (s *Server) handleCloudflareGateway(w http.ResponseWriter, r *http.Request) {
	actor := actorFromContext(r.Context())
	g := s.connectors.Cloudflare
	if g == nil {
		writeError(w, 503, "Cloudflare gateway unavailable")
		return
	}
	handle := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	path := "/" + r.PathValue("path")
	path = strings.TrimPrefix(path, "/client/v4")
	result, err := g.ReadHandle(r.Context(), handle, actor.DeviceID, actor.AccountID(), path, r.URL.Query())
	if err != nil {
		status := http.StatusBadGateway
		if errors.Is(err, connectors.ErrCloudflareAccess) {
			status = http.StatusForbidden
		}
		if errors.Is(err, connectors.ErrCloudflareHandleExpired) {
			status = http.StatusUnauthorized
		}
		writeJSON(w, status, map[string]any{"success": false, "errors": []any{map[string]any{"code": status, "message": err.Error()}}})
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, 200, result)
}

func (s *Server) mcpCloudflare(r *http.Request, actor Actor, args map[string]json.RawMessage) (any, error) {
	if !actor.Agent() {
		return nil, errors.New("Cloudflare tools require an active workspace session")
	}
	session, err := s.store.GetAgentSessionSummary(r.Context(), actor.Identity.SessionID)
	if err != nil {
		return nil, err
	}
	if session.WorkspaceID != actor.Identity.WorkspaceID {
		return nil, connectors.ErrCloudflareAccess
	}
	g := s.connectors.Cloudflare
	if g == nil {
		return nil, connectors.ErrCloudflareAccess
	}
	accountID := mcpArgString(args, "accountId")
	if mcpArgString(args, "action") == "accounts" {
		accounts, err := s.connectors.ServerHeld.SessionAccounts(r.Context(), session.WorkspaceID, session.CreatedByUserID, session.CreatedByUserID)
		if err != nil {
			return nil, err
		}
		visible := []map[string]any{}
		for _, a := range accounts {
			if a.Provider != "cloudflare" {
				continue
			}
			checked, resources, err := g.CheckSession(r.Context(), session.ID, session.DeviceID, session.CreatedByUserID, a.ID)
			if err == nil {
				visible = append(visible, map[string]any{"accountId": checked.ID, "identity": checked.DisplayName, "subject": checked.Subject, "zones": resources, "permissions": checked.GrantedScopes, "access": s.cloudflareBindingAccess(r.Context(), session.WorkspaceID, checked.ID)})
			}
		}
		return map[string]any{"accounts": visible}, nil
	}
	path := mcpArgString(args, "path")
	if method := strings.ToUpper(mcpArgString(args, "method")); method != "" && method != http.MethodGet {
		return g.RequestSession(r.Context(), session.ID, session.DeviceID, session.CreatedByUserID, session.WorkspaceID, accountID, method, path, args["body"])
	}
	if body := args["body"]; len(body) > 0 && string(body) != "null" {
		return nil, &connectors.CloudflareRefusal{Message: "a GET request takes no body"}
	}
	query := map[string]string{}
	if raw := args["query"]; len(raw) > 0 {
		if err := json.Unmarshal(raw, &query); err != nil {
			return nil, err
		}
	}
	values := url.Values{}
	for k, v := range query {
		values.Set(k, v)
	}
	return g.ReadSession(r.Context(), session.ID, session.DeviceID, session.CreatedByUserID, accountID, path, values)
}

func (s *Server) cloudflareToolAvailable(ctx context.Context, actor Actor) error {
	if !actor.Agent() || s.connectors.Cloudflare == nil {
		return connectors.ErrCloudflareAccess
	}
	session, err := s.store.GetAgentSessionSummary(ctx, actor.Identity.SessionID)
	if err != nil {
		return err
	}
	owner, err := s.store.DeviceOwner(ctx, session.DeviceID)
	if err != nil {
		return err
	}
	accounts, err := s.connectors.ServerHeld.SessionAccounts(ctx, session.WorkspaceID, session.CreatedByUserID, owner)
	if err != nil {
		return err
	}
	for _, account := range accounts {
		if account.Provider == "cloudflare" {
			if _, _, err := s.connectors.Cloudflare.CheckSession(ctx, session.ID, session.DeviceID, session.CreatedByUserID, account.ID); err == nil {
				return nil
			}
		}
	}
	return connectors.ErrCloudflareAccess
}
