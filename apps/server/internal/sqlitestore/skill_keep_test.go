package sqlitestore

import (
	"archive/zip"
	"context"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// Keeping the library version of a same-named skill publishes nothing and
// leaves the device folder unlinked, so it is offered again after a change.
func TestKeepLibraryVersionPublishesNothing(t *testing.T) {
	db := newTestStore(t)
	ctx := context.Background()
	libraryZip, libraryIndex := versionArchive(t, "alpha", "library", zip.Store)
	library := store.DeviceSkill{DeviceID: "dev_a", Root: "/skills", DirName: "alpha", Name: "alpha", SourceDigest: libraryIndex.SourceDigest, Manifest: libraryIndex.Files, DependenciesAnalyzed: true}
	items, err := db.PromoteSkillPackages(ctx, []store.SkillPromotionPackage{{Source: library, Content: libraryZip, Resolution: store.SkillPromotionResolution{Action: "create"}}})
	if err != nil {
		t.Fatal(err)
	}
	entry := items[0]

	_, localIndex := versionArchive(t, "alpha", "local edit", zip.Store)
	local := store.DeviceSkill{DeviceID: "dev_b", Root: "/skills", DirName: "alpha", Name: "alpha", SourceDigest: localIndex.SourceDigest, Manifest: localIndex.Files, DependenciesAnalyzed: true}
	if err := db.ReplaceDeviceSkills(ctx, store.ReplaceDeviceSkillsInput{DeviceID: "dev_b", Skills: []store.DeviceSkill{local}}); err != nil {
		t.Fatal(err)
	}
	scanned, _ := db.ListDeviceSkills(ctx, "dev_b")
	if scanned[0].ServerState != "name_conflict" {
		t.Fatalf("state %q, want name_conflict", scanned[0].ServerState)
	}
	// Reusing differing content stays refused; keeping is the explicit way.
	if _, err := db.PromoteSkillPackages(ctx, []store.SkillPromotionPackage{{Source: scanned[0], Resolution: store.SkillPromotionResolution{Action: "reuse", TargetSkillID: entry.ID, ExpectedRevision: 1}}}); err == nil {
		t.Fatal("differing content was reused")
	}
	kept, err := db.PromoteSkillPackages(ctx, []store.SkillPromotionPackage{{Source: scanned[0], Resolution: store.SkillPromotionResolution{Action: "keep", TargetSkillID: entry.ID, ExpectedRevision: 1}}})
	if err != nil {
		t.Fatal(err)
	}
	if kept[0].ID != entry.ID || kept[0].LatestRevision != 1 {
		t.Fatalf("kept %+v, want the library entry at rev 1", kept[0])
	}
	after, _ := db.ListDeviceSkills(ctx, "dev_b")
	if after[0].PromotedSkillID != "" || after[0].ServerState != "name_conflict" {
		t.Fatalf("after keep: %+v; the device folder must stay unlinked", after[0])
	}
	if _, err := db.PromoteSkillPackages(ctx, []store.SkillPromotionPackage{{Source: scanned[0], Resolution: store.SkillPromotionResolution{Action: "keep", TargetSkillID: entry.ID, ExpectedRevision: 2}}}); err == nil {
		t.Fatal("keep against a stale revision was accepted")
	}
}
