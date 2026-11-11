package connectors

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/foundry-dev/foundry/apps/server/internal/externalaccounts"
	"github.com/foundry-dev/foundry/apps/server/internal/gateway"
)

const (
	cloudflareZeroTrustServiceTokenCreate = "service_token_create"
	cloudflareZeroTrustServiceTokenDelete = "service_token_delete"
	cloudflareZeroTrustApplicationCreate  = "application_create"
	cloudflareZeroTrustApplicationUpdate  = "application_update"
	cloudflareZeroTrustPolicyCreate       = "policy_create"
	cloudflareZeroTrustPolicyUpdate       = "policy_update"
	cloudflareZeroTrustTunnelUpdate       = "tunnel_ingress_update"
)

var cloudflareOpaqueID = regexp.MustCompile(`^[a-fA-F0-9-]{16,64}$`)

// cloudflareZeroTrustCall is Classify's reading of an account-level Access
// or Tunnel request.
type cloudflareZeroTrustCall struct {
	account string
	action  string
	write   bool
}

// classifyCloudflareZeroTrust recognises the account-level paths Foundry
// exposes. It is deliberately an allowlist: a new Access or Tunnel endpoint
// does not become reachable merely because the OAuth grant can call it.
func classifyCloudflareZeroTrust(method, path string) (cloudflareZeroTrustCall, bool) {
	parts := strings.Split(strings.TrimPrefix(path, "/"), "/")
	if len(parts) < 4 || parts[0] != "accounts" || !cloudflareZoneID.MatchString(parts[1]) {
		return cloudflareZeroTrustCall{}, false
	}
	call := cloudflareZeroTrustCall{account: parts[1]}
	switch {
	case len(parts) == 4 && parts[2] == "access" && parts[3] == "service_tokens":
		switch method {
		case http.MethodGet:
			return call, true
		case http.MethodPost:
			call.action, call.write = cloudflareZeroTrustServiceTokenCreate, true
			return call, true
		}
	case len(parts) == 5 && parts[2] == "access" && parts[3] == "service_tokens" && cloudflareOpaqueID.MatchString(parts[4]):
		switch method {
		case http.MethodGet:
			return call, true
		case http.MethodDelete:
			call.action, call.write = cloudflareZeroTrustServiceTokenDelete, true
			return call, true
		}
	case len(parts) == 4 && parts[2] == "access" && parts[3] == "apps":
		switch method {
		case http.MethodGet:
			return call, true
		case http.MethodPost:
			call.action, call.write = cloudflareZeroTrustApplicationCreate, true
			return call, true
		}
	case len(parts) == 5 && parts[2] == "access" && parts[3] == "apps" && cloudflareOpaqueID.MatchString(parts[4]):
		switch method {
		case http.MethodGet:
			return call, true
		case http.MethodPatch, http.MethodPut:
			call.action, call.write = cloudflareZeroTrustApplicationUpdate, true
			return call, true
		}
	case len(parts) == 6 && parts[2] == "access" && parts[3] == "apps" && cloudflareOpaqueID.MatchString(parts[4]) && parts[5] == "policies":
		switch method {
		case http.MethodGet:
			return call, true
		case http.MethodPost:
			call.action, call.write = cloudflareZeroTrustPolicyCreate, true
			return call, true
		}
	case len(parts) == 7 && parts[2] == "access" && parts[3] == "apps" && cloudflareOpaqueID.MatchString(parts[4]) && parts[5] == "policies" && cloudflareOpaqueID.MatchString(parts[6]):
		switch method {
		case http.MethodGet:
			return call, true
		case http.MethodPatch, http.MethodPut:
			call.action, call.write = cloudflareZeroTrustPolicyUpdate, true
			return call, true
		}
	case len(parts) == 4 && parts[2] == "cfd_tunnel":
		if method == http.MethodGet {
			return call, true
		}
	case len(parts) == 5 && parts[2] == "cfd_tunnel" && cloudflareOpaqueID.MatchString(parts[3]):
		if method == http.MethodGet {
			return call, true
		}
	case len(parts) == 6 && parts[2] == "cfd_tunnel" && cloudflareOpaqueID.MatchString(parts[3]) && parts[4] == "configurations":
		switch method {
		case http.MethodGet:
			return call, true
		case http.MethodPut:
			call.action, call.write = cloudflareZeroTrustTunnelUpdate, true
			return call, true
		}
	}
	return cloudflareZeroTrustCall{}, false
}

func validateCloudflareZeroTrustRead(path string, query url.Values) error {
	parts := strings.Split(strings.TrimPrefix(path, "/"), "/")
	allowed := map[string]bool{}
	collection := (len(parts) == 4 && parts[2] == "access" && (parts[3] == "service_tokens" || parts[3] == "apps")) ||
		(len(parts) == 6 && parts[2] == "access" && parts[3] == "apps" && parts[5] == "policies") ||
		(len(parts) == 4 && parts[2] == "cfd_tunnel")
	if collection {
		allowed = map[string]bool{"page": true, "per_page": true, "name": true, "search": true}
		if len(parts) == 4 && parts[2] == "access" && parts[3] == "apps" {
			allowed["domain"], allowed["aud"], allowed["target_attributes"], allowed["exact"] = true, true, true, true
		}
		if len(parts) == 4 && parts[2] == "cfd_tunnel" {
			allowed["is_deleted"], allowed["status"] = true, true
		}
	}
	for key, values := range query {
		if !allowed[key] {
			return &CloudflareRefusal{Reason: RefusalQueryNotAllow, Message: "query parameter " + key + " is not accepted for this Cloudflare Zero Trust read"}
		}
		if len(values) != 1 || len(values[0]) > 256 {
			return &CloudflareRefusal{Reason: RefusalQueryNotAllow, Message: "query parameter " + key + " takes one value of at most 256 characters"}
		}
		switch key {
		case "page", "per_page":
			value, err := strconv.Atoi(values[0])
			if err != nil || value < 1 || (key == "per_page" && value > 1000) {
				message := key + " must be a positive integer"
				if key == "per_page" {
					message += " no larger than 1000"
				}
				return &CloudflareRefusal{Reason: RefusalQueryNotAllow, Message: message}
			}
		case "exact":
			if values[0] != "true" && values[0] != "false" {
				return &CloudflareRefusal{Reason: RefusalQueryNotAllow, Message: "exact must be true or false"}
			}
		}
	}
	return nil
}

func validateCloudflareZeroTrustWrite(method, path string) error {
	call, ok := classifyCloudflareZeroTrust(method, path)
	if !ok || !call.write {
		return &CloudflareRefusal{Reason: RefusalBadRequest, Message: fmt.Sprintf("%s %s is not a supported Cloudflare Zero Trust change", method, cloudflareWriteAuditPath(path))}
	}
	return nil
}

// cloudflareZeroTrustBody keeps the body as plain JSON data and refuses an
// Access bypass before any request leaves Foundry.
func cloudflareZeroTrustBody(method string, raw json.RawMessage) (map[string]any, error) {
	body, err := cloudflareObjectBody(method, raw, "the Zero Trust change")
	if err != nil {
		return nil, err
	}
	if containsCloudflareBypass(body) {
		return nil, &CloudflareRefusal{Message: "Cloudflare Access Bypass is not available through Foundry", Reason: RefusalPathNotAllowed}
	}
	return body, nil
}

func containsCloudflareBypass(value any) bool {
	switch typed := value.(type) {
	case map[string]any:
		for key, child := range typed {
			switch strings.ToLower(key) {
			case "decision", "action":
				if text, ok := child.(string); ok && strings.EqualFold(text, "bypass") {
					return true
				}
			case "bypass":
				if enabled, ok := child.(bool); ok && enabled {
					return true
				}
			}
			if containsCloudflareBypass(child) {
				return true
			}
		}
	case []any:
		for _, child := range typed {
			if containsCloudflareBypass(child) {
				return true
			}
		}
	}
	return false
}

func cloudflareZeroTrustResponseHasSecret(method, path string) bool {
	call, ok := classifyCloudflareZeroTrust(method, path)
	return ok && call.action == cloudflareZeroTrustServiceTokenCreate
}

// redactCloudflareClientSecrets removes write-only credentials from a
// provider response before it reaches a device, audit line or event.
func redactCloudflareClientSecrets(raw json.RawMessage) json.RawMessage {
	var envelope map[string]any
	if json.Unmarshal(raw, &envelope) != nil {
		return json.RawMessage(`{"success":false,"errors":[{"code":502,"message":"Cloudflare returned an unreadable service token response"}]}`)
	}
	redactSecretFields(envelope)
	if result, ok := envelope["result"].(map[string]any); ok {
		result["client_secret_redacted"] = true
	}
	out, err := json.Marshal(envelope)
	if err != nil {
		return json.RawMessage(`{"success":false,"errors":[{"code":502,"message":"Cloudflare returned an unreadable service token response"}]}`)
	}
	return out
}

func redactSecretFields(value any) {
	switch typed := value.(type) {
	case map[string]any:
		for key, child := range typed {
			if strings.EqualFold(key, "client_secret") {
				delete(typed, key)
				continue
			}
			redactSecretFields(child)
		}
	case []any:
		for _, child := range typed {
			redactSecretFields(child)
		}
	}
}

// zeroTrustAccountIDs are the Cloudflare accounts named by the workspace's
// bound zones. Account-level requests are checked against this set, so a
// valid OAuth grant alone cannot reach an account the workspace did not bind.
func (g *CloudflareGateway) zeroTrustAccountIDs(ctx context.Context, lease *gateway.Lease, bound cloudflareBinding) []string {
	use := externalaccounts.Use{SessionID: lease.Grant.SessionID, DeviceID: lease.Device.ID, By: "session"}
	seen := map[string]bool{}
	for _, zone := range bound.binding.ResourceIDs {
		if account := g.zoneAccount(ctx, bound.account, zone, use); account != "" {
			seen[account] = true
		}
	}
	out := make([]string, 0, len(seen))
	for account := range seen {
		out = append(out, account)
	}
	sort.Strings(out)
	return out
}
