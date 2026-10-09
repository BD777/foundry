package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/skillarchive"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// A repository followed as a bundle takes every skill at its newest
// release, moves to the next release by itself (adding, changing and
// retiring skills together), delivers its current skills to workspaces that
// use it, and can be rolled back, which holds it until resumed.
func TestSkillBundleLifecycle(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	f := newIsolationFixture(t)
	ctx := context.Background()
	repo := localRepo{t: t, dir: t.TempDir()}
	repo.git("init", "--quiet", "--initial-branch=main")
	repo.commit(map[string]string{
		"skills/manifest.yaml":         "skills: [tools-docs, tools-mail]\n",
		"skills/tools-docs/SKILL.md":   "---\nname: tools-docs\ndescription: Docs\n---\nv1\n",
		"skills/tools-mail/SKILL.md":   "---\nname: tools-mail\ndescription: Mail\n---\nv1\n",
		"skills/tools-mail/scripts.sh": "echo mail\n",
	})
	repo.git("tag", "v1.0.0")
	// Work after the release is not followed until it is released.
	repo.commit(map[string]string{"skills/tools-docs/SKILL.md": "---\nname: tools-docs\n---\nunreleased\n"})
	f.server.skillRepos = repo
	var releasesDown atomic.Bool
	release := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if releasesDown.Load() {
			http.Error(w, "rate limited", http.StatusForbidden)
			return
		}
		tag := r.URL.Path[strings.LastIndex(r.URL.Path, "/")+1:]
		if !strings.HasPrefix(r.URL.Path, "/repos/acme/tools/releases/tags/") {
			http.NotFound(w, r)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"tag_name": tag, "assets": []map[string]string{
			{"name": "tools_" + tag + "_linux-amd64.tar.gz", "browser_download_url": "https://github.com/acme/tools/releases/download/" + tag + "/tools_linux-amd64.tar.gz"},
			{"name": "tools_" + tag + "_darwin-arm64.tar.gz", "browser_download_url": "https://github.com/acme/tools/releases/download/" + tag + "/tools_darwin-arm64.tar.gz"},
			{"name": "tools_" + tag + "_windows-amd64.zip", "browser_download_url": "https://github.com/acme/tools/releases/download/" + tag + "/w.zip"},
			{"name": "checksums.txt", "browser_download_url": "https://github.com/acme/tools/releases/download/" + tag + "/checksums.txt"},
		}})
	}))
	defer release.Close()
	f.server.releaseAPI = release.URL
	call := func(session, method, path, body string, want int) []byte {
		t.Helper()
		recorder := doAuthCall(t, f.handler, f.as(session, method, path, body))
		expectStatus(t, recorder, want, method+" "+path)
		return recorder.Body.Bytes()
	}

	var preview struct {
		SuggestBundle bool   `json:"suggestBundle"`
		Release       string `json:"release"`
		Name          string `json:"name"`
	}
	_ = json.Unmarshal(call(f.alice, http.MethodGet, "/api/skill-repositories/preview?url=acme/tools&subpath=skills", ``, http.StatusOK), &preview)
	if !preview.SuggestBundle || preview.Release != "v1.0.0" || preview.Name != "tools" {
		t.Fatalf("preview %+v", preview)
	}
	var added store.SkillRepositoryView
	_ = json.Unmarshal(call(f.alice, http.MethodPost, "/api/skill-repositories", `{"url":"acme/tools","subpath":"skills","mode":"bundle"}`, http.StatusCreated), &added)
	bundle := added.Repository
	if bundle.Mode != "bundle" || bundle.Version != "v1.0.0" || len(bundle.Skills) != 2 || len(bundle.Versions) != 1 || len(bundle.Versions[0].Added) != 2 {
		t.Fatalf("bundle %+v", bundle)
	}
	if len(bundle.Tools) != 1 || bundle.Tools[0].Name != "tools" || len(bundle.Tools[0].Assets) != 2 || bundle.Tools[0].ChecksumsURL == "" {
		t.Fatalf("tools %+v", bundle.Tools)
	}
	content := func(skillID string) string {
		t.Helper()
		item, err := f.server.store.GetPromotedSkill(ctx, skillID)
		if err != nil {
			t.Fatal(err)
		}
		pkg, err := f.server.store.GetSkillPackage(ctx, skillID, item.LatestRevision)
		if err != nil {
			t.Fatal(err)
		}
		text, err := skillarchive.ReadStoredFile(pkg.Content, pkg.Checksum, "SKILL.md")
		if err != nil {
			t.Fatal(err)
		}
		return string(text)
	}
	byName := map[string]string{}
	for _, skill := range bundle.Skills {
		byName[skill.Name] = skill.SkillID
	}
	if !strings.Contains(content(byName["tools-docs"]), "v1") {
		t.Fatal("the bundle took unreleased work instead of the release")
	}

	call(f.alice, http.MethodPut, "/api/workspaces/ws_alice/skill-bundles", `{"bundleIds":["`+bundle.ID+`"]}`, http.StatusOK)
	names := func() string {
		t.Helper()
		refs, err := sessionSkillRefs(ctx, f.server.store, "ws_alice", "codex")
		if err != nil {
			t.Fatal(err)
		}
		var list []string
		for _, ref := range refs {
			list = append(list, ref.Name)
		}
		return strings.Join(list, ",")
	}
	if got := names(); got != "tools-docs,tools-mail" {
		t.Fatalf("workspace gets %q", got)
	}

	// v1.1.0 changes docs, adds calendar and drops mail.
	if err := os.RemoveAll(filepath.Join(repo.dir, "skills/tools-mail")); err != nil {
		t.Fatal(err)
	}
	repo.commit(map[string]string{
		"skills/tools-docs/SKILL.md":     "---\nname: tools-docs\ndescription: Docs\n---\nv2\n",
		"skills/tools-calendar/SKILL.md": "---\nname: tools-calendar\ndescription: Calendar\n---\nv1\n",
	})
	repo.git("tag", "v1.1.0")
	var checked store.SkillRepository
	_ = json.Unmarshal(call(f.alice, http.MethodPost, "/api/skill-repositories/"+bundle.ID+"/check", ``, http.StatusOK), &checked)
	latest := checked.Versions[0]
	if checked.Version != "v1.1.0" || strings.Join(latest.Added, ",") != "tools-calendar" || strings.Join(latest.Changed, ",") != "tools-docs" || strings.Join(latest.Removed, ",") != "tools-mail" {
		t.Fatalf("update %+v / %+v", checked.Version, latest)
	}
	if got := names(); got != "tools-calendar,tools-docs" {
		t.Fatalf("after the update the workspace gets %q", got)
	}
	if !strings.Contains(content(byName["tools-docs"]), "v2") {
		t.Fatal("docs was not updated")
	}

	// Roll back to v1.0.0: its skills return as new revisions and updates pause.
	var rolled store.SkillRepository
	_ = json.Unmarshal(call(f.alice, http.MethodPost, "/api/skill-repositories/"+bundle.ID+"/rollback", `{"seq":1}`, http.StatusOK), &rolled)
	if !rolled.Paused || rolled.Version != "v1.0.0" || !rolled.Versions[0].RolledBack {
		t.Fatalf("rollback %+v", rolled)
	}
	if got := names(); got != "tools-docs,tools-mail" {
		t.Fatalf("after the rollback the workspace gets %q", got)
	}
	if !strings.Contains(content(byName["tools-docs"]), "v1") {
		t.Fatal("rollback did not restore docs")
	}
	// The release's program goes back with its skills.
	toolAt := func(repo store.SkillRepository, version string) bool {
		return len(repo.Tools) == 1 && repo.Tools[0].Version == version && len(repo.Tools[0].Assets) == 2 &&
			strings.Contains(repo.Tools[0].Assets[0].URL, "/"+version+"/")
	}
	if !toolAt(rolled, "v1.0.0") {
		t.Fatalf("after the rollback the tool is %+v, want v1.0.0", rolled.Tools)
	}
	_ = json.Unmarshal(call(f.alice, http.MethodPost, "/api/skill-repositories/"+bundle.ID+"/check", ``, http.StatusOK), &checked)
	if checked.Version != "v1.0.0" || !toolAt(checked, "v1.0.0") {
		t.Fatalf("a paused bundle moved on a check: %q %+v", checked.Version, checked.Tools)
	}
	// Resuming moves the tool forward with the skills, to the one recorded
	// with v1.1.0 when GitHub does not answer.
	releasesDown.Store(true)
	var resumed store.SkillRepository
	_ = json.Unmarshal(call(f.alice, http.MethodPost, "/api/skill-repositories/"+bundle.ID+"/resume", ``, http.StatusOK), &resumed)
	releasesDown.Store(false)
	if resumed.Paused || resumed.Version != "v1.1.0" || names() != "tools-calendar,tools-docs" {
		t.Fatalf("resume %+v -> %q", resumed.Version, names())
	}
	if !toolAt(resumed, "v1.1.0") {
		t.Fatalf("after resuming the tool is %+v, want v1.1.0", resumed.Tools)
	}

	// A person's default bundles reach the workspaces of their devices.
	call(f.alice, http.MethodPut, "/api/workspaces/ws_alice/skill-bundles", `{"bundleIds":[]}`, http.StatusOK)
	call(f.alice, http.MethodPut, "/api/me/default-skills", `{"skillIds":[],"bundleIds":["`+bundle.ID+`"]}`, http.StatusOK)
	refs, defaults, err := workspaceSkillRefs(ctx, f.server.store, "ws_alice")
	if err != nil || len(refs) != 2 || len(defaults) != 2 {
		t.Fatalf("default bundle refs %+v defaults %v err %v", refs, defaults, err)
	}
	var data store.FoundryDataProjection
	_ = json.Unmarshal(call(f.alice, http.MethodGet, "/api/foundry-data?workspaceId=ws_alice", ``, http.StatusOK), &data)
	if len(data.DefaultBundleIDs) != 1 || data.DefaultBundleIDs[0] != bundle.ID || len(data.WorkspaceBundleIDs) != 1 {
		t.Fatalf("workspace data names default bundles %v, on %v; want the default on", data.DefaultBundleIDs, data.WorkspaceBundleIDs)
	}
	// Unchecking a default bundle in the workspace turns it off there.
	call(f.alice, http.MethodPut, "/api/workspaces/ws_alice/skill-bundles", `{"bundleIds":[]}`, http.StatusOK)
	if refs, _, _ := workspaceSkillRefs(ctx, f.server.store, "ws_alice"); len(refs) != 0 {
		t.Fatalf("default bundle turned off, workspace still gets %+v", refs)
	}
	data = store.FoundryDataProjection{}
	_ = json.Unmarshal(call(f.alice, http.MethodGet, "/api/foundry-data?workspaceId=ws_alice", ``, http.StatusOK), &data)
	if len(data.DefaultBundleIDs) != 1 || len(data.WorkspaceBundleIDs) != 0 {
		t.Fatalf("turned off: default bundles %v, on %v", data.DefaultBundleIDs, data.WorkspaceBundleIDs)
	}
	call(f.alice, http.MethodPut, "/api/workspaces/ws_alice/skill-bundles", `{"bundleIds":["`+bundle.ID+`"]}`, http.StatusOK)
	if refs, _, _ := workspaceSkillRefs(ctx, f.server.store, "ws_alice"); len(refs) != 2 {
		t.Fatalf("default bundle back on, workspace gets %+v", refs)
	}
	if selected, _ := f.server.store.(bundleStore).ListBundleSelection(ctx, bundleScopeWorkspace, "ws_alice"); len(selected) != 0 {
		t.Fatalf("turning a default back on stored a selection %v", selected)
	}
	if bobRefs, _ := sessionSkillRefs(ctx, f.server.store, "ws_bob", "codex"); len(bobRefs) != 0 {
		t.Fatalf("bob's workspace got alice's default bundle: %+v", bobRefs)
	}

	call(f.bob, http.MethodPost, "/api/skill-repositories/"+bundle.ID+"/rollback", `{"seq":1}`, http.StatusForbidden)
	call(f.alice, http.MethodPost, "/api/devices/dev_alice/tools/install", `{"repositoryId":"`+bundle.ID+`","tool":"tools"}`, http.StatusConflict)
}
