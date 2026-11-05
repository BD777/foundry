package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strconv"

	"github.com/foundry-dev/foundry/apps/server/internal/externalaccounts"
	"github.com/foundry-dev/foundry/apps/server/internal/gateway"
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

// handleCloudflareGateway is the one way into Cloudflare for a session, for
// any method: the official cf CLI and curl send their calls here (through the
// device's loopback forwarder) with the session's stand-in handle, and every
// one goes through the same gateway pipeline, whatever its method.
func (s *Server) handleCloudflareGateway(w http.ResponseWriter, r *http.Request) {
	actor := actorFromContext(r.Context())
	s.connectors.Cloudflare.Serve(w, r, gateway.Device{ID: actor.DeviceID, OwnerUserID: actor.AccountID()})
}
