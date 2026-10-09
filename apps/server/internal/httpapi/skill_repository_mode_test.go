package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os/exec"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// A repository followed by picking skills becomes a bundle on request: it
// takes the newest release with every skill folder, and a skill picked
// before stays the same library entry.
func TestPickedRepositoryBecomesABundle(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	f := newIsolationFixture(t)
	repo := localRepo{t: t, dir: t.TempDir()}
	repo.git("init", "--quiet", "--initial-branch=main")
	repo.commit(map[string]string{
		"skills/kit-docs/SKILL.md": "---\nname: kit-docs\ndescription: Docs\n---\nv1\n",
		"skills/kit-mail/SKILL.md": "---\nname: kit-mail\ndescription: Mail\n---\nv1\n",
	})
	repo.git("tag", "v1.0.0")
	f.server.skillRepos = repo
	noReleases := httptest.NewServer(http.NotFoundHandler())
	defer noReleases.Close()
	f.server.releaseAPI = noReleases.URL
	call := func(session, method, path, body string, want int) []byte {
		t.Helper()
		recorder := doAuthCall(t, f.handler, f.as(session, method, path, body))
		expectStatus(t, recorder, want, method+" "+path)
		return recorder.Body.Bytes()
	}

	// Picked with nothing added: the repository says how many skills it has.
	var empty store.SkillRepositoryView
	_ = json.Unmarshal(call(f.alice, http.MethodPost, "/api/skill-repositories", `{"url":"acme/one","subpath":"skills","mode":"pick"}`, http.StatusCreated), &empty)
	if empty.Repository.Mode != "pick" || len(empty.Repository.Skills) != 0 || empty.Repository.FoundCount != 2 {
		t.Fatalf("picked repository %+v", empty.Repository)
	}
	call(f.bob, http.MethodPost, "/api/skill-repositories/"+empty.Repository.ID+"/mode", `{"mode":"bundle"}`, http.StatusForbidden)
	call(f.alice, http.MethodPost, "/api/skill-repositories/"+empty.Repository.ID+"/mode", `{"mode":"pick"}`, http.StatusBadRequest)
	var converted store.SkillRepository
	_ = json.Unmarshal(call(f.alice, http.MethodPost, "/api/skill-repositories/"+empty.Repository.ID+"/mode", `{"mode":"bundle"}`, http.StatusOK), &converted)
	if converted.Mode != "bundle" || converted.Version != "v1.0.0" || converted.Name != "one" || len(converted.Skills) != 2 {
		t.Fatalf("converted %+v", converted)
	}

	// Picked with one skill: that skill keeps its library entry.
	var picked store.SkillRepositoryView
	_ = json.Unmarshal(call(f.alice, http.MethodPost, "/api/skill-repositories", `{"url":"acme/two","subpath":"skills","mode":"pick","dirs":["skills/kit-docs"]}`, http.StatusCreated), &picked)
	if len(picked.Repository.Skills) != 1 {
		t.Fatalf("picked %+v", picked.Repository)
	}
	docsID := picked.Repository.Skills[0].SkillID
	_ = json.Unmarshal(call(f.alice, http.MethodPost, "/api/skill-repositories/"+picked.Repository.ID+"/mode", `{"mode":"bundle"}`, http.StatusOK), &converted)
	ids := map[string]string{}
	for _, skill := range converted.Skills {
		ids[skill.Name] = skill.SkillID
	}
	if converted.Mode != "bundle" || len(converted.Skills) != 2 || ids["kit-docs"] != docsID || ids["kit-mail"] == "" {
		t.Fatalf("converted %+v", converted)
	}
	if added := converted.Versions[0].Added; len(added) != 1 || added[0] != "kit-mail" {
		t.Fatalf("the bundle version added %v; want only kit-mail", added)
	}
	// Converting again changes nothing.
	call(f.alice, http.MethodPost, "/api/skill-repositories/"+picked.Repository.ID+"/mode", `{"mode":"bundle"}`, http.StatusOK)
}
