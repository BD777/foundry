package sqlitestore

import (
	"context"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// Workspace data leaves device skill lists out; a device's skillsVersion is
// what tells the web to load its list again, so it must move with every
// scan of that device and every catalog change, and stay put otherwise.
func TestDeviceSkillsVersionMovesWithScansAndCatalog(t *testing.T) {
	ctx := context.Background()
	db := newTestStore(t)
	for _, workspaceID := range []string{"ws_a", "ws_b"} {
		if err := db.RegisterDaemon(ctx, registrationInput(t, workspaceID, workspaceID)); err != nil {
			t.Fatalf("register %s: %v", workspaceID, err)
		}
	}
	versions := func() map[string]string {
		t.Helper()
		devices, err := db.ListDevices(ctx)
		if err != nil {
			t.Fatalf("list devices: %v", err)
		}
		result := map[string]string{}
		for _, device := range devices {
			if device.SkillsVersion == "" {
				t.Fatalf("device %s has no skillsVersion", device.ID)
			}
			result[device.ID] = device.SkillsVersion
		}
		return result
	}
	scan := func(deviceID string, names ...string) {
		t.Helper()
		skills := []store.DeviceSkill{}
		for _, name := range names {
			skills = append(skills, store.DeviceSkill{Root: "/skills", DirName: name, Name: name})
		}
		if err := db.ReplaceDeviceSkills(ctx, store.ReplaceDeviceSkillsInput{DeviceID: deviceID, Skills: skills}); err != nil {
			t.Fatalf("scan %s: %v", deviceID, err)
		}
	}
	expect := func(step string, before, after map[string]string, moved ...string) {
		t.Helper()
		for id, version := range before {
			want := false
			for _, m := range moved {
				want = want || m == id
			}
			if got := after[id] != version; got != want {
				t.Fatalf("%s: %s skillsVersion %q -> %q, moved=%v want %v", step, id, version, after[id], got, want)
			}
		}
	}

	start := versions()
	if len(start) != 2 {
		t.Fatalf("devices = %v", start)
	}
	expect("nothing changed", start, versions())

	scan("dev_ws_a", "alpha")
	afterScan := versions()
	expect("scan of a", start, afterScan, "dev_ws_a")

	// A scan rewrites the device's rows, so even an unchanged scan reloads.
	scan("dev_ws_a", "alpha")
	afterRescan := versions()
	expect("rescan of a", afterScan, afterRescan, "dev_ws_a")

	source := store.PromoteSkillInput{DeviceID: "dev_ws_a", Root: "/skills", DirName: "alpha"}
	if _, _, err := db.AddPromotedSkillRevision(ctx, source, "alpha", "", []byte("v1"), 1); err != nil {
		t.Fatalf("publish: %v", err)
	}
	afterPublish := versions()
	expect("new catalog skill", afterRescan, afterPublish, "dev_ws_a", "dev_ws_b")

	if _, created, err := db.AddPromotedSkillRevision(ctx, source, "alpha", "", []byte("v1"), 1); err != nil || created {
		t.Fatalf("identical publish: created=%v err=%v", created, err)
	}
	expect("identical publish", afterPublish, versions())

	if _, created, err := db.AddPromotedSkillRevision(ctx, source, "alpha", "", []byte("v2"), 1); err != nil || !created {
		t.Fatalf("new revision: created=%v err=%v", created, err)
	}
	expect("new catalog revision", afterPublish, versions(), "dev_ws_a", "dev_ws_b")
}
