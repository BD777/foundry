package externalaccounts_test

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/externalaccounts"
	"github.com/foundry-dev/foundry/apps/server/internal/sqlitestore"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func TestAppStoreConnectJWTClaimsSignatureAndCache(t *testing.T) {
	privateKey, publicKey := appStoreConnectTestKey(t)
	now := time.Date(2026, 11, 10, 8, 30, 0, 0, time.UTC)
	var mu sync.Mutex
	var authorizations []string
	var claims []map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		limit := r.URL.Query().Get("limit")
		if r.URL.Path != "/v1/apps" || limit != "" && limit != "1" && limit != "200" {
			t.Errorf("unexpected validation request %s?%s", r.URL.Path, r.URL.RawQuery)
		}
		header := r.Header.Get("Authorization")
		token := strings.TrimPrefix(header, "Bearer ")
		if token == header || token == "" {
			t.Error("request did not carry a bearer JWT")
		}
		decoded := verifyAppStoreConnectJWT(t, token, publicKey)
		mu.Lock()
		authorizations = append(authorizations, token)
		claims = append(claims, decoded)
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":[]}`))
	}))
	defer server.Close()
	provider := externalaccounts.NewAppStoreConnect()
	provider.BaseURL = server.URL
	provider.Client = server.Client()
	provider.Now = func() time.Time { return now }
	const issuer = "11111111-2222-3333-4444-555555555555"
	const keyID = "ABCDEF1234"
	if err := provider.CheckKey(context.Background(), issuer, keyID, privateKey); err != nil {
		t.Fatal(err)
	}
	credentials := externalaccounts.AppStoreConnectCredentials{
		AppID: "app-one", IssuerID: issuer, KeyID: keyID, PrivateKey: privateKey,
	}
	for i := 0; i < 2; i++ {
		response, err := provider.Do(context.Background(), credentials, http.MethodGet, "/v1/apps", nil, nil, nil)
		if err != nil {
			t.Fatal(err)
		}
		_, _ = io.Copy(io.Discard, response.Body)
		response.Body.Close()
	}
	mu.Lock()
	if len(authorizations) != 3 || authorizations[1] != authorizations[2] {
		t.Fatalf("JWT was not reused: %d calls, equal=%t", len(authorizations), len(authorizations) > 2 && authorizations[1] == authorizations[2])
	}
	checkClaims, cachedClaims := claims[0], claims[1]
	mu.Unlock()
	if checkClaims["iss"] != issuer || checkClaims["aud"] != "appstoreconnect-v1" || checkClaims["kid"] != keyID {
		t.Fatalf("wrong JWT claims: %+v", checkClaims)
	}
	if checkClaims["exp"].(float64)-checkClaims["iat"].(float64) != 120 {
		t.Fatalf("key check JWT was not two minutes: %+v", checkClaims)
	}
	if cachedClaims["exp"].(float64)-cachedClaims["iat"].(float64) != 900 {
		t.Fatalf("gateway JWT was not fifteen minutes: %+v", cachedClaims)
	}
	now = now.Add(14 * time.Minute)
	response, err := provider.Do(context.Background(), credentials, http.MethodGet, "/v1/apps", nil, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	mu.Lock()
	defer mu.Unlock()
	if len(authorizations) != 4 || authorizations[3] == authorizations[1] {
		t.Fatal("a JWT inside its refresh window was not replaced")
	}
}

func verifyAppStoreConnectJWT(t *testing.T, token string, publicKey *ecdsa.PublicKey) map[string]any {
	t.Helper()
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		t.Fatalf("not a JWT: %q", token)
	}
	signature, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil || len(signature) != 64 {
		t.Fatalf("bad ES256 signature: %v %d", err, len(signature))
	}
	digest := sha256.Sum256([]byte(parts[0] + "." + parts[1]))
	if !ecdsa.Verify(publicKey, digest[:], newBigInt(signature[:32]), newBigInt(signature[32:])) {
		t.Fatal("JWT signature did not verify")
	}
	headerPayload, _ := base64.RawURLEncoding.DecodeString(parts[0])
	claimsPayload, _ := base64.RawURLEncoding.DecodeString(parts[1])
	var header, claims map[string]any
	if json.Unmarshal(headerPayload, &header) != nil || json.Unmarshal(claimsPayload, &claims) != nil {
		t.Fatal("JWT header or claims were not JSON")
	}
	if header["alg"] != "ES256" || header["typ"] != "JWT" || header["kid"] == "" {
		t.Fatalf("wrong JWT header: %+v", header)
	}
	claims["kid"] = header["kid"]
	return claims
}

func newBigInt(value []byte) *big.Int {
	return new(big.Int).SetBytes(value)
}

func appStoreConnectTestKey(t *testing.T) (string, *ecdsa.PublicKey) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	der, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	return string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der})), &key.PublicKey
}

func TestAppStoreConnectKeyIsSealedAndRevocable(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "foundry.db")
	st, err := sqlitestore.OpenWithOptions(dbPath, sqlitestore.Options{SecretKeyPath: filepath.Join(dir, "secret.key")})
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	privateKey, _ := appStoreConnectTestKey(t)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":[]}`))
	}))
	defer server.Close()
	provider := externalaccounts.NewAppStoreConnect()
	provider.BaseURL = server.URL
	provider.Client = server.Client()
	service := externalaccounts.NewService(st, st, externalaccounts.NewRegistry(provider))
	var logs []string
	service.Logf = func(format string, args ...any) {
		logs = append(logs, fmt.Sprintf(format, args...))
	}
	const issuer = "11111111-2222-3333-4444-555555555555"
	connection, err := service.CreateAppStoreConnectKey(ctx, "alice", store.SaveAppStoreConnectKeyInput{
		IssuerID: issuer, KeyID: "ABCDEF1234", PrivateKey: privateKey, Label: "Fixture team",
	})
	if err != nil {
		t.Fatal(err)
	}
	if connection.AppID == "" || connection.AccountID == "" || !connection.HasKey || connection.Status != "ready" {
		t.Fatalf("key was not connected: %+v", connection)
	}
	raw, err := sql.Open("sqlite", dbPath)
	if err != nil {
		t.Fatal(err)
	}
	defer raw.Close()
	var ciphertext, wrapped []byte
	if err := raw.QueryRow(`SELECT ciphertext, wrapped_dek FROM secret_records WHERE id = ?`,
		externalaccounts.AppStoreConnectKeySecretID(connection.AppID)).Scan(&ciphertext, &wrapped); err != nil {
		t.Fatal(err)
	}
	marker := []byte("PRIVATE KEY")
	if bytes.Contains(ciphertext, marker) || bytes.Contains(wrapped, marker) || bytes.Contains(ciphertext, []byte("BEGIN PRIVATE")) {
		t.Fatal("the .p8 is plaintext in the secret record")
	}
	unsealed, err := st.GetSecret(ctx, externalaccounts.AppStoreConnectKeySecretID(connection.AppID))
	var payload struct {
		PrivateKey string `json:"private_key"`
	}
	if err != nil || json.Unmarshal(unsealed, &payload) != nil || payload.PrivateKey != strings.TrimSpace(privateKey) {
		t.Fatalf("sealed payload did not round trip: %v", err)
	}
	listed, err := service.ListAppStoreConnectKeys(ctx, "alice")
	if err != nil || len(listed) != 1 || listed[0].KeyID != "ABCDEF1234" {
		t.Fatalf("key list: %+v %v", listed, err)
	}
	connection, err = service.ReplaceAppStoreConnectKey(ctx, "alice", connection.AppID, store.SaveAppStoreConnectKeyInput{
		IssuerID: issuer, KeyID: "ZZZZZZ9999", PrivateKey: privateKey, Label: "Rotated team",
	})
	if err != nil || connection.KeyID != "ZZZZZZ9999" || connection.Label != "Rotated team" || !connection.HasKey {
		t.Fatalf("key replacement: %+v %v", connection, err)
	}
	connection, err = service.RevokeAppStoreConnectKey(ctx, "alice", connection.AppID, "alice")
	if err != nil || connection.HasKey || connection.Status != "revoked" {
		t.Fatalf("key revocation: %+v %v", connection, err)
	}
	if stored, _ := st.HasSecret(ctx, externalaccounts.AppStoreConnectKeySecretID(connection.AppID)); stored {
		t.Fatal("revocation left the private key sealed")
	}
	for _, line := range logs {
		if strings.Contains(line, privateKey) || strings.Contains(line, "BEGIN PRIVATE KEY") {
			t.Fatal("a log line contains the private key")
		}
	}
}
