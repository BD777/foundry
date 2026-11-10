package httpapi

import (
	"errors"
	"net/http"
	"strings"

	"github.com/foundry-dev/foundry/apps/server/internal/externalaccounts"
	"github.com/foundry-dev/foundry/apps/server/internal/gateway"
	"github.com/foundry-dev/foundry/apps/server/internal/integrations"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func (s *Server) handleListAppStoreConnectKeys(w http.ResponseWriter, r *http.Request) {
	actor, ok := personActor(w, r)
	if !ok {
		return
	}
	keys, err := s.connectors.ServerHeld.ListAppStoreConnectKeys(r.Context(), actor.AccountID())
	if err != nil {
		writeAppStoreConnectConnectorError(w, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, map[string]any{"keys": keys})
}

func (s *Server) handleCreateAppStoreConnectKey(w http.ResponseWriter, r *http.Request) {
	actor, ok := personActor(w, r)
	if !ok {
		return
	}
	var input store.SaveAppStoreConnectKeyInput
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	connection, err := s.connectors.ServerHeld.CreateAppStoreConnectKey(r.Context(), actor.AccountID(), input)
	if err != nil {
		writeAppStoreConnectConnectorError(w, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusCreated, connection)
}

func (s *Server) handleReplaceAppStoreConnectKey(w http.ResponseWriter, r *http.Request) {
	actor, ok := personActor(w, r)
	if !ok {
		return
	}
	var input store.SaveAppStoreConnectKeyInput
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	app, err := s.store.GetExternalProviderApp(r.Context(), strings.TrimSpace(r.PathValue("appId")))
	if err != nil || app.Provider != "appstoreconnect" || app.OwnerUserID != actor.AccountID() {
		writeError(w, http.StatusNotFound, "App Store Connect key not found")
		return
	}
	connection, err := s.connectors.ServerHeld.ReplaceAppStoreConnectKey(r.Context(), actor.AccountID(), app.ID, input)
	if err != nil {
		writeAppStoreConnectConnectorError(w, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, connection)
}

func (s *Server) handleRevokeAppStoreConnectKey(w http.ResponseWriter, r *http.Request) {
	actor, ok := personActor(w, r)
	if !ok {
		return
	}
	app, err := s.store.GetExternalProviderApp(r.Context(), strings.TrimSpace(r.PathValue("appId")))
	if err != nil || app.Provider != "appstoreconnect" || app.OwnerUserID != actor.AccountID() {
		writeError(w, http.StatusNotFound, "App Store Connect key not found")
		return
	}
	connection, err := s.connectors.ServerHeld.RevokeAppStoreConnectKey(r.Context(), actor.AccountID(), app.ID, actor.AccountID())
	if err != nil {
		writeAppStoreConnectConnectorError(w, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, connection)
}

func (s *Server) handleListAppStoreConnectApps(w http.ResponseWriter, r *http.Request) {
	account, ok := s.requireExternalAccountOwner(w, r, r.PathValue("accountId"))
	if !ok {
		return
	}
	if account.Provider != "appstoreconnect" {
		writeError(w, http.StatusNotFound, "App Store Connect key not found")
		return
	}
	app, err := s.store.GetExternalProviderApp(r.Context(), account.AppID)
	if err != nil {
		writeError(w, http.StatusNotFound, "App Store Connect key not found")
		return
	}
	apps, err := s.connectors.ServerHeld.ListAppStoreApps(r.Context(), app)
	if err != nil {
		writeAppStoreConnectConnectorError(w, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, map[string]any{"apps": apps})
}

func (s *Server) handleAppStoreConnectSessionHandle(w http.ResponseWriter, r *http.Request) {
	actor := actorFromContext(r.Context())
	var input struct {
		SessionID string `json:"sessionId"`
		AccountID string `json:"accountId"`
	}
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	g := s.connectors.AppStoreConnect
	account, _, err := g.CheckSession(r.Context(), input.SessionID, actor.DeviceID, actor.AccountID(), input.AccountID)
	if err != nil {
		writeError(w, http.StatusForbidden, err.Error())
		return
	}
	session, err := s.store.GetAgentSessionSummary(r.Context(), input.SessionID)
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	handle, err := g.IssueHandles(r.Context(), externalaccounts.HandleRequest{
		SessionID: session.ID, DeviceID: session.DeviceID, WorkspaceID: session.WorkspaceID,
		UserID: actor.AccountID(), Account: account,
	})
	if err != nil {
		writeAppStoreConnectConnectorError(w, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, handle)
}

func (s *Server) handleAppStoreConnectGateway(w http.ResponseWriter, r *http.Request) {
	actor := actorFromContext(r.Context())
	s.connectors.AppStoreConnect.Serve(w, r, gateway.Device{ID: actor.DeviceID, OwnerUserID: actor.AccountID()})
}

func writeAppStoreConnectConnectorError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, externalaccounts.ErrSecretsNotConfigured):
		writeError(w, http.StatusPreconditionFailed, err.Error())
	case errors.Is(err, integrations.ErrOff):
		writeError(w, http.StatusServiceUnavailable, err.Error())
	case errors.Is(err, externalaccounts.ErrAppStoreConnectKeyRejected):
		writeError(w, http.StatusBadRequest, "App Store Connect rejected this API key; check the Issuer ID, Key ID and .p8 file")
	case errors.Is(err, externalaccounts.ErrInvalidAppStoreConnectKey):
		writeError(w, http.StatusBadRequest, err.Error())
	case errors.Is(err, store.ErrExternalAppNotFound), errors.Is(err, store.ErrNotFound):
		writeError(w, http.StatusNotFound, "App Store Connect key not found")
	default:
		writeError(w, http.StatusBadGateway, "App Store Connect request failed; check the key and its access")
	}
}
