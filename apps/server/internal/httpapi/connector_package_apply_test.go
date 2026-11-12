package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os/exec"
	"strings"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

type packageApplyFixture struct {
	f      isolationFixture
	worker *fakeFetchWorker
}

// newPackageApplyFixture connects a device that can read and install the
// openlark package.
func newPackageApplyFixture(t *testing.T) packageApplyFixture {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	f := newIsolationFixture(t)
	f.server.skillRepos = serverMustNotRead{t: t}
	httpServer := httptest.NewServer(f.handler)
	t.Cleanup(httpServer.Close)
	repo := localRepo{t: t, dir: t.TempDir()}
	repo.git("init", "--quiet", "--initial-branch=main")
	repo.commit(map[string]string{
		"plugins/open-lark/skills/olk/SKILL.md": "---\nname: olk\ndescription: OpenLark CLI\n---\n",
	})
	worker := &fakeFetchWorker{
		t: t, serverURL: httpServer.URL, credential: f.aliceDevice, repo: repo,
		connectors: []map[string]any{packageConnectorExtension()},
		system:     map[string]any{"os": "Linux", "arch": "x64", "nodeVersion": "22.15.0"},
	}
	worker.connect()
	t.Cleanup(worker.disconnect)
	waitFor(t, "the package device to connect", func() bool { return f.server.hub.HasConnection("dev_alice") })
	err := f.server.store.SaveDeviceConnectorState(context.Background(), store.DeviceConnectorState{
		DeviceID: "dev_alice", Kind: "github", Status: store.DeviceConnectorReady,
		Installed: true, SignedIn: true, CheckedAt: "2026-11-11T00:00:00Z",
	})
	if err != nil {
		t.Fatal(err)
	}
	return packageApplyFixture{f: f, worker: worker}
}

func (p packageApplyFixture) selectDevices(t *testing.T, body string) store.ConnectorPackageView {
	t.Helper()
	recorder := doAuthCall(t, p.f.handler, p.f.as(p.f.alice, http.MethodPut, "/api/connector-packages/openlark/devices", body))
	expectStatus(t, recorder, http.StatusOK, "select devices")
	var view store.ConnectorPackageView
	if err := json.Unmarshal(recorder.Body.Bytes(), &view); err != nil {
		t.Fatal(err)
	}
	return view
}

func (p packageApplyFixture) record(t *testing.T) store.ConnectorPackageEnablement {
	t.Helper()
	record, err := p.f.server.store.GetConnectorPackage(context.Background(), p.f.aliceID, "openlark")
	if err != nil {
		t.Fatal(err)
	}
	return record
}

func (p packageApplyFixture) waitDeviceState(t *testing.T, want store.ConnectorPackageDeviceState) store.ConnectorPackageEnablement {
	t.Helper()
	var record store.ConnectorPackageEnablement
	waitFor(t, "the device to be "+string(want), func() bool {
		record = p.record(t)
		if want == store.ConnectorPackageDeviceStateInstalled {
			return !record.Unfinished() && len(record.Devices) == 1 && len(record.States) == 0
		}
		return record.States["dev_alice"].State == want
	})
	return record
}

// holdApply keeps the package's background apply from starting.
func (p packageApplyFixture) holdApply() func() {
	return p.f.server.packageApplies.lock(connectorPackageApplyKey(p.f.aliceID, "openlark"))
}

func TestConnectorPackageSelectionReturnsPendingAndTheBackgroundApplyInstalls(t *testing.T) {
	p := newPackageApplyFixture(t)
	release := p.holdApply()
	view := p.selectDevices(t, `{"deviceIds":["dev_alice"]}`)
	if !view.Enabled || len(view.Devices) != 1 || !view.Devices[0].Selected ||
		view.Devices[0].State != store.ConnectorPackageDeviceStatePending {
		t.Fatalf("view at return: %+v", view)
	}
	if record := p.record(t); len(record.Devices) != 0 || len(p.worker.installs) != 0 {
		t.Fatalf("the request installed before returning: %+v installs=%v", record, p.worker.installs)
	}
	release()
	record := p.waitDeviceState(t, store.ConnectorPackageDeviceStateInstalled)
	if record.RepositoryID == "" || len(p.worker.installs) != 1 || len(p.worker.extensions) != 1 {
		t.Fatalf("applied %+v installs=%v extensions=%v", record, p.worker.installs, p.worker.extensions)
	}
	recorder := doAuthCall(t, p.f.handler, p.f.as(p.f.alice, http.MethodGet, "/api/connector-packages/openlark", ""))
	var got store.ConnectorPackageView
	_ = json.Unmarshal(recorder.Body.Bytes(), &got)
	if got.Devices[0].State != store.ConnectorPackageDeviceStateInstalled {
		t.Fatalf("view after apply: %+v", got.Devices)
	}
}

func TestConnectorPackageApplyFailureIsRecordedPerDeviceAndRetried(t *testing.T) {
	p := newPackageApplyFixture(t)
	p.worker.installFailures = 1
	p.selectDevices(t, `{"deviceIds":["dev_alice"]}`)
	record := p.waitDeviceState(t, store.ConnectorPackageDeviceStateFailed)
	if !strings.Contains(record.States["dev_alice"].Error, "download failed") || len(record.Devices) != 0 {
		t.Fatalf("failed record %+v", record)
	}
	if len(p.worker.installs) != 0 {
		t.Fatalf("a failed install was recorded as installed: %v", p.worker.installs)
	}
	recorder := doAuthCall(t, p.f.handler, p.f.as(p.f.alice, http.MethodGet, "/api/connector-packages/openlark", ""))
	var view store.ConnectorPackageView
	_ = json.Unmarshal(recorder.Body.Bytes(), &view)
	if view.Devices[0].State != store.ConnectorPackageDeviceStateFailed || !strings.Contains(view.Devices[0].Error, "download failed") {
		t.Fatalf("failure not shown: %+v", view.Devices)
	}
	p.selectDevices(t, `{"deviceIds":["dev_alice"]}`)
	p.waitDeviceState(t, store.ConnectorPackageDeviceStateInstalled)
}

func TestConnectorPackageApplyResumesAfterRestart(t *testing.T) {
	p := newPackageApplyFixture(t)
	previous := connectorPackageResumeGrace
	connectorPackageResumeGrace = 0
	t.Cleanup(func() { connectorPackageResumeGrace = previous })
	// A run that died while installing left the device installing.
	err := p.f.server.store.SaveConnectorPackage(context.Background(), store.ConnectorPackageEnablement{
		OwnerUserID: p.f.aliceID, Kind: "openlark", ExtensionID: "open-lark",
		Selected: []string{"dev_alice"}, Devices: []string{},
		States: map[string]store.ConnectorPackageProgress{
			"dev_alice": {State: store.ConnectorPackageDeviceStateInstalling, UpdatedAt: time.Now().UTC().Format(time.RFC3339)},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	p.f.server.resumeConnectorPackageApplies(context.Background())
	p.waitDeviceState(t, store.ConnectorPackageDeviceStateInstalled)
}

func TestConnectorPackageConcurrentAppliesRunOneAtATimeAndMerge(t *testing.T) {
	p := newPackageApplyFixture(t)
	release := p.holdApply()
	p.selectDevices(t, `{"deviceIds":["dev_alice"]}`)
	p.selectDevices(t, `{"deviceIds":["dev_alice"]}`)
	p.selectDevices(t, `{"deviceIds":["dev_alice"]}`)
	release()
	p.waitDeviceState(t, store.ConnectorPackageDeviceStateInstalled)
	// Wait for the queued runs: each takes the lock, finds nothing pending.
	for range 3 {
		p.holdApply()()
	}
	if len(p.worker.installs) != 1 || len(p.worker.extensions) != 1 {
		t.Fatalf("queued applies installed more than once: installs=%v extensions=%v", p.worker.installs, p.worker.extensions)
	}
}
