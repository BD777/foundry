package externalaccounts

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"time"
)

// FakeFeishu is a test double of Feishu's OAuth endpoints, for package and
// server tests (no real Feishu app or person is needed). It issues JWT-shaped
// tokens with the claims the real ones carry (exp, auth_time, auth_exp),
// rotates refresh tokens and refuses a spent one with code 20073, the way
// the real service does. Point a Feishu adapter at it with
// NewFeishuAgainst.
type FakeFeishu struct {
	Server *httptest.Server

	mu sync.Mutex
	// Approved: the person approved the pending device code.
	Approved bool
	// Denied: the person refused.
	Denied bool
	// RefreshTokenExpiresIn is the refresh_token_expires_in the token
	// endpoint reports; 0 omits it (the token's own exp then counts).
	RefreshTokenExpiresIn int
	// NoRefreshToken makes the device flow issue no refresh token (an app
	// without offline_access).
	NoRefreshToken bool
	// RefreshFailCode, when set, makes every refresh fail with that Feishu
	// code (20073: reused, 20050: transient…).
	RefreshFailCode int
	// Identity is what user_info answers.
	Identity Identity
	// RegistrationApproved: the person confirmed the app to be created.
	RegistrationApproved bool
	// RegistrationDenied: the person declined it.
	RegistrationDenied bool
	// RegistrationTenantBrand is the tenant_brand registration polls
	// report ("lark" moves polling to the fake's /lark host).
	RegistrationTenantBrand string
	// GrantScopes, when set, is what an approved login grants instead of
	// everything asked for.
	GrantScopes []string
	// API, when set, serves every request the fake's OAuth routes do not
	// (the open-API calls a test sends through a gateway). Check tokens
	// with AccessTokenValid and TenantTokenValid.
	API http.Handler

	clientID, clientSecret string
	deviceCode, userCode   string
	requestedScope         string
	issued                 int
	currentRefresh         string
	liveRefresh            map[string]bool
	spentRefresh           map[string]bool
	validAccess            map[string]bool
	revoked                []string
	refreshes              int
	grantedScope           string
	registrations          int
	registrationPolls      map[string]int
	validTenant            map[string]bool
	tenantIssued           int
}

// NewFakeFeishu starts the fake for one app.
func NewFakeFeishu(clientID, clientSecret string) *FakeFeishu {
	fake := &FakeFeishu{
		clientID: clientID, clientSecret: clientSecret, RefreshTokenExpiresIn: 7 * 24 * 3600,
		Identity:    Identity{Subject: "ou_fake", DisplayName: "Fake Person", Tenant: "tenant_fake"},
		liveRefresh: map[string]bool{}, spentRefresh: map[string]bool{}, validAccess: map[string]bool{},
		registrationPolls: map[string]int{}, validTenant: map[string]bool{},
	}
	mux := http.NewServeMux()
	// "/lark" stands in for the Lark hosts.
	for _, prefix := range []string{"", "/lark"} {
		brand := FeishuBrandFeishu
		if prefix != "" {
			brand = FeishuBrandLark
		}
		mux.HandleFunc("POST "+prefix+feishuDeviceAuthPath, fake.deviceAuthorization)
		mux.HandleFunc("POST "+prefix+feishuTokenPath, fake.token)
		mux.HandleFunc("POST "+prefix+feishuRevokePath, fake.revoke)
		mux.HandleFunc("GET "+prefix+feishuUserInfoPath, fake.userInfo)
		mux.HandleFunc("POST "+prefix+feishuAppRegistrationPath, func(w http.ResponseWriter, r *http.Request) { fake.appRegistration(w, r, brand) })
	}
	mux.HandleFunc("POST "+FeishuTenantTokenPath, fake.tenantToken)
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if fake.API == nil {
			writeOAuthJSON(w, http.StatusNotFound, map[string]any{"code": 404, "msg": "not served by the fake"})
			return
		}
		fake.API.ServeHTTP(w, r)
	})
	fake.Server = httptest.NewServer(mux)
	return fake
}

// RegistrationPolls counts registration polls served per brand.
func (f *FakeFeishu) RegistrationPolls(brand string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.registrationPolls[brand]
}

// ApproveRegistration lets the pending app registration succeed.
func (f *FakeFeishu) ApproveRegistration() {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.RegistrationApproved = true
}

// appRegistration serves begin and poll of the PersonalAgent app
// registration; the app it creates is the fake's own app.
func (f *FakeFeishu) appRegistration(w http.ResponseWriter, r *http.Request, brand string) {
	if err := r.ParseForm(); err != nil {
		writeOAuthJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid_request"})
		return
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	switch r.PostForm.Get("action") {
	case "begin":
		if r.PostForm.Get("archetype") != "PersonalAgent" || r.PostForm.Get("auth_method") != "client_secret" {
			writeOAuthJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid_request", "error_description": "unexpected archetype or auth_method"})
			return
		}
		f.registrations++
		writeOAuthJSON(w, http.StatusOK, map[string]any{
			"device_code": fmt.Sprintf("reg_%d", f.registrations), "user_code": fmt.Sprintf("REG-%04d", f.registrations),
			"verification_uri": f.Server.URL + "/page/launcher", "expire_in": 600, "interval": 0,
		})
	case "poll":
		f.registrationPolls[brand]++
		if r.PostForm.Get("device_code") != fmt.Sprintf("reg_%d", f.registrations) {
			writeOAuthJSON(w, http.StatusOK, map[string]any{"error": "expired_token"})
			return
		}
		userInfo := map[string]any{"open_id": f.Identity.Subject}
		if f.RegistrationTenantBrand != "" {
			userInfo["tenant_brand"] = f.RegistrationTenantBrand
		}
		switch {
		case f.RegistrationDenied:
			writeOAuthJSON(w, http.StatusOK, map[string]any{"error": "access_denied"})
		case !f.RegistrationApproved:
			writeOAuthJSON(w, http.StatusOK, map[string]any{"error": "authorization_pending", "user_info": userInfo})
		default:
			writeOAuthJSON(w, http.StatusOK, map[string]any{"client_id": f.clientID, "client_secret": f.clientSecret, "user_info": userInfo})
		}
	default:
		writeOAuthJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid_request"})
	}
}

// Close stops the server.
func (f *FakeFeishu) Close() { f.Server.Close() }

// Adapter is a Feishu provider that talks to this fake for both hosts.
func (f *FakeFeishu) Adapter() *Feishu {
	return &Feishu{
		HTTP: f.Server.Client(),
		AccountsBase: func(baseURL string) string {
			if strings.HasSuffix(baseURL, "/lark") {
				return f.Server.URL + "/lark"
			}
			return f.Server.URL
		},
		RegistrationHosts: func(brand string) (string, string) {
			if FeishuBrand(brand) == FeishuBrandLark {
				return f.Server.URL + "/lark", f.Server.URL + "/lark"
			}
			return f.Server.URL, f.Server.URL
		},
	}
}

// BaseURL is what an app pointing at the fake has as its base URL.
func (f *FakeFeishu) BaseURL() string { return f.Server.URL }

// Approve lets the pending device login succeed on the next poll.
func (f *FakeFeishu) Approve() {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.Approved = true
}

// Refreshes counts refresh grants served.
func (f *FakeFeishu) Refreshes() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.refreshes
}

// Revoked lists the tokens revoked, in order.
func (f *FakeFeishu) Revoked() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.revoked...)
}

// RequestedScope is the scope string of the last device authorization.
func (f *FakeFeishu) RequestedScope() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.requestedScope
}

// CurrentRefreshToken is the refresh token the fake considers live.
func (f *FakeFeishu) CurrentRefreshToken() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.currentRefresh
}

// UserCode is the code of the pending device login.
func (f *FakeFeishu) UserCode() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.userCode
}

// AccessTokenValid reports whether the fake issued token and has not
// revoked it.
func (f *FakeFeishu) AccessTokenValid(token string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.validAccess[token]
}

// TenantTokenValid reports whether the fake issued token as a tenant token.
func (f *FakeFeishu) TenantTokenValid(token string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.validTenant[token]
}

// TenantTokensIssued counts the tenant tokens the fake issued.
func (f *FakeFeishu) TenantTokensIssued() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.tenantIssued
}

// tenantToken serves auth/v3/tenant_access_token/internal for the app.
func (f *FakeFeishu) tenantToken(w http.ResponseWriter, r *http.Request) {
	var input struct {
		AppID     string `json:"app_id"`
		AppSecret string `json:"app_secret"`
	}
	_ = json.NewDecoder(r.Body).Decode(&input)
	f.mu.Lock()
	defer f.mu.Unlock()
	if input.AppID != f.clientID || input.AppSecret != f.clientSecret {
		writeOAuthJSON(w, http.StatusOK, map[string]any{"code": 10014, "msg": "app secret invalid"})
		return
	}
	f.tenantIssued++
	token := fmt.Sprintf("t-fake-%d", f.tenantIssued)
	f.validTenant[token] = true
	writeOAuthJSON(w, http.StatusOK, map[string]any{"code": 0, "msg": "ok", "tenant_access_token": token, "expire": 7200})
}

func writeOAuthJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

func (f *FakeFeishu) deviceAuthorization(w http.ResponseWriter, r *http.Request) {
	user, secret, ok := r.BasicAuth()
	if !ok || user != f.clientID || secret != f.clientSecret {
		writeOAuthJSON(w, http.StatusUnauthorized, map[string]any{"error": "invalid_client", "error_description": "bad app credentials"})
		return
	}
	if err := r.ParseForm(); err != nil || r.PostForm.Get("client_id") != f.clientID {
		writeOAuthJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid_request"})
		return
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.issued++
	f.requestedScope = r.PostForm.Get("scope")
	f.deviceCode = fmt.Sprintf("dc_%d", f.issued)
	f.userCode = fmt.Sprintf("FAKE-%04d", f.issued)
	writeOAuthJSON(w, http.StatusOK, map[string]any{
		"device_code": f.deviceCode, "user_code": f.userCode,
		"verification_uri":          f.Server.URL + "/verify",
		"verification_uri_complete": f.Server.URL + "/verify?user_code=" + f.userCode,
		"expires_in":                240, "interval": 0,
	})
}

func (f *FakeFeishu) token(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseForm(); err != nil {
		writeOAuthJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid_request"})
		return
	}
	if r.PostForm.Get("client_id") != f.clientID || r.PostForm.Get("client_secret") != f.clientSecret {
		writeOAuthJSON(w, http.StatusBadRequest, map[string]any{"code": 20002, "msg": "invalid client secret"})
		return
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	switch r.PostForm.Get("grant_type") {
	case feishuDeviceGrantType:
		if r.PostForm.Get("device_code") != f.deviceCode {
			writeOAuthJSON(w, http.StatusBadRequest, map[string]any{"error": "expired_token"})
			return
		}
		if f.Denied {
			writeOAuthJSON(w, http.StatusBadRequest, map[string]any{"error": "access_denied"})
			return
		}
		if !f.Approved {
			writeOAuthJSON(w, http.StatusBadRequest, map[string]any{"error": "authorization_pending"})
			return
		}
		f.grantedScope = f.requestedScope
		if len(f.GrantScopes) > 0 {
			f.grantedScope = strings.Join(f.GrantScopes, " ")
		}
		writeOAuthJSON(w, http.StatusOK, f.issueLocked(time.Now(), !f.NoRefreshToken))
	case "refresh_token":
		if f.RefreshFailCode != 0 {
			writeOAuthJSON(w, http.StatusBadRequest, map[string]any{"code": f.RefreshFailCode, "msg": "refresh refused by the fake"})
			return
		}
		presented := r.PostForm.Get("refresh_token")
		if f.spentRefresh[presented] {
			writeOAuthJSON(w, http.StatusBadRequest, map[string]any{"code": feishuCodeReused, "msg": "refresh_token already used"})
			return
		}
		if presented == "" || !f.liveRefresh[presented] {
			writeOAuthJSON(w, http.StatusBadRequest, map[string]any{"code": feishuCodeLegacyFormat, "msg": "refresh_token invalid"})
			return
		}
		f.spentRefresh[presented] = true
		delete(f.liveRefresh, presented)
		f.refreshes++
		writeOAuthJSON(w, http.StatusOK, f.issueLocked(time.Now(), true))
	default:
		writeOAuthJSON(w, http.StatusBadRequest, map[string]any{"error": "unsupported_grant_type"})
	}
}

// issueLocked mints a new access token (and refresh token) pair.
func (f *FakeFeishu) issueLocked(now time.Time, withRefresh bool) map[string]any {
	f.issued++
	authTime := now.Add(-time.Hour)
	access := fakeJWT(map[string]any{
		"typ": "access", "jti": fmt.Sprintf("at_%d", f.issued), "iat": now.Unix(), "exp": now.Add(2 * time.Hour).Unix(),
		"auth_time": authTime.Unix(), "auth_exp": authTime.Add(365 * 24 * time.Hour).Unix(), "client_id": f.clientID,
	})
	f.validAccess[access] = true
	response := map[string]any{
		"code": 0, "access_token": access, "token_type": "Bearer", "expires_in": 7200, "scope": f.grantedScope,
	}
	if withRefresh {
		refresh := fakeJWT(map[string]any{
			"typ": "refresh", "jti": fmt.Sprintf("rt_%d", f.issued), "iat": now.Unix(), "exp": now.Add(7 * 24 * time.Hour).Unix(),
		})
		f.currentRefresh = refresh
		f.liveRefresh[refresh] = true
		response["refresh_token"] = refresh
		if f.RefreshTokenExpiresIn > 0 {
			response["refresh_token_expires_in"] = f.RefreshTokenExpiresIn
		}
	}
	return response
}

func (f *FakeFeishu) revoke(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseForm(); err != nil || r.PostForm.Get("client_id") != f.clientID || r.PostForm.Get("client_secret") != f.clientSecret {
		writeOAuthJSON(w, http.StatusBadRequest, map[string]any{"code": 20002, "msg": "invalid client"})
		return
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	token := r.PostForm.Get("token")
	f.revoked = append(f.revoked, token)
	if f.liveRefresh[token] {
		f.spentRefresh[token] = true
		delete(f.liveRefresh, token)
		if token == f.currentRefresh {
			f.currentRefresh = ""
		}
	}
	delete(f.validAccess, token)
	writeOAuthJSON(w, http.StatusOK, map[string]any{"code": 0})
}

func (f *FakeFeishu) userInfo(w http.ResponseWriter, r *http.Request) {
	token := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	f.mu.Lock()
	defer f.mu.Unlock()
	if !f.validAccess[token] {
		writeOAuthJSON(w, http.StatusUnauthorized, map[string]any{"code": 99991668, "msg": "Invalid access token"})
		return
	}
	writeOAuthJSON(w, http.StatusOK, map[string]any{"code": 0, "data": map[string]any{
		"open_id": f.Identity.Subject, "name": f.Identity.DisplayName, "tenant_key": f.Identity.Tenant,
	}})
}

// fakeJWT encodes claims as an unsigned-looking JWT: header.payload.sig.
func fakeJWT(claims map[string]any) string {
	header, _ := json.Marshal(map[string]any{"alg": "ES256", "typ": "JWT"})
	payload, _ := json.Marshal(claims)
	return base64.RawURLEncoding.EncodeToString(header) + "." + base64.RawURLEncoding.EncodeToString(payload) + ".fake-signature"
}
