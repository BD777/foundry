package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os/exec"
	"strings"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func packageConnectorExtension() map[string]any {
	return map[string]any{
		"kind": "openlark", "label": "OpenLark", "holding": "device_held", "adapter": "extension:open-lark",
		"extension": map[string]any{
			"id": "open-lark", "name": "OpenLark", "version": "1.0.0",
			"bundled": true, "state": "available",
		},
		"tool": map[string]any{"command": "olk", "source": "device"},
		"package": map[string]any{
			"upstream": map[string]any{
				"via": "github", "repository": "https://github.com/nwverse/open-lark", "ref": "main",
			},
			"skills": map[string]any{"path": "plugins/open-lark/skills"},
			"tools": []any{map[string]any{
				"command": "olk", "source": "repository", "path": "plugins/open-lark",
				"bins": map[string]any{"olk": "bin/olk", "olk-ctx": "bin/olk-ctx"},
			}},
		},
	}
}

func TestConnectorPackageSelectsDevicesAndLinksSessionSkillsAndPins(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	f := newIsolationFixture(t)
	f.server.skillRepos = serverMustNotRead{t: t}
	httpServer := httptest.NewServer(f.handler)
	defer httpServer.Close()
	repo := localRepo{t: t, dir: t.TempDir()}
	repo.git("init", "--quiet", "--initial-branch=main")
	repo.commit(map[string]string{
		"plugins/open-lark/skills/olk/SKILL.md":   "---\nname: olk\ndescription: OpenLark CLI\n---\n",
		"plugins/open-lark/skills/setup/SKILL.md": "---\nname: setup\ndescription: Setup OpenLark\n---\n",
	})
	worker := &fakeFetchWorker{
		t: t, serverURL: httpServer.URL, credential: f.aliceDevice, repo: repo,
		connectors: []map[string]any{packageConnectorExtension()},
		system:     map[string]any{"os": "Linux", "arch": "x64", "nodeVersion": "22.15.0"},
	}
	worker.connect()
	defer worker.disconnect()
	waitFor(t, "the package device to connect", func() bool { return f.server.hub.HasConnection("dev_alice") })

	err := f.server.store.SaveDeviceConnectorState(context.Background(), store.DeviceConnectorState{
		DeviceID: "dev_alice", Kind: "github", Status: store.DeviceConnectorSignedOut,
		Installed: true, SignedIn: false, CheckedAt: "2026-11-11T00:00:00Z",
	})
	if err != nil {
		t.Fatal(err)
	}
	var view store.ConnectorPackageView
	recorder := doAuthCall(t, f.handler, f.as(f.alice, http.MethodGet, "/api/connector-packages/openlark", ""))
	expectStatus(t, recorder, http.StatusOK, "read package")
	_ = json.Unmarshal(recorder.Body.Bytes(), &view)
	if len(view.Devices) != 1 || view.Devices[0].Eligible || !strings.Contains(view.Devices[0].Reason, "Sign in to the GitHub CLI connector") {
		t.Fatalf("signed-out readiness: %+v", view.Devices)
	}

	err = f.server.store.SaveDeviceConnectorState(context.Background(), store.DeviceConnectorState{
		DeviceID: "dev_alice", Kind: "github", Status: store.DeviceConnectorReady,
		Installed: true, SignedIn: true, CheckedAt: "2026-11-11T00:00:00Z",
	})
	if err != nil {
		t.Fatal(err)
	}
	recorder = doAuthCall(t, f.handler, f.as(f.alice, http.MethodPut, "/api/connector-packages/openlark/devices", `{"deviceIds":["dev_alice"]}`))
	expectStatus(t, recorder, http.StatusOK, "enable package")
	_ = json.Unmarshal(recorder.Body.Bytes(), &view)
	if !view.Enabled || view.RepositoryID == "" || len(view.Devices) != 1 ||
		!view.Devices[0].Selected || !view.Devices[0].Eligible {
		t.Fatalf("enabled package: %+v", view)
	}
	if len(worker.installs) != 1 || worker.installs[0].Source != "repository" ||
		worker.installs[0].Bins["olk-ctx"] != "bin/olk-ctx" ||
		worker.installs[0].Path != "plugins/open-lark" {
		t.Fatalf("installed tools: %+v", worker.installs)
	}
	if len(worker.extensions) != 1 || worker.extensions[0] != "open-lark" {
		t.Fatalf("bundled extension installs: %v", worker.extensions)
	}

	refs, pins, err := sessionPackageSkills(
		context.Background(), f.server.store, f.aliceID, "dev_alice",
		map[string]bool{"openlark": true},
	)
	if err != nil {
		t.Fatal(err)
	}
	if len(refs) != 2 || len(pins) != 1 || pins[0].Name != "olk" ||
		pins[0].Version != worker.installs[0].Version || pins[0].BundleID != view.RepositoryID {
		t.Fatalf("session package refs=%+v pins=%+v", refs, pins)
	}
	if refs[0].Bundle == nil || refs[0].Bundle.ID != view.RepositoryID {
		t.Fatalf("skill is not marked with its package bundle: %+v", refs)
	}

	withConnector, _, err := sessionPackageSkills(
		context.Background(), f.server.store, f.aliceID, "dev_alice",
		map[string]bool{"github": true},
	)
	if err != nil {
		t.Fatal(err)
	}
	if len(withConnector) != 0 {
		t.Fatalf("a session without the OpenLark connector got %+v", withConnector)
	}

	recorder = doAuthCall(t, f.handler, f.as(f.alice, http.MethodDelete, "/api/connector-packages/openlark", ""))
	expectStatus(t, recorder, http.StatusOK, "disable package")
	if _, err := f.server.store.GetConnectorPackage(context.Background(), f.aliceID, "openlark"); err == nil {
		t.Fatal("the package enablement remains after deletion")
	}
	if !contains(worker.steps, "uninstall:"+worker.installs[0].Version) {
		t.Fatalf("worker steps after delete: %v", worker.steps)
	}
}

func TestConnectorPackageDeviceEligibilityExplainsOfflineAndUnsupportedPlatforms(t *testing.T) {
	f := newIsolationFixture(t)
	descriptor := store.ConnectorDescriptor{
		Kind: "openlark", Package: &store.ConnectorPackage{
			Upstream: store.ConnectorPackageUpstream{Via: "github", Repository: "https://github.com/nwverse/open-lark"},
		},
	}
	device := store.DeviceProjection{
		ID: "dev_alice", Label: "alice",
		System: &store.DeviceSystem{OS: "Windows", NodeVersion: "22"},
	}
	if ok, reason := f.server.connectorPackageDeviceEligible(context.Background(), device, descriptor, false); ok || !strings.Contains(reason, "offline") {
		t.Fatalf("offline eligibility %v %q", ok, reason)
	}
	if ok, reason := f.server.connectorPackageDeviceEligible(context.Background(), device, descriptor, true); ok || !strings.Contains(reason, "Linux and macOS") {
		t.Fatalf("platform eligibility %v %q", ok, reason)
	}
}

func contains(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}

func TestRepositoryToolIsReadByAnotherDeviceAndHeldForTheTarget(t *testing.T) {
	f := newIsolationFixture(t)
	httpServer := httptest.NewServer(f.handler)
	defer httpServer.Close()
	worker := &fakeFetchWorker{t: t, serverURL: httpServer.URL, credential: f.aliceDevice}
	worker.connect()
	defer worker.disconnect()
	waitFor(t, "the reader to connect", func() bool { return f.server.hub.HasConnection("dev_alice") })

	tool := store.SkillBundleTool{Name: "olk", Version: strings.Repeat("a", 40), Source: "repository"}
	request := wsInstallTool{Tool: tool, Step: "install"}
	release, err := f.server.deliverRepositoryTool(context.Background(), "dev_alice", "dev_company", &request)
	if err != nil {
		t.Fatal(err)
	}
	if request.Archive == nil || request.Archive.SHA256 != "digest" ||
		!strings.HasPrefix(request.Archive.DownloadPath, "/api/daemon/repository-tool-archives/") {
		t.Fatalf("install request: %+v", request)
	}
	id := strings.TrimPrefix(request.Archive.DownloadPath, "/api/daemon/repository-tool-archives/")
	held, ok := f.server.toolArchives.get(id)
	if !ok || held.deviceID != "dev_company" || string(held.data) != "tool-folder" {
		t.Fatalf("held archive: %+v %v", held, ok)
	}
	download, err := http.NewRequest(http.MethodGet, httpServer.URL+request.Archive.DownloadPath, nil)
	if err != nil {
		t.Fatal(err)
	}
	download.Header.Set(deviceCredentialHeader, f.aliceDevice)
	response, err := http.DefaultClient.Do(download)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusNotFound {
		t.Fatalf("a device other than the target downloaded the tool: %d", response.StatusCode)
	}
	release()
	if _, ok := f.server.toolArchives.get(id); ok {
		t.Fatal("the archive is still held after the install")
	}

	direct := wsInstallTool{Tool: tool, Step: "install"}
	if _, err := f.server.deliverRepositoryTool(context.Background(), "dev_alice", "dev_alice", &direct); err != nil || direct.Archive != nil {
		t.Fatalf("the reader installs for itself: %+v %v", direct, err)
	}
}
