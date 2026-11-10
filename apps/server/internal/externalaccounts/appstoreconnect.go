package externalaccounts

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

const (
	AppStoreConnectAPIBaseURL = "https://api.appstoreconnect.apple.com"
	appStoreConnectAudience   = "appstoreconnect-v1"
)

var (
	ErrAppStoreConnectKeyRejected = errors.New("App Store Connect rejected this API key")
	ErrAppStoreConnectKeyRevoked  = errors.New("this App Store Connect API key has been revoked in Foundry")
)

// AppStoreConnectCredentials is one unsealed team key for one upstream call.
// It exists in memory only for the duration of that call.
type AppStoreConnectCredentials struct {
	AppID      string
	IssuerID   string
	KeyID      string
	PrivateKey string
}

type appStoreConnectToken struct {
	mu      sync.Mutex
	token   string
	expires time.Time
	digest  string
}

// AppStoreConnect is the App Store Connect adapter: ES256 team JWTs, the
// documented Apps validation read, and HTTP transport with a short-lived JWT
// cache. The .p8 is supplied per call by the secret store.
type AppStoreConnect struct {
	BaseURL string
	Client  *http.Client
	Now     func() time.Time

	mu     sync.Mutex
	tokens map[string]*appStoreConnectToken
}

func NewAppStoreConnect() *AppStoreConnect {
	return &AppStoreConnect{
		BaseURL: AppStoreConnectAPIBaseURL,
		Client:  &http.Client{Timeout: 45 * time.Second},
		Now:     time.Now,
		tokens:  map[string]*appStoreConnectToken{},
	}
}

func (a *AppStoreConnect) Describe() store.ExternalProvider {
	return store.ExternalProvider{
		Kind:           "appstoreconnect",
		Label:          "App Store Connect",
		CredentialMode: store.ExternalCredentialServerHeld,
		AuthMethods:    []string{"api_key"},
		Tools:          []string{"asc"},
		DefaultBaseURL: AppStoreConnectAPIBaseURL,
		AccessLevels:   AppStoreConnectAccessLevels,
	}
}

// CheckKey signs a two-minute JWT and reads the first App, which validates
// the key without creating or changing anything at Apple.
func (a *AppStoreConnect) CheckKey(ctx context.Context, issuerID, keyID, privateKey string) error {
	credentials := AppStoreConnectCredentials{IssuerID: issuerID, KeyID: keyID, PrivateKey: privateKey}
	token, err := a.mintJWT(credentials, 2*time.Minute)
	if err != nil {
		return fmt.Errorf("%w: the private key is not a P-256 PKCS#8 key", ErrAppStoreConnectKeyRejected)
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(a.baseURL(), "/")+"/v1/apps?limit=1", nil)
	if err != nil {
		return err
	}
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("Accept", "application/json")
	request.Header.Set("User-Agent", "Foundry-Connector/1.0")
	response, err := a.client().Do(request)
	if err != nil {
		return errors.New("App Store Connect could not be reached")
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusUnauthorized || response.StatusCode == http.StatusForbidden {
		return ErrAppStoreConnectKeyRejected
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fmt.Errorf("App Store Connect key check answered HTTP %d", response.StatusCode)
	}
	_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 64<<10))
	return nil
}

// Do sends an authenticated Apple API request. One cached JWT is reused for
// at most fifteen minutes and is replaced one minute before it expires.
func (a *AppStoreConnect) Do(ctx context.Context, credentials AppStoreConnectCredentials, method, path string, query url.Values, headers http.Header, body io.Reader) (*http.Response, error) {
	token, err := a.accessToken(ctx, credentials)
	if err != nil {
		return nil, err
	}
	target := strings.TrimRight(a.baseURL(), "/") + "/" + strings.TrimPrefix(path, "/")
	if len(query) > 0 {
		target += "?" + query.Encode()
	}
	request, err := http.NewRequestWithContext(ctx, method, target, body)
	if err != nil {
		return nil, err
	}
	for name, values := range headers {
		for _, value := range values {
			request.Header.Add(name, value)
		}
	}
	request.Header.Del("Authorization")
	request.Header.Del("X-Foundry-Device-Credential")
	request.Header.Del("X-Foundry-Forwarder-Host")
	request.Header.Del("Cookie")
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("Accept", "application/json")
	request.Header.Set("User-Agent", "Foundry-Connector/1.0")
	return a.client().Do(request)
}

func (a *AppStoreConnect) accessToken(ctx context.Context, credentials AppStoreConnectCredentials) (string, error) {
	if credentials.AppID == "" {
		return a.mintJWT(credentials, 15*time.Minute)
	}
	a.mu.Lock()
	if a.tokens == nil {
		a.tokens = map[string]*appStoreConnectToken{}
	}
	entry := a.tokens[credentials.AppID]
	if entry == nil {
		entry = &appStoreConnectToken{}
		a.tokens[credentials.AppID] = entry
	}
	a.mu.Unlock()

	entry.mu.Lock()
	defer entry.mu.Unlock()
	digest := appStoreConnectKeyDigest(credentials.IssuerID, credentials.KeyID, credentials.PrivateKey)
	now := a.now()
	if entry.token != "" && entry.digest == digest && entry.expires.Sub(now) > time.Minute {
		return entry.token, nil
	}
	token, err := a.mintJWT(credentials, 15*time.Minute)
	if err != nil {
		return "", err
	}
	entry.token, entry.expires, entry.digest = token, now.Add(15*time.Minute), digest
	return token, nil
}

func (a *AppStoreConnect) mintJWT(credentials AppStoreConnectCredentials, lifetime time.Duration) (string, error) {
	key, err := parseAppStoreConnectPrivateKey(credentials.PrivateKey)
	if err != nil {
		return "", err
	}
	now := a.now().UTC().Truncate(time.Second)
	header, _ := json.Marshal(map[string]string{"alg": "ES256", "kid": credentials.KeyID, "typ": "JWT"})
	claims, _ := json.Marshal(map[string]any{
		"iss": credentials.IssuerID,
		"aud": appStoreConnectAudience,
		"iat": now.Unix(),
		"exp": now.Add(lifetime).Unix(),
	})
	unsigned := base64.RawURLEncoding.EncodeToString(header) + "." + base64.RawURLEncoding.EncodeToString(claims)
	digest := sha256.Sum256([]byte(unsigned))
	r, s, err := ecdsa.Sign(rand.Reader, key, digest[:])
	if err != nil {
		return "", err
	}
	signature := make([]byte, 64)
	r.FillBytes(signature[:32])
	s.FillBytes(signature[32:])
	return unsigned + "." + base64.RawURLEncoding.EncodeToString(signature), nil
}

func parseAppStoreConnectPrivateKey(privateKey string) (*ecdsa.PrivateKey, error) {
	block, _ := pem.Decode([]byte(strings.TrimSpace(privateKey)))
	if block == nil {
		return nil, errors.New("no PEM private key")
	}
	if parsed, err := x509.ParsePKCS8PrivateKey(block.Bytes); err == nil {
		key, ok := parsed.(*ecdsa.PrivateKey)
		if ok && key.Curve == elliptic.P256() {
			return key, nil
		}
	}
	if key, err := x509.ParseECPrivateKey(block.Bytes); err == nil && key.Curve == elliptic.P256() {
		return key, nil
	}
	return nil, errors.New("not a P-256 private key")
}

func appStoreConnectKeyDigest(issuerID, keyID, privateKey string) string {
	sum := sha256.Sum256([]byte(issuerID + "\x00" + keyID + "\x00" + privateKey))
	return hex.EncodeToString(sum[:])
}

func (a *AppStoreConnect) ForgetApp(appID string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	delete(a.tokens, appID)
}

func (a *AppStoreConnect) baseURL() string {
	if strings.TrimSpace(a.BaseURL) == "" {
		return AppStoreConnectAPIBaseURL
	}
	return a.BaseURL
}

func (a *AppStoreConnect) client() *http.Client {
	if a.Client != nil {
		return a.Client
	}
	return &http.Client{Timeout: 45 * time.Second}
}

func (a *AppStoreConnect) now() time.Time {
	if a.Now != nil {
		return a.Now()
	}
	return time.Now()
}
