package httpapi

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha512"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/skillrepo"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func npmPackageTarball(t *testing.T, files map[string]string) []byte {
	t.Helper()
	var buffer bytes.Buffer
	compressed := gzip.NewWriter(&buffer)
	archive := tar.NewWriter(compressed)
	for name, body := range files {
		if err := archive.WriteHeader(&tar.Header{Name: "package/" + name, Mode: 0o644, Size: int64(len(body)), Typeflag: tar.TypeReg}); err != nil {
			t.Fatal(err)
		}
		if _, err := archive.Write([]byte(body)); err != nil {
			t.Fatal(err)
		}
	}
	if err := archive.Close(); err != nil {
		t.Fatal(err)
	}
	if err := compressed.Close(); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}

// npmRegistryFake serves one package whose "latest" dist-tag the test moves.
type npmRegistryFake struct {
	mu       sync.Mutex
	name     string
	latest   string
	tarballs map[string][]byte
	server   *httptest.Server
}

func (f *npmRegistryFake) publish(version string, tarball []byte) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.tarballs[version] = tarball
	f.latest = version
}

func (f *npmRegistryFake) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	switch {
	case r.URL.Path == "/"+f.name:
		versions := map[string]any{}
		for version, tarball := range f.tarballs {
			sum := sha512.Sum512(tarball)
			versions[version] = map[string]any{"version": version, "dist": map[string]string{
				"tarball":   f.server.URL + "/" + f.name + "/-/" + version + ".tgz",
				"integrity": "sha512-" + base64.StdEncoding.EncodeToString(sum[:]),
			}}
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"dist-tags": map[string]string{"latest": f.latest}, "versions": versions})
	case r.URL.Path == "/"+f.name+"/latest":
		_ = json.NewEncoder(w).Encode(map[string]string{"description": "Browser automation CLI for AI agents"})
	case strings.HasPrefix(r.URL.Path, "/"+f.name+"/-/"):
		_, _ = w.Write(f.tarballs[strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/"+f.name+"/-/"), ".tgz")])
	default:
		http.NotFound(w, r)
	}
}

// An npm package followed as a bundle takes the skills shipped in its
// tarball at the latest version, names the package's commands as tools to
// install from npm (with their setup step), follows the next version, and
// sends install and setup requests to the device only when asked.
func TestNPMSkillBundle(t *testing.T) {
	f := newIsolationFixture(t)
	manifest := `{"name":"agent-browser","bin":{"agent-browser":"./bin/agent-browser.js"}}`
	skill := func(body string) string {
		return "---\nname: agent-browser\ndescription: Browser automation\n---\n" + body + "\n"
	}
	registry := &npmRegistryFake{name: "agent-browser", tarballs: map[string][]byte{}}
	registry.server = httptest.NewServer(registry)
	defer registry.server.Close()
	registry.publish("0.38.2", npmPackageTarball(t, map[string]string{
		"package.json":                  manifest,
		"skills/agent-browser/SKILL.md": skill("v0.38"),
		// Content the CLI serves itself, not skills to install.
		"skill-data/core/SKILL.md": "---\nname: core\n---\ncore\n",
	}))
	f.server.skillRepos = skillrepo.Sources{Git: skillrepo.Git{}, NPM: skillrepo.NPM{Registry: registry.server.URL}}
	call := func(session, method, path, body string, want int) []byte {
		t.Helper()
		recorder := doAuthCall(t, f.handler, f.as(session, method, path, body))
		expectStatus(t, recorder, want, method+" "+path)
		return recorder.Body.Bytes()
	}

	var added store.SkillRepositoryView
	_ = json.Unmarshal(call(f.alice, http.MethodPost, "/api/skill-repositories",
		`{"url":"npm:agent-browser","subpath":"skills","mode":"bundle","name":"agent-browser"}`, http.StatusCreated), &added)
	bundle := added.Repository
	if bundle.Label != "npmjs.com/package/agent-browser" || bundle.Mode != "bundle" || bundle.Version != "0.38.2" || len(bundle.Skills) != 1 || bundle.Skills[0].Name != "agent-browser" {
		t.Fatalf("bundle %+v", bundle)
	}
	if len(bundle.Tools) != 1 {
		t.Fatalf("tools %+v", bundle.Tools)
	}
	tool := bundle.Tools[0]
	if tool.Name != "agent-browser" || tool.Version != "0.38.2" || tool.Source != "npm" || tool.Package != "agent-browser" || tool.Setup == nil || strings.Join(tool.Setup.Args, " ") != "install" {
		t.Fatalf("tool %+v", tool)
	}

	registry.publish("0.39.0", npmPackageTarball(t, map[string]string{
		"package.json":                  manifest,
		"skills/agent-browser/SKILL.md": skill("v0.39"),
	}))
	var checked store.SkillRepository
	_ = json.Unmarshal(call(f.alice, http.MethodPost, "/api/skill-repositories/"+bundle.ID+"/check", ``, http.StatusOK), &checked)
	if checked.Version != "0.39.0" || strings.Join(checked.Versions[0].Changed, ",") != "agent-browser" || checked.Tools[0].Version != "0.39.0" {
		t.Fatalf("update %+v / %+v / %+v", checked.Version, checked.Versions[0], checked.Tools)
	}

	// Rolling back restores the package version recorded with that version;
	// resuming moves it forward with the skills.
	rollbackTo := func(seq int) store.SkillRepository {
		t.Helper()
		var rolled store.SkillRepository
		_ = json.Unmarshal(call(f.alice, http.MethodPost, "/api/skill-repositories/"+bundle.ID+"/rollback", fmt.Sprintf(`{"seq":%d}`, seq), http.StatusOK), &rolled)
		return rolled
	}
	resume := func() store.SkillRepository {
		t.Helper()
		var resumed store.SkillRepository
		_ = json.Unmarshal(call(f.alice, http.MethodPost, "/api/skill-repositories/"+bundle.ID+"/resume", ``, http.StatusOK), &resumed)
		return resumed
	}
	npmTool := func(repo store.SkillRepository, version string) bool {
		return len(repo.Tools) == 1 && repo.Tools[0].Name == "agent-browser" && repo.Tools[0].Source == "npm" && repo.Tools[0].Version == version
	}
	if rolled := rollbackTo(1); !rolled.Paused || rolled.Version != "0.38.2" || !npmTool(rolled, "0.38.2") {
		t.Fatalf("rollback %q paused %v tools %+v", rolled.Version, rolled.Paused, rolled.Tools)
	}
	if resumed := resume(); resumed.Paused || resumed.Version != "0.39.0" || !npmTool(resumed, "0.39.0") {
		t.Fatalf("resume %q paused %v tools %+v", resumed.Version, resumed.Paused, resumed.Tools)
	}
	// A version recorded before versions held their tools has them read from
	// its package.
	bundles := f.server.store.(bundleStore)
	first, err := bundles.GetBundleVersion(context.Background(), bundle.ID, 1)
	if err != nil {
		t.Fatal(err)
	}
	first.Tools = nil
	legacy, err := bundles.RecordBundleVersion(context.Background(), bundle.ID, first, false)
	if err != nil {
		t.Fatal(err)
	}
	if rolled := rollbackTo(legacy.Seq); rolled.Version != "0.38.2" || !npmTool(rolled, "0.38.2") || rolled.Error != "" {
		t.Fatalf("rollback to a version without tools: %q tools %+v error %q", rolled.Version, rolled.Tools, rolled.Error)
	}
	if resumed := resume(); !npmTool(resumed, "0.39.0") {
		t.Fatalf("resume after the legacy rollback: tools %+v", resumed.Tools)
	}

	// A worker without npm/uv support is asked to update first.
	old := &daemonConnection{deviceID: "dev_alice", done: make(chan struct{}), rpc: newDaemonRPC(), send: make(chan wsEnvelope, 4),
		registration: store.DaemonRegistration{Capabilities: []string{toolInstallCapability}}}
	f.server.hub.mu.Lock()
	f.server.hub.connections["dev_alice"] = old
	f.server.hub.mu.Unlock()
	call(f.alice, http.MethodPost, "/api/devices/dev_alice/tools/install", `{"repositoryId":"`+bundle.ID+`","tool":"agent-browser"}`, http.StatusConflict)

	device := &daemonConnection{deviceID: "dev_alice", done: make(chan struct{}), rpc: newDaemonRPC(), send: make(chan wsEnvelope, 4),
		registration: store.DaemonRegistration{Capabilities: []string{toolInstallCapability, toolSourcesCapability}}}
	f.server.hub.mu.Lock()
	f.server.hub.connections["dev_alice"] = device
	f.server.hub.mu.Unlock()
	requests := make(chan wsInstallTool, 4)
	go func() {
		for envelope := range device.send {
			var request wsInstallTool
			_ = json.Unmarshal(envelope.Payload, &request)
			requests <- request
			answer := map[string]string{"name": request.Tool.Name, "version": request.Tool.Version}
			if request.Step == "setup" {
				answer = map[string]string{"name": request.Tool.Name, "version": request.Tool.Version, "output": "Chrome for Testing installed"}
			}
			payload, _ := json.Marshal(answer)
			device.rpc.resolve(envelope.ID, payload)
		}
	}()
	call(f.alice, http.MethodPost, "/api/devices/dev_alice/tools/install", `{"repositoryId":"`+bundle.ID+`","tool":"agent-browser","step":"reboot"}`, http.StatusBadRequest)
	call(f.alice, http.MethodPost, "/api/devices/dev_alice/tools/install", `{"repositoryId":"`+bundle.ID+`","tool":"agent-browser"}`, http.StatusOK)
	if request := <-requests; request.Step != "install" || request.Tool.Source != "npm" || request.Tool.Version != "0.39.0" {
		t.Fatalf("install request %+v", request)
	}
	var setup wsToolInstalled
	_ = json.Unmarshal(call(f.alice, http.MethodPost, "/api/devices/dev_alice/tools/install", `{"repositoryId":"`+bundle.ID+`","tool":"agent-browser","step":"setup"}`, http.StatusOK), &setup)
	if request := <-requests; request.Step != "setup" || request.Tool.Setup == nil {
		t.Fatalf("setup request %+v", request)
	}
	if setup.Output != "Chrome for Testing installed" {
		t.Fatalf("setup answer %+v", setup)
	}
}
