package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/externalaccounts"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func edgeAccessMCPCall(t *testing.T, handler http.Handler, token string, args map[string]any, resolvedByWorker bool) (string, bool) {
	t.Helper()
	raw, err := json.Marshal(map[string]any{
		"jsonrpc": "2.0",
		"id":      1,
		"method":  "tools/call",
		"params": map[string]any{
			"name": "edge_access", "arguments": args,
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, "/api/mcp", strings.NewReader(string(raw)))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Authorization", "Bearer "+token)
	if resolvedByWorker {
		request.Header.Set(connectorInstanceSecretProxyHeader, connectorInstanceSecretProxyValue)
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	var envelope struct {
		Result struct {
			Content []struct {
				Text string `json:"text"`
			} `json:"content"`
			IsError bool `json:"isError"`
		} `json:"result"`
		Error *struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &envelope); err != nil {
		t.Fatalf("edge_access: %d %s", response.Code, response.Body.String())
	}
	if envelope.Error != nil {
		return envelope.Error.Message, true
	}
	if len(envelope.Result.Content) == 0 {
		t.Fatalf("edge_access answered no content: %s", response.Body.String())
	}
	return envelope.Result.Content[0].Text, envelope.Result.IsError
}

func TestEdgeAccessMCPManagesCredentialsWithoutSecrets(t *testing.T) {
	f := newExternalAccountsFixture(t)
	ctx := context.Background()
	session, err := f.server.store.CreateAgentSession(ctx, store.CreateAgentSessionInput{
		CreatedByUserID: f.aliceID, WorkspaceID: "ws_alice", AgentID: "agent_alice",
		Provider: "claude", Prompt: "configure edge access", Source: store.SessionSourceChat,
	})
	if err != nil {
		t.Fatal(err)
	}
	token, err := f.server.store.MintAgentSessionToken(ctx, session.ID)
	if err != nil {
		t.Fatal(err)
	}
	const clientID = "edge-mcp-client-id-value"
	const clientSecret = "edge-mcp-client-secret-value"
	createdText, failed := edgeAccessMCPCall(t, f.handler, token, map[string]any{
		"action": "create", "label": "OpenLark edge", "provider": "cloudflare_access",
		"match":        map[string]any{"host": "Olk.Example.com", "pathPrefix": "/agent"},
		"team":         "windeng",
		"secretValues": map[string]string{"clientId": clientID, "clientSecret": clientSecret},
	}, true)
	if failed || strings.Contains(createdText, clientID) || strings.Contains(createdText, clientSecret) {
		t.Fatalf("create = %q (error %v)", createdText, failed)
	}
	var created store.EdgeAccess
	if err := json.Unmarshal([]byte(createdText), &created); err != nil || created.ID == "" || created.Match.Host != "olk.example.com" {
		t.Fatalf("created = %s (%v)", createdText, err)
	}

	listedText, failed := edgeAccessMCPCall(t, f.handler, token, map[string]any{"action": "list"}, false)
	if failed || strings.Contains(listedText, clientID) || strings.Contains(listedText, clientSecret) {
		t.Fatalf("list = %q (error %v)", listedText, failed)
	}
	var listed store.EdgeAccessList
	if err := json.Unmarshal([]byte(listedText), &listed); err != nil || len(listed.Credentials) != 1 ||
		listed.Credentials[0].ID != created.ID {
		t.Fatalf("listed = %s (%v)", listedText, err)
	}

	replacedText, failed := edgeAccessMCPCall(t, f.handler, token, map[string]any{
		"action": "replace", "id": created.ID, "label": "Renamed edge", "provider": "cloudflare_access",
		"match": map[string]any{"host": "openlark.example.com"},
	}, false)
	if failed || strings.Contains(replacedText, clientID) || strings.Contains(replacedText, clientSecret) {
		t.Fatalf("replace = %q (error %v)", replacedText, failed)
	}
	unresolved, failed := edgeAccessMCPCall(t, f.handler, token, map[string]any{
		"action": "create", "label": "Unresolved", "provider": "cloudflare_access",
		"match":       map[string]any{"host": "unresolved.example.com"},
		"secretFiles": map[string]any{"clientId": map[string]string{"path": ".env"}},
	}, false)
	if !failed || !strings.Contains(unresolved, "must be resolved by the session worker") {
		t.Fatalf("unresolved secretFiles = %q (error %v)", unresolved, failed)
	}
	unproxied, failed := edgeAccessMCPCall(t, f.handler, token, map[string]any{
		"action": "create", "label": "Unproxied", "provider": "cloudflare_access",
		"match":        map[string]any{"host": "unproxied.example.com"},
		"secretValues": map[string]string{"clientId": clientID, "clientSecret": clientSecret},
	}, false)
	if !failed || !strings.Contains(unproxied, "secret proxy") ||
		strings.Contains(unproxied, clientID) || strings.Contains(unproxied, clientSecret) {
		t.Fatalf("unproxied secretValues = %q (error %v)", unproxied, failed)
	}
	deleted, failed := edgeAccessMCPCall(t, f.handler, token, map[string]any{
		"action": "delete", "id": created.ID,
	}, false)
	if failed || !strings.Contains(deleted, `"status": "deleted"`) {
		t.Fatalf("delete = %q (error %v)", deleted, failed)
	}

	if err := mcpToolAllowed(store.AgentSessionRoleIssueExecution, false, "edge_access"); err == nil {
		t.Fatal("edge_access was listed for an Issue execution")
	}
	if err := mcpToolAllowed("", true, "edge_access"); err == nil {
		t.Fatal("edge_access was listed for a verifier")
	}
}

func TestEdgeAccessMCPProvisionUsesAutomaticSetup(t *testing.T) {
	zeroTrust, _ := externalaccounts.CloudflareAccessLevel(externalaccounts.CloudflareAccessZeroTrust)
	fullScopes := append([]string{"offline_access", "user:read", "account:read"}, zeroTrust.Scopes...)
	f := newEdgeProvisionFixture(t, fullScopes)
	ctx := context.Background()
	session, err := f.server.store.CreateAgentSession(ctx, store.CreateAgentSessionInput{
		CreatedByUserID: f.aliceID, WorkspaceID: "ws_alice", AgentID: "agent_alice",
		Provider: "claude", Prompt: "provision edge access", Source: store.SessionSourceChat,
	})
	if err != nil {
		t.Fatal(err)
	}
	token, err := f.server.store.MintAgentSessionToken(ctx, session.ID)
	if err != nil {
		t.Fatal(err)
	}
	text, failed := edgeAccessMCPCall(t, f.handler, token, map[string]any{
		"action": "provision",
		"edgeAccessRequired": map[string]any{
			"provider": "cloudflare_access",
			"team":     "fixture.cloudflareaccess.com",
			"host":     "Fixture.Invalid",
			"path":     "/lan/",
			"message":  "edge access required",
		},
	}, false)
	if failed {
		t.Fatalf("provision = %q", text)
	}
	var result edgeAccessProvisionResponse
	if err := json.Unmarshal([]byte(text), &result); err != nil {
		t.Fatal(err)
	}
	if result.EdgeAccess.ID == "" || result.EdgeAccess.Match.Host != "fixture.invalid" ||
		result.EdgeAccess.Match.PathPrefix != "/lan" ||
		result.AccountID != edgeProvisionAccountID ||
		result.ServiceTokenID != edgeProvisionTokenID ||
		result.ApplicationID != edgeProvisionAppID ||
		result.PolicyID != edgeProvisionPolicyID ||
		!result.NeedsIngress || result.SuggestedIngress == nil ||
		result.SuggestedIngress.Hostname != "fixture.invalid" {
		t.Fatalf("provision result = %+v", result)
	}
	if got := len(f.callsSnapshot()); got != 7 {
		t.Fatalf("upstream calls = %d, want 7", got)
	}
	for _, secret := range []string{edgeProvisionGrant, edgeProvisionClientID, edgeProvisionClientSecret} {
		if strings.Contains(text, secret) {
			t.Fatalf("provision result exposed %q: %s", secret, text)
		}
	}
}
