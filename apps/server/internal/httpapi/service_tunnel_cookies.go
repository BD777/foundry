package httpapi

import (
	"encoding/base64"
	"encoding/json"
	"github.com/foundry-dev/foundry/apps/server/internal/accounts"
	"net/http"
	"strings"
)

// Browsers do not distinguish a host-only cookie from a parent-Domain cookie
// in the request header. Merely stripping upstream Domain is insufficient:
// another app's JavaScript can still inject parent-domain cookies. Encode app
// cookies under __Host- names so browsers enforce host isolation for them too.
// JS-managed document.cookie names are intentionally not emulated.
const appCookiePrefix = "__Host-fdy_app_"

type appCookieScope struct {
	Name     string `json:"n"`
	Path     string `json:"p"`
	Audience string `json:"a,omitempty"`
}

func scopeAppCookie(cookie *http.Cookie, requestPath string, audience ...string) *http.Cookie {
	path := cookie.Path
	if !strings.HasPrefix(path, "/") {
		path = "/"
		if at := strings.LastIndex(requestPath, "/"); at > 0 {
			path = requestPath[:at]
		}
	}
	scope, _ := json.Marshal(appCookieScope{Name: cookie.Name, Path: path, Audience: appCookieAudienceValue(audience)})
	result := *cookie
	result.Name = appCookiePrefix + base64.RawURLEncoding.EncodeToString(scope)
	result.Path = "/"
	result.Domain = ""
	result.Secure = true
	return &result
}
func unscopedAppCookie(cookie *http.Cookie, requestPath string, audience ...string) *http.Cookie {
	if !strings.HasPrefix(cookie.Name, appCookiePrefix) || len(cookie.Name) > 2048 {
		return nil
	}
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(cookie.Name, appCookiePrefix))
	if err != nil {
		return nil
	}
	var scope appCookieScope
	if json.Unmarshal(raw, &scope) != nil || scope.Name == "" || scope.Audience != appCookieAudienceValue(audience) || !strings.HasPrefix(scope.Path, "/") {
		return nil
	}
	path := scope.Path
	if requestPath != path && !(strings.HasPrefix(requestPath, path) && (strings.HasSuffix(path, "/") || strings.HasPrefix(strings.TrimPrefix(requestPath, path), "/"))) {
		return nil
	}
	result := &http.Cookie{Name: scope.Name, Value: cookie.Value, Path: scope.Path}
	if result.Valid() != nil || result.Name == sessionCookieName || strings.HasPrefix(result.Name, "__Host-foundry") {
		return nil
	}
	return result
}

// Scope application cookies to a Foundry login and mapping, not merely the
// browser hostname. A different authorized person sharing this application
// must not inherit the previous person's upstream application login cookie.
func previewAppCookieAudience(grant previewGrant) string {
	return accounts.HashToken(grant.TunnelID + "\x00" + grant.SessionHash)
}
func appCookieAudienceValue(values []string) string {
	if len(values) > 0 {
		return values[0]
	}
	return ""
}
func clearOtherAppCookieAudiences(w http.ResponseWriter, r *http.Request, audience string) {
	for _, c := range r.Cookies() {
		if !strings.HasPrefix(c.Name, appCookiePrefix) || len(c.Name) > 2048 {
			continue
		}
		raw, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(c.Name, appCookiePrefix))
		var scope appCookieScope
		if err == nil && json.Unmarshal(raw, &scope) == nil && scope.Audience == audience {
			continue
		}
		http.SetCookie(w, &http.Cookie{Name: c.Name, Path: "/", MaxAge: -1, Secure: true, HttpOnly: true, SameSite: http.SameSiteLaxMode})
	}
}
