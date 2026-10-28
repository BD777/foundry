package sqlitestore

import (
	"context"
	"errors"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"path/filepath"
	"testing"
)

func TestServiceTunnelStorePersistsRevisionsAndFollowsWorkspaceDeletion(t *testing.T) {
	path := filepath.Join(t.TempDir(), "foundry.db")
	ctx := context.Background()
	db, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	if err = db.RegisterDaemon(ctx, homeRegistration("dev_home", "Device")); err != nil {
		t.Fatal(err)
	}
	item := store.ServiceTunnel{HostLabel: "existing-opaque-identity", ID: "test-mapping", WorkspaceID: "ws_home", TargetWorkspaceID: "ws_home", DeviceID: "dev_home", OwnerUserID: "owner", Name: "existing web service", Port: 18082, Protocol: "http", Visibility: "private", Enabled: true, Revision: 1}
	if err = db.CreateServiceTunnel(ctx, item); err != nil {
		t.Fatal(err)
	}
	if err = db.Close(); err != nil {
		t.Fatal(err)
	}
	db, err = Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	saved, err := db.GetServiceTunnel(ctx, item.ID)
	if err != nil || saved != item {
		t.Fatalf("restart lost mapping: %+v %v", saved, err)
	}
	saved.Enabled = false
	saved.Revision = 2
	if err = db.UpdateServiceTunnel(ctx, saved, 1); err != nil {
		t.Fatal(err)
	}
	if err = db.UpdateServiceTunnel(ctx, item, 1); err == nil {
		t.Fatal("stale revision overwrote disabled mapping")
	}
	listed, err := db.ListServiceTunnels(ctx, "ws_home")
	if err != nil || len(listed) != 1 || listed[0].Enabled {
		t.Fatal("disabled mapping not retained")
	}
	if _, err = db.DeleteWorkspace(ctx, "ws_home"); err != nil {
		t.Fatal(err)
	}
	if _, err = db.GetServiceTunnel(ctx, item.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatal("deleted workspace retained mapping")
	}
}

func TestServiceTunnelLegacyHostIsAllocatedOnceAndCannotBeRelabeled(t *testing.T) {
	path := filepath.Join(t.TempDir(), "host.db")
	ctx := context.Background()
	db, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	if err = db.RegisterDaemon(ctx, homeRegistration("dev_home", "Device")); err != nil {
		t.Fatal(err)
	}
	item := store.ServiceTunnel{ID: "legacy", WorkspaceID: "ws_home", Name: "Team Atlas", Revision: 1}
	if err = db.CreateServiceTunnel(ctx, item); err != nil {
		t.Fatal(err)
	}
	db.Close()
	db, err = Open(path)
	if err != nil {
		t.Fatal(err)
	}
	saved, err := db.GetServiceTunnel(ctx, item.ID)
	if err != nil || saved.HostLabel == "" {
		t.Fatal("legacy host missing", err)
	}
	host := saved.HostLabel
	db.Close()
	db, err = Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	again, err := db.GetServiceTunnelByHostLabel(ctx, host)
	if err != nil || again.ID != item.ID || again.HostLabel != host {
		t.Fatal("restart changed hostname", err)
	}
	again.HostLabel = "different"
	again.Revision++
	if err = db.UpdateServiceTunnel(ctx, again, 1); err == nil {
		t.Fatal("host identity reassigned")
	}
}
