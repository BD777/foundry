package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/connectors"
	"github.com/foundry-dev/foundry/apps/server/internal/externalaccounts"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// Opt-in browser fixture for DEV-092: a temporary database, synthetic
// people, a synthetic Cloudflare identity and a fake official MCP that
// keeps DNS records in memory. Nothing reaches Cloudflare.
//
//	DEV092_BROWSER_FIXTURE=<dir> DEV092_BROWSER_WEB_DIST=<apps/web/dist> \
//	DEV092_BROWSER_PORT=<port> go test ./internal/httpapi -run TestCloudflareAccessBrowserFixture
//
// /fixture/login signs in as the owner; /fixture/session?op=add|remove has
// a session of the bound workspace call the cloudflare tool over /api/mcp
// with its own session token, as an agent's MCP client does.
func TestCloudflareAccessBrowserFixture(t *testing.T) {
	directory := os.Getenv("DEV092_BROWSER_FIXTURE")
	if directory == "" {
		t.Skip("opt-in browser fixture")
	}
	f := newExternalAccountsFixture(t)
	zone := strings.Repeat("a", 32)
	var mu sync.Mutex
	records := map[string]map[string]any{}
	next := 0
	fake := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var input struct {
			Params struct {
				Name      string `json:"name"`
				Arguments struct {
					Code string `json:"code"`
				} `json:"arguments"`
			} `json:"params"`
		}
		_ = json.NewDecoder(r.Body).Decode(&input)
		reply := func(v any) {
			body, _ := json.Marshal(v)
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": 1, "result": map[string]any{"content": []any{map[string]any{"type": "text", "text": string(body)}}}})
		}
		var call struct {
			Method string         `json:"method"`
			Path   string         `json:"path"`
			Body   map[string]any `json:"body"`
		}
		code := strings.TrimSuffix(strings.TrimPrefix(input.Params.Arguments.Code, "async () => { return await cloudflare.request("), "); }")
		_ = json.Unmarshal([]byte(code), &call)
		mu.Lock()
		defer mu.Unlock()
		zoneObject := map[string]any{"id": zone, "name": "fixture.invalid", "status": "active", "type": "full", "account": map[string]string{"id": strings.Repeat("b", 32), "name": "Fixture account"}}
		parts := strings.Split(strings.TrimPrefix(call.Path, "/"), "/")
		switch {
		case call.Path == "/zones":
			reply(map[string]any{"success": true, "result": []any{zoneObject}, "result_info": map[string]int{"page": 1, "total_pages": 1}})
		case call.Path == "/zones/"+zone:
			reply(map[string]any{"success": true, "result": zoneObject})
		case len(parts) == 3 && call.Method == "GET":
			list := []any{}
			for _, record := range records {
				list = append(list, record)
			}
			reply(map[string]any{"success": true, "result": list})
		case len(parts) == 3 && call.Method == "POST":
			next++
			id := fmt.Sprintf("%032x", next)
			record := map[string]any{"id": id, "zone_id": zone}
			for k, v := range call.Body {
				record[k] = v
			}
			records[id] = record
			reply(map[string]any{"success": true, "result": record})
		case len(parts) == 4 && call.Method == "GET":
			reply(map[string]any{"success": records[parts[3]] != nil, "result": records[parts[3]]})
		case len(parts) == 4 && call.Method == "DELETE":
			delete(records, parts[3])
			reply(map[string]any{"success": true, "result": map[string]string{"id": parts[3]}})
		default:
			reply(map[string]any{"success": false, "errors": []any{map[string]any{"code": 7003, "message": "fixture: unsupported"}}})
		}
	}))
	defer fake.Close()
	adapter := externalaccounts.NewCloudflare()
	adapter.BaseURL = fake.URL
	adapter.Client = fake.Client()
	service := externalaccounts.NewService(f.db, f.db, externalaccounts.NewRegistry(adapter))
	f.server.connectors.ServerHeld = service
	f.server.connectors.Cloudflare = connectors.NewCloudflareGateway(f.db, service)
	ctx := context.Background()
	app, err := f.db.CreateExternalProviderApp(ctx, store.ExternalProviderApp{ID: "cf-app", Provider: "cloudflare", OwnerUserID: f.aliceID, ClientID: "fixture-public", CreatedVia: "dynamic_registration"})
	if err != nil {
		t.Fatal(err)
	}
	scopes := []string{"offline_access", "user:read", "account:read", "zone.read", "dns.read", "ssl-and-certificates.read"}
	if os.Getenv("DEV092_BROWSER_WITHOUT_DNS_WRITE") != "1" {
		scopes = append(scopes, "dns.write", "zone.write", "workers-scripts.write")
	}
	if os.Getenv("DEV092_BROWSER_MANY_SCOPES") == "1" {
		// A broad grant, as the person's: enough for the card's filter.
		for _, area := range []string{"workers-scripts", "zone-settings", "page-rules", "load-balancers", "waf", "access-app", "r2", "d1", "kv", "logs"} {
			for i := 0; i < 10; i++ {
				scopes = append(scopes, fmt.Sprintf("%s-%d.read", area, i), fmt.Sprintf("%s-%d.write", area, i))
			}
		}
	}
	account, err := f.db.SaveExternalAccount(ctx, store.ExternalAccount{ID: "cf-account", AppID: app.ID, Provider: "cloudflare", OwnerUserID: f.aliceID, Label: "Fixture Cloudflare", DisplayName: "Fixture Cloudflare user", Subject: "user:fixture", Mode: store.ExternalCredentialServerHeld, Status: store.ExternalAccountReady, GrantedScopes: scopes})
	if err != nil {
		t.Fatal(err)
	}
	grant, _ := json.Marshal(externalaccounts.Grant{AccessToken: "fixture-access", RefreshToken: "fixture-refresh", AccessExpiresAt: time.Now().Add(12 * time.Hour), RefreshExpiresAt: time.Now().Add(48 * time.Hour)})
	if err := f.db.PutSecret(ctx, externalaccounts.GrantSecretID(account.ID), grant, externalaccounts.GrantSecretID(account.ID)); err != nil {
		t.Fatal(err)
	}
	if err := f.db.SetWorkspaceExternalAccounts(ctx, "ws_alice", f.aliceID, []string{account.ID}, map[string][]string{account.ID: {zone}}); err != nil {
		t.Fatal(err)
	}
	session, err := f.db.CreateAgentSession(ctx, store.CreateAgentSessionInput{CreatedByUserID: f.aliceID, WorkspaceID: "ws_alice", AgentID: "agent_alice", Provider: "claude", Title: "Add the LAN record", Prompt: "Add the LAN DNS record", Source: "chat"})
	if err != nil {
		t.Fatal(err)
	}
	token, err := f.db.MintAgentSessionToken(ctx, session.ID)
	if err != nil {
		t.Fatal(err)
	}
	lastID := ""
	tool := func(args map[string]any) string {
		body, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": map[string]any{"name": "cloudflare", "arguments": args}})
		request := httptest.NewRequest(http.MethodPost, "/api/mcp", strings.NewReader(string(body)))
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("Authorization", "Bearer "+token)
		response := httptest.NewRecorder()
		f.server.Routes().ServeHTTP(response, request)
		return response.Body.String()
	}
	var origin string
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/fixture/login":
			f.server.setSessionCookie(w, f.alice, time.Now().Add(12*time.Hour))
			http.Redirect(w, r, "/connectors/cloudflare", http.StatusSeeOther)
		case "/fixture/session":
			var out string
			switch r.URL.Query().Get("op") {
			case "add":
				out = tool(map[string]any{"action": "request", "accountId": account.ID, "method": "POST", "path": "/zones/" + zone + "/dns_records", "body": map[string]any{"type": "A", "name": "lan.fixture.invalid", "content": "192.0.2.10", "ttl": 1, "proxied": false}})
				var envelope struct {
					Result struct {
						Content []struct{ Text string } `json:"content"`
					} `json:"result"`
				}
				_ = json.Unmarshal([]byte(out), &envelope)
				for _, c := range envelope.Result.Content {
					var answer struct {
						Result struct{ ID string } `json:"result"`
					}
					if json.Unmarshal([]byte(c.Text), &answer) == nil && answer.Result.ID != "" {
						lastID = answer.Result.ID
					}
				}
			case "remove":
				out = tool(map[string]any{"action": "request", "accountId": account.ID, "method": "DELETE", "path": "/zones/" + zone + "/dns_records/" + lastID})
			case "accounts":
				out = tool(map[string]any{"action": "accounts"})
			}
			w.Header().Set("Content-Type", "application/json")
			fmt.Fprint(w, out)
		default:
			if strings.HasPrefix(r.URL.Path, "/api/") || os.Getenv("DEV092_BROWSER_WEB_DIST") == "" {
				f.server.Routes().ServeHTTP(w, r)
				return
			}
			f.server.serveWeb(os.Getenv("DEV092_BROWSER_WEB_DIST")).ServeHTTP(w, r)
		}
	})
	listener, err := net.Listen("tcp", "127.0.0.1:"+os.Getenv("DEV092_BROWSER_PORT"))
	if err != nil {
		t.Fatal(err)
	}
	browser := &httptest.Server{Listener: listener, Config: &http.Server{Handler: handler}}
	browser.Start()
	defer browser.Close()
	origin = browser.URL
	f.server.options.AllowedOrigin = origin
	if err := os.MkdirAll(directory, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(directory, "origin.txt"), []byte(origin), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Log("DEV-092 browser fixture at", origin)
	deadline := time.Now().Add(40 * time.Minute)
	for time.Now().Before(deadline) {
		if _, err := os.Stat(filepath.Join(directory, "stop")); err == nil {
			return
		}
		time.Sleep(300 * time.Millisecond)
	}
}
