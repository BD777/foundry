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
	ok := f.server.validExtensionProbeDevice(recorder, request, f.aliceID, store.ConnectorDescriptor{Kind: "acme-api"}, store.ConnectorServerHeldInstanceInput{
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
