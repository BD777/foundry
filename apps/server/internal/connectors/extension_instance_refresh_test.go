package connectors

import (
	"context"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/externalaccounts"
	"github.com/foundry-dev/foundry/apps/server/internal/sqlitestore"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// An instance created under extension v1 re-derives its descriptor-derived
// metadata from the installed v2 with no person action (DEV-243): the write
// pointer v2 declares is what the gateway reads, while the instance's own
// data (fields, account, network, device binding) and the route directory
// its probe validated stay.
func TestExtensionInstanceFollowsAnUpgradedDescriptor(t *testing.T) {
	ctx := context.Background()
	st, err := sqlitestore.OpenWithOptions(filepath.Join(t.TempDir(), "db"), sqlitestore.Options{SecretKeyPath: filepath.Join(t.TempDir(), "key")})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/capabilities":
			_, _ = w.Write([]byte(`{"version":"2026.1","token":{"scope":"full"}}`))
		case "/api/accounts":
			_, _ = w.Write([]byte(`{"accounts":[{"id":"42","name":"Ada"}]}`))
		case "/api/routes":
			_, _ = w.Write([]byte(`{"version":"2026.1","routes":[
				{"method":"POST","path":"/api/messages/:messageId/replies","access":"write","domain":"messages"}
			]}`))
		default:
			_, _ = w.Write([]byte(`{"ok":true}`))
		}
	}))
	t.Cleanup(upstream.Close)

	v1 := acmeExtensionDescriptor()
	service := externalaccounts.NewService(st, st, externalaccounts.NewRegistry())
	service.Extensions = externalaccounts.NewExtensionTestClient(upstream.Client())
	instance, err := service.CreateExtensionInstance(ctx, "alice", v1, store.ConnectorServerHeldInstanceInput{
		Label: "Acme production", Fields: map[string]string{"baseUrl": upstream.URL, "readToken": "fixture-secret", "account": "42"},
	})
	if err != nil {
		t.Fatal(err)
	}
	app, err := st.GetExternalProviderApp(ctx, instance.ID)
	if err != nil {
		t.Fatal(err)
	}
	before, err := service.ExtensionData(ctx, app)
	if err != nil {
		t.Fatal(err)
	}
	if before.Descriptor.Extension.Version != "1.0.0" || len(before.Descriptor.ServerHeld.Writes) != 0 {
		t.Fatalf("v1 instance = %+v", before.Descriptor.Extension)
	}

	// The installed extension is upgraded. Nothing about the instance is
	// touched here: no check, no person action.
	v2 := acmeExtensionDescriptor()
	v2.Extension.Version = "1.1.0"
	v2.ServerHeld.Writes = []store.ConnectorServerHeldWrite{{
		Method: "POST", Path: "/api/messages/:messageId/replies", CreatedMessageID: "/messageId",
	}}
	service.ExtensionDescriptor = func(context.Context, string, string) (store.ConnectorDescriptor, error) {
		return v2, nil
	}

	after, err := service.ExtensionData(ctx, app)
	if err != nil {
		t.Fatal(err)
	}
	if after.Descriptor.Extension.Version != "1.1.0" || len(after.Descriptor.ServerHeld.Writes) != 1 {
		t.Fatalf("v2 instance did not follow the installed descriptor: %+v", after.Descriptor)
	}
	// Instance data is untouched.
	if after.Values["baseUrl"] != upstream.URL || after.Values["account"] != "42" ||
		after.Network != before.Network || after.ProbeDeviceID != before.ProbeDeviceID ||
		len(after.Routes) != len(before.Routes) || after.Version != before.Version {
		t.Fatalf("instance data changed: before %+v, after %+v", before, after)
	}
	accounts, err := st.ListExternalAccounts(ctx, "alice")
	if err != nil || len(accounts) != 1 || accounts[0].AppID != instance.ID || accounts[0].Status != store.ExternalAccountReady {
		t.Fatalf("account = %+v (%v)", accounts, err)
	}
	// The refreshed snapshot is what the next reader sees, before the
	// resolver is even consulted again.
	service.ExtensionDescriptor = nil
	stored, err := st.GetExternalProviderApp(ctx, instance.ID)
	if err != nil {
		t.Fatal(err)
	}
	persisted, err := service.ExtensionData(ctx, stored)
	if err != nil || persisted.Descriptor.Extension.Version != "1.1.0" || len(persisted.Descriptor.ServerHeld.Writes) != 1 {
		t.Fatalf("persisted instance = %+v (%v)", persisted.Descriptor, err)
	}
}
