package sqlitestore

import (
	"context"
	"errors"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func TestSkillRootsDefaultToEmptyRowsAndReplace(t *testing.T) {
	db := newTestStore(t)
	ctx := context.Background()

	roots, err := db.ListDeviceSkillRoots(ctx, "dev_1")
	if err != nil || len(roots) != 0 {
		t.Fatalf("expected no custom roots, got %v (%v)", roots, err)
	}
	if err := db.SetDeviceSkillRoots(ctx, store.SetDeviceSkillRootsInput{
		DeviceID: "dev_1",
		Paths:    []string{"~/skills/a", " ~/skills/a ", "~/skills/b", ""},
	}); err != nil {
		t.Fatalf("set roots: %v", err)
	}
	roots, _ = db.ListDeviceSkillRoots(ctx, "dev_1")
	if len(roots) != 2 || roots[0].Path != "~/skills/a" || roots[1].Path != "~/skills/b" {
		t.Fatalf("roots not normalized/deduped: %#v", roots)
	}
}

func TestReplaceDeviceSkillsSnapshotAndPromotedBackfill(t *testing.T) {
	db := newTestStore(t)
	ctx := context.Background()
	if err := db.ReplaceDeviceSkills(ctx, store.ReplaceDeviceSkillsInput{
		DeviceID: "dev_1",
		Skills: []store.DeviceSkill{
			{DeviceID: "wrong", Root: "/r", DirName: "a", Name: "Alpha"},
			{Root: "/r", DirName: "b", Name: "Beta"},
		},
	}); err != nil {
		t.Fatalf("replace skills: %v", err)
	}
	skills, err := db.ListDeviceSkills(ctx, "dev_1")
	if err != nil || len(skills) != 2 {
		t.Fatalf("expected 2 skills, got %v (%v)", skills, err)
	}
	if skills[0].DeviceID != "dev_1" {
		t.Fatalf("device id not stamped on stored row: %#v", skills[0])
	}
	if skills[0].PromotedSkillID != "" {
		t.Fatalf("fresh scan should not reference a promoted skill")
	}
}

func TestPromoteAddsRevisionAndBackfillsOnRescan(t *testing.T) {
	db := newTestStore(t)
	ctx := context.Background()

	input := store.PromoteSkillInput{DeviceID: "dev_1", Root: "/r", DirName: "alpha"}
	first, created, err := db.AddPromotedSkillRevision(ctx, input, "Alpha", "first", []byte("v1"), 1)
	if err != nil || !created || first.LatestRevision != 1 || first.ID == "" {
		t.Fatalf("first promote = created:%v rev:%d id:%q err:%v", created, first.LatestRevision, first.ID, err)
	}
	// Byte-identical re-promote is a no-op.
	same, createdAgain, err := db.AddPromotedSkillRevision(ctx, input, "Alpha", "first", []byte("v1"), 1)
	if err != nil || createdAgain || same.LatestRevision != 1 {
		t.Fatalf("identical re-promote should be no-op, got created:%v rev:%d err:%v", createdAgain, same.LatestRevision, err)
	}
	// New bytes from the same source create revision 2 and update metadata.
	second, created, err := db.AddPromotedSkillRevision(ctx, input, "Alpha Two", "second", []byte("v2-bytes"), 2)
	if err != nil || !created || second.LatestRevision != 2 || second.Name != "Alpha Two" {
		t.Fatalf("second promote = created:%v rev:%d name:%q err:%v", created, second.LatestRevision, second.Name, err)
	}
	if second.ID != first.ID {
		t.Fatalf("re-promote must keep the same catalog id")
	}

	// The rescan projection backfills the promoted id.
	if err := db.ReplaceDeviceSkills(ctx, store.ReplaceDeviceSkillsInput{
		DeviceID: "dev_1",
		Skills:   []store.DeviceSkill{{Root: "/r", DirName: "alpha", Name: "Alpha Two"}},
	}); err != nil {
		t.Fatalf("rescan: %v", err)
	}
	skills, _ := db.ListDeviceSkills(ctx, "dev_1")
	if len(skills) != 1 || skills[0].PromotedSkillID != first.ID {
		t.Fatalf("promoted id not backfilled: %#v", skills)
	}
}

func TestSkillPackageLatestAndRevision(t *testing.T) {
	db := newTestStore(t)
	ctx := context.Background()
	input := store.PromoteSkillInput{DeviceID: "dev_1", Root: "/r", DirName: "g"}
	skill, _, _ := db.AddPromotedSkillRevision(ctx, input, "Gamma", "d", []byte("one"), 1)
	_, _, _ = db.AddPromotedSkillRevision(ctx, input, "Gamma", "d", []byte("two-bytes"), 1)

	pkg, err := db.GetSkillPackage(ctx, skill.ID, 0)
	if err != nil || string(pkg.Content) != "two-bytes" || pkg.Revision != 2 {
		t.Fatalf("latest package = %q rev %d (%v)", string(pkg.Content), pkg.Revision, err)
	}
	old, err := db.GetSkillPackage(ctx, skill.ID, 1)
	if err != nil || string(old.Content) != "one" || old.Revision != 1 {
		t.Fatalf("rev 1 package = %q (%v)", string(old.Content), err)
	}
	if _, err := db.GetSkillPackage(ctx, skill.ID, 99); !errors.Is(err, store.ErrSkillPackageNotFound) {
		t.Fatalf("missing revision should be not found, got %v", err)
	}
}

func TestPromoteRejectsOversizedPackages(t *testing.T) {
	db := newTestStore(t)
	_, _, err := db.AddPromotedSkillRevision(
		context.Background(),
		store.PromoteSkillInput{DeviceID: "d", Root: "/r", DirName: "big"},
		"Big", "", make([]byte, MaxSkillPackageBytes+1), 1,
	)
	if !errors.Is(err, store.ErrSkillPackageTooLarge) {
		t.Fatalf("expected too large, got %v", err)
	}
}

func TestWorkspaceSkillsResolveAndDeleteCascades(t *testing.T) {
	db := newTestStore(t)
	ctx := context.Background()
	skill, _, _ := db.AddPromotedSkillRevision(
		ctx,
		store.PromoteSkillInput{DeviceID: "dev_1", Root: "/r", DirName: "s"},
		"Solo", "desc", []byte("zip"), 1,
	)
	if err := db.SetWorkspaceSkills(ctx, store.SetWorkspaceSkillsInput{
		WorkspaceID: "ws_1",
		SkillIDs:    []string{skill.ID, "missing-skill"},
	}); err != nil {
		t.Fatalf("bind: %v", err)
	}
	refs, err := db.ResolveSessionSkills(ctx, "ws_1")
	if err != nil || len(refs) != 1 || refs[0].SkillID != skill.ID || refs[0].Revision != 1 {
		t.Fatalf("resolved refs = %#v (%v)", refs, err)
	}
	empty, err := db.ResolveSessionSkills(ctx, "ws_without_selection")
	if err != nil || len(empty) != 0 {
		t.Fatalf("unselected workspace should resolve to empty, got %#v (%v)", empty, err)
	}

	if err := db.DeletePromotedSkill(ctx, skill.ID); err != nil {
		t.Fatalf("delete: %v", err)
	}
	bindings, _ := db.ListWorkspaceSkillBindings(ctx, "ws_1")
	if len(bindings) != 0 {
		t.Fatalf("bindings should cascade on delete, got %#v", bindings)
	}
	if _, err := db.GetPromotedSkill(ctx, skill.ID); !errors.Is(err, store.ErrSkillNotFound) {
		t.Fatalf("expected skill not found after delete, got %v", err)
	}
}

func TestPromotionBatchRollsBackOnFailure(t *testing.T) {
	db := newTestStore(t)
	ctx := context.Background()
	_, err := db.PromoteSkillPackages(ctx, []store.SkillPromotionPackage{
		{Source: store.DeviceSkill{DeviceID: "dev", Root: "/r", DirName: "a", Name: "a"}, Content: []byte("ok"), FileCount: 1},
		{Source: store.DeviceSkill{DeviceID: "dev", Root: "/r", DirName: "b", Name: "b"}, Content: make([]byte, MaxSkillPackageBytes+1)},
	})
	if err == nil {
		t.Fatal("expected too-large error")
	}
	rows, _ := db.ListPromotedSkills(ctx)
	if len(rows) != 0 {
		t.Fatal("partial promotion escaped transaction")
	}
}
