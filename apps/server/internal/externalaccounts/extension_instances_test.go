package externalaccounts

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func extensionTestDescriptor(baseURL string) store.ConnectorDescriptor {
	return store.ConnectorDescriptor{
		Kind: "acme-api", Label: "Acme API", Holding: store.ConnectorServerHeld,
		Adapter: "extension:acme", Extension: &store.ConnectorExtensionSource{ID: "acme", Name: "Acme", Version: "1.0.0"},
		Tool: store.ConnectorTool{Command: "acme", Source: "device"},
		ServerHeld: &store.ConnectorServerHeldSpec{
			Instances: "many",
			Fields: []store.ConnectorField{
				{ID: "baseUrl", Type: "url", Required: true, Label: "URL", Default: baseURL},
				{ID: "token", Type: "secret", Required: true, Label: "Token"},
				{ID: "account", Type: "select", Label: "Account", OptionsFrom: "probe:accounts"},
			},
			Steps: []store.ConnectorServerHeldStep{{"baseUrl", "token"}, {"account"}},
			Probe: []store.ConnectorServerHeldProbe{
				{
					ID: "capabilities", Method: "GET", Path: "/api/capabilities",
					Extract: store.ConnectorServerHeldProbeExtract{
						Values: map[string]string{"scope": "/token/scope"},
					},
				},
				{
					ID: "accounts", Method: "GET", Path: "/api/accounts",
					Extract: store.ConnectorServerHeldProbeExtract{
						Options: store.ConnectorServerHeldOptionsExtract{Items: "/accounts", Value: "/id", Label: "/name"},
					},
				},
				{
					ID: "routes", Method: "GET", Path: "/api/routes",
					Extract: store.ConnectorServerHeldProbeExtract{
						Routes: store.ConnectorServerHeldRoutesExtract{Items: "/routes", Method: "/method", Path: "/path", Access: "/access"},
					},
				},
			},
			Upstream: store.ConnectorServerHeldUpstream{
				BaseField: "baseUrl", PathPrefix: "/api",
				Headers: map[string]string{"Authorization": "Bearer {secret:token}"},
			},
			Access: store.ConnectorServerHeldAccess{
				From: "probe:routes", Default: "deny",
				AllowBy: store.ConnectorServerHeldAccessBy{
					Value: "probe:capabilities/scope",
					Map: map[string]store.ConnectorServerHeldAccessLevels{
						"full": {"read", "write"},
						"read": {"read"},
					},
					Otherwise: store.ConnectorServerHeldAccessLevels{"read"},
				},
			},
			Session: store.ConnectorServerHeldSession{Env: map[string]string{
				"ACME_TOKEN":     "{standIn}",
				"ACME_READ_ONLY": "{probeMap:capabilities/scope|full=0|*=1}",
			}},
			Network: store.ConnectorServerHeldNetwork{Holdings: []string{"server", "device"}, PublicOnly: true},
		},
	}
}

func TestExtensionSSRFGuardRejectsPrivateAndNonHTTPSAddresses(t *testing.T) {
	client := &ExtensionClient{}
	for _, raw := range []string{"https://10.37.93.185", "https://169.254.169.254"} {
		_, err := client.endpoint(context.Background(), raw)
		var probeErr *ExtensionProbeError
		if !errors.As(err, &probeErr) || probeErr.Class != "ssrf_blocked" ||
			!strings.Contains(probeErr.Message, "Choose 'Via a device'") {
			t.Errorf("%s error = %v", raw, err)
		}
	}
	for _, raw := range []string{
		"https://127.0.0.1",
		"https://[::1]",
		"http://example.com",
		"https://user:pass@example.com",
		"https://example.com/api?x=1",
		"https://example.com/api/../admin",
	} {
		if _, err := client.endpoint(context.Background(), raw); err == nil {
			t.Errorf("accepted %s", raw)
		}
	}
	if _, err := client.endpoint(context.Background(), "https://example.com/api?x=1"); err == nil ||
		!strings.Contains(err.Error(), "query string") {
		t.Fatalf("query error = %v", err)
	}
}

func TestDeviceNetworkProbePreservesPathAndRunsOnSelectedDevice(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer fixture-secret" {
			http.Error(w, "missing credential", http.StatusUnauthorized)
			return
		}
		switch r.URL.Path {
		case "/openlark/api/capabilities":
			_, _ = w.Write([]byte(`{"token":{"scope":"read"}}`))
		case "/openlark/api/accounts":
			_, _ = w.Write([]byte(`{"accounts":[{"id":"42","name":"Ada"}]}`))
		case "/openlark/api/routes":
			_, _ = w.Write([]byte(`{"routes":[{"method":"GET","path":"/api/read","access":"read"}]}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer upstream.Close()

	service := NewService(nil, nil, NewRegistry())
	var usedDevice string
	service.ExtensionDeviceRequest = func(ctx context.Context, deviceID string, request ExtensionDeviceHTTPRequest) (ExtensionDeviceHTTPResponse, error) {
		usedDevice = deviceID
		req, err := http.NewRequestWithContext(ctx, request.Method, request.URL, bytes.NewReader(request.Body))
		if err != nil {
			return ExtensionDeviceHTTPResponse{}, err
		}
		for name, value := range request.Headers {
			req.Header.Set(name, value)
		}
		response, err := upstream.Client().Do(req)
		if err != nil {
			return ExtensionDeviceHTTPResponse{}, err
		}
		defer response.Body.Close()
		body, err := io.ReadAll(response.Body)
		return ExtensionDeviceHTTPResponse{
			Status: response.StatusCode, Headers: response.Header.Clone(), Body: body,
		}, err
	}
	service.ExtensionDevices = func(context.Context, string, string) ([]ExtensionDeviceCandidate, error) {
		return []ExtensionDeviceCandidate{{ID: "byte-dev", Name: "byte-dev", Online: true, Installed: true}}, nil
	}
	descriptor := extensionTestDescriptor(upstream.URL + "/openlark")
	result, err := service.ProbeExtensionInstance(context.Background(), "owner_1", descriptor, store.ConnectorServerHeldInstanceInput{
		Label: "OpenLark intranet", Network: ExtensionNetworkDevice, DeviceID: "byte-dev",
		Fields: map[string]string{"baseUrl": upstream.URL + "/openlark", "token": "fixture-secret", "account": "42"},
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if usedDevice != "byte-dev" || result.Network != ExtensionNetworkDevice ||
		result.RouteCount != 1 || len(result.AvailableDevices) != 1 {
		t.Fatalf("device probe = %+v, device = %q", result, usedDevice)
	}
}

func TestExtensionProbeExtractsOptionsRoutesAndClassifiesRedirect(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/capabilities":
			_, _ = w.Write([]byte(`{"token":{"scope":"read"}}`))
		case "/api/accounts":
			_, _ = w.Write([]byte(`{"accounts":[{"id":"42","name":"Ada"}]}`))
		case "/api/routes":
			_, _ = w.Write([]byte(`{"routes":[{"method":"POST","path":"/api/search","access":"read"}]}`))
		case "/redirect":
			http.Redirect(w, r, "/somewhere", http.StatusFound)
		default:
			http.NotFound(w, r)
		}
	}))
	defer upstream.Close()
	service := NewService(nil, nil, NewRegistry())
	service.Extensions = NewExtensionTestClient(upstream.Client())
	descriptor := extensionTestDescriptor(upstream.URL)
	result, err := service.ProbeExtensionInstance(context.Background(), "owner_1", descriptor, store.ConnectorServerHeldInstanceInput{
		Label: "Acme", Fields: map[string]string{"baseUrl": upstream.URL, "token": "secret", "account": "42"},
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if result.RouteCount != 1 || result.ProbeValues["capabilities/scope"] != "read" ||
		len(result.FieldOptions["account"]) != 1 || result.FieldOptions["account"][0].Value != "42" {
		t.Fatalf("probe = %+v", result)
	}

	redirect := extensionTestDescriptor(upstream.URL)
	redirect.ServerHeld.Probe = []store.ConnectorServerHeldProbe{{
		ID: "routes", Method: "GET", Path: "/redirect",
		Extract: store.ConnectorServerHeldProbeExtract{
			Routes: store.ConnectorServerHeldRoutesExtract{Items: "/routes", Method: "/method", Path: "/path", Access: "/access"},
		},
	}}
	redirect.ServerHeld.Access.From = "probe:routes"
	_, err = service.ProbeExtensionInstance(context.Background(), "owner_1", redirect, store.ConnectorServerHeldInstanceInput{
		Label: "Acme", Fields: map[string]string{"baseUrl": upstream.URL, "token": "secret"},
	}, nil)
	var probeErr *ExtensionProbeError
	if !errors.As(err, &probeErr) || probeErr.Class != "redirect_refused" {
		t.Fatalf("redirect probe = %v", err)
	}
}
