package httpapi

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/connectors"
	"github.com/foundry-dev/foundry/apps/server/internal/externalaccounts"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func TestAppStoreConnectHTTPKeyBindingHandleAndGateway(t *testing.T) {
	f := newExternalAccountsFixture(t)
	ctx := context.Background()
	const appID = "123456789"
	var upstreamAuthorization string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/v1/apps" && r.URL.Query().Get("limit") == "1":
			_, _ = w.Write([]byte(`{"data":[]}`))
		case r.Method == http.MethodGet && r.URL.Path == "/v1/apps" && r.URL.Query().Get("limit") == "200":
			_, _ = w.Write([]byte(`{"data":[{"id":"` + appID + `","type":"apps","attributes":{"name":"Fixture","bundleId":"com.example.fixture","sku":"FIXTURE"}}]}`))
		case r.Method == http.MethodGet && r.URL.Path == "/v1/apps/"+appID:
			upstreamAuthorization = r.Header.Get("Authorization")
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"data":{"id":"` + appID + `","type":"apps","attributes":{"name":"Fixture"}}}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer upstream.Close()
	provider := externalaccounts.NewAppStoreConnect()
	provider.BaseURL = upstream.URL
	provider.Client = upstream.Client()
	service := externalaccounts.NewService(f.db, f.db, externalaccounts.NewRegistry(provider))
	f.server.connectors.ServerHeld = service
	f.server.connectors.AppStoreConnect = connectors.NewAppStoreConnectGateway(f.db, service)
	f.server.connectors.AppStoreConnect.UseNativeWork(f.server.hub)
	f.server.connectors.SetGatewayIssuer(f.server.feishuGateway)

	privateKey := appStoreConnectHTTPKey(t)
	inputBody, _ := json.Marshal(store.SaveAppStoreConnectKeyInput{
		IssuerID: "11111111-2222-3333-4444-555555555555", KeyID: "ABCDEF1234",
		PrivateKey: privateKey, Label: "HTTP fixture",
	})
	var connection store.AppStoreConnectConnection
	created := doAuthCall(t, f.handler, f.as(f.alice, http.MethodPost, "/api/connectors/appstoreconnect/keys", string(inputBody)))
	expectStatus(t, created, http.StatusCreated, "save key")
	if strings.Contains(created.Body.String(), privateKey) || strings.Contains(created.Body.String(), "BEGIN PRIVATE KEY") {
		t.Fatal("the key response carries the private key")
	}
	if err := json.Unmarshal(created.Body.Bytes(), &connection); err != nil {
		t.Fatal(err)
	}
	if connection.AccountID == "" || !connection.HasKey {
		t.Fatalf("saved key: %+v", connection)
	}
	var listed struct {
		Keys []store.AppStoreConnectConnection `json:"keys"`
	}
	f.call(f.alice, http.MethodGet, "/api/connectors/appstoreconnect/keys", "", http.StatusOK, "list keys", &listed)
	if len(listed.Keys) != 1 || listed.Keys[0].KeyID != "ABCDEF1234" {
		t.Fatalf("listed keys: %+v", listed)
	}
	var apps struct {
		Apps []store.AppStoreConnectApp `json:"apps"`
	}
	f.call(f.alice, http.MethodGet, "/api/connectors/appstoreconnect/accounts/"+connection.AccountID+"/apps", "", http.StatusOK, "list apps", &apps)
	if len(apps.Apps) != 1 || apps.Apps[0].ID != appID || apps.Apps[0].BundleID != "com.example.fixture" {
		t.Fatalf("App Store Connect apps: %+v", apps)
	}
	bindBody, _ := json.Marshal(store.SetWorkspaceExternalAccountsInput{
		AccountIDs: []string{connection.AccountID},
		Resources:  map[string][]string{connection.AccountID: {appID}},
	})
	f.call(f.alice, http.MethodPut, "/api/workspaces/ws_alice/external-accounts", string(bindBody), http.StatusOK, "bind app", nil)
	f.call(f.alice, http.MethodPut, "/api/workspaces/ws_alice/external-accounts/"+connection.AccountID+"/access", `{"access":"commerce"}`, http.StatusOK, "set commerce access", nil)

	session, err := f.db.CreateAgentSession(ctx, store.CreateAgentSessionInput{
		CreatedByUserID: f.aliceID, WorkspaceID: "ws_alice", AgentID: "agent_alice",
		Provider: "claude", Prompt: "manage the bound app", Source: "chat",
	})
	if err != nil {
		t.Fatal(err)
	}
	handleBody, _ := json.Marshal(map[string]string{"sessionId": session.ID, "accountId": connection.AccountID})
	issued := doAuthCall(t, f.handler, deviceCall(http.MethodPost, "/api/connectors/appstoreconnect/session-handle", string(handleBody), f.aliceDevice))
	expectStatus(t, issued, http.StatusOK, "issue session handle")
	var material store.ExternalAccountGateway
	if err := json.Unmarshal(issued.Body.Bytes(), &material); err != nil || !strings.HasPrefix(material.UserHandle, "fdyasc_user_") {
		t.Fatalf("session handle: %s %v", issued.Body.String(), err)
	}
	gatewayCall := deviceCall(http.MethodGet, "/api/connectors/appstoreconnect/gateway/v1/apps/"+appID, "", f.aliceDevice)
	gatewayCall.headers["Authorization"] = "Bearer " + material.UserHandle
	proxied := doAuthCall(t, f.handler, gatewayCall)
	expectStatus(t, proxied, http.StatusOK, "gateway request")
	if !strings.HasPrefix(upstreamAuthorization, "Bearer ") || strings.Contains(upstreamAuthorization, material.UserHandle) {
		t.Fatalf("stand-in reached Apple: %q", upstreamAuthorization)
	}
	f.call(f.alice, http.MethodDelete, "/api/connectors/appstoreconnect/keys/"+connection.AppID, "", http.StatusOK, "revoke key", nil)
	renew := doAuthCall(t, f.handler, deviceCall(http.MethodPost, "/api/connectors/appstoreconnect/session-handle", string(handleBody), f.aliceDevice))
	expectStatus(t, renew, http.StatusForbidden, "revoked key cannot renew")
}

func appStoreConnectHTTPKey(t *testing.T) string {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	der, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	return string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}))
}
