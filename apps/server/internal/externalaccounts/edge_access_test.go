package externalaccounts_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/externalaccounts"
	"github.com/foundry-dev/foundry/apps/server/internal/sqlitestore"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

const edgeTestOwner = "user_edge"

func edgeTestDescriptor(baseURL string) store.ConnectorDescriptor {
	return store.ConnectorDescriptor{
		Kind: "acme-api", Label: "Acme API", Holding: store.ConnectorServerHeld,
		Adapter: "extension:acme", Extension: &store.ConnectorExtensionSource{ID: "acme", Name: "Acme", Version: "1.0.0"},
		Tool: store.ConnectorTool{Command: "acme", Source: "device"},
		ServerHeld: &store.ConnectorServerHeldSpec{
			Instances: "many",
			Fields: []store.ConnectorField{
				{ID: "baseUrl", Type: "url", Required: true, Label: "URL", Default: baseURL},
				{ID: "token", Type: "secret", Required: true, Label: "Token"},
			},
			Steps: []store.ConnectorServerHeldStep{{"baseUrl", "token"}},
			Probe: []store.ConnectorServerHeldProbe{{
				ID: "capabilities", Method: "GET", Path: "/api/capabilities",
				Extract: store.ConnectorServerHeldProbeExtract{Values: map[string]string{"scope": "/token/scope"}},
			}, {
				ID: "routes", Method: "GET", Path: "/api/routes",
				Extract: store.ConnectorServerHeldProbeExtract{
					Routes: store.ConnectorServerHeldRoutesExtract{Items: "/routes", Method: "/method", Path: "/path", Access: "/access"},
				},
			}},
			Upstream: store.ConnectorServerHeldUpstream{
				BaseField: "baseUrl", PathPrefix: "/api",
				Headers: map[string]string{"Authorization": "Bearer {secret:token}"},
			},
			Access: store.ConnectorServerHeldAccess{
				From: "probe:routes", Default: "deny",
				AllowBy: store.ConnectorServerHeldAccessBy{
					Value:     "probe:capabilities/scope",
					Map:       map[string]store.ConnectorServerHeldAccessLevels{"read": {"read"}},
					Otherwise: store.ConnectorServerHeldAccessLevels{"read"},
				},
			},
			Network: store.ConnectorServerHeldNetwork{Holdings: []string{"server", "device"}},
		},
	}
}

func edgeTestService(t *testing.T) *externalaccounts.Service {
	t.Helper()
	dir := t.TempDir()
	st, err := sqlitestore.OpenWithOptions(filepath.Join(dir, "foundry.db"), sqlitestore.Options{SecretKeyPath: filepath.Join(dir, "secret.key")})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	return externalaccounts.NewService(st, st, externalaccounts.NewRegistry())
}

func edgeTestApp(t *testing.T, descriptor store.ConnectorDescriptor, baseURL, network string) store.ExternalProviderApp {
	t.Helper()
	data, err := json.Marshal(store.ExtensionInstanceData{
		Descriptor: descriptor, Values: map[string]string{"baseUrl": baseURL}, Network: store.ConnectorServerHeldNetworkPath(network),
	})
	if err != nil {
		t.Fatal(err)
	}
	return store.ExternalProviderApp{ID: "app_edge", OwnerUserID: edgeTestOwner, CreatedVia: "extension", ExtensionData: string(data)}
}

func parse(t *testing.T, raw string) *url.URL {
	t.Helper()
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	return u
}

func TestMatchEdgeAccessLongestPrefixAndCaseInsensitiveHost(t *testing.T) {
	items := []store.EdgeAccess{
		{ID: "whole", Match: store.EdgeAccessMatch{Host: "olk.example.com"}},
		{ID: "agent", Match: store.EdgeAccessMatch{Host: "olk.example.com", PathPrefix: "/agent"}},
		{ID: "v1", Match: store.EdgeAccessMatch{Host: "olk.example.com", PathPrefix: "/agent/v1"}},
		{ID: "other", Match: store.EdgeAccessMatch{Host: "other.example.com"}},
	}
	for target, want := range map[string]string{
		"https://OLK.Example.COM/agent/v1/capabilities": "v1",
		"https://olk.example.com/agent/v1":              "v1",
		"https://olk.example.com:8443/agent/v2":         "agent",
		"https://olk.example.com/agentic":               "whole",
		"https://olk.example.com":                       "whole",
		"https://other.example.com/agent/v1":            "other",
		"https://nomatch.example.com/":                  "",
	} {
		got, ok := externalaccounts.MatchEdgeAccess(items, parse(t, target))
		if got.ID != want || ok != (want != "") {
			t.Errorf("%s matched %q (ok=%v), want %q", target, got.ID, ok, want)
		}
	}
}

func TestEdgeAccessCreateReplaceDeleteNeverReturnsSecrets(t *testing.T) {
	service := edgeTestService(t)
	ctx := context.Background()
	input := store.EdgeAccessInput{
		Label: "OpenLark", Provider: store.EdgeAccessProviderCloudflareAccess,
		Match:    store.EdgeAccessMatch{Host: " OLK.Example.com ", PathPrefix: "/agent/v1/"},
		ClientID: "client-id-value.access", ClientSecret: "client-secret-value",
	}
	created, err := service.CreateEdgeAccess(ctx, edgeTestOwner, input)
	if err != nil {
		t.Fatal(err)
	}
	if created.Match.Host != "olk.example.com" || created.Match.PathPrefix != "/agent/v1" {
		t.Fatalf("match not normalised: %+v", created.Match)
	}
	if _, err := service.CreateEdgeAccess(ctx, edgeTestOwner, input); !errors.Is(err, store.ErrEdgeAccessConflict) {
		t.Fatalf("duplicate address = %v", err)
	}
	for _, bad := range []store.EdgeAccessInput{
		{Label: "x", Provider: store.EdgeAccessProviderBasic, Match: store.EdgeAccessMatch{Host: "a.example.com"}, ClientID: "a", ClientSecret: "b"},
		{Label: "x", Provider: store.EdgeAccessProviderCloudflareAccess, Match: store.EdgeAccessMatch{Host: "https://a.example.com"}, ClientID: "a", ClientSecret: "b"},
		{Label: "x", Provider: store.EdgeAccessProviderCloudflareAccess, Match: store.EdgeAccessMatch{Host: "a.example.com"}},
	} {
		if _, err := service.CreateEdgeAccess(ctx, edgeTestOwner, bad); !errors.Is(err, externalaccounts.ErrInvalidEdgeAccess) {
			t.Errorf("accepted %+v: %v", bad, err)
		}
	}
	replaced, err := service.ReplaceEdgeAccess(ctx, edgeTestOwner, created.ID, store.EdgeAccessInput{
		Label: "OpenLark 2", Provider: store.EdgeAccessProviderCloudflareAccess, Team: "windeng",
		Match: store.EdgeAccessMatch{Host: "olk.example.com"},
	})
	if err != nil || replaced.Label != "OpenLark 2" || replaced.Team != "windeng" {
		t.Fatalf("replace = %+v, %v", replaced, err)
	}
	if _, err := service.ReplaceEdgeAccess(ctx, "someone_else", created.ID, input); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("another owner replaced it: %v", err)
	}
	list, err := service.ListEdgeAccess(ctx, edgeTestOwner)
	if err != nil || len(list.Credentials) != 1 {
		t.Fatalf("list = %+v, %v", list, err)
	}
	encoded, _ := json.Marshal(list)
	for _, secret := range []string{"client-id-value", "client-secret-value"} {
		if strings.Contains(string(encoded), secret) {
			t.Fatalf("list exposes %q: %s", secret, encoded)
		}
	}
	if err := service.DeleteEdgeAccess(ctx, edgeTestOwner, created.ID); err != nil {
		t.Fatal(err)
	}
	if err := service.DeleteEdgeAccess(ctx, edgeTestOwner, created.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("second delete = %v", err)
	}
}

func TestEdgeAccessHeadersReachServerPathProbeAndGateway(t *testing.T) {
	var seen []http.Header
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = append(seen, r.Header.Clone())
		if r.URL.Path == "/api/capabilities" {
			_, _ = w.Write([]byte(`{"token":{"scope":"read"}}`))
			return
		}
		if r.URL.Path == "/api/routes" {
			_, _ = w.Write([]byte(`{"routes":[{"method":"GET","path":"/api/read","access":"read"}]}`))
			return
		}
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer upstream.Close()
	service := edgeTestService(t)
	service.Extensions = externalaccounts.NewExtensionTestClient(upstream.Client())
	ctx := context.Background()
	host := parse(t, upstream.URL).Hostname()
	if _, err := service.CreateEdgeAccess(ctx, edgeTestOwner, store.EdgeAccessInput{
		Label: "root", Provider: store.EdgeAccessProviderCloudflareAccess, Match: store.EdgeAccessMatch{Host: host},
		ClientID: "root-id", ClientSecret: "root-secret",
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := service.CreateEdgeAccess(ctx, edgeTestOwner, store.EdgeAccessInput{
		Label: "api", Provider: store.EdgeAccessProviderCloudflareAccess, Match: store.EdgeAccessMatch{Host: host, PathPrefix: "/api"},
		ClientID: "api-id", ClientSecret: "api-secret",
	}); err != nil {
		t.Fatal(err)
	}
	descriptor := edgeTestDescriptor(upstream.URL)
	if _, err := service.ProbeExtensionInstance(ctx, edgeTestOwner, descriptor, store.ConnectorServerHeldInstanceInput{
		Label: "Acme", Fields: map[string]string{"baseUrl": upstream.URL, "token": "service-token"},
	}, nil); err != nil {
		t.Fatal(err)
	}
	response, err := service.DoExtensionRequest(ctx, edgeTestApp(t, descriptor, upstream.URL, "server"), "", http.MethodGet, "/api/read", nil,
		http.Header{"Cf-Access-Client-Id": {"spoofed"}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	_ = response.Body.Close()
	if len(seen) != 3 {
		t.Fatalf("upstream saw %d requests", len(seen))
	}
	for index, header := range seen {
		if header.Get("Cf-Access-Client-Id") != "api-id" || header.Get("Cf-Access-Client-Secret") != "api-secret" {
			t.Errorf("request %d headers = %v", index, header)
		}
		if index < 2 && header.Get("Authorization") != "Bearer service-token" {
			t.Errorf("request %d lost the connector token: %v", index, header)
		}
	}
	list, _ := service.ListEdgeAccess(ctx, edgeTestOwner)
	for _, item := range list.Credentials {
		if item.Label == "api" && item.LastUsedAt == "" {
			t.Error("lastUsedAt not recorded")
		}
	}
	if _, err := service.DoExtensionRequest(ctx, edgeTestApp(t, descriptor, upstream.URL, "server"), "", http.MethodGet, "/api/read", nil, nil, nil); err != nil {
		t.Fatal(err)
	}
	other := edgeTestApp(t, descriptor, upstream.URL, "server")
	other.OwnerUserID = "someone_else"
	seen = nil
	if _, err := service.DoExtensionRequest(ctx, other, "", http.MethodGet, "/api/read", nil, nil, nil); err != nil {
		t.Fatal(err)
	}
	if got := seen[0].Get("Cf-Access-Client-Id"); got != "" {
		t.Fatalf("another owner's request carried %q", got)
	}
}

func TestEdgeAccessHeadersReachDevicePath(t *testing.T) {
	service := edgeTestService(t)
	ctx := context.Background()
	if _, err := service.CreateEdgeAccess(ctx, edgeTestOwner, store.EdgeAccessInput{
		Label: "dev", Provider: store.EdgeAccessProviderCloudflareAccess, Match: store.EdgeAccessMatch{Host: "olk.example.com"},
		ClientID: "dev-id", ClientSecret: "dev-secret",
	}); err != nil {
		t.Fatal(err)
	}
	var handed externalaccounts.ExtensionDeviceHTTPRequest
	service.ExtensionDeviceRequest = func(_ context.Context, deviceID string, request externalaccounts.ExtensionDeviceHTTPRequest) (externalaccounts.ExtensionDeviceHTTPResponse, error) {
		handed = request
		return externalaccounts.ExtensionDeviceHTTPResponse{Status: 200, Headers: http.Header{}, Body: []byte(`{}`)}, nil
	}
	descriptor := edgeTestDescriptor("https://olk.example.com")
	response, err := service.DoExtensionRequest(ctx, edgeTestApp(t, descriptor, "https://olk.example.com", "device"), "dev_1", http.MethodGet, "/api/read", nil, nil, bytes.NewReader(nil))
	if err != nil {
		t.Fatal(err)
	}
	_ = response.Body.Close()
	if handed.URL != "https://olk.example.com/api/read" || handed.Headers["Cf-Access-Client-Id"] != "dev-id" || handed.Headers["Cf-Access-Client-Secret"] != "dev-secret" {
		t.Fatalf("device request = %+v", handed)
	}
}

func TestCloudflareAccessRedirectIsEdgeAccessRequired(t *testing.T) {
	accessURL := "https://windeng.cloudflareaccess.com/cdn-cgi/access/login/olk.example.com?kid=abc"
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, accessURL, http.StatusFound)
	}))
	defer upstream.Close()
	service := edgeTestService(t)
	service.Extensions = externalaccounts.NewExtensionTestClient(upstream.Client())
	ctx := context.Background()
	descriptor := edgeTestDescriptor(upstream.URL)

	check := func(name string, err error, host, path string) {
		t.Helper()
		var probeErr *externalaccounts.ExtensionProbeError
		if !errors.As(err, &probeErr) || probeErr.Class != "edge_access_required" || probeErr.EdgeAccess == nil {
			t.Fatalf("%s: err = %v", name, err)
		}
		edge := probeErr.EdgeAccess
		if edge.Team != "windeng" || edge.Provider != store.EdgeAccessProviderCloudflareAccess || edge.Host != host || edge.Path != path {
			t.Errorf("%s: edge = %+v", name, edge)
		}
		if !strings.Contains(probeErr.Message, "Cloudflare Access (team windeng)") || !strings.Contains(probeErr.Message, "edge access credential") {
			t.Errorf("%s: message = %q", name, probeErr.Message)
		}
	}
	_, err := service.ProbeExtensionInstance(ctx, edgeTestOwner, descriptor, store.ConnectorServerHeldInstanceInput{
		Label: "Acme", Fields: map[string]string{"baseUrl": upstream.URL, "token": "t"},
	}, nil)
	check("server probe", err, parse(t, upstream.URL).Hostname(), "/api/capabilities")

	service.ExtensionDeviceRequest = func(context.Context, string, externalaccounts.ExtensionDeviceHTTPRequest) (externalaccounts.ExtensionDeviceHTTPResponse, error) {
		return externalaccounts.ExtensionDeviceHTTPResponse{Status: 302, Headers: http.Header{"Location": {accessURL}}}, nil
	}
	service.ExtensionDevices = func(context.Context, string, string) ([]externalaccounts.ExtensionDeviceCandidate, error) {
		return nil, nil
	}
	_, err = service.DoExtensionRequest(ctx, edgeTestApp(t, descriptor, "https://olk.example.com", "device"), "dev_1", http.MethodGet, "/api/routes", nil, nil, nil)
	check("device gateway", err, "olk.example.com", "/api/routes")

	// A stored credential that Access still bounces is reported as rejected.
	if _, err := service.CreateEdgeAccess(ctx, edgeTestOwner, store.EdgeAccessInput{
		Label: "stale", Provider: store.EdgeAccessProviderCloudflareAccess, Match: store.EdgeAccessMatch{Host: "olk.example.com"},
		ClientID: "stale-id", ClientSecret: "stale-secret",
	}); err != nil {
		t.Fatal(err)
	}
	_, err = service.DoExtensionRequest(ctx, edgeTestApp(t, descriptor, "https://olk.example.com", "device"), "dev_1", http.MethodGet, "/api/routes", nil, nil, nil)
	var probeErr *externalaccounts.ExtensionProbeError
	if !errors.As(err, &probeErr) || probeErr.EdgeAccess == nil || probeErr.EdgeAccess.CredentialID == "" || !strings.Contains(probeErr.Message, "rejected") {
		t.Fatalf("stale credential error = %v", err)
	}
	if strings.Contains(probeErr.Message, "stale-secret") || strings.Contains(probeErr.Message, "stale-id") {
		t.Fatalf("message leaks the credential: %q", probeErr.Message)
	}
}

func TestEdgeAccessSecretsAreRedactedFromUpstreamErrors(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		_, _ = io.WriteString(w, `{"error":{"code":"denied","message":"bad `+r.Header.Get("Cf-Access-Client-Secret")+` for `+r.Header.Get("Cf-Access-Client-Id")+`"}}`)
	}))
	defer upstream.Close()
	service := edgeTestService(t)
	service.Extensions = externalaccounts.NewExtensionTestClient(upstream.Client())
	ctx := context.Background()
	if _, err := service.CreateEdgeAccess(ctx, edgeTestOwner, store.EdgeAccessInput{
		Label: "leaky", Provider: store.EdgeAccessProviderCloudflareAccess, Match: store.EdgeAccessMatch{Host: parse(t, upstream.URL).Hostname()},
		ClientID: "leaky-id-123", ClientSecret: "leaky-secret-456",
	}); err != nil {
		t.Fatal(err)
	}
	_, err := service.ProbeExtensionInstance(ctx, edgeTestOwner, edgeTestDescriptor(upstream.URL), store.ConnectorServerHeldInstanceInput{
		Label: "Acme", Fields: map[string]string{"baseUrl": upstream.URL, "token": "t"},
	}, nil)
	if err == nil {
		t.Fatal("expected the 403 to fail the probe")
	}
	if strings.Contains(err.Error(), "leaky-secret-456") || strings.Contains(err.Error(), "leaky-id-123") {
		t.Fatalf("error leaks the credential: %v", err)
	}
}
