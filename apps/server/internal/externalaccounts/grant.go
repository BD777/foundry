package externalaccounts

import (
	"encoding/base64"
	"encoding/json"
	"strings"
	"time"
)

// Grant is a server-held credential: what the secret store seals under
// "external-account:<accountID>". Generation grows with every reseal so two
// concurrent refreshes cannot both spend the same refresh token (the one
// that loaded an older generation finds the record changed and reloads).
type Grant struct {
	AccessToken      string    `json:"access_token"`
	RefreshToken     string    `json:"refresh_token,omitempty"`
	TokenType        string    `json:"token_type,omitempty"`
	AccessExpiresAt  time.Time `json:"access_expires_at"`
	RefreshExpiresAt time.Time `json:"refresh_expires_at,omitempty"`
	// AuthExpiresAt is when the authorization itself ends (Feishu: 365 days
	// from auth_time), after which no refresh helps.
	AuthExpiresAt time.Time `json:"auth_expires_at,omitempty"`
	AuthTime      time.Time `json:"auth_time,omitempty"`
	Scope         string    `json:"scope,omitempty"`
	Generation    int       `json:"generation"`
}

// Scopes splits the grant's space-separated scope string.
func (g Grant) Scopes() []string {
	return splitScopes(g.Scope)
}

func splitScopes(scope string) []string {
	fields := strings.FieldsFunc(scope, func(r rune) bool { return r == ' ' || r == ',' || r == '\t' || r == '\n' })
	seen := map[string]bool{}
	scopes := []string{}
	for _, field := range fields {
		if field == "" || seen[field] {
			continue
		}
		seen[field] = true
		scopes = append(scopes, field)
	}
	return scopes
}

func joinScopes(groups ...[]string) string {
	seen := map[string]bool{}
	scopes := []string{}
	for _, group := range groups {
		for _, scope := range group {
			scope = strings.TrimSpace(scope)
			if scope == "" || seen[scope] {
				continue
			}
			seen[scope] = true
			scopes = append(scopes, scope)
		}
	}
	return strings.Join(scopes, " ")
}

// jwtClaims reads the claims of a JWT without verifying it: the server only
// wants the expiry the token itself names (the issuer signed it; what the
// server does with a wrong value is to try a refresh that fails). Non-JWT
// tokens read as no claims.
func jwtClaims(token string) map[string]any {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return nil
	}
	payload, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(parts[1], "="))
	if err != nil {
		return nil
	}
	var claims map[string]any
	if err := json.Unmarshal(payload, &claims); err != nil {
		return nil
	}
	return claims
}

// jwtTime reads a numeric time claim (seconds since the epoch).
func jwtTime(claims map[string]any, name string) (time.Time, bool) {
	value, ok := claims[name].(float64)
	if !ok || value <= 0 {
		return time.Time{}, false
	}
	return time.Unix(int64(value), 0).UTC(), true
}

// refreshTokenExpiry derives when a refresh token dies: the response field
// when the provider sent one, else the refresh token's own exp claim, else a
// conservative default (Feishu issues 7-day refresh tokens). Never a long
// optimistic default: that would make the server believe a dead grant alive.
func refreshTokenExpiry(now time.Time, refreshExpiresIn int, refreshToken string, fallback time.Duration) time.Time {
	if refreshExpiresIn > 0 {
		return now.Add(time.Duration(refreshExpiresIn) * time.Second)
	}
	if expiry, ok := jwtTime(jwtClaims(refreshToken), "exp"); ok {
		return expiry
	}
	return now.Add(fallback)
}
