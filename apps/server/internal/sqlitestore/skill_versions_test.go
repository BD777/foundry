package sqlitestore

import (
	"archive/zip"
	"bytes"
	"context"
	"github.com/foundry-dev/foundry/apps/server/internal/skillarchive"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"testing"
)

func versionArchive(t *testing.T, name, body string, method uint16) ([]byte, skillarchive.Index) {
	t.Helper()
	var b bytes.Buffer
	z := zip.NewWriter(&b)
	w, err := z.CreateHeader(&zip.FileHeader{Name: "SKILL.md", Method: method})
	if err != nil {
		t.Fatal(err)
	}
	w.Write([]byte("---\nname: " + name + "\ndescription: Test\n---\n" + body))
	if err := z.Close(); err != nil {
		t.Fatal(err)
	}
	idx, err := skillarchive.Inspect(b.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	return b.Bytes(), idx
}
func TestSkillVersionLifecycle(t *testing.T) {
	db := newTestStore(t)
	ctx := context.Background()
	zip1, idx1 := versionArchive(t, "alpha", "first", zip.Store)
	source := store.DeviceSkill{DeviceID: "dev", Root: "/skills", DirName: "alpha", Name: "alpha", SourceDigest: idx1.SourceDigest, Manifest: idx1.Files, DependenciesAnalyzed: true}
	publish := func(s store.DeviceSkill, data []byte, r store.SkillPromotionResolution) store.PromotedSkill {
		t.Helper()
		items, err := db.PromoteSkillPackages(ctx, []store.SkillPromotionPackage{{Source: s, Content: data, Resolution: r}})
		if err != nil {
			t.Fatal(err)
		}
		return items[0]
	}
	first := publish(source, zip1, store.SkillPromotionResolution{Action: "create"})
	scan := func(s store.DeviceSkill) store.DeviceSkill {
		t.Helper()
		if err := db.ReplaceDeviceSkills(ctx, store.ReplaceDeviceSkillsInput{DeviceID: s.DeviceID, Skills: []store.DeviceSkill{s}}); err != nil {
			t.Fatal(err)
		}
		items, err := db.ListDeviceSkills(ctx, s.DeviceID)
		if err != nil {
			t.Fatal(err)
		}
		return items[0]
	}
	source = scan(source)
	if source.ServerState != "in_sync" {
		t.Fatalf("state: %+v", source)
	}
	compressed, idx := versionArchive(t, "alpha", "first", zip.Deflate)
	if idx.SourceDigest != idx1.SourceDigest {
		t.Fatal("compression affected content identity")
	}
	same := publish(source, compressed, store.SkillPromotionResolution{Action: "update", TargetSkillID: first.ID, ExpectedRevision: 1})
	if same.LatestRevision != 1 {
		t.Fatal("identical content created revision")
	}
	// Another source with identical contents links the same catalog identity.
	other := source
	other.DeviceID = "other"
	other.PromotedSkillID = ""
	other = scan(other)
	if other.ServerState != "reusable" {
		t.Fatalf("expected reusable: %s", other.ServerState)
	}
	reused := publish(other, nil, store.DefaultSkillResolution(other))
	if reused.ID != first.ID {
		t.Fatal("same content duplicated catalog")
	}
	zip2, idx2 := versionArchive(t, "alpha", "second", zip.Deflate)
	source.SourceDigest = idx2.SourceDigest
	source.Manifest = idx2.Files
	source = scan(source)
	if source.ServerState != "different" {
		t.Fatalf("expected changed source: %+v", source)
	}
	second := publish(source, zip2, store.DefaultSkillResolution(source))
	if second.LatestRevision != 2 {
		t.Fatal("update did not append revision")
	}
	old, err := db.GetSkillPackage(ctx, first.ID, 1)
	if err != nil || !bytes.Equal(old.Content, zip1) {
		t.Fatal("old revision changed")
	}
	_, err = db.PromoteSkillPackages(ctx, []store.SkillPromotionPackage{{Source: source, Content: zip2, Resolution: store.SkillPromotionResolution{Action: "update", TargetSkillID: first.ID, ExpectedRevision: 1}}})
	if err == nil {
		t.Fatal("stale update accepted")
	}
	// The other linked device did not change locally, but the server has advanced.
	other = scan(other)
	if other.ServerState != "different" {
		t.Fatalf("alias missed remote update: %s", other.ServerState)
	}
	// A deliberate fork changes only the server copy's invocation name.
	fork := publish(source, zip2, store.SkillPromotionResolution{Action: "fork", Name: "team-alpha"})
	if fork.ID == first.ID || fork.Name != "team-alpha" {
		t.Fatal("fork overwrote original")
	}
	source = scan(source)
	if source.ServerState != "in_sync" || source.PromotedSkillID != fork.ID {
		t.Fatalf("fork source binding: %+v", source)
	}
	pkg, _ := db.GetSkillPackage(ctx, fork.ID, 1)
	md, _ := skillarchive.ReadFile(pkg.Content, "SKILL.md")
	if !bytes.Contains(md, []byte("name: team-alpha")) {
		t.Fatalf("runtime name not changed: %s", md)
	}
	// Original source bytes remain untouched.
	original, _ := skillarchive.ReadFile(zip2, "SKILL.md")
	if !bytes.Contains(original, []byte("name: alpha")) {
		t.Fatal("local source bytes were changed")
	}
}
func TestWorkspaceDuplicateSkillNamesRejectedBeforeReplacingBindings(t *testing.T) {
	db := newTestStore(t)
	ctx := context.Background()
	data, _ := versionArchive(t, "same", "body", zip.Store)
	a, _, err := db.AddPromotedSkillRevision(ctx, store.PromoteSkillInput{DeviceID: "a", Root: "/r", DirName: "same"}, "same", "", data, 1)
	if err != nil {
		t.Fatal(err)
	}
	b, _, err := db.AddPromotedSkillRevision(ctx, store.PromoteSkillInput{DeviceID: "b", Root: "/r", DirName: "same"}, "same", "", data, 1)
	if err != nil {
		t.Fatal(err)
	}
	if err = db.SetWorkspaceSkills(ctx, store.SetWorkspaceSkillsInput{WorkspaceID: "w", SkillIDs: []string{a.ID}}); err != nil {
		t.Fatal(err)
	}
	if err = db.SetWorkspaceSkills(ctx, store.SetWorkspaceSkillsInput{WorkspaceID: "w", SkillIDs: []string{a.ID, b.ID}}); err == nil {
		t.Fatal("name conflict saved")
	}
	refs, _ := db.ListWorkspaceSkillBindings(ctx, "w")
	if len(refs) != 1 || refs[0].SkillID != a.ID {
		t.Fatal("failed save changed selection")
	}
}
