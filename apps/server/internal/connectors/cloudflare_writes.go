package connectors

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/externalaccounts"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
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

// CloudflareRefusal is a request the binding's access level does not
// allow; its message says what would allow it and where.
type CloudflareRefusal struct{ Message string }

func (e *CloudflareRefusal) Error() string        { return e.Message }
func (e *CloudflareRefusal) Is(target error) bool { return target == ErrCloudflareAccess }

const cloudflareAccessWhere = "the account owner sets it per workspace in Connectors → Cloudflare, Workspace access"

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

// RequestSession is the session's call of method on path: GET reads as
// ReadSession does; a change goes through when the binding's level allows
// it.
func (g *CloudflareGateway) RequestSession(ctx context.Context, sessionID, deviceID, owner, workspaceID, accountID, method, path string, body json.RawMessage) (json.RawMessage, error) {
	method = strings.ToUpper(strings.TrimSpace(method))
	if method == "" || method == http.MethodGet {
		if len(body) > 0 && string(body) != "null" {
			return nil, &CloudflareRefusal{"a GET request takes no body"}
		}
		return g.ReadSession(ctx, sessionID, deviceID, owner, accountID, path, nil)
	}
	return g.writeSession(ctx, sessionID, deviceID, owner, workspaceID, accountID, method, path, body)
}

func (g *CloudflareGateway) writeSession(ctx context.Context, sessionID, deviceID, owner, workspaceID, accountID, method, path string, raw json.RawMessage) (result json.RawMessage, err error) {
	ctx, cancel := context.WithTimeout(ctx, 45*time.Second)
	defer cancel()
	account, binding, err := g.checkBinding(ctx, sessionID, deviceID, owner, accountID)
	if err != nil {
		return nil, err
	}
	detail := CloudflareWriteDetail{WorkspaceID: workspaceID, Method: method, Path: cloudflareWriteAuditPath(path), Result: "refused"}
	defer func() {
		if err != nil && detail.Error == "" {
			detail.Error = shortError(err)
		}
		line, _ := json.Marshal(detail)
		// The caller's context may be over; the line is still written.
		audit, done := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer done()
		_ = g.store.AppendExternalAccountEvent(audit, store.ExternalAccountEvent{AccountID: account.ID, Kind: CloudflareWriteEvent, SessionID: sessionID, DeviceID: deviceID, ActorID: owner, Detail: string(line)})
	}()
	// A refused attempt names the record it was for, too.
	var attempted map[string]any
	if len(raw) <= 16*1024 && json.Unmarshal(raw, &attempted) == nil {
		detail.RecordName, detail.RecordType, detail.Content = recordFields(attempted)
	}
	zone, rest, err := validateCloudflareWrite(method, path, binding, account.GrantedScopes)
	if err != nil {
		return nil, err
	}
	detail.ZoneID = zone
	if len(rest) == 2 {
		detail.RecordID = rest[1]
	}
	body, err := cloudflareWriteBody(method, raw)
	if err != nil {
		return nil, err
	}
	detail.RecordName, detail.RecordType, detail.Content = recordFields(body)
	use := externalaccounts.Use{SessionID: sessionID, DeviceID: deviceID, By: "session"}
	if method == http.MethodDelete {
		// The log names what was removed, not only its id.
		if before, e := g.accounts.CloudflareRead(ctx, account, path, nil, use); e == nil {
			detail.RecordName, detail.RecordType, detail.Content = recordFields(resultObject(before))
		}
	}
	result, err = g.accounts.CloudflareRequest(ctx, account, method, path, nil, body, use)
	detail.Result = "failed"
	if err != nil {
		return nil, err
	}
	var answer struct {
		Success bool                                  `json:"success"`
		Errors  []externalaccounts.CloudflareAPIError `json:"errors"`
	}
	_ = json.Unmarshal(result, &answer)
	if !answer.Success {
		for _, e := range answer.Errors {
			detail.Error = strings.TrimPrefix(detail.Error+fmt.Sprintf("; %d: %s", e.Code, e.Message), "; ")
		}
		if detail.Error == "" {
			detail.Error = "Cloudflare did not report success"
		}
		return result, nil
	}
	detail.Result = "succeeded"
	if name, kind, content := recordFields(resultObject(result)); name != "" {
		detail.RecordName, detail.RecordType, detail.Content = name, kind, content
	}
	return result, nil
}

// validateCloudflareWrite decides a change: the path must be in a bound
// zone and the binding's level must allow method there, with the grant
// still holding the level's scopes. It answers the zone and the path's
// rest below it.
func validateCloudflareWrite(method, path string, binding store.ExternalAccountBinding, granted []string) (string, []string, error) {
	switch method {
	case http.MethodPost, http.MethodPatch, http.MethodPut, http.MethodDelete:
	default:
		return "", nil, &CloudflareRefusal{fmt.Sprintf("method %s is not supported; use GET, POST, PATCH, PUT or DELETE", method)}
	}
	if strings.ContainsAny(path, "\\%?#\x00\r\n") || strings.Contains(path, "..") {
		return "", nil, ErrCloudflareAccess
	}
	parts := strings.Split(strings.TrimPrefix(path, "/"), "/")
	if len(parts) < 3 || parts[0] != "zones" || !cloudflareZoneID.MatchString(parts[1]) {
		return "", nil, &CloudflareRefusal{fmt.Sprintf("%s %s is outside what a workspace's Cloudflare access allows. DNS edit allows %s in the workspace's bound zones; other changes stay with the person in the Cloudflare dashboard", method, cloudflareWriteAuditPath(path), cloudflareDNSEditPaths)}
	}
	bound := false
	for _, id := range binding.ResourceIDs {
		bound = bound || id == parts[1]
	}
	if !bound {
		return "", nil, ErrCloudflareAccess
	}
	rest := parts[2:]
	current := binding.Access
	if current == "" {
		current = externalaccounts.CloudflareAccessRead
	}
	if allows := cloudflareWriteRules[current]; allows != nil && allows(method, rest) {
		level, _ := externalaccounts.CloudflareAccessLevel(current)
		if missing := externalaccounts.MissingScopes(level, granted); len(missing) > 0 {
			return "", nil, &CloudflareRefusal{fmt.Sprintf("this workspace has %s access, but the Cloudflare authorization no longer includes %s; the account owner re-authorizes in Connectors → Cloudflare", current, strings.Join(missing, ", "))}
		}
		return parts[1], rest, nil
	}
	for name, allows := range cloudflareWriteRules {
		if allows(method, rest) {
			return "", nil, &CloudflareRefusal{fmt.Sprintf("%s %s needs the %s access level; this workspace's Cloudflare binding has %s access, and %s", method, cloudflareWriteAuditPath(path), name, current, cloudflareAccessWhere)}
		}
	}
	return "", nil, &CloudflareRefusal{fmt.Sprintf("%s %s is outside what a workspace's Cloudflare access allows. DNS edit allows %s; other changes stay with the person in the Cloudflare dashboard", method, cloudflareWriteAuditPath(path), cloudflareDNSEditPaths)}
}

// cloudflareWriteBody is the request body as plain JSON data: an object for
// POST, PATCH and PUT, nothing for DELETE.
func cloudflareWriteBody(method string, raw json.RawMessage) (map[string]any, error) {
	empty := len(bytes.TrimSpace(raw)) == 0 || string(bytes.TrimSpace(raw)) == "null"
	if method == http.MethodDelete {
		if !empty {
			return nil, &CloudflareRefusal{"DELETE takes no body"}
		}
		return nil, nil
	}
	if empty {
		return nil, &CloudflareRefusal{method + " needs a body: the DNS record as a JSON object (type, name, content, ttl, proxied, comment…)"}
	}
	if len(raw) > 16*1024 {
		return nil, &CloudflareRefusal{"the body is larger than 16 KiB"}
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var body map[string]any
	if err := decoder.Decode(&body); err != nil || body == nil || decoder.More() {
		return nil, &CloudflareRefusal{"the body must be one JSON object"}
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

// cloudflareWriteAuditPath is path with its zone and record ids as ":id",
// or "unsupported_path" for one outside /zones/<id>/….
func cloudflareWriteAuditPath(path string) string {
	parts := strings.Split(strings.TrimPrefix(path, "/"), "/")
	if len(parts) < 2 || parts[0] != "zones" || !cloudflareZoneID.MatchString(parts[1]) || len(parts) > 6 || strings.ContainsAny(path, "\\%?#\x00\r\n") {
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
