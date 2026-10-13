package resources_test

import (
	"strings"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/resources"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// reportCompute has the Mac report its compute instance, ready as its
// worker enforces the owner's settings.
func (f *leaseFixture) reportCompute(ready bool) string {
	f.t.Helper()
	readiness := store.ResourceReadiness{Ready: ready, Level: "configured"}
	if !ready {
		readiness = store.ResourceReadiness{Level: "installed", Reason: "Remote commands are off", Missing: []string{"remote_commands_off"}}
	}
	report := store.ResourcesReport{ScannerVersion: 1, Instances: []store.DetectedResource{{
		Key: "compute", Type: "compute", Platform: "macos", Name: "Compute (10 CPUs, 16 GiB)", Detector: "compute@1",
		Readiness: readiness, Backends: []store.ResourceBackend{{ID: "foundry-compute", Mode: "remote_ops", Readiness: readiness}},
		Details: map[string]string{"cpus": "10"},
	}}}
	if _, err := f.service.Report(f.ctx, mac, report); err != nil {
		f.t.Fatal(err)
	}
	return resources.InstanceID("dev_mac", "compute")
}

func (f *leaseFixture) allowRemoteCommands(allow bool) {
	f.t.Helper()
	if err := f.service.SetSettings(f.ctx, "dev_mac", store.ResourceSourceSettings{AllowRemoteCommands: allow}, "usr_alice"); err != nil {
		f.t.Fatal(err)
	}
}

func TestComputeNeedsTheOwnersPermission(t *testing.T) {
	f := newLeaseFixture(t)
	compute := f.reportCompute(true)

	// On by default: a device whose owner never chose allows them.
	if settings, err := f.service.Settings(f.ctx, "dev_mac"); err != nil || !settings.AllowRemoteCommands {
		t.Fatalf("default settings = %+v, %v", settings, err)
	}
	list, err := f.service.List(f.ctx, store.ResourceFilter{})
	if err != nil || len(list.Sources) != 1 || !list.Sources[0].AllowRemoteCommands {
		t.Fatalf("default sources = %+v, %v", list.Sources, err)
	}

	// Ready on the device is not enough: the server keeps the owner's
	// explicit off.
	f.allowRemoteCommands(false)
	if _, err := f.acquire("sess_a", 0, compute); !resources.IsLeaseError(err, resources.CodeUnready) ||
		!strings.Contains(err.Error(), "Allow remote commands") {
		t.Fatalf("acquire without permission: %v", err)
	}
	list, err = f.service.List(f.ctx, store.ResourceFilter{})
	if err != nil || len(list.Sources) != 1 || list.Sources[0].AllowRemoteCommands {
		t.Fatalf("sources after turning off = %+v, %v", list.Sources, err)
	}
	f.allowRemoteCommands(true)
	lease := f.mustAcquire("sess_a", compute)
	f.confirm()
	if _, err := f.leases.Begin(f.ctx, lease.ID, "sess_a"); err != nil {
		t.Fatalf("begin: %v", err)
	}

	// Turning it off ends the lease and resets the instance (the worker
	// stops its commands); reports do not turn it back on.
	f.allowRemoteCommands(false)
	ended := f.lease(lease.ID)
	if ended.State != store.LeaseRevoked || ended.EndedBy != "usr_alice" {
		t.Fatalf("lease after turning off = %+v", ended)
	}
	if reset := f.router.last(); reset.ResourceID != compute || reset.Generation <= lease.Generation {
		t.Fatalf("reset = %+v", reset)
	}
	f.reportCompute(true)
	if settings, err := f.service.Settings(f.ctx, "dev_mac"); err != nil || settings.AllowRemoteCommands {
		t.Fatalf("settings after a report = %+v, %v", settings, err)
	}
	if _, err := f.leases.Begin(f.ctx, lease.ID, "sess_a"); !resources.IsLeaseError(err, resources.CodeLeaseEnded) ||
		!strings.Contains(err.Error(), "commands it started were stopped") {
		t.Fatalf("operating after turning off: %v", err)
	}
}

func TestComputeAuditKeepsTheCommandNotSecrets(t *testing.T) {
	spec, ok := resources.Spec("compute")
	if !ok || !spec.RemoteCommands || spec.MaxDeadline <= resources.MaxComputeRun {
		t.Fatalf("compute spec = %+v", spec)
	}
	run, _ := spec.Operation("run")
	long := strings.Repeat("x", 300)
	summary := run.AuditArgs(map[string]any{
		"command": "pnpm test " + long,
		"argv":    []any{"go", "test", "./...", long},
		"env":     map[string]any{"TOKEN": "secret", "CI": "1"},
		"cwd":     "repo",
	})
	if summary["command"] != "pnpm test "+long || summary["cwd"] != "repo" {
		t.Fatalf("summary = %+v", summary)
	}
	if argv := summary["argv"].([]string); len(argv) != 4 || argv[3] != long {
		t.Fatalf("argv = %+v", summary["argv"])
	}
	if keys := summary["env"].([]string); strings.Join(keys, ",") != "CI,TOKEN" {
		t.Fatalf("env = %+v", summary["env"])
	}
	upload, _ := spec.Operation("put_files")
	if piece := upload.AuditArgs(map[string]any{"data": "aGVsbG8=", "upload": "p"}); piece["data"] != nil || piece["dataLength"] != 8 {
		t.Fatalf("put_files summary = %+v", piece)
	}
}
