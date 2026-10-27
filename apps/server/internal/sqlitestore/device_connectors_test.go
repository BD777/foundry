package sqlitestore

import (
	"context"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func TestDeviceConnectorStatesAndBindings(t *testing.T) {
	db := newTestStore(t)
	ctx := context.Background()
	state := store.DeviceConnectorState{DeviceID: "dev_a", Kind: "bytedcli", Status: store.DeviceConnectorReady, Installed: true,
		Version: "0.170.0", InstallSource: "device", SignedIn: true, Identity: "someone", Sites: []string{"cn"},
		ExpiresAt: "2026-11-13T16:39:56Z", CheckedAt: "2026-10-15T00:00:00Z",
		Authorizations: []store.ConnectorAuthorizationState{{ID: "feishu_web_session", Revision: 1, Status: "ready", Verification: "local_state"}}}
	if err := db.SaveDeviceConnectorState(ctx, state); err != nil {
		t.Fatal(err)
	}
	state.Status, state.ExpiringSince = store.DeviceConnectorExpiring, "2026-11-11T00:00:00Z"
	if err := db.SaveDeviceConnectorState(ctx, state); err != nil {
		t.Fatal(err)
	}
	states, err := db.ListDeviceConnectorStates(ctx, []string{"dev_a", "dev_b"})
	if err != nil || len(states) != 1 || states[0].Status != store.DeviceConnectorExpiring || states[0].ExpiringSince == "" ||
		len(states[0].Sites) != 1 || !states[0].SignedIn || states[0].Identity != "someone" {
		t.Fatalf("states = %+v, %v", states, err)
	}
	if none, _ := db.ListDeviceConnectorStates(ctx, nil); len(none) != 0 {
		t.Fatalf("no devices listed %+v", none)
	}
	if len(states[0].Authorizations) != 1 || states[0].Authorizations[0].Status != "ready" || states[0].Authorizations[0].ID != "feishu_web_session" {
		t.Fatalf("authorization metadata was lost: %+v", states[0])
	}
	// Rechecking replaces old capability state, including clearing it for old CLIs.
	state.Authorizations = nil
	if err := db.SaveDeviceConnectorState(ctx, state); err != nil {
		t.Fatal(err)
	}
	states, err = db.ListDeviceConnectorStates(ctx, []string{"dev_a"})
	if err != nil || len(states) != 1 || len(states[0].Authorizations) != 0 {
		t.Fatalf("stale authorization survived: %+v, %v", states, err)
	}

	if err := db.SetWorkspaceDeviceConnectors(ctx, "ws", "alice", []store.DeviceConnectorBindingInput{{Kind: "bytedcli", DeviceID: "dev_a", Members: true}}); err != nil {
		t.Fatal(err)
	}
	if err := db.SetWorkspaceDeviceConnectors(ctx, "ws", "bob", []store.DeviceConnectorBindingInput{{Kind: "bytedcli", DeviceID: "dev_b"}}); err != nil {
		t.Fatal(err)
	}
	// Replacing alice's bindings leaves bob's.
	if err := db.SetWorkspaceDeviceConnectors(ctx, "ws", "alice", nil); err != nil {
		t.Fatal(err)
	}
	bindings, err := db.ListWorkspaceDeviceConnectors(ctx, "ws")
	if err != nil || len(bindings) != 1 || bindings[0].DeviceID != "dev_b" || bindings[0].GrantedBy != "bob" || bindings[0].Members {
		t.Fatalf("bindings = %+v, %v", bindings, err)
	}
}

func TestDeviceConnectorAuthorizationMigrationPreservesExistingLogin(t *testing.T) {
	db := newTestStore(t)
	ctx := context.Background()
	original := store.DeviceConnectorState{DeviceID: "dev_old", Kind: "bytedcli", Status: "ready", SignedIn: true, Identity: "owner", ExpiresAt: "2026-11-26T07:35:56Z"}
	if err := db.SaveDeviceConnectorState(ctx, original); err != nil {
		t.Fatal(err)
	}
	// Recreate the pre-DEV-052 schema, then run the additive setup twice.
	if _, err := db.conn().ExecContext(ctx, `ALTER TABLE device_connector_states DROP COLUMN authorizations`); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		if err := db.setupDeviceConnectors(ctx); err != nil {
			t.Fatal(err)
		}
	}
	states, err := db.ListDeviceConnectorStates(ctx, []string{"dev_old"})
	if err != nil || len(states) != 1 || states[0].Identity != "owner" || states[0].ExpiresAt != original.ExpiresAt || len(states[0].Authorizations) != 0 {
		t.Fatalf("migrated state=%+v err=%v", states, err)
	}
}
