package httpapi

import (
	"context"
	"net/http"
	"strconv"
	"strings"

	"github.com/foundry-dev/foundry/apps/server/internal/externalaccounts"
	"github.com/foundry-dev/foundry/apps/server/internal/feishugateway"
	"github.com/foundry-dev/foundry/apps/server/internal/integrations"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// The Feishu gateway's routes: feishu-cli on a session's device reaches
// Feishu only through here (feishugateway), via the worker's loopback
// forwarder, which adds the device credential. The device's identity is
// the only thing the route checks; the gateway checks the rest per request.

// newFeishuGateway wires the gateway over the store and the external
// accounts service and lets the service issue its handles; nil when the
// store keeps neither.
func newFeishuGateway(st store.Store, service *externalaccounts.Service, sw *integrations.Switch) *feishugateway.Gateway {
	gatewayStore, ok := st.(store.FeishuGatewayStore)
	accounts, accountsOK := st.(store.ExternalAccountStore)
	if !ok || !accountsOK || service == nil {
		return nil
	}
	gateway := feishugateway.New(gatewayStore, accounts, st, service)
	gateway.Integrations = sw
	service.Handles = gateway
	return gateway
}

// FeishuGateway is the server's gateway, for wiring its event subscriptions
// (Events) before the server serves; nil without external accounts.
func (s *Server) FeishuGateway() *feishugateway.Gateway { return s.feishuGateway }

// RunFeishuGatewayMaintenance prunes ended sessions' grants and old audit
// lines until ctx ends. It touches only this server's database.
func (s *Server) RunFeishuGatewayMaintenance(ctx context.Context) {
	if s.feishuGateway != nil {
		s.feishuGateway.Run(ctx)
	}
}

func (s *Server) handleFeishuGateway(w http.ResponseWriter, r *http.Request) {
	if s.feishuGateway == nil {
		writeError(w, http.StatusServiceUnavailable, errExternalAccountsUnavailable.Error())
		return
	}
	actor := actorFromContext(r.Context())
	s.feishuGateway.Serve(w, r, feishugateway.Device{ID: actor.DeviceID, OwnerUserID: actor.AccountID()})
}

// handleFeishuGatewayRequests is the gateway's audit: the caller's own
// sessions' calls; an admin may read everyone's with ?all=1. Filters:
// sessionId, accountId, before (an id, to page back), limit.
func (s *Server) handleFeishuGatewayRequests(w http.ResponseWriter, r *http.Request) {
	gatewayStore, ok := s.store.(store.FeishuGatewayStore)
	if !ok {
		writeError(w, http.StatusServiceUnavailable, errExternalAccountsUnavailable.Error())
		return
	}
	actor, ok := personActor(w, r)
	if !ok {
		return
	}
	query := r.URL.Query()
	filter := store.FeishuGatewayRequestFilter{
		UserID: actor.AccountID(), SessionID: strings.TrimSpace(query.Get("sessionId")), AccountID: strings.TrimSpace(query.Get("accountId")),
	}
	if query.Get("all") == "1" {
		scope, err := s.requestScope(r)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "resolve access")
			return
		}
		if !scope.admin {
			writeForbidden(w, "Reading everyone's Feishu gateway calls needs the instance Admin role.")
			return
		}
		filter.UserID = ""
	}
	filter.BeforeID, _ = strconv.ParseInt(query.Get("before"), 10, 64)
	filter.Limit, _ = strconv.Atoi(query.Get("limit"))
	requests, err := gatewayStore.ListFeishuGatewayRequests(r.Context(), filter)
	writeResult(w, map[string]any{"requests": requests}, err)
}
