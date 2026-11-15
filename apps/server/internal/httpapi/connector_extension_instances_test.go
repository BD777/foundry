package httpapi

import (
	"context"
	"encoding/json"
	"errors"
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

func TestDeleteServerHeldExtensionInstanceIsOwnerOnlyAndKeepsAudit(t *testing.T) {
	f := newExternalAccountsFixture(t)
	httpServer := httptest.NewServer(f.handler)
	defer httpServer.Close()
	worker := &fakeConnectorWorker{t: t, reportedConnectors: []any{acmeServerHeldExtension()}}
	worker.connect(httpServer.URL, f.aliceDevice)
	defer worker.disconnect()
	waitFor(t, "the extension device to report Acme", func() bool {
		_, err := f.server.connectors.Devices.ServerHeldDescriptorForOwner(context.Background(), f.aliceID, "acme-api")
		return err == nil
	})

	ctx := context.Background()
	descriptor, err := f.server.connectors.Devices.ServerHeldDescriptorForOwner(ctx, f.aliceID, "acme-api")
	if err != nil {
		t.Fatal(err)
	}
	create := func(label string, status store.ExternalAccountStatus) (store.ExternalProviderApp, store.ExternalAccount) {
		t.Helper()
		raw, err := json.Marshal(store.ExtensionInstanceData{
			Descriptor: descriptor, Values: map[string]string{"baseUrl": "https://acme.example", "account": "42"},
			Network: store.ConnectorServerHeldNetworkPath(externalaccounts.ExtensionNetworkServer),
		})
		if err != nil {
			t.Fatal(err)
		}
		app, err := f.db.CreateExternalProviderApp(ctx, store.ExternalProviderApp{
			ID: "xapp_" + strings.ReplaceAll(label, " ", "_"), Provider: descriptor.Kind, OwnerUserID: f.aliceID,
			Visibility: store.ExternalAppPersonal, Label: label, CreatedVia: "extension", ExtensionData: string(raw),
		})
		if err != nil {
			t.Fatal(err)
		}
		account, err := f.db.SaveExternalAccount(ctx, store.ExternalAccount{
			ID: "xacc_" + strings.ReplaceAll(label, " ", "_"), AppID: app.ID, Provider: descriptor.Kind,
			OwnerUserID: f.aliceID, Label: label, Mode: store.ExternalCredentialServerHeld, Status: status,
		})
		if err != nil {
			t.Fatal(err)
		}
		return app, account
	}

	revokedApp, revokedAccount := create("revoked delete", store.ExternalAccountRevoked)
	if err := f.db.SetWorkspaceExternalAccounts(ctx, "ws_alice", f.aliceID, []string{revokedAccount.ID}); err != nil {
		t.Fatal(err)
	}
	for _, event := range []store.ExternalAccountEvent{
		{AccountID: revokedAccount.ID, Kind: "extension_instance_added"},
		{AccountID: revokedAccount.ID, Kind: "extension_instance_revoked"},
	} {
		if err := f.db.AppendExternalAccountEvent(ctx, event); err != nil {
			t.Fatal(err)
		}
	}

	path := "/api/connectors/extensions/acme-api/instances/" + revokedApp.ID + "/delete"
	expectStatus(t, doAuthCall(t, f.handler, f.as(f.bob, http.MethodPost, path, "")), http.StatusNotFound, "another owner's instance")
	expectStatus(t, doAuthCall(t, f.handler, f.as(f.alice, http.MethodPost, path, "")), http.StatusOK, "delete a revoked instance")
	if _, err := f.db.GetExternalProviderApp(ctx, revokedApp.ID); !errors.Is(err, store.ErrExternalAppNotFound) {
		t.Fatalf("deleted app = %v", err)
	}
	if _, err := f.db.GetExternalAccount(ctx, revokedAccount.ID); !errors.Is(err, store.ErrExternalAccountNotFound) {
		t.Fatalf("deleted account = %v", err)
	}
	bindings, err := f.db.ListWorkspaceExternalAccounts(ctx, "ws_alice")
	if err != nil {
		t.Fatal(err)
	}
	for _, binding := range bindings {
		if binding.AccountID == revokedAccount.ID {
			t.Fatalf("binding survived deletion: %+v", bindings)
		}
	}
	events, err := f.db.ListExternalAccountEvents(ctx, revokedAccount.ID, 20)
	if err != nil || len(events) != 3 {
		t.Fatalf("audit after deletion = %+v (%v)", events, err)
	}
	if events[0].Kind != "extension_instance_deleted" {
		t.Fatalf("latest audit = %+v", events)
	}

	readyApp, _ := create("still ready", store.ExternalAccountReady)
	readyPath := "/api/connectors/extensions/acme-api/instances/" + readyApp.ID + "/delete"
	response := doAuthCall(t, f.handler, f.as(f.alice, http.MethodPost, readyPath, ""))
	expectStatus(t, response, http.StatusConflict, "delete only after revocation")
	if _, err := f.db.GetExternalProviderApp(ctx, readyApp.ID); err != nil {
		t.Fatalf("ready instance was removed: %v", err)
	}
}
