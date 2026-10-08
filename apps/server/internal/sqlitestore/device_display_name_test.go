package sqlitestore

import (
	"context"
	"path/filepath"
	"testing"
)

// A name given on the server survives the worker re-registering with its
// hostname, and every workspace on the device shows it.
func TestRenamedDeviceKeepsItsNameAcrossRegistrations(t *testing.T) {
	ctx := context.Background()
	db := openTestStore(t, filepath.Join(t.TempDir(), "foundry.db"))
	first := registrationInput(t, "ws_named", "first")
	if err := db.RegisterDaemon(ctx, first); err != nil {
		t.Fatalf("register: %v", err)
	}
	renamed, err := db.RenameDevice(ctx, first.Device.ID, "Work Mac")
	if err != nil {
		t.Fatalf("rename: %v", err)
	}
	if renamed.Label != "Work Mac" {
		t.Fatalf("renamed label = %q", renamed.Label)
	}
	again := registrationInput(t, "ws_named", "again")
	if err := db.RegisterDaemon(ctx, again); err != nil {
		t.Fatalf("register again: %v", err)
	}
	devices, err := db.ListDevices(ctx)
	if err != nil || len(devices) != 1 || devices[0].Label != "Work Mac" {
		t.Fatalf("devices = %+v, %v", devices, err)
	}
	workspace, err := db.GetWorkspace(ctx, "ws_named")
	if err != nil || workspace.DeviceLabel != "Work Mac" {
		t.Fatalf("workspace device label = %q, %v", workspace.DeviceLabel, err)
	}
	if _, err := db.RenameDevice(ctx, "dev_missing", "x"); err == nil {
		t.Fatal("renaming an unknown device succeeded")
	}
}

// A server starting up holds no connections, so presence left from before
// is cleared until each worker reconnects.
func TestMarkAllDevicesOfflineClearsStalePresence(t *testing.T) {
	ctx := context.Background()
	db := openTestStore(t, filepath.Join(t.TempDir(), "foundry.db"))
	registration := registrationInput(t, "ws_presence", "first")
	registration.Device.Status = "connected"
	if err := db.RegisterDaemon(ctx, registration); err != nil {
		t.Fatalf("register: %v", err)
	}
	if err := db.MarkAllDevicesOffline(ctx); err != nil {
		t.Fatalf("mark offline: %v", err)
	}
	devices, err := db.ListDevices(ctx)
	if err != nil || len(devices) != 1 || devices[0].Status != "disconnected" {
		t.Fatalf("devices = %+v, %v", devices, err)
	}
}
