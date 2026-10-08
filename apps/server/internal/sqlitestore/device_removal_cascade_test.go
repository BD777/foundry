package sqlitestore

import (
	"context"
	"errors"
	"path/filepath"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// Removing a device deletes what it reported or was given (agents, agent
// profiles, health, connection assignments, skill roots, credential copies)
// and keeps its history; a removed device takes no new assignments.
func TestSoftRemoveDevicePurgesLiveStateAndKeepsHistory(t *testing.T) {
	ctx := context.Background()
	db := openTestStore(t, filepath.Join(t.TempDir(), "foundry.db"))
	registration := registrationInput(t, "ws_cascade", "cascade")
	deviceID := registration.Device.ID
	registration.AgentProfiles = []store.AgentProfileProjection{{ID: "codex_local", DeviceID: deviceID, Runtime: "codex", Status: "healthy"}}
	registration.ProviderHealth = []store.ProviderHealth{{Provider: "codex", DeviceID: deviceID, Status: "healthy"}}
	if err := db.RegisterDaemon(ctx, registration); err != nil {
		t.Fatalf("register: %v", err)
	}
	profile, err := db.SaveProfile(ctx, store.SaveProfileInput{Runtime: "codex", Label: "Relay", ConnectionType: "openai_compatible", BaseURL: "https://relay.example"})
	if err != nil {
		t.Fatalf("save profile: %v", err)
	}
	if err := db.SetDeviceProfiles(ctx, store.SetDeviceProfilesInput{DeviceID: deviceID, ProfileIDs: []string{profile.ID}}); err != nil {
		t.Fatalf("assign: %v", err)
	}
	if err := db.SetDeviceSkillRoots(ctx, store.SetDeviceSkillRootsInput{DeviceID: deviceID, Paths: []string{"/skills"}}); err != nil {
		t.Fatalf("skill roots: %v", err)
	}
	for _, id := range []string{"agent-profile:" + deviceID + ":codex_local", "agent-profile:dev_other:codex_local"} {
		if _, err := db.conn().ExecContext(ctx, `INSERT INTO secret_records (id, aad, ciphertext, wrapped_dek, dek_nonce, ct_nonce, created_at, updated_at)
			VALUES (?, '', x'00', x'00', x'00', x'00', '', '')`, id); err != nil {
			t.Fatalf("seed secret: %v", err)
		}
	}

	if _, err := db.SoftRemoveDevice(ctx, deviceID); err != nil {
		t.Fatalf("remove: %v", err)
	}
	count := func(query string, args ...any) int {
		var n int
		if err := db.conn().QueryRowContext(ctx, query, args...).Scan(&n); err != nil {
			t.Fatalf("%s: %v", query, err)
		}
		return n
	}
	for label, n := range map[string]int{
		"agents":           count(`SELECT count(*) FROM agents WHERE device_id = ?`, deviceID),
		"agent profiles":   count(`SELECT count(*) FROM agent_profiles WHERE device_id = ?`, deviceID),
		"provider health":  count(`SELECT count(*) FROM provider_health WHERE json_extract(payload_json, '$.deviceId') = ?`, deviceID),
		"assignments":      count(`SELECT count(*) FROM device_profiles WHERE device_id = ?`, deviceID),
		"skill roots":      count(`SELECT count(*) FROM device_skill_roots WHERE device_id = ?`, deviceID),
		"its credentials":  count(`SELECT count(*) FROM secret_records WHERE id = ?`, "agent-profile:"+deviceID+":codex_local"),
		"other credential": count(`SELECT count(*) FROM secret_records WHERE id = 'agent-profile:dev_other:codex_local'`) - 1,
	} {
		if n != 0 {
			t.Errorf("%s: %d rows left", label, n)
		}
	}
	if _, err := db.GetWorkspace(ctx, "ws_cascade"); err != nil {
		t.Errorf("history workspace gone: %v", err)
	}
	if err := db.SetDeviceProfiles(ctx, store.SetDeviceProfilesInput{DeviceID: deviceID, ProfileIDs: []string{profile.ID}}); !errors.Is(err, store.ErrDeviceRemoved) {
		t.Errorf("assigning to a removed device: %v, want ErrDeviceRemoved", err)
	}
}
