package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/skillarchive"
	"github.com/foundry-dev/foundry/apps/server/internal/skillrepo"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// localRepo stands in for a remote: any URL reads one local repository.
type localRepo struct {
	t   *testing.T
	dir string
}

func (l localRepo) git(args ...string) string {
	l.t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = l.dir
	cmd.Env = append(os.Environ(), "GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@example.com", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@example.com", "GIT_CONFIG_GLOBAL=/dev/null")
	out, err := cmd.CombinedOutput()
	if err != nil {
		l.t.Fatalf("git %v: %v %s", args, err, out)
	}
	return strings.TrimSpace(string(out))
}

func (l localRepo) commit(files map[string]string) {
	l.t.Helper()
	for name, body := range files {
		full := filepath.Join(l.dir, name)
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			l.t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(body), 0o644); err != nil {
			l.t.Fatal(err)
		}
	}
	l.git("add", "-A")
	l.git("commit", "--quiet", "-m", "change")
}

func (l localRepo) Resolve(_ context.Context, _ string, ref string) (string, error) {
	if ref == "" {
		ref = "HEAD"
	}
	return l.git("rev-parse", ref+"^{commit}"), nil
}

// LatestRelease reads the local repository's tags the way the real
// transport reads a remote's.
// Describe gives every local repository the same description.
func (l localRepo) Describe(context.Context, string) (string, error) {
	return "Skills for testing", nil
}

func (l localRepo) LatestRelease(ctx context.Context, _ string) (string, string, bool, error) {
	// A repository without tags makes show-ref exit 1 with no output.
	out, _ := exec.Command("git", "-C", l.dir, "show-ref", "--tags", "-d").Output()
	return skillrepo.LatestReleaseFromRefs(string(out))
}

func (l localRepo) Fetch(_ context.Context, _ string, ref string) (*skillrepo.Checkout, error) {
	dir := l.t.TempDir()
	if out, err := exec.Command("cp", "-r", l.dir+"/.", dir).CombinedOutput(); err != nil {
		l.t.Fatalf("copy: %v %s", err, out)
	}
	copy := localRepo{t: l.t, dir: dir}
	if ref != "" {
		copy.git("checkout", "--quiet", ref)
	}
	return &skillrepo.Checkout{Dir: dir, Commit: copy.git("rev-parse", "HEAD")}, nil
}

// skillContent reads a library skill's SKILL.md at its latest revision.
func skillContent(t *testing.T, db store.Store, skillID string) (string, int) {
	t.Helper()
	ctx := context.Background()
	item, err := db.GetPromotedSkill(ctx, skillID)
	if err != nil {
		t.Fatal(err)
	}
	pkg, err := db.GetSkillPackage(ctx, skillID, item.LatestRevision)
	if err != nil {
		t.Fatal(err)
	}
	text, err := skillarchive.ReadStoredFile(pkg.Content, pkg.Checksum, "SKILL.md")
	if err != nil {
		t.Fatal(err)
	}
	return string(text), item.LatestRevision
}

// An admin follows a repository and picks skills from it. The picked skills
// follow the repository's releases by themselves: a changed skill gets a
// revision, an unchanged one none, a workspace pinned to a revision keeps
// it, a skill gone from the repository stays in the library flagged, and a
// rollback holds the repository until it is resumed.
func TestSkillRepositoryLifecycle(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	f := newIsolationFixture(t)
	ctx := context.Background()
	repo := localRepo{t: t, dir: t.TempDir()}
	repo.git("init", "--quiet", "--initial-branch=main")
	repo.commit(map[string]string{
		"skills/review/SKILL.md": "---\nname: review\ndescription: Reviews\n---\nv1\n",
		"skills/notes/SKILL.md":  "---\nname: notes\n---\n",
		"README.md":              "x",
	})
	repo.git("tag", "v1.0.0")
	// Work after the release is not taken until it is released.
	repo.commit(map[string]string{"skills/review/SKILL.md": "---\nname: review\n---\nunreleased\n"})
	f.server.skillRepos = repo
	call := func(session, method, path, body string, want int) []byte {
		t.Helper()
		recorder := doAuthCall(t, f.handler, f.as(session, method, path, body))
		expectStatus(t, recorder, want, method+" "+path)
		return recorder.Body.Bytes()
	}

	call(f.bob, http.MethodPost, "/api/skill-repositories", `{"url":"acme/skills"}`, http.StatusForbidden)
	call(f.alice, http.MethodPost, "/api/skill-repositories", `{"url":"git@github.com:acme/skills.git"}`, http.StatusBadRequest)
	var added store.SkillRepositoryView
	_ = json.Unmarshal(call(f.alice, http.MethodPost, "/api/skill-repositories", `{"url":"acme/skills","subpath":"skills"}`, http.StatusCreated), &added)
	if added.Repository.Label != "github.com/acme/skills" || len(added.Available) != 2 {
		t.Fatalf("added %+v", added)
	}
	if added.Repository.Description != "Skills for testing" {
		t.Fatalf("added repository description %q, want the host's", added.Repository.Description)
	}
	var listed []store.SkillRepository
	_ = json.Unmarshal(call(f.bob, http.MethodGet, "/api/skill-repositories", ``, http.StatusOK), &listed)
	if len(listed) != 1 || listed[0].Description != "Skills for testing" {
		t.Fatalf("listed repositories %+v, want the stored description", listed)
	}
	call(f.alice, http.MethodPost, "/api/skill-repositories", `{"url":"https://github.com/acme/skills.git","subpath":"skills"}`, http.StatusConflict)
	call(f.alice, http.MethodPost, "/api/skill-repositories", `{"url":"acme/other","subpath":"skills","tools":[{"source":"uv","package":"x"}]}`, http.StatusBadRequest)
	id := added.Repository.ID

	call(f.alice, http.MethodPost, "/api/skill-repositories/"+id+"/import", `{"dirs":["skills/nope"]}`, http.StatusBadRequest)
	var imported store.SkillRepository
	_ = json.Unmarshal(call(f.alice, http.MethodPost, "/api/skill-repositories/"+id+"/import", `{"dirs":["skills/review","skills/notes"]}`, http.StatusOK), &imported)
	if len(imported.Skills) != 2 || imported.Version != "v1.0.0" || len(imported.Versions) != 1 || len(imported.Versions[0].Added) != 2 {
		t.Fatalf("imported %+v", imported)
	}
	ids := map[string]string{}
	for _, skill := range imported.Skills {
		ids[skill.Name] = skill.SkillID
	}
	review, notes := ids["review"], ids["notes"]
	skill, err := f.server.store.GetPromotedSkill(ctx, review)
	if err != nil || skill.LatestRevision != 1 || skill.OriginDeviceID != store.RepositoryOrigin(id) || skill.OriginRoot != "github.com/acme/skills" {
		t.Fatalf("library skill %+v, %v", skill, err)
	}
	if text, _ := skillContent(t, f.server.store, review); !strings.Contains(text, "v1") {
		t.Fatalf("picked the unreleased work instead of the release: %q", text)
	}

	// The workspace uses both skills and holds review at revision 1.
	call(f.alice, http.MethodPut, "/api/workspaces/ws_alice/skills", `{"skillIds":["`+review+`","`+notes+`"]}`, http.StatusOK)
	call(f.alice, http.MethodPut, "/api/workspaces/ws_alice/skills/"+review+"/pin", `{"revision":1}`, http.StatusOK)
	workspaceRevisions := func() map[string]int {
		t.Helper()
		refs, err := sessionSkillRefs(ctx, f.server.store, "ws_alice", "codex")
		if err != nil {
			t.Fatal(err)
		}
		revisions := map[string]int{}
		for _, ref := range refs {
			revisions[ref.SkillID] = ref.Revision
		}
		return revisions
	}
	check := func() store.SkillRepository {
		t.Helper()
		var checked store.SkillRepository
		_ = json.Unmarshal(call(f.alice, http.MethodPost, "/api/skill-repositories/"+id+"/check", ``, http.StatusOK), &checked)
		return checked
	}
	skillOf := func(repo store.SkillRepository, skillID string) store.SkillRepositorySkill {
		t.Helper()
		for _, skill := range repo.Skills {
			if skill.SkillID == skillID {
				return skill
			}
		}
		t.Fatalf("%s is no longer linked to its repository", skillID)
		return store.SkillRepositorySkill{}
	}
	if checked := check(); len(checked.Versions) != 1 {
		t.Fatalf("a check without a new release recorded a version: %+v", checked.Versions)
	}

	// v1.1.0 changes review only: review gets revision 2 by itself, notes
	// none, and the pinned workspace stays on review's revision 1.
	repo.commit(map[string]string{"skills/review/SKILL.md": "---\nname: review\ndescription: Reviews better\n---\nv2\n", "skills/review/extra.md": "new"})
	repo.git("tag", "v1.1.0")
	checked := check()
	if latest := checked.Versions[0]; checked.Version != "v1.1.0" || strings.Join(latest.Changed, ",") != "review" || len(latest.Added)+len(latest.Missing) != 0 {
		t.Fatalf("update %q %+v", checked.Version, latest)
	}
	if text, revision := skillContent(t, f.server.store, review); revision != 2 || !strings.Contains(text, "v2") {
		t.Fatalf("review is at revision %d: %q", revision, text)
	}
	if _, revision := skillContent(t, f.server.store, notes); revision != 1 {
		t.Fatalf("unchanged notes got revision %d", revision)
	}
	if latest, _ := f.server.store.GetPromotedSkill(ctx, review); latest.Description != "Reviews better" {
		t.Fatalf("review's description %q", latest.Description)
	}
	if revisions := workspaceRevisions(); revisions[review] != 1 || revisions[notes] != 1 {
		t.Fatalf("workspace runs %v; the pin must hold review at 1", revisions)
	}

	// v1.2.0 drops notes: the library keeps it at its revision, flagged, and
	// the workspace keeps using it.
	if err := os.RemoveAll(filepath.Join(repo.dir, "skills/notes")); err != nil {
		t.Fatal(err)
	}
	repo.commit(map[string]string{"README.md": "y"})
	repo.git("tag", "v1.2.0")
	checked = check()
	if latest := checked.Versions[0]; strings.Join(latest.Missing, ",") != "notes" || len(latest.Changed) != 0 || !skillOf(checked, notes).Missing {
		t.Fatalf("notes gone upstream: %+v / %+v", latest, checked.Skills)
	}
	if _, revision := skillContent(t, f.server.store, notes); revision != 1 {
		t.Fatalf("notes moved to revision %d after leaving the repository", revision)
	}
	if revisions := workspaceRevisions(); revisions[notes] != 1 {
		t.Fatalf("the workspace lost notes: %v", revisions)
	}

	// Rolling back to v1.0.0 restores its skills and pauses updates; the
	// repository takes no new skills until resumed.
	var rolled store.SkillRepository
	call(f.bob, http.MethodPost, "/api/skill-repositories/"+id+"/rollback", `{"seq":1}`, http.StatusForbidden)
	_ = json.Unmarshal(call(f.alice, http.MethodPost, "/api/skill-repositories/"+id+"/rollback", `{"seq":1}`, http.StatusOK), &rolled)
	if !rolled.Paused || rolled.Version != "v1.0.0" || !rolled.Versions[0].RolledBack || skillOf(rolled, notes).Missing {
		t.Fatalf("rollback %+v", rolled)
	}
	if text, _ := skillContent(t, f.server.store, review); !strings.Contains(text, "v1") {
		t.Fatalf("rollback left review at %q", text)
	}
	if checked := check(); checked.Version != "v1.0.0" {
		t.Fatal("a paused repository moved on a check")
	}
	call(f.alice, http.MethodPost, "/api/skill-repositories/"+id+"/import", `{"dirs":["skills/review"]}`, http.StatusConflict)
	var resumed store.SkillRepository
	_ = json.Unmarshal(call(f.alice, http.MethodPost, "/api/skill-repositories/"+id+"/resume", ``, http.StatusOK), &resumed)
	if resumed.Paused || resumed.Version != "v1.2.0" || !skillOf(resumed, notes).Missing {
		t.Fatalf("resume %+v", resumed)
	}
	if text, _ := skillContent(t, f.server.store, review); !strings.Contains(text, "v2") {
		t.Fatalf("resume left review at %q", text)
	}

	call(f.alice, http.MethodDelete, "/api/skill-repositories/"+id, ``, http.StatusOK)
	if _, err := f.server.store.GetPromotedSkill(ctx, review); err != nil {
		t.Fatal("removing the repository removed its skill from the library")
	}
}

// A repository followed by picking before picked skills followed versions
// has skills but no version: its first check takes the version it follows,
// giving changed skills a revision and unchanged ones none.
func TestPickedSkillsFromBeforeFollowVersions(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	f := newIsolationFixture(t)
	ctx := context.Background()
	repo := localRepo{t: t, dir: t.TempDir()}
	repo.git("init", "--quiet", "--initial-branch=main")
	repo.commit(map[string]string{
		"skills/review/SKILL.md": "---\nname: review\n---\nv1\n",
		"skills/notes/SKILL.md":  "---\nname: notes\n---\nv1\n",
	})
	f.server.skillRepos = repo
	repos := f.server.store.(skillRepositoryStore)
	old, err := repos.CreateSkillRepository(ctx, store.SkillRepository{URL: "https://github.com/acme/old", Label: "github.com/acme/old", Subpath: "skills", Commit: repo.git("rev-parse", "HEAD")}, "")
	if err != nil {
		t.Fatal(err)
	}
	checkout, err := repo.Fetch(ctx, old.URL, "")
	if err != nil {
		t.Fatal(err)
	}
	ids := map[string]string{}
	for _, dir := range []string{"skills/review", "skills/notes"} {
		pkg, count, err := checkout.Pack(dir)
		if err != nil {
			t.Fatal(err)
		}
		skill, _, err := f.server.store.AddPromotedSkillRevision(ctx, store.PromoteSkillInput{DeviceID: store.RepositoryOrigin(old.ID), Root: old.Label, DirName: dir}, filepath.Base(dir), "", pkg, count)
		if err != nil {
			t.Fatal(err)
		}
		if err := repos.LinkSkillRepositorySkill(ctx, old.ID, dir, skill.ID, checkout.Commit); err != nil {
			t.Fatal(err)
		}
		ids[skill.Name] = skill.ID
	}
	repo.commit(map[string]string{"skills/review/SKILL.md": "---\nname: review\n---\nv2\n"})

	var checked store.SkillRepository
	recorder := doAuthCall(t, f.handler, f.as(f.alice, http.MethodPost, "/api/skill-repositories/"+old.ID+"/check", ``))
	expectStatus(t, recorder, http.StatusOK, "check")
	_ = json.Unmarshal(recorder.Body.Bytes(), &checked)
	if len(checked.Versions) != 1 || strings.Join(checked.Versions[0].Changed, ",") != "review" || checked.Version != repo.git("rev-parse", "--short=7", "HEAD") {
		t.Fatalf("first check of an old picked repository: version %q %+v", checked.Version, checked.Versions)
	}
	if _, revision := skillContent(t, f.server.store, ids["review"]); revision != 2 {
		t.Fatalf("review at revision %d, want 2", revision)
	}
	if _, revision := skillContent(t, f.server.store, ids["notes"]); revision != 1 {
		t.Fatalf("notes at revision %d, want 1", revision)
	}
}
