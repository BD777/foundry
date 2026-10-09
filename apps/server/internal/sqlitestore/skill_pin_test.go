package sqlitestore

import (
	"archive/zip"
	"context"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// A workspace can hold a skill at one revision while the library moves on;
// saving the selection keeps the pin, and unpinning follows the latest again.
func TestWorkspaceSkillPinHoldsARevision(t *testing.T) {
	db := newTestStore(t)
	ctx := context.Background()
	source := store.PromoteSkillInput{DeviceID: "dev", Root: "/r", DirName: "alpha"}
	first, _ := versionArchive(t, "alpha", "first", zip.Store)
	skill, _, err := db.AddPromotedSkillRevision(ctx, source, "alpha", "", first, 1)
	if err != nil {
		t.Fatal(err)
	}
	second, _ := versionArchive(t, "alpha", "second", zip.Store)
	if skill, _, err = db.AddPromotedSkillRevision(ctx, source, "alpha", "", second, 1); err != nil {
		t.Fatal(err)
	}
	if skill.LatestRevision != 2 {
		t.Fatalf("latest revision %d, want 2", skill.LatestRevision)
	}
	if err := db.SetWorkspaceSkills(ctx, store.SetWorkspaceSkillsInput{WorkspaceID: "w", SkillIDs: []string{skill.ID}}); err != nil {
		t.Fatal(err)
	}
	revision := func() int {
		t.Helper()
		refs, err := db.ResolveSessionSkills(ctx, "w")
		if err != nil || len(refs) != 1 {
			t.Fatalf("refs %+v, %v", refs, err)
		}
		return refs[0].Revision
	}
	if got := revision(); got != 2 {
		t.Fatalf("follows revision %d, want latest 2", got)
	}
	if err := db.SetWorkspaceSkillPin(ctx, "w", skill.ID, 1); err != nil {
		t.Fatal(err)
	}
	if got := revision(); got != 1 {
		t.Fatalf("pinned workspace runs revision %d, want 1", got)
	}
	if err := db.SetWorkspaceSkills(ctx, store.SetWorkspaceSkillsInput{WorkspaceID: "w", SkillIDs: []string{skill.ID}}); err != nil {
		t.Fatal(err)
	}
	if got := revision(); got != 1 {
		t.Fatal("saving the selection dropped the pin")
	}
	if err := db.SetWorkspaceSkillPin(ctx, "w", skill.ID, 9); err == nil {
		t.Fatal("pinned a revision that does not exist")
	}
	if err := db.SetWorkspaceSkillPin(ctx, "w", skill.ID, 0); err != nil {
		t.Fatal(err)
	}
	if got := revision(); got != 2 {
		t.Fatalf("unpinned workspace runs revision %d, want 2", got)
	}
}
