package sqlitestore

import (
	"context"
	"strings"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// Workspace data leaves device skill lists out; a device's skillsVersion is
// what tells the web to load its list again, so it must move with every
// scan that changes that device's skills and every catalog change, and stay
// put otherwise: a rescan every half hour that finds the same skills must
// not invalidate every client's workspace data.
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
	// scan reports skills named name, or name=description.
	scan := func(deviceID string, names ...string) bool {
		t.Helper()
		skills := []store.DeviceSkill{}
		for _, entry := range names {
			name, description, _ := strings.Cut(entry, "=")
			skills = append(skills, store.DeviceSkill{Root: "/skills", DirName: name, Name: name, Description: description})
		}
		changed, err := db.ReplaceDeviceSkills(ctx, store.ReplaceDeviceSkillsInput{DeviceID: deviceID, Skills: skills})
		if err != nil {
			t.Fatalf("scan %s: %v", deviceID, err)
		}
		return changed
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

	if !scan("dev_ws_a", "alpha") {
		t.Fatal("first scan of a reported no change")
	}
	afterScan := versions()
	expect("scan of a", start, afterScan, "dev_ws_a")
	firstScannedAt, err := db.DeviceSkillsScannedAt(ctx, "dev_ws_a")
	if err != nil || firstScannedAt == "" {
		t.Fatalf("scan time after a scan = %q, %v", firstScannedAt, err)
	}

	// The same skills again change nothing; only the scan time moves.
	if scan("dev_ws_a", "alpha") {
		t.Fatal("an unchanged rescan reported a change")
	}
	expect("unchanged rescan of a", afterScan, versions())
	if scannedAt, err := db.DeviceSkillsScannedAt(ctx, "dev_ws_a"); err != nil || scannedAt == "" || scannedAt == firstScannedAt {
		t.Fatalf("scan time after a rescan = %q (before %q), %v", scannedAt, firstScannedAt, err)
	}

	// A changed skill, a new one and a removed one each move it.
	if !scan("dev_ws_a", "alpha=now with a description") {
		t.Fatal("a changed description reported no change")
	}
	afterEdit := versions()
	expect("changed skill on a", afterScan, afterEdit, "dev_ws_a")
	if !scan("dev_ws_a", "alpha=now with a description", "beta") {
		t.Fatal("a new skill reported no change")
	}
	afterAdd := versions()
	expect("new skill on a", afterEdit, afterAdd, "dev_ws_a")
	if !scan("dev_ws_a", "alpha=now with a description") {
		t.Fatal("a removed skill reported no change")
	}
	afterRescan := versions()
	expect("removed skill on a", afterAdd, afterRescan, "dev_ws_a")
	if skills, err := db.ListDeviceSkills(ctx, "dev_ws_a"); err != nil || len(skills) != 1 || skills[0].Description != "now with a description" {
		t.Fatalf("stored skills = %+v, %v", skills, err)
	}

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
