package httpapi

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"os"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/externalaccounts"
	"github.com/foundry-dev/foundry/apps/server/internal/feishu"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// bundledOpenLarkReport is the shipped open-lark manifest's connector as the
// Worker reports it: installed as the bundled extension.
func bundledOpenLarkReport(t *testing.T) map[string]any {
	t.Helper()
	raw, err := os.ReadFile("../../../../extensions/open-lark/foundry-extension.json")
	if err != nil {
		t.Fatal(err)
	}
	var manifest struct {
		Connectors []map[string]any `json:"connectors"`
	}
	if err := json.Unmarshal(raw, &manifest); err != nil {
		t.Fatal(err)
	}
	connector := manifest.Connectors[0]
	connector["adapter"] = "extension:open-lark"
	connector["holding"] = string(store.ConnectorServerHeld)
	connector["extension"] = map[string]any{"id": "open-lark", "name": "OpenLark", "version": "1.6.6", "bundled": true, "state": "installed"}
	if tool, ok := connector["tool"].(map[string]any); ok && tool["source"] == nil {
		tool["source"] = "device"
	}
	return connector
}

// TestNoticeInstancesListEveryExtensionInstanceWithItsReason covers the setting's
// list: every extension instance the person has is listed with what blocks its
// notices, a stale descriptor snapshot is brought up to the installed extension,
// and pasted or other people's apps are left out.
func TestNoticeInstancesListEveryExtensionInstanceWithItsReason(t *testing.T) {
	f := newExternalAccountsFixture(t)
	// The fixture swaps in its own Feishu-only service; production wires the
	// installed-descriptor resolver on the service it builds (connectors.New).
	f.server.connectors.ServerHeld.ExtensionDescriptor = f.server.connectors.Devices.ServerHeldDescriptorForOwner
	httpServer := httptest.NewServer(f.handler)
	defer httpServer.Close()
	openLark := bundledOpenLarkReport(t)
	workerDeviceID := "dev_alice"
	worker := &fakeConnectorWorker{t: t, reportedConnectors: []any{acmeServerHeldExtension(), openLark}}
	worker.connect(httpServer.URL, f.aliceDevice)
	defer worker.disconnect()
	ctx := context.Background()
	waitFor(t, "the device to report OpenLark and Acme", func() bool {
		_, openErr := f.server.connectors.Devices.ServerHeldDescriptorForOwner(ctx, f.aliceID, "openlark")
		_, acmeErr := f.server.connectors.Devices.ServerHeldDescriptorForOwner(ctx, f.aliceID, "acme-api")
		return openErr == nil && acmeErr == nil
	})
	waitFor(t, "the device connection to be held", func() bool {
		return f.server.hub.HasConnection(workerDeviceID)
	})

	current, err := f.server.connectors.Devices.ServerHeldDescriptorForOwner(ctx, f.aliceID, "openlark")
	if err != nil {
		t.Fatal(err)
	}
	acme, err := f.server.connectors.Devices.ServerHeldDescriptorForOwner(ctx, f.aliceID, "acme-api")
	if err != nil {
		t.Fatal(err)
	}
	// A 1.6.5-era snapshot: the same connector without its notify section.
	stale := current
	staleServerHeld := *current.ServerHeld
	staleServerHeld.Notify = nil
	stale.ServerHeld = &staleServerHeld

	create := func(id, owner, createdVia, kind string, descriptor store.ConnectorDescriptor, network string, devices []store.ConnectorServerHeldDeviceCheck) {
		t.Helper()
		raw := ""
		if createdVia == "extension" {
			encoded, err := json.Marshal(store.ExtensionInstanceData{
				Descriptor: descriptor, Values: map[string]string{"baseUrl": "http://127.0.0.1:8081", "account": "1"},
				Network: store.ConnectorServerHeldNetworkPath(network), AvailableDevices: devices,
			})
			if err != nil {
				t.Fatal(err)
			}
			raw = string(encoded)
		}
		if _, err := f.db.CreateExternalProviderApp(ctx, store.ExternalProviderApp{
			ID: id, Provider: kind, OwnerUserID: owner, Visibility: store.ExternalAppPersonal, Label: id,
			CreatedVia: createdVia, ExtensionData: raw,
		}); err != nil {
			t.Fatal(err)
		}
	}
	reachable := []store.ConnectorServerHeldDeviceCheck{{DeviceID: workerDeviceID, Name: "alice", Status: "ok"}}
	unreachable := []store.ConnectorServerHeldDeviceCheck{{DeviceID: "dev_offline", Name: "offline", Status: "ok"}}
	create("xapp_notice_server", f.aliceID, "extension", "openlark", current, externalaccounts.ExtensionNetworkServer, nil)
	create("xapp_notice_device", f.aliceID, "extension", "openlark", current, externalaccounts.ExtensionNetworkDevice, reachable)
	create("xapp_notice_offline", f.aliceID, "extension", "openlark", current, externalaccounts.ExtensionNetworkDevice, unreachable)
	create("xapp_notice_stale", f.aliceID, "extension", "openlark", stale, externalaccounts.ExtensionNetworkServer, nil)
	create("xapp_acme", f.aliceID, "extension", "acme-api", acme, externalaccounts.ExtensionNetworkServer, nil)
	create("xapp_pasted", f.aliceID, "pasted", "feishu", store.ConnectorDescriptor{}, "", nil)
	create("xapp_bob", f.bobID, "extension", "openlark", current, externalaccounts.ExtensionNetworkServer, nil)

	instances, err := f.server.listPersonalAgentNotifyInstances(ctx, store.PersonalAgent{UserID: f.aliceID})
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]string{}
	for _, instance := range instances {
		got[instance.ConnectorInstanceID] = instance.Reason
	}
	want := map[string]string{
		feishu.NoticeSinkID:   notifyReasonFeishuNotPaired,
		"xapp_notice_server":  "",
		"xapp_notice_device":  "",
		"xapp_notice_offline": notifyReasonNoDevice,
		"xapp_notice_stale":   "",
		"xapp_acme":           notifyReasonNotNotifiable,
	}
	if len(got) != len(want) {
		t.Fatalf("listed %v, want %v", got, want)
	}
	for id, reason := range want {
		if got[id] != reason {
			t.Errorf("instance %s reason = %q, want %q", id, got[id], reason)
		}
	}

	refreshed, err := f.db.GetExternalProviderApp(ctx, "xapp_notice_stale")
	if err != nil {
		t.Fatal(err)
	}
	var data store.ExtensionInstanceData
	if err := json.Unmarshal([]byte(refreshed.ExtensionData), &data); err != nil {
		t.Fatal(err)
	}
	if data.Descriptor.ServerHeld == nil || data.Descriptor.ServerHeld.Notify == nil {
		t.Fatal("the stale snapshot was listed without taking the installed notify section")
	}
}
