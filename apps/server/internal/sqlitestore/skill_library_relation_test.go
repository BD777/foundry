package sqlitestore

import (
	"archive/zip"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"testing"
)

func TestSkillLibraryRelation(t *testing.T) {
	item := &librarySkillHistory{id: "lib", latest: 4, matches: map[string]int{"old": 2, "third": 3, "latest": 4}, digests: map[int]string{1: "old", 2: "old", 3: "third", 4: "latest"}}
	h := librarySkillHistories{byID: map[string]*librarySkillHistory{"lib": item}, byName: map[string][]*librarySkillHistory{"alpha": {item}}}
	for _, tc := range []struct {
		name, digest, id string
		base             int
		status           string
		match            int
	}{
		{"new", "data", "", 0, "notInLibrary", 0},
		{"Alpha", "latest", "", 0, "same", 4},
		{"Alpha", "old", "", 0, "same", 2},
		{"alpha", "change", "lib", 4, "differs", 0},
		{"alpha", "change", "lib", 1, "diverged", 0},
		{"alpha", "third", "lib", 1, "diverged", 3},
		{"alpha", "old", "lib", 1, "same", 2},
		{"alpha", "latest", "lib", 1, "same", 4},
	} {
		got := h.compare(tc.name, tc.digest, tc.id, tc.base)
		if got.Status != tc.status || got.MatchedRevision != tc.match || got.BaseRevision != tc.base {
			t.Errorf("%+v: got %+v", tc, got)
		}
	}
}

func TestDeviceAndDraftReadCurrentLibraryRelation(t *testing.T) {
	db := newTestStore(t)
	ctx := t.Context()
	registerAgentSessionTestDaemon(t, db, "ws_drafts", "agent_drafts")
	first, idx := versionArchive(t, "demo", "one", zip.Store)
	source := store.PromoteSkillInput{DeviceID: "dev", Root: "/skills", DirName: "demo"}
	item, _, err := db.AddPromotedSkillRevision(ctx, source, "demo", "", first, 1)
	if err != nil {
		t.Fatal(err)
	}
	draft := store.WorkspaceDraftSkill{ID: "draft", Name: "demo", RelativePath: ".agents/skills/demo", Status: "ready", Digest: "prepared-with-dependencies", SourceDigest: idx.SourceDigest}
	if err = db.SaveWorkspaceDrafts(ctx, "ws_drafts", "ws_drafts", store.WorkspaceDraftSkills{Skills: []store.WorkspaceDraftSkill{draft}}); err != nil {
		t.Fatal(err)
	}
	device := store.DeviceSkill{Name: "demo", Root: source.Root, DirName: "demo", SourceDigest: idx.SourceDigest}
	if _, err = db.ReplaceDeviceSkills(ctx, store.ReplaceDeviceSkillsInput{DeviceID: source.DeviceID, Skills: []store.DeviceSkill{device}}); err != nil {
		t.Fatal(err)
	}
	second, _ := versionArchive(t, "demo", "two", zip.Store)
	if _, _, err = db.AddPromotedSkillRevision(ctx, source, "demo", "", second, 1); err != nil {
		t.Fatal(err)
	}
	view, err := db.WorkspaceDrafts(ctx, "ws_drafts", "ws_drafts")
	if err != nil {
		t.Fatal(err)
	}
	local, err := db.ListDeviceSkills(ctx, source.DeviceID)
	if err != nil {
		t.Fatal(err)
	}
	for _, got := range []*store.SkillLibraryRelation{view.Skills[0].LibraryRelation, local[0].LibraryRelation} {
		if got == nil || got.Status != "same" || got.SkillID != item.ID || got.MatchedRevision != 1 || got.LatestRevision != 2 {
			t.Fatalf("historical source comparison: %+v", got)
		}
	}
}
