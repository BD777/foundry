package sqlitestore

import (
	"context"
	"errors"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func TestConnectorPackageEnablementRoundTripsDevices(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	want := store.ConnectorPackageEnablement{
		OwnerUserID: "user_owner", Kind: "openlark", ExtensionID: "open-lark",
		RepositoryID: "repo_openlark", Devices: []string{"dev_a", "dev_b"},
		UpdatedAt: "2026-11-11T00:00:00Z",
	}
	if err := s.SaveConnectorPackage(ctx, want); err != nil {
		t.Fatal(err)
	}
	got, err := s.GetConnectorPackage(ctx, want.OwnerUserID, want.Kind)
	if err != nil {
		t.Fatal(err)
	}
	if got.RepositoryID != want.RepositoryID || got.ExtensionID != want.ExtensionID ||
		len(got.Devices) != 2 || got.Devices[0] != "dev_a" || got.Devices[1] != "dev_b" {
		t.Fatalf("round trip %+v", got)
	}
	if err := s.DeleteConnectorPackage(ctx, want.OwnerUserID, want.Kind); err != nil {
		t.Fatal(err)
	}
	if _, err := s.GetConnectorPackage(ctx, want.OwnerUserID, want.Kind); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("after delete: %v", err)
	}
}

func TestConnectorPackageEnablementKeepsSelectionAndDeviceStates(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	want := store.ConnectorPackageEnablement{
		OwnerUserID: "user_owner", Kind: "openlark", ExtensionID: "open-lark",
		Selected: []string{"dev_a", "dev_b"}, Devices: []string{"dev_a"},
		States: map[string]store.ConnectorPackageProgress{
			"dev_b": {State: store.ConnectorPackageDeviceStateFailed, Error: "offline", UpdatedAt: "2026-11-11T00:00:00Z"},
		},
		UpdatedAt: "2026-11-11T00:00:00Z",
	}
	if err := s.SaveConnectorPackage(ctx, want); err != nil {
		t.Fatal(err)
	}
	got, err := s.GetConnectorPackage(ctx, want.OwnerUserID, want.Kind)
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Selected) != 2 || len(got.Devices) != 1 || got.States["dev_b"].Error != "offline" || got.Unfinished() {
		t.Fatalf("round trip %+v", got)
	}
	got.States["dev_b"] = store.ConnectorPackageProgress{State: store.ConnectorPackageDeviceStatePending}
	if err := s.SaveConnectorPackage(ctx, got); err != nil {
		t.Fatal(err)
	}
	all, err := s.ListAllConnectorPackages(ctx)
	if err != nil || len(all) != 1 || !all[0].Unfinished() {
		t.Fatalf("list all %+v %v", all, err)
	}
	// A row without a recorded selection selects the devices it has.
	if _, err := s.conn().ExecContext(ctx, `UPDATE connector_package_enablements SET selected_json = ''`); err != nil {
		t.Fatal(err)
	}
	legacy, err := s.GetConnectorPackage(ctx, want.OwnerUserID, want.Kind)
	if err != nil || len(legacy.Selected) != 1 || legacy.Selected[0] != "dev_a" {
		t.Fatalf("legacy selection %+v %v", legacy, err)
	}
}
