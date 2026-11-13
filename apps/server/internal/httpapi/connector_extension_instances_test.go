package httpapi

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/externalaccounts"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func TestExtensionDeviceSelectionRejectsAnotherPersonsDevice(t *testing.T) {
	f := newIsolationFixture(t)
	request := httptest.NewRequest(http.MethodPost, "/api/connectors/extensions/acme-api/instances/probe", nil)
	recorder := httptest.NewRecorder()
	ok := f.server.prepareExtensionProbeDeviceRequest(recorder, request, f.aliceID, store.ConnectorDescriptor{Kind: "acme-api"}, store.ConnectorServerHeldInstanceInput{
		Network: externalaccounts.ExtensionNetworkDevice, DeviceID: f.bobDevice,
	})
	if ok || recorder.Code != http.StatusBadRequest ||
		!strings.Contains(recorder.Body.String(), "one of your own devices") {
		t.Fatalf("device selection = %t, %d %s", ok, recorder.Code, recorder.Body.String())
	}
	devices, err := f.server.extensionInstanceDevices(request.Context(), f.aliceID)
	if err != nil {
		t.Fatal(err)
	}
	for _, device := range devices {
		if device.DeviceID == f.bobDevice {
			t.Fatalf("another person's device listed: %+v", devices)
		}
	}
}

func TestExtensionInstallRequestUsesPublishedSourceOrBundledCopy(t *testing.T) {
	source := &store.ConnectorExtensionRepository{
		Git: "https://github.com/acme/tools.git", Path: "foundry-extension", Ref: "main",
	}
	request, err := connectorExtensionInstallRequest(store.ConnectorDescriptor{
		Extension: &store.ConnectorExtensionSource{
			ID: "acme", Name: "Acme tools", Version: "1.0.0", Source: source,
		},
	})
	if err != nil || request.Source == nil || request.Source.Git != source.Git || request.BundledExtensionID != "" {
		t.Fatalf("source install = %+v, %v", request, err)
	}
	bundled := true
	request, err = connectorExtensionInstallRequest(store.ConnectorDescriptor{
		Extension: &store.ConnectorExtensionSource{
			ID: "acme", Name: "Acme tools", Version: "1.0.0", Bundled: &bundled,
		},
	})
	if err != nil || request.BundledExtensionID != "acme" || request.Source != nil {
		t.Fatalf("bundled install = %+v, %v", request, err)
	}
	if _, err := connectorExtensionInstallRequest(store.ConnectorDescriptor{
		Extension: &store.ConnectorExtensionSource{ID: "acme", Name: "Acme tools", Version: "1.0.0"},
	}); err == nil || !strings.Contains(err.Error(), "local folder") {
		t.Fatalf("local-only install error = %v", err)
	}
}

func TestExtensionProbeDeviceOfflineBeforeInstall(t *testing.T) {
	f := newIsolationFixture(t)
	offlineID, _ := pairOverHTTP(t, f.handler, f.alice, "machine-alice-offline", "dev_alice_offline")
	request := httptest.NewRequest(http.MethodPost, "/api/connectors/extensions/acme-api/instances/probe", nil)
	recorder := httptest.NewRecorder()
	bundled := true
	ok := f.server.prepareExtensionProbeDeviceRequest(recorder, request, f.aliceID, store.ConnectorDescriptor{
		Kind: "acme-api", Label: "Acme API",
		Extension: &store.ConnectorExtensionSource{
			ID: "acme", Name: "Acme tools", Version: "1.0.0", Bundled: &bundled,
		},
	}, store.ConnectorServerHeldInstanceInput{
		Network: externalaccounts.ExtensionNetworkDevice, DeviceID: offlineID,
	})
	if ok || recorder.Code != http.StatusBadRequest || !strings.Contains(recorder.Body.String(), "offline") {
		t.Fatalf("offline device = %t, %d %s", ok, recorder.Code, recorder.Body.String())
	}
}
