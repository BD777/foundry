package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/connectors"
	"github.com/foundry-dev/foundry/apps/server/internal/externalaccounts"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func TestAppStoreConnectMCPCreateCheckAndBind(t *testing.T) {
	f := newExternalAccountsFixture(t)
	ctx := context.Background()
	const appID = "123456789"
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/v1/apps" && r.URL.Query().Get("limit") == "1":
			_, _ = w.Write([]byte(`{"data":[]}`))
		case r.Method == http.MethodGet && r.URL.Path == "/v1/apps":
			_, _ = w.Write([]byte(`{"data":[{"id":"` + appID + `","type":"apps","attributes":{"name":"Fixture","bundleId":"com.example.fixture"}}]}`))
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

	session, err := f.server.store.CreateAgentSession(ctx, store.CreateAgentSessionInput{
		CreatedByUserID: f.aliceID, WorkspaceID: "ws_alice", AgentID: "agent_alice",
		Provider: "claude", Prompt: "configure App Store Connect", Source: store.SessionSourceChat,
	})
	if err != nil {
		t.Fatal(err)
	}
	token, err := f.server.store.MintAgentSessionToken(ctx, session.ID)
	if err != nil {
		t.Fatal(err)
	}
	privateKey := appStoreConnectHTTPKey(t)
	fields := map[string]string{"issuerId": "11111111-2222-3333-4444-555555555555", "keyId": "ABCDEF1234"}

	if text, failed := connectorMCPCall(t, f.handler, token, map[string]any{
		"action": "create", "kind": "appstoreconnect", "fields": fields,
		"secretValues": map[string]string{"privateKey": privateKey},
	}, false); !failed || !strings.Contains(text, "secret proxy") {
		t.Fatalf("secretValues without the Worker proxy = %q (error %v)", text, failed)
	}
	if text, failed := connectorMCPCall(t, f.handler, token, map[string]any{
		"action": "create", "kind": "appstoreconnect",
		"fields": map[string]string{"issuerId": fields["issuerId"], "keyId": fields["keyId"], "privateKey": "inline"},
	}, false); !failed || !strings.Contains(text, "secretFiles.privateKey") {
		t.Fatalf("inline private key = %q (error %v)", text, failed)
	}

	created, failed := connectorMCPCall(t, f.handler, token, map[string]any{
		"action": "create", "kind": "appstoreconnect", "label": "MCP fixture", "fields": fields,
		"secretValues": map[string]string{"privateKey": privateKey},
	}, true)
	if failed || strings.Contains(created, "PRIVATE KEY") || !strings.Contains(created, `"bundleId": "com.example.fixture"`) {
		t.Fatalf("create = %q (error %v)", created, failed)
	}
	var result struct {
		Instance appStoreConnectInstanceSummary `json:"instance"`
	}
	if err := json.Unmarshal([]byte(created), &result); err != nil || result.Instance.ID == "" || result.Instance.KeyID != "ABCDEF1234" {
		t.Fatalf("created instance: %s %v", created, err)
	}

	listed, failed := connectorMCPCall(t, f.handler, token, map[string]any{"action": "list", "kind": "appstoreconnect"}, false)
	if failed || !strings.Contains(listed, result.Instance.ID) || !strings.Contains(listed, `"commerce"`) {
		t.Fatalf("list = %q (error %v)", listed, failed)
	}

	if text, failed := connectorMCPCall(t, f.handler, token, map[string]any{
		"action": "bind_workspace", "kind": "appstoreconnect", "instanceId": result.Instance.ID,
		"workspaceId": "ws_alice", "resourceIds": []string{"999"},
	}, false); !failed || !strings.Contains(text, "not visible") {
		t.Fatalf("binding an unseen App = %q (error %v)", text, failed)
	}
	bound, failed := connectorMCPCall(t, f.handler, token, map[string]any{
		"action": "bind_workspace", "kind": "appstoreconnect", "instanceId": result.Instance.ID,
		"workspaceId": "ws_alice", "resourceIds": []string{appID}, "access": "commerce",
	}, false)
	if failed || !strings.Contains(bound, `"access": "commerce"`) {
		t.Fatalf("bind = %q (error %v)", bound, failed)
	}
	bindings, err := f.db.ListWorkspaceExternalAccounts(ctx, "ws_alice")
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, binding := range bindings {
		if binding.AccountID == result.Instance.AccountID {
			found = len(binding.ResourceIDs) == 1 && binding.ResourceIDs[0] == appID && binding.Access == "commerce"
		}
	}
	if !found {
		t.Fatalf("workspace bindings: %+v", bindings)
	}
}
