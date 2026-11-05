package feishugateway

import (
	"errors"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/externalaccounts"
	"github.com/foundry-dev/foundry/apps/server/internal/gateway"
	"github.com/foundry-dev/foundry/apps/server/internal/integrations"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// levelFull is Feishu's one access level: a session may make every call the
// blocklist (policy.go) does not refuse, within what Feishu grants the
// account. There are no resources and no further levels.
const levelFull = "full"

// What a request is to the gateway, by its path below the prefix.
type route int

const (
	// routeForward is an open-API call, streamed to Feishu with the real token.
	routeForward route = iota
	routeTenantToken
	routeRefresh
	routeEndpoint
	routeSocket
	// routeOther is a path the gateway does not serve.
	routeOther
)

// reasonNotServed and reasonBadTicket are this connector's own reasons
// beyond the common ones.
const (
	reasonNotServed = "not_served"
	reasonBadTicket = "bad_ticket"
)

// pathOf is r's path below the gateway prefix (either route to it).
func pathOf(r *http.Request) string {
	path := r.URL.Path
	if rest, ok := strings.CutPrefix(path, ConnectorPathPrefix); ok {
		path = rest
	} else {
		path = strings.TrimPrefix(path, PathPrefix)
	}
	if path == "" {
		return "/"
	}
	return path
}

func routeOf(r *http.Request) route {
	path := pathOf(r)
	switch {
	case r.Method == http.MethodGet && path == eventSocketPath:
		return routeSocket
	case r.Method == http.MethodPost && path == externalaccounts.FeishuTenantTokenPath:
		return routeTenantToken
	case r.Method == http.MethodPost && path == eventEndpointPath:
		return routeEndpoint
	case r.Method == http.MethodPost && path == userRefreshPath:
		return routeRefresh
	case strings.HasPrefix(path, "/open-apis/"):
		return routeForward
	}
	return routeOther
}

// Classify (gateway.Provider): a Feishu call needs the one level, "full",
// and names no resource, unless the blocklist refuses it.
func (g *Gateway) Classify(r *http.Request, _ *gateway.Lease) (gateway.Need, *gateway.Denial) {
	if reason := blocked(r.Method, pathOf(r)); reason != "" {
		return gateway.Need{}, &gateway.Denial{Reason: gateway.ReasonBlocked, Message: reason}
	}
	return gateway.Need{Level: levelFull}, nil
}

// Refuse (gateway.Provider) answers a denied call the way Feishu answers a
// bad credential, so feishu-cli shows msg.
func (g *Gateway) Refuse(w http.ResponseWriter, r *http.Request, denial *gateway.Denial) gateway.Refused {
	answer := func(status, code int, message string) gateway.Refused {
		writeFeishu(w, status, code, message)
		return gateway.Refused{Status: status, Message: message}
	}
	which := routeOf(r)
	if denial.Reason == reasonNotServed || which == routeOther {
		return answer(http.StatusNotFound, 404, "Foundry's Feishu gateway does not serve "+pathTemplate(pathOf(r))+": sessions cannot log in, register apps or revoke logins through Foundry")
	}
	if which == routeRefresh {
		return g.refuseRefresh(w, denial)
	}
	// The code Feishu gives a bad credential, by the call.
	code := map[route]int{routeTenantToken: 10014, routeEndpoint: 514, routeSocket: 1}[which]
	identity := store.FeishuHandleUser
	if which == routeForward {
		handle := bearer(r)
		if handleKind(handle) == store.FeishuHandleTenant {
			identity = store.FeishuHandleTenant
		}
		code = 99991668
		if identity == store.FeishuHandleTenant {
			code = 99991663
		}
	}
	switch denial.Reason {
	case gateway.ReasonNoCredential:
		if which == routeForward {
			return answer(http.StatusUnauthorized, 99991661, "Foundry gateway: the call carries no token of this session; use the Feishu profile Foundry set up (FEISHU_PROFILE)")
		}
		fallthrough
	case gateway.ReasonAccessEnded, gateway.ReasonHandleExpired:
		return answer(http.StatusUnauthorized, code, "Foundry gateway: "+errAccessEnded.Error())
	case reasonBadTicket:
		return answer(http.StatusUnauthorized, 1, "Foundry gateway: the event connection ticket is unknown, spent or expired; reconnect")
	case gateway.ReasonBadRequest:
		message := "Foundry gateway: " + denial.Message
		if which == routeTenantToken {
			return answer(http.StatusBadRequest, 10003, message)
		}
		return answer(http.StatusBadRequest, 1, message)
	case gateway.ReasonBlocked:
		return answer(http.StatusForbidden, 99991672, "Foundry gateway: "+r.Method+" "+pathTemplate(pathOf(r))+" is not available to sessions ("+denial.Message+")")
	case gateway.ReasonUnavailable:
		return answer(http.StatusServiceUnavailable, 1, "Foundry gateway: "+denial.Message)
	case gateway.ReasonRateLimited:
		seconds := int(denial.Wait/time.Second) + 1
		w.Header().Set("x-ogw-ratelimit-reset", strconv.Itoa(seconds))
		w.Header().Set("Retry-After", strconv.Itoa(seconds))
		return answer(http.StatusTooManyRequests, 99991400, "Foundry gateway: too many Feishu calls from this session; slow down")
	}
	g.logf("feishu gateway: authorize: %v", denial.Err)
	return answer(http.StatusInternalServerError, code, "Foundry gateway: could not check this session's access")
}

// refuseRefresh answers a denied user token refresh in OAuth's error shape.
func (g *Gateway) refuseRefresh(w http.ResponseWriter, denial *gateway.Denial) gateway.Refused {
	status, code, description := http.StatusBadRequest, "invalid_grant", ""
	switch denial.Reason {
	case gateway.ReasonBadRequest:
		code, description = "invalid_request", "unreadable token request"
	case gateway.ReasonNoCredential:
		description = "sessions can only refresh the login Foundry set up for them; they cannot log in through Foundry"
	case gateway.ReasonAccessEnded, gateway.ReasonHandleExpired:
		description = errAccessEnded.Error()
	default:
		g.logf("feishu gateway: authorize: %v", denial.Err)
		status, code, description = http.StatusInternalServerError, "server_error", "could not check this session's access"
	}
	writeJSON(w, status, map[string]any{"error": code, "error_description": "Foundry gateway: " + description})
	return gateway.Refused{Status: status, Message: description}
}

// Upstream (gateway.Provider) swaps the stand-in for the real token and
// streams the call to Feishu.
func (g *Gateway) Upstream(w http.ResponseWriter, r *http.Request, x *gateway.Exchange) *gateway.Denial {
	lease := x.Lease
	invalidCode := 99991668
	if lease.Kind == store.FeishuHandleTenant {
		invalidCode = 99991663
	}
	var token string
	var err error
	if lease.Kind == store.FeishuHandleUser {
		var minted store.ExternalAccountToken
		minted, err = g.service.AccessToken(r.Context(), lease.Grant.AccountID, externalaccounts.Use{SessionID: lease.Grant.SessionID, DeviceID: x.Device.ID, By: "session"})
		token = minted.AccessToken
	} else {
		token, err = g.tenantToken(r.Context(), lease.App)
	}
	if err != nil {
		g.tokenFailed(w, x, err, invalidCode)
		return nil
	}
	target, err := url.Parse(upstreamBase(lease.App.BaseURL))
	if err != nil {
		x.Outcome = gateway.OutcomeUpstreamError
		writeFeishu(w, http.StatusBadGateway, 1, "Foundry gateway: the app's base URL is invalid")
		return nil
	}
	path := pathOf(r)
	proxy := &httputil.ReverseProxy{
		Rewrite: func(out *httputil.ProxyRequest) {
			out.Out.URL.Scheme, out.Out.URL.Host = target.Scheme, target.Host
			out.Out.URL.Path, out.Out.URL.RawPath = strings.TrimRight(target.Path, "/")+path, ""
			out.Out.URL.RawQuery = r.URL.RawQuery
			out.Out.Host = ""
			for _, header := range []string{"X-Foundry-Device-Credential", ForwarderHostHeader, "Cookie", "Authorization"} {
				out.Out.Header.Del(header)
			}
			out.Out.Header.Set("Authorization", "Bearer "+token)
		},
		FlushInterval: -1,
		Transport:     g.Transport,
		ErrorHandler: func(w http.ResponseWriter, _ *http.Request, err error) {
			x.Outcome = gateway.OutcomeUpstreamError
			g.logf("feishu gateway: forward %s %s: %v", r.Method, pathTemplate(path), err)
			writeFeishu(w, http.StatusBadGateway, 1, "Foundry gateway: Feishu could not be reached")
		},
	}
	proxy.ServeHTTP(w, r)
	return nil
}

func (g *Gateway) tokenFailed(w http.ResponseWriter, x *gateway.Exchange, err error, invalidCode int) {
	x.Outcome = gateway.OutcomeUpstreamError
	switch {
	case errors.Is(err, integrations.ErrOff):
		x.Outcome = gateway.OutcomeUnavailable
		writeFeishu(w, http.StatusServiceUnavailable, 1, "Foundry gateway: "+err.Error())
	case errors.Is(err, externalaccounts.ErrAccountUnusable):
		x.Outcome = gateway.OutcomeRefused
		writeFeishu(w, http.StatusUnauthorized, invalidCode, "Foundry gateway: the Feishu account needs to be re-authorized in Foundry (Connectors → Feishu)")
	default:
		g.logf("feishu gateway: token for %s: %v", x.Lease.Grant.AccountID, err)
		writeFeishu(w, http.StatusBadGateway, invalidCode, "Foundry gateway: could not get a Feishu token for this call: "+err.Error())
	}
}
