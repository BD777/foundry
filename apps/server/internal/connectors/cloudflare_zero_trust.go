package connectors

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"

	"github.com/foundry-dev/foundry/apps/server/internal/externalaccounts"
	"github.com/foundry-dev/foundry/apps/server/internal/gateway"
)

// The Zero Trust actions of access/cloudflare.json that the gateway treats
// specially.
const (
	cloudflareZeroTrustServiceTokenCreate = "service_token_create"
)

var cloudflareOpaqueID = regexp.MustCompile(`^[a-fA-F0-9-]{16,64}$`)

// cloudflareZeroTrustCall is Classify's reading of an account-level Access
// or Tunnel request.
type cloudflareZeroTrustCall struct {
	account string
	level   string
	action  string
	write   bool
}

// classifyCloudflareZeroTrust recognises the account-level paths Foundry
// exposes: the /accounts/ routes of access/cloudflare.json. It is
// deliberately an allowlist: a new Access or Tunnel endpoint does not become
// reachable merely because the OAuth grant can call it.
func classifyCloudflareZeroTrust(method, path string) (cloudflareZeroTrustCall, bool) {
	if !strings.HasPrefix(path, "/accounts/") {
		return cloudflareZeroTrustCall{}, false
	}
	route, ok := matchCloudflareRoute(method, path)
	if !ok || route.account == "" {
		return cloudflareZeroTrustCall{}, false
	}
	return cloudflareZeroTrustCall{account: route.account, level: route.Level, action: route.Action, write: method != http.MethodGet}, true
}

func validateCloudflareZeroTrustRead(path string, query url.Values) error {
	route, _ := matchCloudflareRoute(http.MethodGet, path)
	for key, values := range query {
		if !slices.Contains(route.Query, key) {
			message := "query parameter " + key + " is not accepted for this Cloudflare Zero Trust read"
			if len(route.Query) > 0 {
				message += "; it takes " + strings.Join(route.Query, ", ")
			}
			return &CloudflareRefusal{Reason: RefusalQueryNotAllow, Message: message}
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
