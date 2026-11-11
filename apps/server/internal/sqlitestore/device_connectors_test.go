package sqlitestore

import (
	"context"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func TestDeviceConnectorStatesAndBindings(t *testing.T) {
	db := newTestStore(t)
	ctx := context.Background()
	state := store.DeviceConnectorState{DeviceID: "dev_a", Kind: "corpcli", Status: store.DeviceConnectorReady, Installed: true,
		Version: "0.170.0", InstallSource: "device", SignedIn: true, Identity: "someone", Sites: []string{"cn"},
		ExpiresAt: "2026-11-13T16:39:56Z", CheckedAt: "2026-10-15T00:00:00Z",
		Configuration:  &store.ConnectorConfiguration{Region: "us-east-1"},
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
	if states[0].Configuration == nil || states[0].Configuration.Region != "us-east-1" {
		t.Fatalf("configuration metadata was lost: %+v", states[0])
	}
	// What the worker checked of a session's environment is kept and replaced.
	holds := false
	state.SessionCheck = &store.DeviceConnectorSessionCheck{Usable: false, Reason: "gh is not on the PATH a session gets", IsolationHolds: &holds, IsolationReason: "still signed in", CheckedAt: "2026-10-15T00:00:00Z"}
	if err := db.SaveDeviceConnectorState(ctx, state); err != nil {
		t.Fatal(err)
	}
	states, _ = db.ListDeviceConnectorStates(ctx, []string{"dev_a"})
	if check := states[0].SessionCheck; check == nil || check.Usable || check.Reason == "" || check.IsolationHolds == nil || *check.IsolationHolds || check.IsolationReason == "" {
		t.Fatalf("session check lost: %+v", states[0].SessionCheck)
	}
	state.SessionCheck = nil
	if err := db.SaveDeviceConnectorState(ctx, state); err != nil {
		t.Fatal(err)
	}
	if states, _ = db.ListDeviceConnectorStates(ctx, []string{"dev_a"}); states[0].SessionCheck != nil {
		t.Fatalf("stale session check survived: %+v", states[0].SessionCheck)
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

	if err := db.SetWorkspaceDeviceConnectors(ctx, "ws", "alice", []store.DeviceConnectorBindingInput{{Kind: "corpcli", DeviceID: "dev_a", Members: true}}); err != nil {
		t.Fatal(err)
	}
	if err := db.SetWorkspaceDeviceConnectors(ctx, "ws", "bob", []store.DeviceConnectorBindingInput{{Kind: "corpcli", DeviceID: "dev_b"}}); err != nil {
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

// A database made before session checks and configuration gets both columns
// when the server starts.
func TestDeviceConnectorStatesGainTheSessionCheckColumns(t *testing.T) {
	db := newTestStore(t)
	ctx := context.Background()
	if _, err := db.conn().ExecContext(ctx, `ALTER TABLE device_connector_states DROP COLUMN session_check`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.conn().ExecContext(ctx, `ALTER TABLE device_connector_states DROP COLUMN configuration`); err != nil {
		t.Fatal(err)
	}
	if err := db.setupDeviceConnectors(ctx); err != nil {
		t.Fatal(err)
	}
	state := store.DeviceConnectorState{DeviceID: "dev_a", Kind: "corpcli", Status: store.DeviceConnectorReady, SignedIn: true, CheckedAt: "2026-10-15T00:00:00Z",
		Configuration: &store.ConnectorConfiguration{Region: "eu-west-1"},
		SessionCheck:  &store.DeviceConnectorSessionCheck{Usable: true, CheckedAt: "2026-10-15T00:00:00Z"}}
	if err := db.SaveDeviceConnectorState(ctx, state); err != nil {
		t.Fatal(err)
	}
	if states, err := db.ListDeviceConnectorStates(ctx, []string{"dev_a"}); err != nil || len(states) != 1 || states[0].SessionCheck == nil || !states[0].SessionCheck.Usable || states[0].Configuration == nil || states[0].Configuration.Region != "eu-west-1" {
		t.Fatalf("states = %+v, %v", states, err)
	}
}

func TestDeviceConnectorVisibilityChecksAreCachedAndInvalidated(t *testing.T) {
	db := newTestStore(t)
	ctx := context.Background()
	check := store.ConnectorVisibilityCheck{
		DeviceID: "dev_a", Result: store.ConnectorVisibilityRepository,
		Kind: "corpcli", Via: "github", Repository: "owner/repository",
		Status: "ok", Identity: "reader", Detail: "readable",
		CheckedAt: "2026-11-11T00:00:00Z",
	}
	if err := db.SaveConnectorVisibilityCheck(ctx, check); err != nil {
		t.Fatal(err)
	}
	check.Status, check.Detail = "no_access", "not found"
	if err := db.SaveConnectorVisibilityCheck(ctx, check); err != nil {
		t.Fatal(err)
	}
	checks, err := db.ListConnectorVisibilityChecks(ctx, []string{"dev_a"})
	if err != nil || len(checks) != 1 || checks[0].Status != "no_access" || checks[0].Identity != "reader" {
		t.Fatalf("checks = %+v, %v", checks, err)
	}
	if err := db.DeleteConnectorVisibilityChecks(ctx, "dev_a", "github"); err != nil {
		t.Fatal(err)
	}
	checks, err = db.ListConnectorVisibilityChecks(ctx, []string{"dev_a"})
	if err != nil || len(checks) != 0 {
		t.Fatalf("checks after delete = %+v, %v", checks, err)
	}
}
