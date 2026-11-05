package feishugateway

import (
	"crypto/hmac"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strings"

	"github.com/foundry-dev/foundry/apps/server/internal/gateway"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// The calls the gateway answers itself, with stand-ins, never a real token:
// feishu-cli's tenant token call, its user token refresh, and the event
// connection (gateway.LocalEndpoints, the optional capability).

var appOnly = []string{store.FeishuHandleApp}

type tenantTokenInput struct {
	AppID     string `json:"app_id"`
	AppSecret string `json:"app_secret"`
}

type eventEndpointInput struct {
	AppID     string `json:"AppID"`
	AppSecret string `json:"AppSecret"`
}

// Enter (gateway.Entries) says how a call enters the pipeline: the
// stand-in a local call presents is in its body, a form or a ticket, a
// forwarded call carries it as the bearer, and other paths are not served.
func (g *Gateway) Enter(r *http.Request) gateway.Entry {
	switch routeOf(r) {
	case routeForward:
		return gateway.Entry{Handle: bearer(r), Kinds: g.pipeline.Scheme.Bearer}
	case routeTenantToken:
		var input tenantTokenInput
		if err := json.NewDecoder(io.LimitReader(r.Body, maxTokenBody)).Decode(&input); err != nil {
			return gateway.Entry{Local: true, Denial: &gateway.Denial{Reason: gateway.ReasonBadRequest, Message: "unreadable tenant token request"}}
		}
		return gateway.Entry{Local: true, Handle: strings.TrimSpace(input.AppSecret), Kinds: appOnly, Data: input}
	case routeEndpoint:
		var input eventEndpointInput
		if err := json.NewDecoder(io.LimitReader(r.Body, maxTokenBody)).Decode(&input); err != nil {
			return gateway.Entry{Local: true, Denial: &gateway.Denial{Reason: gateway.ReasonBadRequest, Message: "unreadable event endpoint request"}}
		}
		return gateway.Entry{Local: true, Handle: strings.TrimSpace(input.AppSecret), Kinds: appOnly, Data: input}
	case routeRefresh:
		// OAuth form: grant_type=refresh_token, refresh_token, client_id,
		// client_secret (the app handle).
		if err := r.ParseForm(); err != nil {
			return gateway.Entry{Local: true, Denial: &gateway.Denial{Reason: gateway.ReasonBadRequest}}
		}
		if r.PostForm.Get("grant_type") != "refresh_token" {
			return gateway.Entry{Local: true, Denial: &gateway.Denial{Reason: gateway.ReasonNoCredential}}
		}
		return gateway.Entry{Local: true, Handle: strings.TrimSpace(r.PostForm.Get("client_secret")), Kinds: appOnly}
	case routeSocket:
		grant, ok := g.tickets.redeem(r.URL.Query().Get("foundry_ticket"), g.Now())
		if !ok {
			return gateway.Entry{Local: true, Raw: true, Denial: &gateway.Denial{Reason: reasonBadTicket}}
		}
		// The ticket names the grant the endpoint call was authenticated
		// with; it is good only while that grant is still the app's.
		if current, err := g.store.FindFeishuGatewayGrant(r.Context(), store.FeishuHandleApp, grant.AppHash); err != nil || current.ID != grant.ID {
			return gateway.Entry{Local: true, Raw: true, Denial: &gateway.Denial{Reason: gateway.ReasonAccessEnded}}
		}
		return gateway.Entry{Local: true, Raw: true, Grant: &grant}
	}
	return gateway.Entry{Denial: &gateway.Denial{Reason: reasonNotServed}}
}

// Answer (gateway.LocalEndpoints) replies to a local call whose grant was
// authenticated and rechecked.
func (g *Gateway) Answer(w http.ResponseWriter, r *http.Request, x *gateway.Exchange, entry gateway.Entry) *gateway.Denial {
	lease := x.Lease
	caller := callerOf(lease)
	switch routeOf(r) {
	case routeTenantToken:
		if entry.Data.(tenantTokenInput).AppID != caller.ClientID {
			x.Outcome = gateway.OutcomeRefused
			writeFeishu(w, http.StatusOK, 10003, "Foundry gateway: app_id does not match this session's Feishu app")
			return nil
		}
		tenant, _ := derivedHandle(entry.Handle, tenantHandlePrefix)
		x.Outcome = gateway.OutcomeLocal
		writeJSON(w, http.StatusOK, map[string]any{"code": 0, "msg": "ok", "tenant_access_token": tenant, "expire": tenantTokenExpire})
	case routeRefresh:
		return g.answerUserRefresh(w, r, x, entry, caller)
	case routeEndpoint:
		if entry.Data.(eventEndpointInput).AppID != caller.ClientID {
			return &gateway.Denial{Reason: gateway.ReasonAccessEnded}
		}
		if g.Events == nil {
			x.Outcome = gateway.OutcomeUnavailable
			writeFeishu(w, http.StatusServiceUnavailable, 503, "Foundry gateway: Feishu events are not available through this Foundry server yet")
			return nil
		}
		host := strings.TrimSpace(r.Header.Get(ForwarderHostHeader))
		if !loopbackHost(host) {
			x.Outcome = gateway.OutcomeRefused
			writeFeishu(w, http.StatusBadRequest, 1, "Foundry gateway: event connections need the worker's loopback forwarder")
			return nil
		}
		ticket := g.tickets.issue(lease.Grant, g.Now())
		connectURL := "ws://" + host + eventSocketPath + "?foundry_ticket=" + url.QueryEscape(ticket)
		x.Outcome = gateway.OutcomeLocal
		g.Events.ServeEndpoint(w, r, caller, connectURL)
	case routeSocket:
		if g.Events == nil {
			x.Status, x.Outcome = http.StatusServiceUnavailable, gateway.OutcomeUnavailable
			writeFeishu(w, http.StatusServiceUnavailable, 503, "Foundry gateway: Feishu events are not available through this Foundry server yet")
			return nil
		}
		x.Status, x.Outcome = http.StatusSwitchingProtocols, gateway.OutcomeLocal
		g.Events.ServeConnection(w, r, caller)
	}
	return nil
}

// answerUserRefresh answers feishu-cli's user token refresh with the
// session's stand-ins again, never a real token. The real login is
// refreshed by the server when a call needs it; the device's refresh only
// keeps feishu-cli's token.json current and is refused once access ends.
func (g *Gateway) answerUserRefresh(w http.ResponseWriter, r *http.Request, x *gateway.Exchange, entry gateway.Entry, caller Caller) *gateway.Denial {
	refresh, _ := derivedHandle(entry.Handle, refreshHandlePrefix)
	presented := strings.TrimSpace(r.PostForm.Get("refresh_token"))
	if r.PostForm.Get("client_id") != caller.ClientID || !hmac.Equal([]byte(presented), []byte(refresh)) {
		x.Outcome = gateway.OutcomeRefused
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid_grant", "error_description": "Foundry gateway: the refresh token or client_id is not this session's; use the Feishu profile Foundry set up (FEISHU_PROFILE)"})
		return nil
	}
	user, _ := derivedHandle(entry.Handle, userHandlePrefix)
	x.Outcome = gateway.OutcomeLocal
	writeJSON(w, http.StatusOK, map[string]any{
		"code": 0, "access_token": user, "refresh_token": refresh, "token_type": "Bearer", "expires_in": userTokenExpire,
	})
	return nil
}
