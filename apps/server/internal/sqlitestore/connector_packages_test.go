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
