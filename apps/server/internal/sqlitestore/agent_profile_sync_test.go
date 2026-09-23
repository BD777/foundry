package sqlitestore

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// A daemon report is the machine's complete profile set, so a profile the user
// removed locally must not survive as a row nobody can delete from the UI.
func TestRegisterDaemonDropsProfilesTheDeviceNoLongerReports(t *testing.T) {
	ctx := context.Background()
	db := openTestStore(t, filepath.Join(t.TempDir(), "foundry.db"))
	workspaceID := "ws_profile_sync"
	deviceID := "dev_" + workspaceID

	first := registrationInput(t, workspaceID, "first")
	first.AgentProfiles = []store.AgentProfileProjection{
		{ID: "claude_local", DeviceID: deviceID, Runtime: "claude", Status: "healthy"},
		{ID: "claude_env_endpoint", DeviceID: deviceID, Runtime: "claude", Status: "healthy"},
	}
	if err := db.RegisterDaemon(ctx, first); err != nil {
		t.Fatalf("first registration: %v", err)
	}

	second := registrationInput(t, workspaceID, "second")
	second.AgentProfiles = []store.AgentProfileProjection{
		{ID: "claude_local", DeviceID: deviceID, Runtime: "claude", Status: "healthy"},
	}
	if err := db.RegisterDaemon(ctx, second); err != nil {
		t.Fatalf("second registration: %v", err)
	}

	profiles, err := db.ListAgentProfiles(ctx, deviceID)
	if err != nil {
		t.Fatalf("list profiles: %v", err)
	}
	if len(profiles) != 1 || profiles[0].ID != "claude_local" {
		t.Fatalf("stale profile survived the report: %+v", profiles)
	}
}

// Another device's profiles are not touched by a report that never mentions
// them, because each daemon only speaks for its own machine.
func TestRegisterDaemonLeavesOtherDevicesAlone(t *testing.T) {
	ctx := context.Background()
	db := openTestStore(t, filepath.Join(t.TempDir(), "foundry.db"))

	one := registrationInput(t, "ws_one", "one")
	one.AgentProfiles = []store.AgentProfileProjection{
		{ID: "codex_local", DeviceID: "dev_ws_one", Runtime: "codex", Status: "healthy"},
	}
	two := registrationInput(t, "ws_two", "two")
	two.AgentProfiles = []store.AgentProfileProjection{
		{ID: "claude_local", DeviceID: "dev_ws_two", Runtime: "claude", Status: "healthy"},
	}
	if err := db.RegisterDaemon(ctx, one); err != nil {
		t.Fatalf("register device one: %v", err)
	}
	if err := db.RegisterDaemon(ctx, two); err != nil {
		t.Fatalf("register device two: %v", err)
	}

	profiles, err := db.ListAgentProfiles(ctx, "dev_ws_one")
	if err != nil {
		t.Fatalf("list profiles: %v", err)
	}
	if len(profiles) != 1 || profiles[0].ID != "codex_local" {
		t.Fatalf("a second device's report disturbed the first: %+v", profiles)
	}
}
