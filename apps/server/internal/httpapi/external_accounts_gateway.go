package httpapi

import (
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

// newFeishuGateway wires the gateway over the backend and the external
// accounts service and lets the service issue its handles.
func newFeishuGateway(st Backend, service *externalaccounts.Service, sw *integrations.Switch) *feishugateway.Gateway {
	gateway := feishugateway.New(st, st, st, service)
	gateway.Integrations = sw
	service.Handles = gateway
	return gateway
}

func (s *Server) handleFeishuGateway(w http.ResponseWriter, r *http.Request) {
	actor := actorFromContext(r.Context())
	s.feishuGateway.Serve(w, r, feishugateway.Device{ID: actor.DeviceID, OwnerUserID: actor.AccountID()})
}

// handleFeishuGatewayRequests is the gateway's audit: the caller's own
// sessions' calls; an admin may read everyone's with ?all=1. Filters:
// sessionId, accountId, before (an id, to page back), limit.
func (s *Server) handleFeishuGatewayRequests(w http.ResponseWriter, r *http.Request) {
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
	requests, err := s.store.ListFeishuGatewayRequests(r.Context(), filter)
	writeResult(w, map[string]any{"requests": requests}, err)
}
