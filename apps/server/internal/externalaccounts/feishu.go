package externalaccounts

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// Feishu endpoints, as feishu-cli uses them (internal/auth/device_flow.go,
// oauth.go, revoke.go): device authorization and revoke live on the
// accounts host, token and user info on the open-API host.
const (
	FeishuDefaultBaseURL = "https://open.feishu.cn"
	feishuDeviceAuthPath = "/oauth/v1/device_authorization"
	feishuRevokePath     = "/oauth/v1/revoke"
	feishuTokenPath      = "/open-apis/authen/v2/oauth/token"
	feishuUserInfoPath   = "/open-apis/authen/v1/user_info"
	// FeishuTenantTokenPath exchanges an app's id and secret for its tenant
	// access token (the bot's identity), on the open-API host.
	FeishuTenantTokenPath = "/open-apis/auth/v3/tenant_access_token/internal"
	feishuDeviceGrantType = "urn:ietf:params:oauth:grant-type:device_code"
	// feishuAppRegistrationPath creates a "PersonalAgent" app for the person
	// through a device flow, on the accounts host. Not in Feishu's published
	// docs; the official lark-cli (larksuite/cli internal/auth/
	// app_registration.go, `config init --new`) and feishu-cli (`config
	// create-app`) use it the same way.
	feishuAppRegistrationPath = "/oauth/v1/app/registration"
	// feishuScopeApplyPath is the open platform's page where an app's owner
	// applies for scopes (lark-cli internal/errclass ConsoleURL).
	feishuScopeApplyPath = "/page/scope-apply"
	// feishuRefreshFallback is how long a refresh token lives when neither
	// the response nor the token says: Feishu issues 7-day refresh tokens.
	feishuRefreshFallback = 7 * 24 * time.Hour
	feishuHTTPTimeout     = 15 * time.Second
	feishuMaxBody         = 1 << 20
)

// Feishu refresh failure codes (feishu-cli internal/auth/oauth.go, aligned
// with the official lark-cli): the first four are terminal, 20050 transient.
const (
	feishuCodeLegacyFormat = 20026
	feishuCodeExpired      = 20037
	feishuCodeServerError  = 20050
	feishuCodeRevoked      = 20064
	feishuCodeReused       = 20073
)

// feishuAlwaysScopes go with every login: offline_access makes Feishu
// issue a refresh token at all, auth:user.id:read lets the server read who
// the account is. feishu-cli appends the same two.
var feishuAlwaysScopes = []string{"offline_access", "auth:user.id:read"}

// Feishu is the server-held provider for Feishu / Lark user logins.
type Feishu struct {
	// HTTP makes the calls; nil uses a client with feishuHTTPTimeout.
	HTTP *http.Client
	// Now is the clock expiries are counted from; nil is time.Now.
	Now func() time.Time
	// AccountsBase overrides where the accounts host is derived from the
	// open-API base URL (tests point both at one fake server).
	AccountsBase func(baseURL string) string
	// RegistrationHosts overrides the accounts and open-API hosts of a
	// brand for app registration (tests point both at one fake server).
	RegistrationHosts func(brand string) (accounts, open string)
}

// Feishu brands: mainland Feishu and international Lark.
const (
	FeishuBrandFeishu = "feishu"
	FeishuBrandLark   = "lark"
)

// FeishuBrand reads a brand name; anything but Lark is Feishu.
func FeishuBrand(brand string) string {
	switch strings.ToLower(strings.TrimSpace(brand)) {
	case "lark", "larksuite":
		return FeishuBrandLark
	}
	return FeishuBrandFeishu
}

func (f *Feishu) registrationHosts(brand string) (string, string) {
	if f.RegistrationHosts != nil {
		return f.RegistrationHosts(brand)
	}
	if FeishuBrand(brand) == FeishuBrandLark {
		return "https://accounts.larksuite.com", "https://open.larksuite.com"
	}
	return "https://accounts.feishu.cn", FeishuDefaultBaseURL
}

func (f *Feishu) Describe() store.ExternalProvider {
	return store.ExternalProvider{
		Kind:           "feishu",
		Label:          "Feishu",
		CredentialMode: store.ExternalCredentialServerHeld,
		AuthMethods:    []string{"oauth_device"},
		Tools:          []string{"feishu-cli"},
		DefaultBaseURL: FeishuDefaultBaseURL,
		AlwaysScopes:   append([]string(nil), feishuAlwaysScopes...),
		ScopePreset: &store.ExternalScopePreset{
			Name: FeishuPresetName, Source: FeishuPresetSource,
			Scopes: FeishuPresetScopes(false), ApprovalScopes: append([]string(nil), feishuApprovalScopes...),
		},
		RegistersApps: true,
	}
}

// PresetScopes is the feishu-cli preset (feishu_scopes.go).
func (f *Feishu) PresetScopes(includeApproval bool) []string {
	return FeishuPresetScopes(includeApproval)
}

// ScopeApplyURL opens the open platform's scope application page for the
// app with scopes preselected.
func (f *Feishu) ScopeApplyURL(app AppCredentials, scopes []string) string {
	if app.ClientID == "" {
		return ""
	}
	link := openBase(app.BaseURL) + feishuScopeApplyPath + "?clientID=" + url.QueryEscape(app.ClientID)
	if len(scopes) > 0 {
		link += "&scopes=" + url.QueryEscape(strings.Join(scopes, ","))
	}
	return link
}

// BeginAppRegistration asks Feishu to create a PersonalAgent app for
// whoever confirms the returned page. Registration always starts on
// Feishu's accounts host (lark-cli does the same); brand picks the host of
// the page the person opens.
func (f *Feishu) BeginAppRegistration(ctx context.Context, brand string) (AppRegistration, error) {
	bootstrapAccounts, _ := f.registrationHosts(FeishuBrandFeishu)
	_, open := f.registrationHosts(FeishuBrand(brand))
	form := url.Values{}
	form.Set("action", "begin")
	form.Set("archetype", "PersonalAgent")
	form.Set("auth_method", "client_secret")
	form.Set("request_user_info", "open_id tenant_brand")
	raw, status, err := f.postForm(ctx, bootstrapAccounts+feishuAppRegistrationPath, form)
	if err != nil {
		return AppRegistration{}, fmt.Errorf("feishu app registration: %w", err)
	}
	if oauthErr := stringField(raw, "error"); oauthErr != "" || status >= 400 {
		return AppRegistration{}, fmt.Errorf("feishu app registration refused: %s", oauthDescription(raw, oauthErr))
	}
	deviceCode, userCode := stringField(raw, "device_code"), stringField(raw, "user_code")
	if deviceCode == "" || userCode == "" {
		return AppRegistration{}, errors.New("feishu app registration answered without device_code or user_code")
	}
	// The protocol field is expire_in; older answers say expires_in.
	expiresIn := numberField(raw, "expire_in", 0)
	if expiresIn <= 0 {
		expiresIn = numberField(raw, "expires_in", 600)
	}
	interval := numberField(raw, "interval", 5)
	return AppRegistration{
		DeviceCode: deviceCode, UserCode: userCode,
		VerificationURL: open + "/page/cli?user_code=" + url.QueryEscape(userCode),
		ExpiresAt:       f.now().Add(time.Duration(expiresIn) * time.Second),
		Interval:        time.Duration(interval) * time.Second,
		Brand:           FeishuBrandFeishu,
	}, nil
}

// PollAppRegistration asks once whether the person confirmed. A first
// answer naming a tenant of the other brand moves polling there (once), as
// lark-cli does: that brand's host issues the credentials.
func (f *Feishu) PollAppRegistration(ctx context.Context, registration AppRegistration) (RegisteredApp, AppRegistration, PollOutcome, error) {
	accounts, open := f.registrationHosts(registration.Brand)
	form := url.Values{}
	form.Set("action", "poll")
	form.Set("device_code", registration.DeviceCode)
	raw, _, err := f.postForm(ctx, accounts+feishuAppRegistrationPath, form)
	if err != nil {
		return RegisteredApp{}, registration, PollPending, nil
	}
	if !registration.brandMoved {
		if userInfo, ok := raw["user_info"].(map[string]any); ok {
			if tenantBrand := stringField(userInfo, "tenant_brand"); tenantBrand != "" && FeishuBrand(tenantBrand) != registration.Brand {
				registration.Brand = FeishuBrand(tenantBrand)
				registration.brandMoved = true
				return RegisteredApp{}, registration, PollPending, nil
			}
		}
	}
	switch oauthErr := stringField(raw, "error"); oauthErr {
	case "":
	case "authorization_pending":
		return RegisteredApp{}, registration, PollPending, nil
	case "slow_down":
		return RegisteredApp{}, registration, PollSlowDown, nil
	case "access_denied":
		return RegisteredApp{}, registration, PollDone, ErrRegistrationDenied
	case "expired_token", "invalid_grant":
		return RegisteredApp{}, registration, PollDone, ErrLoginExpired
	default:
		return RegisteredApp{}, registration, PollDone, fmt.Errorf("feishu app registration failed: %s", oauthDescription(raw, oauthErr))
	}
	app := RegisteredApp{ClientID: stringField(raw, "client_id"), ClientSecret: stringField(raw, "client_secret")}
	if app.ClientID == "" || app.ClientSecret == "" {
		return RegisteredApp{}, registration, PollPending, nil
	}
	if open != FeishuDefaultBaseURL {
		app.BaseURL = open
	}
	return app, registration, PollDone, nil
}

func (f *Feishu) now() time.Time {
	if f.Now != nil {
		return f.Now()
	}
	return time.Now()
}

func (f *Feishu) client() *http.Client {
	if f.HTTP != nil {
		return f.HTTP
	}
	return &http.Client{Timeout: feishuHTTPTimeout}
}

// openBase is the open-API host of an app: its base URL, else Feishu's.
func openBase(baseURL string) string {
	base := strings.TrimRight(strings.TrimSpace(baseURL), "/")
	if base == "" {
		return FeishuDefaultBaseURL
	}
	return base
}

// FeishuAccountsBase derives the accounts host from the open-API host the
// way feishu-cli does: open.feishu.cn → accounts.feishu.cn,
// open.larksuite.com → accounts.larksuite.com. Any other host is kept.
func FeishuAccountsBase(baseURL string) string {
	base := openBase(baseURL)
	parsed, err := url.Parse(base)
	if err != nil || parsed.Host == "" {
		return base
	}
	if strings.HasPrefix(parsed.Host, "open.") {
		parsed.Host = "accounts." + strings.TrimPrefix(parsed.Host, "open.")
	}
	return strings.TrimRight(parsed.String(), "/")
}

func (f *Feishu) accountsBase(baseURL string) string {
	if f.AccountsBase != nil {
		return f.AccountsBase(baseURL)
	}
	return FeishuAccountsBase(baseURL)
}

// BeginDeviceLogin is RFC 8628 step one: Basic app auth, form body with
// client_id and the scopes (always including offline_access).
func (f *Feishu) BeginDeviceLogin(ctx context.Context, app AppCredentials, scopes []string) (DeviceLogin, error) {
	if app.ClientID == "" || app.ClientSecret == "" {
		return DeviceLogin{}, errors.New("the Feishu app has no client id or secret")
	}
	scope := joinScopes(scopes, feishuAlwaysScopes)
	form := url.Values{}
	form.Set("client_id", app.ClientID)
	form.Set("scope", scope)
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, f.accountsBase(app.BaseURL)+feishuDeviceAuthPath, strings.NewReader(form.Encode()))
	if err != nil {
		return DeviceLogin{}, err
	}
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	request.Header.Set("Authorization", "Basic "+base64.StdEncoding.EncodeToString([]byte(app.ClientID+":"+app.ClientSecret)))
	raw, status, err := f.do(request)
	if err != nil {
		return DeviceLogin{}, fmt.Errorf("feishu device authorization: %w", err)
	}
	if oauthErr, _ := raw["error"].(string); oauthErr != "" {
		return DeviceLogin{}, fmt.Errorf("feishu device authorization refused: %s", oauthDescription(raw, oauthErr))
	}
	if status != http.StatusOK {
		return DeviceLogin{}, fmt.Errorf("feishu device authorization: HTTP %d", status)
	}
	login := DeviceLogin{
		DeviceCode:              stringField(raw, "device_code"),
		UserCode:                stringField(raw, "user_code"),
		VerificationURI:         stringField(raw, "verification_uri"),
		VerificationURIComplete: stringField(raw, "verification_uri_complete"),
		ExpiresAt:               f.now().Add(time.Duration(numberField(raw, "expires_in", 240)) * time.Second),
		Interval:                time.Duration(numberField(raw, "interval", 5)) * time.Second,
		RequestedScopes:         splitScopes(scope),
	}
	if login.VerificationURIComplete == "" {
		login.VerificationURIComplete = login.VerificationURI
	}
	if login.DeviceCode == "" || login.UserCode == "" || login.VerificationURI == "" {
		return DeviceLogin{}, errors.New("feishu device authorization answered without device_code, user_code or verification_uri")
	}
	return login, nil
}

// PollDeviceLogin is RFC 8628 step two, once.
func (f *Feishu) PollDeviceLogin(ctx context.Context, app AppCredentials, login DeviceLogin) (Grant, PollOutcome, error) {
	form := url.Values{}
	form.Set("grant_type", feishuDeviceGrantType)
	form.Set("device_code", login.DeviceCode)
	form.Set("client_id", app.ClientID)
	form.Set("client_secret", app.ClientSecret)
	raw, status, err := f.postForm(ctx, openBase(app.BaseURL)+feishuTokenPath, form)
	if err != nil {
		// A transport fault while pending: try again on the next tick.
		return Grant{}, PollPending, nil
	}
	switch oauthErr, _ := raw["error"].(string); oauthErr {
	case "":
	case "authorization_pending":
		return Grant{}, PollPending, nil
	case "slow_down":
		return Grant{}, PollSlowDown, nil
	case "access_denied":
		return Grant{}, PollDone, ErrLoginDenied
	case "expired_token", "invalid_grant":
		return Grant{}, PollDone, ErrLoginExpired
	default:
		return Grant{}, PollDone, fmt.Errorf("feishu token endpoint refused the device code: %s", oauthDescription(raw, oauthErr))
	}
	if status != http.StatusOK || stringField(raw, "access_token") == "" {
		if code := int(numberField(raw, "code", 0)); code != 0 {
			return Grant{}, PollDone, fmt.Errorf("feishu token endpoint failed (code %d): %s", code, stringField(raw, "msg"))
		}
		return Grant{}, PollDone, fmt.Errorf("feishu token endpoint answered HTTP %d without an access token", status)
	}
	return grantFromTokenResponse(f.now(), raw, Grant{}), PollDone, nil
}

// grantFromTokenResponse reads a token response. Fields the response leaves
// out keep the previous grant's values (a refresh may omit the refresh
// token, meaning "keep using it"; see feishu-cli issue #94).
func grantFromTokenResponse(now time.Time, raw map[string]any, previous Grant) Grant {
	grant := Grant{
		AccessToken:   stringField(raw, "access_token"),
		RefreshToken:  stringField(raw, "refresh_token"),
		TokenType:     stringField(raw, "token_type"),
		Scope:         stringField(raw, "scope"),
		AuthTime:      previous.AuthTime,
		AuthExpiresAt: previous.AuthExpiresAt,
		Generation:    previous.Generation,
	}
	if grant.RefreshToken == "" {
		grant.RefreshToken = previous.RefreshToken
	}
	if grant.Scope == "" {
		grant.Scope = previous.Scope
	}
	if grant.TokenType == "" {
		grant.TokenType = "Bearer"
	}
	grant.AccessExpiresAt = now.Add(time.Duration(numberField(raw, "expires_in", 7200)) * time.Second)
	refreshExpiresIn := int(numberField(raw, "refresh_token_expires_in", 0))
	switch {
	case refreshExpiresIn > 0 || grant.RefreshToken != previous.RefreshToken || previous.RefreshExpiresAt.IsZero():
		if grant.RefreshToken != "" {
			grant.RefreshExpiresAt = refreshTokenExpiry(now, refreshExpiresIn, grant.RefreshToken, feishuRefreshFallback)
		}
	default:
		grant.RefreshExpiresAt = previous.RefreshExpiresAt
	}
	// The access token names the authorization's own window.
	claims := jwtClaims(grant.AccessToken)
	if authTime, ok := jwtTime(claims, "auth_time"); ok {
		grant.AuthTime = authTime
	}
	if authExp, ok := jwtTime(claims, "auth_exp"); ok {
		grant.AuthExpiresAt = authExp
	}
	return grant
}

// Refresh spends the refresh token once. The caller holds the account's
// lock; this method retries only transient faults, once.
func (f *Feishu) Refresh(ctx context.Context, app AppCredentials, grant Grant) (Grant, error) {
	if grant.RefreshToken == "" {
		return Grant{}, &RefreshError{Terminal: true, Description: "the grant holds no refresh token"}
	}
	var last *RefreshError
	uncertain := false
	for attempt := 1; attempt <= 2; attempt++ {
		refreshed, refreshErr := f.refreshOnce(ctx, app, grant)
		if refreshErr == nil {
			return refreshed, nil
		}
		uncertain = uncertain || refreshErr.Uncertain
		last = refreshErr
		if !refreshErr.Retryable || attempt == 2 || ctx.Err() != nil {
			break
		}
		select {
		case <-time.After(300 * time.Millisecond):
		case <-ctx.Done():
		}
	}
	if uncertain && !last.Terminal {
		last.Uncertain = true
	}
	return Grant{}, last
}

func (f *Feishu) refreshOnce(ctx context.Context, app AppCredentials, grant Grant) (Grant, *RefreshError) {
	form := url.Values{}
	form.Set("grant_type", "refresh_token")
	form.Set("refresh_token", grant.RefreshToken)
	form.Set("client_id", app.ClientID)
	form.Set("client_secret", app.ClientSecret)
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, openBase(app.BaseURL)+feishuTokenPath, strings.NewReader(form.Encode()))
	if err != nil {
		return Grant{}, &RefreshError{Description: "build the token request", Cause: err}
	}
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	response, err := f.client().Do(request)
	if err != nil {
		// The request may have been received: treat the token as possibly spent.
		return Grant{}, &RefreshError{Description: "reach the token endpoint", Retryable: ctx.Err() == nil, Uncertain: true, Cause: err}
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, feishuMaxBody))
	if err != nil {
		return Grant{}, &RefreshError{HTTPStatus: response.StatusCode, Description: "read the token response", Retryable: true, Uncertain: true, Cause: err}
	}
	var raw map[string]any
	if err := json.Unmarshal(body, &raw); err != nil {
		return Grant{}, &RefreshError{HTTPStatus: response.StatusCode, Description: "the token endpoint answered unreadably", Retryable: true, Uncertain: true}
	}
	code := int(numberField(raw, "code", 0))
	oauthErr := stringField(raw, "error")
	if code != 0 || oauthErr != "" {
		refreshErr := &RefreshError{HTTPStatus: response.StatusCode, Code: code, OAuthError: oauthErr, Description: oauthDescription(raw, oauthErr)}
		switch {
		case code == feishuCodeLegacyFormat, code == feishuCodeExpired, code == feishuCodeRevoked, code == feishuCodeReused:
			refreshErr.Terminal = true
		case code == feishuCodeServerError:
			refreshErr.Retryable = true
		case code == 0 && oauthErr == "invalid_grant":
			refreshErr.Terminal = true
		case code == 0 && (oauthErr == "server_error" || oauthErr == "temporarily_unavailable"):
			refreshErr.Retryable = true
		case code == 0 && response.StatusCode >= 500:
			refreshErr.Retryable = true
		}
		return Grant{}, refreshErr
	}
	if response.StatusCode != http.StatusOK {
		return Grant{}, &RefreshError{HTTPStatus: response.StatusCode, Description: "the token endpoint answered without a token", Retryable: response.StatusCode >= 500}
	}
	if stringField(raw, "access_token") == "" {
		return Grant{}, &RefreshError{HTTPStatus: response.StatusCode, Description: "the token response holds no access_token"}
	}
	return grantFromTokenResponse(f.now(), raw, grant), nil
}

// Revoke invalidates the grant: the refresh token (which ends the whole
// authorization), else the access token.
func (f *Feishu) Revoke(ctx context.Context, app AppCredentials, grant Grant) error {
	token, hint := grant.RefreshToken, "refresh_token"
	if token == "" {
		token, hint = grant.AccessToken, "access_token"
	}
	if token == "" {
		return nil
	}
	form := url.Values{}
	form.Set("client_id", app.ClientID)
	form.Set("client_secret", app.ClientSecret)
	form.Set("token", token)
	form.Set("token_type_hint", hint)
	raw, status, err := f.postForm(ctx, f.accountsBase(app.BaseURL)+feishuRevokePath, form)
	if err != nil {
		return fmt.Errorf("feishu revoke: %w", err)
	}
	if code := int(numberField(raw, "code", 0)); code != 0 {
		return fmt.Errorf("feishu revoke failed (code %d): %s", code, stringField(raw, "msg"))
	}
	if oauthErr := stringField(raw, "error"); oauthErr != "" {
		return fmt.Errorf("feishu revoke refused: %s", oauthDescription(raw, oauthErr))
	}
	if status >= 400 {
		return fmt.Errorf("feishu revoke: HTTP %d", status)
	}
	return nil
}

// TenantAccessToken exchanges the app's credentials for its tenant access
// token (auth/v3/tenant_access_token/internal).
func (f *Feishu) TenantAccessToken(ctx context.Context, app AppCredentials) (string, time.Duration, error) {
	if app.ClientID == "" || app.ClientSecret == "" {
		return "", 0, errors.New("the Feishu app has no client id or secret")
	}
	body, _ := json.Marshal(map[string]string{"app_id": app.ClientID, "app_secret": app.ClientSecret})
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, openBase(app.BaseURL)+FeishuTenantTokenPath, strings.NewReader(string(body)))
	if err != nil {
		return "", 0, err
	}
	request.Header.Set("Content-Type", "application/json; charset=utf-8")
	raw, status, err := f.do(request)
	if err != nil {
		return "", 0, fmt.Errorf("feishu tenant token: %w", err)
	}
	if code := int(numberField(raw, "code", 0)); code != 0 {
		return "", 0, fmt.Errorf("feishu tenant token refused (code %d): %s", code, stringField(raw, "msg"))
	}
	token := stringField(raw, "tenant_access_token")
	if status != http.StatusOK || token == "" {
		return "", 0, fmt.Errorf("feishu tenant token: HTTP %d without a token", status)
	}
	return token, time.Duration(numberField(raw, "expire", 7200)) * time.Second, nil
}

// CheckAppSecret asks Feishu for the app's tenant token with the secret.
func (f *Feishu) CheckAppSecret(ctx context.Context, app AppCredentials) error {
	_, _, err := f.TenantAccessToken(ctx, app)
	return err
}

// Identity reads who the token belongs to (authen/v1/user_info).
func (f *Feishu) Identity(ctx context.Context, app AppCredentials, accessToken string) (Identity, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, openBase(app.BaseURL)+feishuUserInfoPath, nil)
	if err != nil {
		return Identity{}, err
	}
	request.Header.Set("Authorization", "Bearer "+accessToken)
	raw, status, err := f.do(request)
	if err != nil {
		return Identity{}, fmt.Errorf("feishu user info: %w", err)
	}
	if code := int(numberField(raw, "code", 0)); code != 0 {
		return Identity{}, fmt.Errorf("feishu user info failed (code %d): %s", code, stringField(raw, "msg"))
	}
	if status != http.StatusOK {
		return Identity{}, fmt.Errorf("feishu user info: HTTP %d", status)
	}
	data, _ := raw["data"].(map[string]any)
	identity := Identity{Subject: stringField(data, "open_id"), DisplayName: stringField(data, "name"), Tenant: stringField(data, "tenant_key")}
	if identity.DisplayName == "" {
		identity.DisplayName = stringField(data, "en_name")
	}
	return identity, nil
}

func (f *Feishu) postForm(ctx context.Context, endpoint string, form url.Values) (map[string]any, int, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, strings.NewReader(form.Encode()))
	if err != nil {
		return nil, 0, err
	}
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	return f.do(request)
}

// do sends the request and reads a JSON object; an empty body reads as an
// empty object (revoke may answer 200 with nothing).
func (f *Feishu) do(request *http.Request) (map[string]any, int, error) {
	response, err := f.client().Do(request)
	if err != nil {
		return nil, 0, err
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, feishuMaxBody))
	if err != nil {
		return nil, response.StatusCode, err
	}
	raw := map[string]any{}
	if len(strings.TrimSpace(string(body))) > 0 {
		if err := json.Unmarshal(body, &raw); err != nil {
			return nil, response.StatusCode, fmt.Errorf("HTTP %d with an unreadable body", response.StatusCode)
		}
	}
	return raw, response.StatusCode, nil
}

func stringField(raw map[string]any, name string) string {
	value, _ := raw[name].(string)
	return value
}

func numberField(raw map[string]any, name string, fallback float64) float64 {
	if value, ok := raw[name].(float64); ok {
		return value
	}
	return fallback
}

func oauthDescription(raw map[string]any, oauthErr string) string {
	if description := stringField(raw, "error_description"); description != "" {
		return description
	}
	if message := stringField(raw, "msg"); message != "" {
		return message
	}
	return oauthErr
}
