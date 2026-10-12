package feishugateway

import (
	"net/http"
	"regexp"
	"strings"
)

// The gateway forwards every Feishu open-API call a session makes, within
// what Feishu itself grants the account or the app (the person decided
// pass-through within the granted scopes, 2026-10-12). It refuses only
// what a session must never do through Foundry, read from the API
// catalogue of the Feishu Go SDK feishu-cli links (larksuite/oapi-sdk-go
// v3.5.3, service/*):
//
//   - credentials: auth/v3 (app_access_token, app_ticket/resend, store-app
//     tenant tokens) and authen/v1 token exchange and refresh. The gateway
//     answers the one token call feishu-cli needs (tenant_access_token/
//     internal) with a stand-in itself; real tokens never reach a device,
//     and a session cannot mint its own from a code.
//   - the app's own settings: every write under application/v6 (enable or
//     disable the app, visibility, collaborators, owner transfer, version
//     approval, contact range, scope applications, badges). A session acts
//     with the app, it does not reconfigure it.
//   - tenant administration: admin/v1 (password reset, badges, admin
//     statistics and audit), passport/v1 (sign people out of their
//     devices, read their sessions) and security_and_compliance (the
//     tenant's OpenAPI and device audit logs).
//
// Everything else passes, and every call is audited.

type blockRule struct {
	prefix string
	// writesOnly: GET and HEAD pass.
	writesOnly bool
	// except are full paths that pass anyway (method-independent).
	except []string
	reason string
}

var blockRules = []blockRule{
	{prefix: "/open-apis/auth/", reason: "issues app credentials; sessions get stand-ins from Foundry"},
	{prefix: "/open-apis/authen/", except: []string{"/open-apis/authen/v1/user_info"}, reason: "exchanges or refreshes user tokens; Foundry holds this login"},
	{prefix: "/open-apis/application/", writesOnly: true, reason: "changes the app's own settings"},
	{prefix: "/open-apis/admin/", reason: "tenant administration"},
	{prefix: "/open-apis/passport/", reason: "tenant administration (people's sign-in sessions)"},
	{prefix: "/open-apis/security_and_compliance/", reason: "tenant administration (audit logs)"},
}

// blocked returns why the gateway refuses method on path, or "".
func blocked(method, path string) string {
	for _, rule := range blockRules {
		if !strings.HasPrefix(path, rule.prefix) {
			continue
		}
		if rule.writesOnly && (method == http.MethodGet || method == http.MethodHead) {
			return ""
		}
		for _, allowed := range rule.except {
			if path == allowed {
				return ""
			}
		}
		return rule.reason
	}
	return ""
}

var (
	versionSegment = regexp.MustCompile(`^v[0-9]+$`)
	wordSegment    = regexp.MustCompile(`^[a-z][a-z_.-]*$`)
)

// pathTemplate is the audit's path: ids (any segment that is not a version
// or a lowercase word) become ":id", so the audit names the API, not the
// documents, chats or people it touched.
func pathTemplate(path string) string {
	segments := strings.Split(path, "/")
	for index, segment := range segments {
		if segment == "" || versionSegment.MatchString(segment) || (wordSegment.MatchString(segment) && len(segment) <= 40) {
			continue
		}
		segments[index] = ":id"
	}
	template := strings.Join(segments, "/")
	if len(template) > 200 {
		template = template[:200]
	}
	return template
}
