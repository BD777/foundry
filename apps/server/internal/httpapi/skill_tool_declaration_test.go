package httpapi

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os/exec"
	"strings"
	"sync"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// pypiFake answers PyPI's JSON API for one project: its latest release and
// the releases it has, or 503 while down.
type pypiFake struct {
	mu       sync.Mutex
	latest   string
	releases map[string]bool
	down     bool
}

func (p *pypiFake) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.down {
		http.Error(w, "unavailable", http.StatusServiceUnavailable)
		return
	}
	version := ""
	switch parts := strings.Split(strings.Trim(r.URL.Path, "/"), "/"); {
	case len(parts) == 3 && parts[0] == "pypi" && parts[1] == "browser-use" && parts[2] == "json":
		version = p.latest
	case len(parts) == 4 && parts[0] == "pypi" && parts[1] == "browser-use" && parts[3] == "json" && p.releases[parts[2]]:
		version = parts[2]
	default:
		http.NotFound(w, r)
		return
	}
	_ = json.NewEncoder(w).Encode(map[string]any{"info": map[string]any{"version": version, "yanked": false}})
}

func (p *pypiFake) set(change func(*pypiFake)) {
	p.mu.Lock()
	defer p.mu.Unlock()
	change(p)
}

// A bundle can declare a Python CLI installed with uv: the tool takes the
// PyPI release matching the bundle's version (else PyPI's latest), is
// retried when PyPI does not answer, and installs on a device only when
// asked, through a worker that installs uv packages.
func TestBundleDeclaresUvTool(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	f := newIsolationFixture(t)
	repo := localRepo{t: t, dir: t.TempDir()}
	repo.git("init", "--quiet", "--initial-branch=main")
	repo.commit(map[string]string{
		"skills/browser-use/SKILL.md": "---\nname: browser-use\ndescription: Browser control\n---\nv1\n",
		"skills/cloud/SKILL.md":       "---\nname: cloud\n---\n",
	})
	repo.git("tag", "0.13.11")
	f.server.skillRepos = repo
	noReleases := httptest.NewServer(http.NotFoundHandler())
	defer noReleases.Close()
	f.server.releaseAPI = noReleases.URL
	pypi := &pypiFake{latest: "0.13.11", releases: map[string]bool{"0.13.11": true}}
	pypiServer := httptest.NewServer(pypi)
	defer pypiServer.Close()
	f.server.pypiAPI = pypiServer.URL
	call := func(method, path, body string, want int) []byte {
		t.Helper()
		recorder := doAuthCall(t, f.handler, f.as(f.alice, method, path, body))
		expectStatus(t, recorder, want, method+" "+path)
		return recorder.Body.Bytes()
	}
	follow := func(tools string, want int) []byte {
		t.Helper()
		return call(http.MethodPost, "/api/skill-repositories",
			`{"url":"browser-use/browser-use","subpath":"skills/browser-use","mode":"bundle","name":"browser-use","tools":`+tools+`}`, want)
	}

	follow(`[{"source":"pip","package":"browser-use"}]`, http.StatusBadRequest)
	follow(`[{"source":"uv","package":"browser use"}]`, http.StatusBadRequest)
	follow(`[{"source":"uv","package":"browser-use","command":"../bin"}]`, http.StatusBadRequest)
	follow(`[{"source":"uv","package":"a"},{"source":"uv","package":"a"}]`, http.StatusBadRequest)

	var added store.SkillRepositoryView
	_ = json.Unmarshal(follow(`[{"source":"uv","package":"browser-use","command":"browser-use"}]`, http.StatusCreated), &added)
	bundle := added.Repository
	if bundle.Version != "0.13.11" || len(bundle.Skills) != 1 || bundle.Skills[0].Name != "browser-use" {
		t.Fatalf("bundle %+v", bundle)
	}
	want := store.SkillBundleTool{Name: "browser-use", Version: "0.13.11", Source: "uv", Package: "browser-use"}
	if len(bundle.Tools) != 1 || bundle.Tools[0].Name != want.Name || bundle.Tools[0].Version != want.Version || bundle.Tools[0].Source != want.Source || bundle.Tools[0].Package != want.Package {
		t.Fatalf("tools %+v, want %+v", bundle.Tools, want)
	}
	var listed []store.SkillRepository
	_ = json.Unmarshal(call(http.MethodGet, "/api/skill-repositories", ``, http.StatusOK), &listed)
	if len(listed) != 1 || len(listed[0].DeclaredTools) != 1 || listed[0].DeclaredTools[0] != (store.SkillToolDeclaration{Source: "uv", Package: "browser-use", Command: "browser-use"}) {
		t.Fatalf("declared tools after reload %+v", listed)
	}
	check := func() store.SkillRepository {
		t.Helper()
		var checked store.SkillRepository
		_ = json.Unmarshal(call(http.MethodPost, "/api/skill-repositories/"+bundle.ID+"/check", ``, http.StatusOK), &checked)
		return checked
	}

	// A release PyPI does not have yet takes PyPI's latest.
	repo.commit(map[string]string{"skills/browser-use/SKILL.md": "---\nname: browser-use\n---\nv2\n"})
	repo.git("tag", "0.14.0")
	pypi.set(func(p *pypiFake) { p.latest = "0.13.12"; p.releases["0.13.12"] = true })
	if checked := check(); checked.Version != "0.14.0" || len(checked.Tools) != 1 || checked.Tools[0].Version != "0.13.12" {
		t.Fatalf("PyPI behind the release: %q %+v", checked.Version, checked.Tools)
	}

	// PyPI down at a release: the tool waits, the card says why, and the
	// next check reads it although the bundle's version did not move.
	repo.commit(map[string]string{"skills/browser-use/SKILL.md": "---\nname: browser-use\n---\nv3\n"})
	repo.git("tag", "0.15.0")
	pypi.set(func(p *pypiFake) { p.down = true })
	if checked := check(); checked.Version != "0.15.0" || len(checked.Tools) != 0 || !strings.Contains(checked.Error, "PyPI") {
		t.Fatalf("PyPI down: %q tools %+v error %q", checked.Version, checked.Tools, checked.Error)
	}
	pypi.set(func(p *pypiFake) { p.down = false; p.latest = "0.15.0"; p.releases["0.15.0"] = true })
	checked := check()
	if len(checked.Tools) != 1 || checked.Tools[0].Version != "0.15.0" || checked.Error != "" || len(checked.Versions) != 3 {
		t.Fatalf("PyPI back: tools %+v error %q versions %d", checked.Tools, checked.Error, len(checked.Versions))
	}

	// Rolling back restores the tool version recorded with that version,
	// without asking PyPI; resuming moves it forward with the skills.
	rollback := func(seq string) store.SkillRepository {
		t.Helper()
		var rolled store.SkillRepository
		_ = json.Unmarshal(call(http.MethodPost, "/api/skill-repositories/"+bundle.ID+"/rollback", `{"seq":`+seq+`}`, http.StatusOK), &rolled)
		return rolled
	}
	toolVersion := func(repo store.SkillRepository) string {
		if len(repo.Tools) != 1 || repo.Tools[0].Name != "browser-use" || repo.Tools[0].Source != "uv" {
			return fmt.Sprintf("%+v", repo.Tools)
		}
		return repo.Tools[0].Version
	}
	pypi.set(func(p *pypiFake) { p.down = true })
	if rolled := rollback("1"); !rolled.Paused || rolled.Version != "0.13.11" || toolVersion(rolled) != "0.13.11" {
		t.Fatalf("rollback to 0.13.11: %q paused %v tool %s", rolled.Version, rolled.Paused, toolVersion(rolled))
	}
	pypi.set(func(p *pypiFake) { p.down = false })
	var resumed store.SkillRepository
	_ = json.Unmarshal(call(http.MethodPost, "/api/skill-repositories/"+bundle.ID+"/resume", ``, http.StatusOK), &resumed)
	if resumed.Paused || resumed.Version != "0.15.0" || toolVersion(resumed) != "0.15.0" {
		t.Fatalf("resume: %q paused %v tool %s", resumed.Version, resumed.Paused, toolVersion(resumed))
	}
	if rolled := rollback("2"); rolled.Version != "0.14.0" || toolVersion(rolled) != "0.13.12" {
		t.Fatalf("rollback to 0.14.0: %q tool %s", rolled.Version, toolVersion(rolled))
	}
	// 0.15.0 was recorded without its tool (PyPI was down), as versions
	// recorded before they held their tools are: it is read for that version.
	if rolled := rollback("3"); rolled.Version != "0.15.0" || toolVersion(rolled) != "0.15.0" || rolled.Error != "" {
		t.Fatalf("rollback to 0.15.0: %q tool %s error %q", rolled.Version, toolVersion(rolled), rolled.Error)
	}

	// Installing goes to a worker that installs uv packages, on request; the
	// worker's own words (e.g. that uv is missing) reach the person.
	old := &daemonConnection{deviceID: "dev_alice", done: make(chan struct{}), rpc: newDaemonRPC(), send: make(chan wsEnvelope, 4),
		registration: store.DaemonRegistration{Capabilities: []string{toolInstallCapability}}}
	f.server.hub.mu.Lock()
	f.server.hub.connections["dev_alice"] = old
	f.server.hub.mu.Unlock()
	install := `{"repositoryId":"` + bundle.ID + `","tool":"browser-use"}`
	call(http.MethodPost, "/api/devices/dev_alice/tools/install", install, http.StatusConflict)

	device := &daemonConnection{deviceID: "dev_alice", done: make(chan struct{}), rpc: newDaemonRPC(), send: make(chan wsEnvelope, 4),
		registration: store.DaemonRegistration{Capabilities: []string{toolInstallCapability, toolSourcesCapability}}}
	f.server.hub.mu.Lock()
	f.server.hub.connections["dev_alice"] = device
	f.server.hub.mu.Unlock()
	requests := make(chan wsInstallTool, 4)
	answers := make(chan map[string]string, 4)
	go func() {
		for envelope := range device.send {
			var request wsInstallTool
			_ = json.Unmarshal(envelope.Payload, &request)
			requests <- request
			payload, _ := json.Marshal(<-answers)
			device.rpc.resolve(envelope.ID, payload)
		}
	}()
	answers <- map[string]string{"error": "browser-use needs uv, which is not on this device; install uv (docs.astral.sh/uv) and try again"}
	recorder := doAuthCall(t, f.handler, f.as(f.alice, http.MethodPost, "/api/devices/dev_alice/tools/install", install))
	expectStatus(t, recorder, http.StatusBadGateway, "install without uv")
	if !strings.Contains(recorder.Body.String(), "needs uv") {
		t.Fatalf("install without uv answered %s", recorder.Body.String())
	}
	if request := <-requests; request.Tool.Source != "uv" || request.Tool.Package != "browser-use" || request.Tool.Version != "0.15.0" || request.Step != "install" {
		t.Fatalf("install request %+v", request)
	}
	answers <- map[string]string{"name": "browser-use", "version": "0.15.0"}
	call(http.MethodPost, "/api/devices/dev_alice/tools/install", install, http.StatusOK)
	<-requests
	call(http.MethodPost, "/api/devices/dev_alice/tools/install", `{"repositoryId":"`+bundle.ID+`","tool":"browser-use","step":"setup"}`, http.StatusBadRequest)
}
