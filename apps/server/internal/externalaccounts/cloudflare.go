package externalaccounts

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

const cloudflareMCPOrigin = "https://mcp.cloudflare.com"

// CloudflareRequestError contains a fixed phase and HTTP status and at most
// the code and message of the Cloudflare API errors a failed tool call
// reported, never a provider response body, URL, header or credential.
type CloudflareRequestError struct {
	Status int
	Kind   string
	API    []CloudflareAPIError
}

// CloudflareAPIError is one entry of a Cloudflare API "errors" list.
type CloudflareAPIError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

func (e *CloudflareRequestError) Error() string {
	text := fmt.Sprintf("Cloudflare %s (HTTP %d)", e.Kind, e.Status)
	for _, api := range e.API {
		text += fmt.Sprintf("; %d: %s", api.Code, api.Message)
	}
	return text
}

// cloudflareAPIErrors finds a Cloudflare API "errors" list in a failed tool
// call's text and keeps only codes and short messages.
func cloudflareAPIErrors(text string) []CloudflareAPIError {
	start := strings.Index(text, "{")
	if start < 0 {
		return nil
	}
	var body struct {
		Errors []CloudflareAPIError `json:"errors"`
	}
	if json.NewDecoder(strings.NewReader(text[start:])).Decode(&body) != nil {
		return nil
	}
	out := []CloudflareAPIError{}
	for _, e := range body.Errors {
		if len(out) == 3 {
			break
		}
		message := strings.Map(func(r rune) rune {
			if r < 0x20 {
				return ' '
			}
			return r
		}, e.Message)
		if len(message) > 200 {
			message = message[:200]
		}
		out = append(out, CloudflareAPIError{Code: e.Code, Message: message})
	}
	return out
}

// Cloudflare uses the official MCP authorization server. Its OAuth credentials
// are never presented to the public REST API or exported to a device CLI.
type Cloudflare struct {
	BaseURL string
	Client  *http.Client
	Now     func() time.Time
}

func NewCloudflare() *Cloudflare {
	return &Cloudflare{BaseURL: cloudflareMCPOrigin, Client: &http.Client{Timeout: 25 * time.Second, CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }}, Now: time.Now}
}
func (c *Cloudflare) OAuthIssuer() string { return c.BaseURL }
func (c *Cloudflare) Describe() store.ExternalProvider {
	return store.ExternalProvider{Kind: "cloudflare", Label: "Cloudflare", CredentialMode: store.ExternalCredentialServerHeld, AuthMethods: []string{"oauth_authorization_code"}, Tools: []string{"cf", "cloudflare_mcp"}, DefaultBaseURL: cloudflareMCPOrigin, AlwaysScopes: []string{"offline_access", "user:read", "account:read"},
		AccessLevels: CloudflareAccessLevels,
		// What Foundry asks for; Connectors compares a grant with it.
		ScopePreset: &store.ExternalScopePreset{Name: "Foundry read-only", Source: "Foundry", Scopes: c.PresetScopes(false)}}
}

// Cloudflare access levels of a workspace's zone binding (DEV-092): read
// (the default), or read plus DNS record changes in the bound zones. The
// gateway (connectors.CloudflareGateway) holds what each one allows.
const (
	CloudflareAccessRead    = "read"
	CloudflareAccessDNSEdit = "dns_edit"
)

var CloudflareAccessLevels = []store.ExternalAccessLevel{
	{Name: CloudflareAccessRead},
	{Name: CloudflareAccessDNSEdit, Scopes: []string{"dns.write"}},
}

// CloudflareAccessLevel is the named level; "" is the default.
func CloudflareAccessLevel(name string) (store.ExternalAccessLevel, bool) {
	if name == "" {
		name = CloudflareAccessRead
	}
	for _, level := range CloudflareAccessLevels {
		if level.Name == name {
			return level, true
		}
	}
	return store.ExternalAccessLevel{}, false
}

// MissingScopes are the level's scopes the grant does not hold.
func MissingScopes(level store.ExternalAccessLevel, granted []string) []string {
	missing := []string{}
	for _, scope := range level.Scopes {
		if !slices.Contains(granted, scope) {
			missing = append(missing, scope)
		}
	}
	return missing
}

func (c *Cloudflare) PresetScopes(bool) []string {
	return []string{"offline_access", "user:read", "account:read", "zone.read", "dns.read", "ssl-and-certificates.read"}
}
func (c *Cloudflare) ScopeApplyURL(AppCredentials, []string) string { return "" }
func (c *Cloudflare) do(ctx context.Context, path, contentType string, body []byte, token string) ([]byte, http.Header, int, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.BaseURL+path, bytes.NewReader(body))
	if err != nil {
		return nil, nil, 0, err
	}
	req.Header.Set("Content-Type", contentType)
	req.Header.Set("Accept", "application/json, text/event-stream")
	req.Header.Set("User-Agent", "Foundry-Connector/1.0")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
		req.Header.Set("MCP-Protocol-Version", "2025-06-18")
	}
	res, err := c.Client.Do(req)
	if err != nil {
		return nil, nil, 0, errors.New("Cloudflare connection failed")
	}
	defer res.Body.Close()
	data, err := io.ReadAll(io.LimitReader(res.Body, 4*1024*1024+1))
	if err != nil || len(data) > 4*1024*1024 {
		return nil, nil, res.StatusCode, errors.New("Cloudflare response unavailable or too large")
	}
	return data, res.Header, res.StatusCode, nil
}
func (c *Cloudflare) RegisterPublicClient(ctx context.Context, redirectURI string) (string, error) {
	body, _ := json.Marshal(map[string]any{"client_name": "Foundry Cloudflare Connector", "redirect_uris": []string{redirectURI}, "grant_types": []string{"authorization_code", "refresh_token"}, "response_types": []string{"code"}, "token_endpoint_auth_method": "none"})
	data, _, status, err := c.do(ctx, "/register", "application/json", body, "")
	if err != nil {
		return "", err
	}
	if status < 200 || status >= 300 {
		return "", fmt.Errorf("Cloudflare client registration HTTP %d", status)
	}
	var out struct {
		ClientID string `json:"client_id"`
		Method   string `json:"token_endpoint_auth_method"`
	}
	if json.Unmarshal(data, &out) != nil || out.ClientID == "" || (out.Method != "" && out.Method != "none") {
		return "", errors.New("Cloudflare returned an invalid public client")
	}
	return out.ClientID, nil
}
func (c *Cloudflare) AuthorizationURL(clientID, redirectURI, state, challenge string, scopes []string) string {
	q := url.Values{"response_type": {"code"}, "client_id": {clientID}, "redirect_uri": {redirectURI}, "state": {state}, "code_challenge": {challenge}, "code_challenge_method": {"S256"}, "scope": {strings.Join(scopes, " ")}, "resource": {c.BaseURL + "/mcp"}}
	return c.BaseURL + "/authorize?" + q.Encode()
}
func (c *Cloudflare) token(ctx context.Context, form url.Values) (Grant, error) {
	data, _, status, err := c.do(ctx, "/token", "application/x-www-form-urlencoded", []byte(form.Encode()), "")
	if err != nil {
		return Grant{}, &RefreshError{Uncertain: true, Description: "Cloudflare token response was not confirmed"}
	}
	var out struct {
		Access         string `json:"access_token"`
		Refresh        string `json:"refresh_token"`
		Type           string `json:"token_type"`
		Expires        int    `json:"expires_in"`
		RefreshExpires int    `json:"refresh_token_expires_in"`
		Scope          string `json:"scope"`
		Error          string `json:"error"`
	}
	if json.Unmarshal(data, &out) != nil {
		return Grant{}, &RefreshError{Uncertain: true, Description: "Cloudflare token response was unreadable"}
	}
	switch out.Error {
	case "", "invalid_grant", "invalid_client", "invalid_scope", "access_denied", "temporarily_unavailable", "server_error", "unsupported_grant_type", "invalid_request":
	default:
		out.Error = "provider_error"
	}
	if status < 200 || status >= 300 || out.Error != "" {
		return Grant{}, &RefreshError{HTTPStatus: status, OAuthError: out.Error, Terminal: out.Error == "invalid_grant" || out.Error == "invalid_client", Retryable: status == 429 || status >= 500, Description: "Cloudflare authorization exchange failed"}
	}
	if out.Access == "" || out.Expires <= 0 || !strings.EqualFold(out.Type, "Bearer") {
		return Grant{}, errors.New("Cloudflare returned an incomplete token response")
	}
	var refreshExpiry time.Time
	if out.RefreshExpires > 0 {
		refreshExpiry = c.Now().Add(time.Duration(out.RefreshExpires) * time.Second)
	}
	return Grant{AccessToken: out.Access, RefreshToken: out.Refresh, TokenType: "Bearer", AccessExpiresAt: c.Now().Add(time.Duration(out.Expires) * time.Second), RefreshExpiresAt: refreshExpiry, AuthTime: c.Now(), Scope: out.Scope}, nil
}
func (c *Cloudflare) ExchangeCode(ctx context.Context, app AppCredentials, code, redirectURI, verifier string) (Grant, error) {
	return c.token(ctx, url.Values{"grant_type": {"authorization_code"}, "client_id": {app.ClientID}, "code": {code}, "redirect_uri": {redirectURI}, "code_verifier": {verifier}, "resource": {c.BaseURL + "/mcp"}})
}
func (c *Cloudflare) Refresh(ctx context.Context, app AppCredentials, old Grant) (Grant, error) {
	fresh, err := c.token(ctx, url.Values{"grant_type": {"refresh_token"}, "client_id": {app.ClientID}, "refresh_token": {old.RefreshToken}, "resource": {c.BaseURL + "/mcp"}})
	if err != nil {
		return Grant{}, err
	}
	if fresh.RefreshToken == "" {
		fresh.RefreshToken = old.RefreshToken
		fresh.RefreshExpiresAt = old.RefreshExpiresAt
	}
	if fresh.Scope == "" {
		fresh.Scope = old.Scope
	}
	fresh.AuthTime = old.AuthTime
	return fresh, nil
}
func (c *Cloudflare) Revoke(ctx context.Context, app AppCredentials, grant Grant) error {
	token, hint := grant.RefreshToken, "refresh_token"
	if token == "" {
		token, hint = grant.AccessToken, "access_token"
	}
	_, _, status, err := c.do(ctx, "/token", "application/x-www-form-urlencoded", []byte(url.Values{"token": {token}, "token_type_hint": {hint}, "client_id": {app.ClientID}}.Encode()), "")
	if err != nil {
		return err
	}
	if status < 200 || status >= 300 {
		return fmt.Errorf("Cloudflare revocation HTTP %d", status)
	}
	return nil
}

// MCPCall accepts only structured parameters created by this adapter/gateway.
// It does not enable upstream Skills or persist any provider token in MCP config.
func (c *Cloudflare) MCPCall(ctx context.Context, token, name string, args any) (json.RawMessage, error) {
	body, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": map[string]any{"name": name, "arguments": args}})
	data, headers, status, err := c.do(ctx, "/mcp?truncateToolResult=false", "application/json", body, token)
	if err != nil {
		return nil, err
	}
	if status == 401 || status == 403 {
		return nil, &CloudflareRequestError{Status: status, Kind: "authorization or permission required"}
	}
	if status != 200 {
		return nil, &CloudflareRequestError{Status: status, Kind: "MCP request failed"}
	}
	if strings.Contains(headers.Get("Content-Type"), "text/event-stream") {
		var message []byte
		for _, line := range bytes.Split(data, []byte("\n")) {
			if bytes.HasPrefix(line, []byte("data:")) {
				candidate := bytes.TrimSpace(line[5:])
				if json.Valid(candidate) {
					message = candidate
				}
			}
		}
		data = message
	}
	var envelope struct {
		Error  json.RawMessage `json:"error"`
		Result struct {
			IsError    bool            `json:"isError"`
			Structured json.RawMessage `json:"structuredContent"`
			Content    []struct {
				Type string `json:"type"`
				Text string `json:"text"`
			} `json:"content"`
		} `json:"result"`
	}
	if json.Unmarshal(data, &envelope) != nil || (len(envelope.Error) > 0 && string(envelope.Error) != "null") {
		return nil, &CloudflareRequestError{Status: status, Kind: "MCP tool request failed"}
	}
	if envelope.Result.IsError {
		failed := &CloudflareRequestError{Status: status, Kind: "MCP tool request failed"}
		for _, content := range envelope.Result.Content {
			if content.Type == "text" && failed.API == nil {
				failed.API = cloudflareAPIErrors(content.Text)
			}
		}
		return nil, failed
	}
	if len(envelope.Result.Structured) > 0 && string(envelope.Result.Structured) != "null" {
		return envelope.Result.Structured, nil
	}
	for _, content := range envelope.Result.Content {
		if content.Type == "text" && json.Valid([]byte(content.Text)) {
			return json.RawMessage(content.Text), nil
		}
	}
	return nil, errors.New("Cloudflare returned no structured result")
}
func (c *Cloudflare) Identity(ctx context.Context, _ AppCredentials, token string) (Identity, error) {
	data, err := c.MCPCall(ctx, token, "whoami", map[string]any{})
	if err != nil {
		return Identity{}, err
	}
	var who struct {
		ID    string `json:"id"`
		Email string `json:"email"`
		Name  string `json:"name"`
	}
	if json.Unmarshal(data, &who) != nil || (!strings.HasPrefix(who.ID, "user:") && !strings.HasPrefix(who.ID, "account:")) {
		return Identity{}, errors.New("Cloudflare identity was not verified")
	}
	name := who.Name
	if name == "" {
		name = who.Email
	}
	return Identity{Subject: who.ID, DisplayName: name}, nil
}

// APIRequest keeps the OAuth audience at the official MCP resource. The
// gateway constructs this code from a validated method/path/query and a JSON
// body it decoded and re-encoded as plain data; no caller-supplied JS runs.
func (c *Cloudflare) APIRequest(ctx context.Context, token, method, path string, query url.Values, body map[string]any) (json.RawMessage, error) {
	call := map[string]any{"method": method, "path": path, "query": query}
	if body != nil {
		call["body"] = body
	}
	request, err := json.Marshal(call)
	if err != nil {
		return nil, err
	}
	return c.MCPCall(ctx, token, "execute", map[string]any{"code": "async () => { return await cloudflare.request(" + string(request) + "); }"})
}

func (s *Service) CloudflareRead(ctx context.Context, account store.ExternalAccount, path string, query url.Values, use Use) (json.RawMessage, error) {
	return s.CloudflareRequest(ctx, account, http.MethodGet, path, query, nil, use)
}

// CloudflareRequest calls the Cloudflare API as account. Which methods and
// paths a caller may use is the gateway's decision, made before this.
func (s *Service) CloudflareRequest(ctx context.Context, account store.ExternalAccount, method, path string, query url.Values, body map[string]any, use Use) (json.RawMessage, error) {
	if account.Provider != "cloudflare" {
		return nil, store.ErrExternalAccountNotFound
	}
	if err := s.Integrations.Err(); err != nil {
		return nil, err
	}
	provider, _ := s.registry.Lookup("cloudflare")
	cloudflare, ok := provider.(*Cloudflare)
	if !ok {
		return nil, errors.New("Cloudflare is unavailable")
	}
	token, err := s.AccessToken(ctx, account.ID, use)
	if err != nil {
		return nil, err
	}
	result, err := cloudflare.APIRequest(ctx, token.AccessToken, method, path, query, body)
	var refused *CloudflareRequestError
	if errors.As(err, &refused) && refused.Status == http.StatusUnauthorized {
		lock := s.lockFor(account.ID)
		lock.Lock()
		current, loadErr := s.loadGrant(ctx, account.ID)
		if loadErr == nil && current.AccessToken == token.AccessToken {
			if latest, readErr := s.store.GetExternalAccount(ctx, account.ID); readErr == nil && latest.Status != store.ExternalAccountRevoked {
				latest.Status = store.ExternalAccountNeedsReauth
				latest.StatusDetail = "provider_rejected"
				_, _ = s.store.SaveExternalAccount(ctx, latest)
				s.changed(account.ID)
			}
		}
		lock.Unlock()
	}
	return result, err
}
