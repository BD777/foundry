package resources_test

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/resources"
	"github.com/foundry-dev/foundry/apps/server/internal/sqlitestore"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func newService(t *testing.T) (*resources.Service, *time.Time, *[]string) {
	t.Helper()
	db, err := sqlitestore.Open(filepath.Join(t.TempDir(), "foundry.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	service := resources.NewService(db)
	now := time.Date(2026, 10, 13, 8, 0, 0, 0, time.UTC)
	service.Now = func() time.Time { return now }
	changes := &[]string{}
	service.Changed = func(sourceID string) { *changes = append(*changes, sourceID) }
	return service, &now, changes
}

var mac = store.ResourceSource{Kind: "device", ID: "dev_mac", Label: "Mac mini"}

func detected(key, typ, detector string, ready bool) store.DetectedResource {
	readiness := store.ResourceReadiness{Ready: ready, Level: "installed"}
	if !ready {
		readiness.Reason = "not granted"
	}
	return store.DetectedResource{Key: key, Type: typ, Platform: "macos", Name: key, Detector: detector, Readiness: readiness}
}

func byKey(t *testing.T, service *resources.Service, filter store.ResourceFilter) map[string]store.ResourceInstance {
	t.Helper()
	list, err := service.List(context.Background(), filter)
	if err != nil {
		t.Fatal(err)
	}
	result := map[string]store.ResourceInstance{}
	for _, instance := range list.Instances {
		result[instance.Key] = instance
	}
	return result
}

func TestInstanceIDsAreStableAndPerSource(t *testing.T) {
	id := resources.InstanceID("dev_mac", "browser/google-chrome")
	if id != resources.InstanceID("dev_mac", "browser/google-chrome") || len(id) != len("res_")+20 {
		t.Fatalf("id = %q", id)
	}
	if id == resources.InstanceID("dev_other", "browser/google-chrome") {
		t.Fatal("the same key on another device has the same id")
	}
}

// A full snapshot replaces the source's instances: what is reported is
// current, what disappeared is gone (kept until its retention ends), and
// an instance keeps its id and first discovery across reports.
func TestSnapshotsReplaceInstancesAndMarkTheMissingGone(t *testing.T) {
	ctx := context.Background()
	service, now, changes := newService(t)
	first := store.ResourcesReport{ScannerVersion: 1, Instances: []store.DetectedResource{
		detected("browser/google-chrome", "browser", "browser@1", true),
		detected("computer_use/macos/console:501", "computer_use", "computer_use.macos.foundry-worker@1", false),
	}}
	if changed, err := service.Report(ctx, mac, first); err != nil || !changed {
		t.Fatalf("first report: changed=%v err=%v", changed, err)
	}
	instances := byKey(t, service, store.ResourceFilter{})
	chrome := instances["browser/google-chrome"]
	if chrome.ID != resources.InstanceID("dev_mac", "browser/google-chrome") || chrome.State != store.ResourceAvailable || chrome.Source.Label != "Mac mini" {
		t.Fatalf("chrome = %+v", chrome)
	}
	if desktop := instances["computer_use/macos/console:501"]; desktop.State != store.ResourceUnready || desktop.StateReason != "not granted" {
		t.Fatalf("desktop = %+v", desktop)
	}

	*now = now.Add(time.Minute)
	if changed, err := service.Report(ctx, mac, first); err != nil || changed {
		t.Fatalf("the same report again: changed=%v err=%v", changed, err)
	}
	if len(*changes) != 1 {
		t.Fatalf("changes = %v, want one", *changes)
	}

	*now = now.Add(time.Minute)
	second := store.ResourcesReport{ScannerVersion: 1, Instances: first.Instances[1:]}
	if _, err := service.Report(ctx, mac, second); err != nil {
		t.Fatal(err)
	}
	if _, listed := byKey(t, service, store.ResourceFilter{})["browser/google-chrome"]; listed {
		t.Fatal("a gone instance is listed without includeGone")
	}
	gone := byKey(t, service, store.ResourceFilter{IncludeGone: true})["browser/google-chrome"]
	if gone.State != store.ResourceGone || gone.GoneAt == "" || gone.ID != chrome.ID {
		t.Fatalf("gone = %+v", gone)
	}

	*now = now.Add(time.Minute)
	if _, err := service.Report(ctx, mac, first); err != nil {
		t.Fatal(err)
	}
	back := byKey(t, service, store.ResourceFilter{})["browser/google-chrome"]
	if back.State != store.ResourceAvailable || back.GoneAt != "" || back.DiscoveredAt != chrome.DiscoveredAt || back.LastSeenAt == chrome.LastSeenAt {
		t.Fatalf("back = %+v, first seen %+v", back, chrome)
	}

	*now = now.Add(resources.GoneRetention + time.Hour)
	if _, err := service.Report(ctx, mac, second); err != nil {
		t.Fatal(err)
	}
	*now = now.Add(resources.GoneRetention + time.Hour)
	if _, err := service.Report(ctx, mac, second); err != nil {
		t.Fatal(err)
	}
	if _, kept := byKey(t, service, store.ResourceFilter{IncludeGone: true})["browser/google-chrome"]; kept {
		t.Fatal("a gone instance outlived its retention")
	}
}

// A detector that failed keeps what it found before, marked stale, and the
// failure is the source's; it is not taken as the resource disappearing.
func TestAFailedDetectorKeepsItsInstancesStale(t *testing.T) {
	ctx := context.Background()
	service, _, _ := newService(t)
	if _, err := service.Report(ctx, mac, store.ResourcesReport{Instances: []store.DetectedResource{
		detected("simulator/ios/ABC", "simulator", "simulator.ios@1", true),
		detected("gpu/0", "gpu", "gpu@1", true),
	}}); err != nil {
		t.Fatal(err)
	}
	if _, err := service.Report(ctx, mac, store.ResourcesReport{
		Instances:      []store.DetectedResource{detected("gpu/0", "gpu", "gpu@1", true)},
		DetectorErrors: []store.ResourceDetectorError{{Detector: "simulator.ios@2", Type: "simulator", Error: "timeout after 3000ms"}},
	}); err != nil {
		t.Fatal(err)
	}
	simulator := byKey(t, service, store.ResourceFilter{Type: "simulator"})["simulator/ios/ABC"]
	if !simulator.Stale || simulator.State != store.ResourceAvailable {
		t.Fatalf("simulator = %+v", simulator)
	}
	list, err := service.List(ctx, store.ResourceFilter{})
	if err != nil {
		t.Fatal(err)
	}
	if len(list.Sources) != 1 || len(list.Sources[0].DetectorErrors) != 1 || list.Sources[0].DetectorErrors[0].Error != "timeout after 3000ms" {
		t.Fatalf("sources = %+v", list.Sources)
	}
}

// A disconnected device's instances read offline with their last values;
// so do those of a device the server has no connection to (a restart).
func TestOfflineSourcesListOffline(t *testing.T) {
	ctx := context.Background()
	service, _, changes := newService(t)
	report := store.ResourcesReport{Instances: []store.DetectedResource{detected("toolchain/git", "toolchain", "toolchain@1", true)}}
	if _, err := service.Report(ctx, mac, report); err != nil {
		t.Fatal(err)
	}
	if err := service.SourceOffline(ctx, mac.ID); err != nil {
		t.Fatal(err)
	}
	git := byKey(t, service, store.ResourceFilter{})["toolchain/git"]
	if git.State != store.ResourceOffline || !git.Readiness.Ready {
		t.Fatalf("git = %+v", git)
	}
	if len(*changes) != 2 {
		t.Fatalf("changes = %v", *changes)
	}
	if _, err := service.Report(ctx, mac, report); err != nil {
		t.Fatal(err)
	}
	if git := byKey(t, service, store.ResourceFilter{})["toolchain/git"]; git.State != store.ResourceAvailable {
		t.Fatalf("after reconnecting git = %+v", git)
	}
	service.Online = func(string) bool { return false }
	if git := byKey(t, service, store.ResourceFilter{})["toolchain/git"]; git.State != store.ResourceOffline {
		t.Fatalf("without a connection git = %+v", git)
	}
}

// Reports are bounded and cleaned; detection never claims "verified".
func TestReportsAreSanitized(t *testing.T) {
	report := resources.Sanitize(store.ResourcesReport{Instances: []store.DetectedResource{
		{Key: "", Type: "gpu"},
		{Key: "gpu/0", Type: "gpu", Readiness: store.ResourceReadiness{Ready: true, Level: "verified"}},
	}})
	if len(report.Instances) != 1 || report.Instances[0].Readiness.Level != "permitted" || report.Instances[0].Platform != "any" {
		t.Fatalf("instances = %+v", report.Instances)
	}
	many := store.ResourcesReport{}
	for range resources.MaxInstancesPerReport + 10 {
		many.Instances = append(many.Instances, store.DetectedResource{Key: "k", Type: "toolchain"})
	}
	if got := len(resources.Sanitize(many).Instances); got != resources.MaxInstancesPerReport {
		t.Fatalf("kept %d instances", got)
	}
}
