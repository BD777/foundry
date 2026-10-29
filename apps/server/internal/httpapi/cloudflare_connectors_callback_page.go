package httpapi

import (
	"errors"
	"html"
	"net/http"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/accounts"
	"github.com/foundry-dev/foundry/apps/server/internal/externalaccounts"
)

// The page the browser lands on when Cloudflare returns to Foundry
// (DEV-091). Every outcome, a refused one included, is this page with its
// reason and a way back to Connectors, never a bare JSON error.

const (
	callbackReceived  = "received"
	callbackSignedOut = "signed_out"
	callbackBrowser   = "browser"
	callbackDenied    = "denied"
	callbackFailed    = "failed"
)

type callbackCopy struct{ title, body string }

var cloudflareCallbackCopy = map[string]map[string]callbackCopy{
	"en": {
		callbackReceived:                      {"Cloudflare authorization received", "Return to Foundry Connectors to choose the zones and workspaces that may use this account. You can close this tab."},
		externalaccounts.CallbackUnknown:      {"Foundry has no record of this authorization", "It may have been removed after it expired, or started on another Foundry server. Start the connection again from Connectors."},
		externalaccounts.CallbackExpired:      {"This authorization expired", "A Cloudflare sign-in has to be finished within 10 minutes of starting it. Start the connection again from Connectors."},
		externalaccounts.CallbackUsed:         {"This authorization was already used", "Each return from Cloudflare works once. Check Connectors: the account may already be connected. If it is not, start the connection again."},
		externalaccounts.CallbackClosed:       {"This authorization was closed", "The connection dialog in Foundry was closed before Cloudflare returned. Start the connection again from Connectors."},
		externalaccounts.CallbackSuperseded:   {"This authorization was replaced", "A Cloudflare connection was disconnected, revoked or reconnected after this sign-in started. Start the connection again from Connectors."},
		externalaccounts.CallbackOtherAccount: {"This authorization belongs to another Foundry account", "Sign in to Foundry as the person who started this connection, or start a new connection from Connectors."},
		externalaccounts.CallbackIssuer:       {"Cloudflare's reply could not be verified", "The reply did not come from the Cloudflare authorization server this sign-in expects. Start the connection again from Connectors."},
		externalaccounts.CallbackNotReady:     {"This authorization was not ready", "Foundry had not finished preparing this sign-in. Start the connection again from Connectors."},
		callbackSignedOut:                     {"Sign in to Foundry first", "This browser is not signed in to Foundry. Sign in, then start the connection again from Connectors."},
		callbackBrowser:                       {"The browser did not confirm this return", "Foundry accepts Cloudflare's return only as a top-level page opened from Cloudflare. Start the connection again from Connectors and open the Cloudflare link in this browser."},
		callbackDenied:                        {"Cloudflare authorization was declined", "Cloudflare reported that access was not granted. Start the connection again from Connectors to connect."},
		callbackFailed:                        {"Authorization was not confirmed", "Foundry could not confirm the authorization with Cloudflare. Return to Connectors to check it; this return cannot be reused."},
	},
	"zh-CN": {
		callbackReceived:                      {"已收到 Cloudflare 授权", "请回到 Foundry 连接器，选择允许使用此账号的域名和工作区。可以关闭此标签页。"},
		externalaccounts.CallbackUnknown:      {"Foundry 没有这次授权的记录", "它可能已过期并被清除，或是在另一台 Foundry 服务器上发起的。请从连接器重新连接。"},
		externalaccounts.CallbackExpired:      {"这次授权已过期", "Cloudflare 登录需要在开始后 10 分钟内完成。请从连接器重新连接。"},
		externalaccounts.CallbackUsed:         {"这次授权已被使用", "每次从 Cloudflare 返回只能使用一次。请在连接器中查看，账号可能已经连接；如未连接，请重新连接。"},
		externalaccounts.CallbackClosed:       {"这次授权已关闭", "Cloudflare 返回前，Foundry 中的连接对话框已被关闭。请从连接器重新连接。"},
		externalaccounts.CallbackSuperseded:   {"这次授权已被取代", "这次登录开始后，有 Cloudflare 连接被断开、撤销或重新连接。请从连接器重新连接。"},
		externalaccounts.CallbackOtherAccount: {"这次授权属于另一个 Foundry 账号", "请以发起这次连接的人登录 Foundry，或从连接器发起新的连接。"},
		externalaccounts.CallbackIssuer:       {"无法验证 Cloudflare 的答复", "答复并非来自这次登录预期的 Cloudflare 授权服务器。请从连接器重新连接。"},
		externalaccounts.CallbackNotReady:     {"这次授权尚未就绪", "Foundry 还没有准备好这次登录。请从连接器重新连接。"},
		callbackSignedOut:                     {"请先登录 Foundry", "此浏览器尚未登录 Foundry。请登录后从连接器重新连接。"},
		callbackBrowser:                       {"浏览器未确认这次返回", "Foundry 只接受从 Cloudflare 打开的顶层页面返回。请从连接器重新连接，并在此浏览器中打开 Cloudflare 链接。"},
		callbackDenied:                        {"Cloudflare 授权被拒绝", "Cloudflare 报告未授予访问权限。如需连接，请从连接器重新连接。"},
		callbackFailed:                        {"授权未能确认", "Foundry 未能向 Cloudflare 确认这次授权。请回到连接器查看；这次返回不能再次使用。"},
	},
}

var cloudflareCallbackLink = map[string]string{"en": "Return to Connectors", "zh-CN": "返回连接器"}

// isCloudflareCallback is a browser's GET of the OAuth callback.
func isCloudflareCallback(r *http.Request) bool {
	return r.Method == http.MethodGet && r.URL.Path == cloudflareOAuthCallbackPath
}

// writeCloudflareCallbackPage answers the callback with outcome's page. The
// page has no script and no reference to the query: the code never echoes.
func writeCloudflareCallbackPage(w http.ResponseWriter, r *http.Request, status int, outcome string) {
	language := requestLanguage(r)
	if language == "" {
		language = "en"
	}
	text, ok := cloudflareCallbackCopy[language][outcome]
	if !ok {
		text = cloudflareCallbackCopy[language][callbackFailed]
	}
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'; base-uri 'none'")
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(status)
	_, _ = w.Write([]byte(`<!doctype html><html lang="` + language + `"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>` +
		html.EscapeString(text.title) + `</title><h1>` + html.EscapeString(text.title) + `</h1><p>` + html.EscapeString(text.body) +
		`</p><p><a href="/connectors/cloudflare">` + html.EscapeString(cloudflareCallbackLink[language]) + `</a></p></html>`))
}

// callbackOutcome names the page for a failed callback completion.
func callbackOutcome(err error) string {
	var problem *externalaccounts.CallbackError
	switch {
	case errors.As(err, &problem):
		return problem.Problem
	case errors.Is(err, externalaccounts.ErrLoginDenied):
		return callbackDenied
	}
	return callbackFailed
}

// refuseCloudflareCallback answers a callback the browser provenance rule
// refused with the reason it cannot complete. It only reads: nothing is
// claimed or exchanged, so the refusal stays a refusal.
func (s *Server) refuseCloudflareCallback(w http.ResponseWriter, r *http.Request) {
	owner := s.callbackOwner(r)
	if owner == "" {
		writeCloudflareCallbackPage(w, r, http.StatusUnauthorized, callbackSignedOut)
		return
	}
	outcome := callbackBrowser
	if s.connectors != nil && s.connectors.ServerHeld != nil {
		query := r.URL.Query()
		if problem := s.connectors.ServerHeld.AuthorizationCodeCallbackProblem(owner, query.Get("state"), query.Get("iss")); problem != "" {
			outcome = problem
		}
	}
	writeCloudflareCallbackPage(w, r, http.StatusForbidden, outcome)
}

// callbackOwner is the signed-in person the request's session cookie
// names, "" for none.
func (s *Server) callbackOwner(r *http.Request) string {
	cookie, err := r.Cookie(s.accountCookieName())
	if err != nil {
		return ""
	}
	user, _, err := s.store.ResolveUserSession(r.Context(), accounts.HashToken(cookie.Value), time.Now(), time.Time{}, time.Time{})
	if err != nil {
		return ""
	}
	return user.ID
}
