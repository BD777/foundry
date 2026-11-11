package connectors

import (
	"bytes"
	"cmp"
	"encoding/json"
	"net/http"
	"strings"

	"github.com/foundry-dev/foundry/apps/server/internal/externalaccounts"
)

// Changes through the gateway (DEV-092). A workspace's zone binding has an
// access level its owner picks in Connectors → Cloudflare; a level other
// than read lets the workspace's sessions change what that level names, in
// the bound zones only. Every attempt is a line of the account's activity
// log; the owner's choice of level is the consent, so there is no per-call
// confirmation.

// CloudflareWriteEvent is the kind of the activity line of a change attempt.
const CloudflareWriteEvent = "cloudflare_write"

// CloudflareWriteDetail is that line's detail (JSON): never a token, and no
// request body beyond a record's name, type and content.
type CloudflareWriteDetail struct {
	WorkspaceID string `json:"workspaceId"`
	Method      string `json:"method"`
	// Path is the call's path with the zone and record ids as ":id".
	Path       string `json:"path"`
	ZoneID     string `json:"zoneId,omitempty"`
	RecordID   string `json:"recordId,omitempty"`
	RecordName string `json:"recordName,omitempty"`
	RecordType string `json:"recordType,omitempty"`
	Content    string `json:"content,omitempty"`
	// Result: "succeeded", "failed" (Cloudflare refused or did not answer)
	// or "refused" (Foundry did not send it).
	Result string `json:"result"`
	Error  string `json:"error,omitempty"`
}

// Reasons a request is refused by Foundry rather than by Cloudflare.
const (
	RefusalNoGrant        = "no_grant"
	RefusalNotBound       = "zone_not_bound"
	RefusalAccessLevel    = "access_level"
	RefusalScopeMissing   = "scope_missing"
	RefusalPathNotAllowed = "path_not_allowed"
	RefusalQueryNotAllow  = "query_not_allowed"
	RefusalBadRequest     = "bad_request"
)

// CloudflareRefusal is a request Foundry did not send: the binding's access
// level, bound zones or grant do not allow it. Message says what would allow
// it and where; Reason, Needed and Current say the same to a program.
type CloudflareRefusal struct {
	Message string
	Reason  string
	// Needed is the access level that would allow the request, Current the
	// workspace binding's.
	Needed  string
	Current string
}

func (e *CloudflareRefusal) Error() string        { return e.Message }
func (e *CloudflareRefusal) Is(target error) bool { return target == ErrCloudflareAccess }

// Foundry is the structured part of a refusal's answer, beside Cloudflare's
// own "errors": what was refused, which level would allow it, and where the
// person sets it.
func (e *CloudflareRefusal) Foundry() map[string]any {
	out := map[string]any{"refused": true, "reason": cmp.Or(e.Reason, RefusalNoGrant)}
	if e.Needed != "" {
		out["needed"] = e.Needed
	}
	if e.Current != "" {
		out["current"] = e.Current
	}
	switch e.Reason {
	case RefusalAccessLevel, RefusalScopeMissing, RefusalNotBound, RefusalNoGrant:
		out["where"] = cloudflareAccessWhereShort
	}
	return out
}

const cloudflareAccessWhereShort = "Connectors → this workspace → Cloudflare (Session access); the account owner decides"
const cloudflareAccessWhere = "the account owner sets it per workspace in Connectors → this workspace → Cloudflare"

// cloudflareWriteRules say which changes each level other than read
// allows: method and path below /zones/<bound zone>/.
var cloudflareWriteRules = map[string]func(method string, rest []string) bool{
	externalaccounts.CloudflareAccessDNSEdit: func(method string, rest []string) bool {
		if len(rest) == 1 && rest[0] == "dns_records" {
			return method == http.MethodPost
		}
		if len(rest) == 2 && rest[0] == "dns_records" && cloudflareZoneID.MatchString(rest[1]) {
			return method == http.MethodPatch || method == http.MethodPut || method == http.MethodDelete
		}
		return false
	},
}

const cloudflareDNSEditPaths = "POST /zones/<zone id>/dns_records, and PATCH, PUT or DELETE /zones/<zone id>/dns_records/<record id>"

// cloudflareWriteBody is the request body as plain JSON data: an object for
// POST, PATCH and PUT, nothing for DELETE.
func cloudflareWriteBody(method string, raw json.RawMessage) (map[string]any, error) {
	return cloudflareObjectBody(method, raw, "the DNS record, with fields such as type, name, content, ttl, proxied and comment")
}

// cloudflareObjectBody is one JSON object for a change, nothing for DELETE.
func cloudflareObjectBody(method string, raw json.RawMessage, description string) (map[string]any, error) {
	empty := len(bytes.TrimSpace(raw)) == 0 || string(bytes.TrimSpace(raw)) == "null"
	if method == http.MethodDelete {
		if !empty {
			return nil, &CloudflareRefusal{Message: "DELETE takes no body", Reason: RefusalBadRequest}
		}
		return nil, nil
	}
	if empty {
		return nil, &CloudflareRefusal{Message: method + " needs a body: " + description + ", as a JSON object", Reason: RefusalBadRequest}
	}
	if len(raw) > 16*1024 {
		return nil, &CloudflareRefusal{Message: "the body is larger than 16 KiB", Reason: RefusalBadRequest}
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var body map[string]any
	if err := decoder.Decode(&body); err != nil || body == nil || decoder.More() {
		return nil, &CloudflareRefusal{Message: "the body must be one JSON object", Reason: RefusalBadRequest}
	}
	return body, nil
}

func resultObject(data json.RawMessage) map[string]any {
	var envelope struct {
		Result map[string]any `json:"result"`
	}
	_ = json.Unmarshal(data, &envelope)
	return envelope.Result
}

// recordFields are a DNS record's name, type and content, each cut short.
func recordFields(record map[string]any) (name, kind, content string) {
	text := func(key string, limit int) string {
		value, _ := record[key].(string)
		value = strings.Map(func(r rune) rune {
			if r < 0x20 {
				return ' '
			}
			return r
		}, value)
		if len(value) > limit {
			value = value[:limit] + "…"
		}
		return value
	}
	return text("name", 255), text("type", 16), text("content", 512)
}

// cloudflareWriteAuditPath is a zone, account, application, policy or tunnel
// path with its opaque ids as ":id", or "unsupported_path" when the request
// never had a shape Foundry forwards.
func cloudflareWriteAuditPath(path string) string {
	parts := strings.Split(strings.TrimPrefix(path, "/"), "/")
	if len(parts) < 2 || (parts[0] != "zones" && parts[0] != "accounts") || !cloudflareZoneID.MatchString(parts[1]) || len(parts) > 9 || strings.ContainsAny(path, "\\%?#\x00\r\n") {
		return "unsupported_path"
	}
	parts[1] = ":id"
	for i := 2; i < len(parts); i++ {
		if cloudflareZoneID.MatchString(parts[i]) {
			parts[i] = ":id"
		} else if len(parts[i]) > 40 {
			return "unsupported_path"
		}
	}
	return "/" + strings.Join(parts, "/")
}

func shortError(err error) string {
	text := err.Error()
	if len(text) > 300 {
		text = text[:300]
	}
	return text
}
