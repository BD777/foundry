package httpapi

import (
	"encoding/json"
	"net/http"
	"os"
	"strings"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/sqlitestore"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func TestEdgeAccessAPIIsPrivateAndNeverReturnsSecrets(t *testing.T) {
	dir := t.TempDir()
	db, err := sqlitestore.OpenWithOptions(dir+"/foundry.db", sqlitestore.Options{SecretKeyPath: dir + "/secret.key"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	server := NewServerWithOptions(db, ServerOptions{AllowedOrigin: accountsTestOrigin})
	shutDownAtCleanup(t, server)
	f := newIsolationFixtureOn(t, server, server.Routes())
	body := `{"label":"OpenLark","provider":"cloudflare_access","match":{"host":"Olk.Example.com","pathPrefix":"/agent/v1"},"clientId":"api-test-client-id","clientSecret":"api-test-client-secret"}`
	created := doAuthCall(t, f.handler, f.as(f.alice, http.MethodPost, "/api/edge-access", body))
	expectStatus(t, created, http.StatusCreated, "alice creates an edge credential")
	var item store.EdgeAccess
	if err := json.Unmarshal(created.Body.Bytes(), &item); err != nil || item.ID == "" || item.Match.Host != "olk.example.com" {
		t.Fatalf("created = %s (%v)", created.Body.String(), err)
	}
	for _, response := range []string{created.Body.String(), doAuthCall(t, f.handler, f.as(f.alice, http.MethodGet, "/api/edge-access", "")).Body.String()} {
		if strings.Contains(response, "api-test-client") {
			t.Fatalf("response exposes a credential: %s", response)
		}
	}
	bobList := doAuthCall(t, f.handler, f.as(f.bob, http.MethodGet, "/api/edge-access", ""))
	expectStatus(t, bobList, http.StatusOK, "bob lists")
	if strings.Contains(bobList.Body.String(), item.ID) {
		t.Fatalf("bob sees alice's credential: %s", bobList.Body.String())
	}
	expectStatus(t, doAuthCall(t, f.handler, f.as(f.bob, http.MethodDelete, "/api/edge-access/"+item.ID, "")), http.StatusNotFound, "bob deletes alice's")
	expectStatus(t, doAuthCall(t, f.handler, f.as(f.alice, http.MethodPost, "/api/edge-access", body)), http.StatusConflict, "duplicate address")
	expectStatus(t, doAuthCall(t, f.handler, f.as(f.alice, http.MethodPut, "/api/edge-access/"+item.ID,
		`{"label":"Renamed","provider":"cloudflare_access","match":{"host":"olk.example.com"}}`)), http.StatusOK, "alice replaces")
	expectStatus(t, doAuthCall(t, f.handler, f.as(f.alice, http.MethodDelete, "/api/edge-access/"+item.ID, "")), http.StatusNoContent, "alice deletes")
}

func TestOpenLarkDescriptorNoLongerCarriesCloudflareAccessFields(t *testing.T) {
	f := newIsolationFixture(t)
	rawManifest, err := os.ReadFile("../../../../extensions/open-lark/foundry-extension.json")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(rawManifest), "accessClient") || strings.Contains(string(rawManifest), "Cf-Access") {
		t.Fatal("the OpenLark descriptor still names Cloudflare Access fields or headers")
	}
	var manifest struct {
		Connectors []map[string]any `json:"connectors"`
	}
	if err := json.Unmarshal(rawManifest, &manifest); err != nil {
		t.Fatal(err)
	}
	descriptor := manifest.Connectors[0]
	descriptor["holding"] = store.ConnectorServerHeld
	descriptor["adapter"] = "extension:open-lark"
	descriptor["extension"] = map[string]any{"id": "open-lark", "name": "OpenLark", "version": "1.3.0"}
	var body map[string]any
	if err := json.Unmarshal([]byte(registrationBody("dev_alice", "ws_alice")), &body); err != nil {
		t.Fatal(err)
	}
	body["device"].(map[string]any)["connectors"] = []any{descriptor}
	raw, _ := json.Marshal(body)
	registerDeviceForTest(t, f.server, string(raw))
	recorder := doAuthCall(t, f.handler, f.as(f.alice, http.MethodGet, "/api/connectors/devices", ""))
	expectStatus(t, recorder, http.StatusOK, "GET /api/connectors/devices")
	var view store.DeviceConnectorsView
	if err := json.Unmarshal(recorder.Body.Bytes(), &view); err != nil {
		t.Fatal(err)
	}
	if len(view.Devices) != 1 || len(view.Devices[0].ExtensionErrors) != 0 {
		t.Fatalf("the descriptor was refused: %+v", view.Devices)
	}
}
