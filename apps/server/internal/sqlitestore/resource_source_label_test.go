package sqlitestore

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// The Resources page names a device as Foundry does, not by the hostname
// its worker reported with the inventory.
func TestResourceSourcesUseTheDevicesFoundryName(t *testing.T) {
	ctx := context.Background()
	db := openTestStore(t, filepath.Join(t.TempDir(), "foundry.db"))
	registration := registrationInput(t, "ws_label", "label")
	deviceID := registration.Device.ID
	if err := db.RegisterDaemon(ctx, registration); err != nil {
		t.Fatalf("register: %v", err)
	}
	if _, err := db.RenameDevice(ctx, deviceID, "mac-laptop"); err != nil {
		t.Fatalf("rename: %v", err)
	}
	if err := db.ReplaceSourceResources(ctx, store.ResourceSourceStatus{Kind: "device", ID: deviceID, Label: "CX4454F7JQ", Online: true},
		[]store.ResourceInstance{{ID: "res_label", Key: "gpu/0", Type: "gpu", Platform: "linux", Name: "GPU", State: store.ResourceAvailable}}); err != nil {
		t.Fatalf("resources: %v", err)
	}
	instances, err := db.ListResourceInstances(ctx, store.ResourceFilter{})
	if err != nil || len(instances) != 1 || instances[0].Source.Label != "mac-laptop" {
		t.Fatalf("instances = %+v, %v; want source label mac-laptop", instances, err)
	}
	sources, err := db.ListResourceSources(ctx)
	if err != nil || len(sources) != 1 || sources[0].Label != "mac-laptop" {
		t.Fatalf("sources = %+v, %v; want label mac-laptop", sources, err)
	}
}
