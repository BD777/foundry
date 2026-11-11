package connectors

import (
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func acmeExtensionDescriptor() store.ConnectorDescriptor {
	return store.ConnectorDescriptor{
		Kind: "acme-api", Label: "Acme API", Holding: store.ConnectorServerHeld,
		Adapter: "extension:acme", Extension: &store.ConnectorExtensionSource{ID: "acme", Name: "Acme extensions", Version: "1.0.0"},
		Tool: store.ConnectorTool{Command: "acme", Source: "device"},
		ServerHeld: &store.ConnectorServerHeldSpec{
			Instances: "many",
			Fields: []store.ConnectorField{
				{ID: "baseUrl", Type: "url", Required: true, Label: "Server"},
				{ID: "readToken", Type: "secret", Required: true, Label: "Token"},
				{ID: "account", Type: "select", Required: false, Label: "Account", OptionsFrom: "probe:accounts"},
			},
			Steps: []store.ConnectorServerHeldStep{{"baseUrl", "readToken"}, {"account"}},
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
						Values: map[string]string{"version": "/version"},
						Routes: store.ConnectorServerHeldRoutesExtract{
							Items: "/routes", Method: "/method", Path: "/path", Access: "/access", Domain: "/domain",
						},
					},
				},
			},
			Upstream: store.ConnectorServerHeldUpstream{
				BaseField: "baseUrl", PathPrefix: "/api",
				Headers: map[string]string{
					"Authorization": "Bearer {secret:readToken}",
					"X-Account":     "{field:account}",
				},
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
				"ACME_BASE":      "{gatewayBase}",
				"ACME_TOKEN":     "{standIn}",
				"ACME_ACCOUNT":   "{field:account}",
				"ACME_READ_ONLY": "{probeMap:capabilities/scope|full=0|*=1}",
			}},
			Network: store.ConnectorServerHeldNetwork{Holdings: []string{"server", "device"}, PublicOnly: true},
		},
	}
}

func TestServerHeldExtensionDescriptorAcceptsPureData(t *testing.T) {
	descriptor := acmeExtensionDescriptor()
	if err := checkDescriptor(descriptor); err != nil {
		t.Fatal(err)
	}
	kept := DefaultCatalog().ExtensionConnectors([]store.ConnectorDescriptor{descriptor})
	if len(kept) != 1 || kept[0].Holding != store.ConnectorServerHeld || kept[0].ServerHeld == nil {
		t.Fatalf("kept = %+v", kept)
	}
}

func TestServerHeldExtensionDescriptorRejectsUnsafeTemplatesAndNetwork(t *testing.T) {
	cases := map[string]func(*store.ConnectorDescriptor){
		"secret in session env": func(descriptor *store.ConnectorDescriptor) {
			descriptor.ServerHeld.Session.Env["LEAK"] = "{secret:readToken}"
		},
		"runtime reference in header": func(descriptor *store.ConnectorDescriptor) {
			descriptor.ServerHeld.Upstream.Headers["X-Gateway"] = "{gatewayBase}"
		},
		"unknown field": func(descriptor *store.ConnectorDescriptor) {
			descriptor.ServerHeld.Session.Env["LEAK"] = "{field:nope}"
		},
		"private network": func(descriptor *store.ConnectorDescriptor) {
			descriptor.ServerHeld.Network.PublicOnly = false
		},
		"query in probe": func(descriptor *store.ConnectorDescriptor) {
			descriptor.ServerHeld.Probe[0].Path = "/api/accounts?all=1"
		},
		"unknown options probe": func(descriptor *store.ConnectorDescriptor) {
			descriptor.ServerHeld.Fields[2].OptionsFrom = "probe:nope"
		},
		"unknown access probe value": func(descriptor *store.ConnectorDescriptor) {
			descriptor.ServerHeld.Access.AllowBy.Value = "probe:capabilities/nope"
		},
		"unknown env probe value": func(descriptor *store.ConnectorDescriptor) {
			descriptor.ServerHeld.Session.Env["LEAK"] = "{probeMap:capabilities/nope|full=0|*=1}"
		},
		"both fixed and probed access": func(descriptor *store.ConnectorDescriptor) {
			descriptor.ServerHeld.Access.Allow = store.ConnectorServerHeldAccessLevels{"read"}
		},
		"extra route extraction": func(descriptor *store.ConnectorDescriptor) {
			descriptor.ServerHeld.Probe[0].Extract.Routes = descriptor.ServerHeld.Probe[2].Extract.Routes
		},
		"base field not required": func(descriptor *store.ConnectorDescriptor) {
			descriptor.ServerHeld.Fields[0].Required = false
		},
		"oversized timeout": func(descriptor *store.ConnectorDescriptor) {
			descriptor.ServerHeld.Upstream.TimeoutSeconds = 61
		},
	}
	for name, mutate := range cases {
		descriptor := acmeExtensionDescriptor()
		mutate(&descriptor)
		if err := checkDescriptor(descriptor); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}
