package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/externalaccounts"
	"github.com/foundry-dev/foundry/apps/server/internal/skillarchive"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// DEV-154: a device is on the newest recorded bundle version whose tool
// versions are the ones Foundry installed there; a version recorded before
// versions kept their tools matches by tag.
func TestBundleVersionForDevice(t *testing.T) {
	repo := store.SkillRepository{Tools: []store.SkillBundleTool{{Name: "feishu-cli", Version: "v1.44.0"}}}
	tools := func(version string) []store.SkillBundleTool {
		return []store.SkillBundleTool{{Name: "feishu-cli", Version: version}}
	}
	passed := &store.SkillBundleCheck{State: store.CheckPassed}
	versions := []store.SkillBundleVersion{ // newest first
		{Seq: 4, Tag: "v1.41.0", Tools: tools("v1.41.0")}, // a rollback to v1.41.0
		{Seq: 3, Tag: "v1.44.0", Tools: tools("v1.44.0"), Check: &store.SkillBundleCheck{State: store.CheckFailed}},
		{Seq: 2, Tag: "v1.41.0", Tools: tools("v1.41.0"), Check: passed},
		{Seq: 1, Tag: "v1.40.0"},
	}
	cases := []struct {
		name      string
		installed map[string]string
		seq       int
		state     string
		verified  bool
		ok        bool
	}{
		{"the rolled-back release is current", map[string]string{"feishu-cli": "v1.41.0"}, 4, store.DeviceBundleCurrent, false, true},
		{"a newer release than the library is on", map[string]string{"feishu-cli": "v1.44.0"}, 3, store.DeviceBundleBehind, false, true},
		{"a version recorded without tools matches by tag", map[string]string{"feishu-cli": "v1.40.0"}, 1, store.DeviceBundleBehind, false, true},
		{"a version no record has", map[string]string{"feishu-cli": "v1.39.9"}, 4, store.DeviceBundleUnknown, false, true},
		{"other tools do not count", map[string]string{"gh": "v2.0.0"}, 0, "", false, false},
	}
	for _, c := range cases {
		version, standing, ok := bundleVersionForDevice(repo, versions, c.installed)
		if ok != c.ok || version.Seq != c.seq || standing.State != c.state || standing.Verified != c.verified {
			t.Errorf("%s: version %d, %+v, %v", c.name, version.Seq, standing, ok)
		}
	}
	// An npm bundle's old records match by package version the same way.
	npmRepo := store.SkillRepository{Tools: []store.SkillBundleTool{{Name: "playwright-cli", Version: "0.1.23", Source: "npm"}}}
	npmVersions := []store.SkillBundleVersion{{Seq: 2, Tag: "0.1.23", Tools: []store.SkillBundleTool{{Name: "playwright-cli", Version: "0.1.23", Source: "npm"}}}, {Seq: 1, Tag: "0.1.22"}}
	if version, standing, _ := bundleVersionForDevice(npmRepo, npmVersions, map[string]string{"playwright-cli": "0.1.22"}); version.Seq != 1 || standing.State != store.DeviceBundleBehind {
		t.Fatalf("npm device on an old record: version %d, %+v", version.Seq, standing)
	}
	// The newest record's check counts for the device on it.
	versions[0].Check = passed
	if _, standing, _ := bundleVersionForDevice(repo, versions, map[string]string{"feishu-cli": "v1.41.0"}); !standing.Verified {
		t.Fatalf("checked version: %+v", standing)
	}
}

// DEV-154: a bundle that ships a CLI moves its devices as one version.
// Sessions on a device get the skills of the version its CLI is and run
// that CLI; a new version is staged on a canary, checked and only then
// made current, and a failed check leaves every device where it was,
// returns the library to that version, pauses following and tells the
// person who follows the repository.
func TestBundleRolloutCanaryPassesAndFailsBack(t *testing.T) {
	f := newIsolationFixture(t)
	f.server.skillRepos = serverMustNotRead{t: t}
	httpServer := httptest.NewServer(f.handler)
	defer httpServer.Close()
	ctx := context.Background()
	retries := rolloutInstallRetries
	rolloutInstallRetries = []time.Duration{time.Millisecond, time.Millisecond}
	t.Cleanup(func() { rolloutInstallRetries = retries })
	const packageJSON = `{"name":"@acme/corpcli","version":"%s","bin":{"corpcli":"cli.js"}}`
	worker := &fakeFetchWorker{t: t, serverURL: httpServer.URL, credential: f.aliceDevice, npm: map[string][]byte{}, capabilities: []string{bundleRolloutCapability}}
	publish := func(version, body string) {
		worker.mu.Lock()
		defer worker.mu.Unlock()
		worker.npm[version] = npmPackageTarball(t, map[string]string{
			"package.json":            strings.Replace(packageJSON, "%s", version, 1),
			"cli.js":                  "#!/usr/bin/env node\n",
			"skills/corpcli/SKILL.md": "---\nname: corpcli\ndescription: Corp tools\n---\n" + body + "\n",
		})
		worker.npmLatest = version
	}
	steps := func() []string {
		worker.mu.Lock()
		defer worker.mu.Unlock()
		taken := worker.steps
		worker.steps = nil
		return taken
	}
	publish("1.0.0", "skill for 1.0.0")
	worker.connect()
	defer worker.disconnect()
	waitFor(t, "the device to connect", func() bool { return f.server.hub.HasConnection("dev_alice") })
	call := func(method, path, body string, want int) []byte {
		t.Helper()
		recorder := doAuthCall(t, f.handler, f.as(f.alice, method, path, body))
		expectStatus(t, recorder, want, method+" "+path)
		return recorder.Body.Bytes()
	}
	repository := func(id string) store.SkillRepository {
		t.Helper()
		var listed []store.SkillRepository
		_ = json.Unmarshal(call(http.MethodGet, "/api/skill-repositories", "", http.StatusOK), &listed)
		for _, item := range listed {
			if item.ID == id {
				return item
			}
		}
		t.Fatalf("repository %s not listed", id)
		return store.SkillRepository{}
	}
	rolloutEnded := func(id string) store.SkillBundleRollout {
		t.Helper()
		var rollout store.SkillBundleRollout
		waitFor(t, "the rollout to end", func() bool {
			item, err := f.server.store.(skillRepositoryStore).GetSkillRepository(ctx, id)
			if err != nil || item.Rollout == nil || !item.Rollout.Finished() {
				return false
			}
			rollout = *item.Rollout
			return true
		})
		return rollout
	}
	// What a session on dev_alice gets: the bundle's skill text and the
	// corpcli version it runs.
	session := func() (string, []store.SessionToolPin) {
		t.Helper()
		refs, _, err := workspaceSkillRefs(ctx, f.server.store, "ws_alice")
		if err != nil {
			t.Fatal(err)
		}
		refs, pins, err := deviceSkillRefs(ctx, f.server.store, refs, "dev_alice")
		if err != nil {
			t.Fatal(err)
		}
		for _, ref := range refs {
			if ref.Name == "corpcli" {
				pkg, err := f.server.store.GetSkillPackage(ctx, ref.SkillID, ref.Revision)
				if err != nil {
					t.Fatal(err)
				}
				text, err := skillarchive.ReadStoredFile(pkg.Content, pkg.Checksum, "SKILL.md")
				if err != nil {
					t.Fatal(err)
				}
				return string(text), pins
			}
		}
		t.Fatalf("no corpcli skill in %+v", refs)
		return "", nil
	}
	expectSession := func(what, skill, cli string) {
		t.Helper()
		text, pins := session()
		if !strings.Contains(text, "skill for "+skill) || len(pins) != 1 || pins[0].Name != "corpcli" || pins[0].Version != cli {
			t.Fatalf("%s: skill %q, pins %+v; want skill for %s and corpcli %s", what, text, pins, skill, cli)
		}
	}

	var added store.SkillRepositoryView
	_ = json.Unmarshal(call(http.MethodPost, "/api/skill-repositories", `{"url":"npm:@acme/corpcli","mode":"bundle","deviceId":"dev_alice","registry":"https://npm.internal.example/"}`, http.StatusCreated), &added)
	bundle := added.Repository
	call(http.MethodPut, "/api/workspaces/ws_alice/skill-bundles", `{"bundleIds":["`+bundle.ID+`"]}`, http.StatusOK)
	call(http.MethodPost, "/api/devices/dev_alice/tools/install", `{"repositoryId":"`+bundle.ID+`","tool":"corpcli"}`, http.StatusOK)
	if got := steps(); !slices.Equal(got, []string{"install:1.0.0"}) {
		t.Fatalf("the owner's install: %v", got)
	}
	expectSession("installed", "1.0.0", "1.0.0")

	// Manual: a new version waits for Update, and sessions keep the skills
	// of the CLI the device has.
	call(http.MethodPut, "/api/skill-repositories/"+bundle.ID+"/update-policy", `{"policy":"manual"}`, http.StatusOK)
	publish("1.1.0", "skill for 1.1.0")
	call(http.MethodPost, "/api/skill-repositories/"+bundle.ID+"/check", `{}`, http.StatusOK)
	listed := repository(bundle.ID)
	if listed.Version != "1.1.0" || listed.Rollout != nil || len(listed.DeviceVersions) != 1 || listed.DeviceVersions[0].State != store.DeviceBundleBehind || listed.DeviceVersions[0].Tag != "1.0.0" {
		t.Fatalf("manual bundle after a release: version %s, rollout %+v, devices %+v", listed.Version, listed.Rollout, listed.DeviceVersions)
	}
	if got := steps(); len(got) != 0 {
		t.Fatalf("a manual bundle installed on its own: %v", got)
	}
	expectSession("library ahead of the device", "1.0.0", "1.0.0")

	// Switched to automatic, the version the device is owed goes out:
	// staged (a download that failed once is tried again), checked, then
	// current, CLI and skills together.
	worker.mu.Lock()
	worker.installFailures = 1
	worker.mu.Unlock()
	call(http.MethodPut, "/api/skill-repositories/"+bundle.ID+"/update-policy", `{"policy":"auto"}`, http.StatusOK)
	if rollout := rolloutEnded(bundle.ID); rollout.State != store.RolloutDone || rollout.CanaryDeviceID != "dev_alice" || rollout.Tag != "1.1.0" || rollout.Trigger != store.BundleUpdateAuto {
		t.Fatalf("owed rollout once automatic: %+v", rollout)
	}
	if got := steps(); !slices.Equal(got, []string{"install:1.1.0:staged:failed", "install:1.1.0:staged", "check:1.1.0", "activate:1.1.0"}) {
		t.Fatalf("canary steps: %v", got)
	}
	versions, _ := f.server.store.ListBundleVersions(ctx, bundle.ID)
	if versions[0].Tag != "1.1.0" || versions[0].Check == nil || versions[0].Check.State != store.CheckPassed || versions[0].Check.DeviceID != "dev_alice" {
		t.Fatalf("the version's check: %+v", versions[0])
	}
	// A passed command's output (an account's name and ids) is not kept;
	// the version a passed --version reports is.
	if steps := versions[0].Check.Steps; len(steps) != 2 || steps[0].Kind != "version" || steps[0].Value != "1.1.0" || steps[0].Detail != "" || steps[1].Detail != "" {
		t.Fatalf("kept check steps: %+v", steps)
	}
	if listed := repository(bundle.ID); listed.DeviceVersions[0].State != store.DeviceBundleCurrent || !listed.DeviceVersions[0].Verified {
		t.Fatalf("device after the update: %+v", listed.DeviceVersions)
	}
	expectSession("updated", "1.1.0", "1.1.0")
	// Nothing to move: every device is on the newest version; a device
	// connecting again starts nothing, the version was rolled out.
	call(http.MethodPost, "/api/skill-repositories/"+bundle.ID+"/update", `{}`, http.StatusConflict)
	f.server.bundleRolloutsOnConnect(ctx, "dev_alice")
	if got := steps(); len(got) != 0 {
		t.Fatalf("a reconnect after the rollout installed: %v", got)
	}
	// An automatic start from a stale read (it saw no rollout) does not
	// replace the rollout of the same version.
	done := repository(bundle.ID).Rollout
	stale := repository(bundle.ID)
	stale.Rollout = nil
	if err := f.server.store.SetDeviceToolVersion(ctx, "dev_bob", "corpcli", "1.0.0"); err != nil {
		t.Fatal(err)
	}
	f.server.catchUpAutomaticRollouts(ctx, []store.SkillRepository{stale})
	if now := repository(bundle.ID).Rollout; now == nil || now.ID != done.ID {
		t.Fatalf("a stale automatic start replaced %+v with %+v", done, now)
	}
	if err := f.server.store.SetDeviceToolVersion(ctx, "dev_bob", "corpcli", ""); err != nil {
		t.Fatal(err)
	}

	// Automatic, and the canary's check fails: the staged version is
	// removed, the library returns to 1.1.0 and stops following.
	worker.mu.Lock()
	worker.checkFails = true
	worker.mu.Unlock()
	publish("1.2.0", "skill for 1.2.0")
	call(http.MethodPost, "/api/skill-repositories/"+bundle.ID+"/check", `{}`, http.StatusOK)
	rollout := rolloutEnded(bundle.ID)
	if rollout.State != store.RolloutRolledBack || rollout.Trigger != store.BundleUpdateAuto || !strings.Contains(rollout.Error, "reported 0.9.0") {
		t.Fatalf("failed canary: %+v", rollout)
	}
	if got := steps(); !slices.Equal(got, []string{"install:1.2.0:staged", "check:1.2.0", "remove:1.2.0"}) {
		t.Fatalf("failed canary steps: %v", got)
	}
	listed = repository(bundle.ID)
	if !listed.Paused || listed.Version != "1.1.0" || listed.DeviceVersions[0].State != store.DeviceBundleCurrent {
		t.Fatalf("library after the failed check: paused %v, version %s, devices %+v", listed.Paused, listed.Version, listed.DeviceVersions)
	}
	versions, _ = f.server.store.ListBundleVersions(ctx, bundle.ID)
	for _, version := range versions {
		if version.Tag == "1.2.0" && (version.Check == nil || version.Check.State != store.CheckFailed) {
			t.Fatalf("1.2.0's check: %+v", version.Check)
		}
	}
	expectSession("after the rollback", "1.1.0", "1.1.0")
	var pending pendingItemList
	_ = json.Unmarshal(call(http.MethodGet, "/api/pending-items", "", http.StatusOK), &pending)
	told := false
	for _, item := range pending.Items {
		told = told || (item.Source == store.PendingSourceBundleUpdate && item.State == store.PendingOpen && strings.Contains(item.Title, "1.2.0") && strings.Contains(item.Excerpt, "reported 0.9.0"))
	}
	if !told {
		t.Fatalf("the follower was not told: %+v", pending.Items)
	}

	// Resumed, 1.2.0 goes out again, and this time the canary cannot
	// install it (its download keeps failing): nothing moved and nothing
	// says the version is bad, so the rollout fails without rolling back or
	// pausing, the device and its sessions stay on 1.1.0, and the person
	// is told.
	worker.mu.Lock()
	worker.checkFails = false
	worker.installFailures = 3
	worker.mu.Unlock()
	call(http.MethodPost, "/api/skill-repositories/"+bundle.ID+"/resume", `{}`, http.StatusOK)
	if rollout := rolloutEnded(bundle.ID); rollout.State != store.RolloutFailed || !strings.Contains(rollout.Error, "download failed") {
		t.Fatalf("canary install failed: %+v", rollout)
	}
	if got := steps(); !slices.Equal(got, []string{"install:1.2.0:staged:failed", "install:1.2.0:staged:failed", "install:1.2.0:staged:failed"}) {
		t.Fatalf("install tries: %v", got)
	}
	if listed := repository(bundle.ID); listed.Paused || listed.Version != "1.2.0" || listed.DeviceVersions[0].State != store.DeviceBundleBehind {
		t.Fatalf("after a failed install: paused %v, version %s, devices %+v", listed.Paused, listed.Version, listed.DeviceVersions)
	}
	expectSession("after a failed install", "1.1.0", "1.1.0")
	_ = json.Unmarshal(call(http.MethodGet, "/api/pending-items", "", http.StatusOK), &pending)
	told = false
	for _, item := range pending.Items {
		told = told || (item.Source == store.PendingSourceBundleUpdate && item.Rule == store.RolloutFailed && item.State == store.PendingOpen && strings.Contains(item.Excerpt, "download failed"))
	}
	if !told {
		t.Fatalf("the failed install was not told: %+v", pending.Items)
	}

	// Update tries again; with a working download the same version goes out.
	call(http.MethodPost, "/api/skill-repositories/"+bundle.ID+"/update", `{}`, http.StatusOK)
	if rollout := rolloutEnded(bundle.ID); rollout.State != store.RolloutDone || rollout.Tag != "1.2.0" {
		t.Fatalf("updated again: %+v", rollout)
	}
	steps()
	expectSession("updated again", "1.2.0", "1.2.0")

	// The rollback drill: a manual update asked to fail its check.
	call(http.MethodPut, "/api/skill-repositories/"+bundle.ID+"/update-policy", `{"policy":"manual"}`, http.StatusOK)
	publish("1.3.0", "skill for 1.3.0")
	call(http.MethodPost, "/api/skill-repositories/"+bundle.ID+"/check", `{}`, http.StatusOK)
	expectStatus(t, doAuthCall(t, f.handler, f.as(f.bob, http.MethodPost, "/api/skill-repositories/"+bundle.ID+"/update", `{"failCheck":true}`)), http.StatusForbidden, "a member drills")
	call(http.MethodPost, "/api/skill-repositories/"+bundle.ID+"/update", `{"failCheck":true}`, http.StatusOK)
	rollout = rolloutEnded(bundle.ID)
	canary := rollout.Devices[0]
	if rollout.State != store.RolloutRolledBack || canary.Check == nil || !canary.Check.Forced {
		t.Fatalf("drill: %+v", rollout)
	}
	if got := steps(); !slices.Equal(got, []string{"install:1.3.0:staged", "check:1.3.0", "remove:1.3.0"}) {
		t.Fatalf("drill steps: %v", got)
	}
	// A member sees the bundle's state without anyone else's devices.
	var seen []store.SkillRepository
	recorder := doAuthCall(t, f.handler, f.as(f.bob, http.MethodGet, "/api/skill-repositories", ""))
	expectStatus(t, recorder, http.StatusOK, "a member lists repositories")
	_ = json.Unmarshal(recorder.Body.Bytes(), &seen)
	for _, item := range seen {
		if item.ID != bundle.ID {
			continue
		}
		if len(item.DeviceVersions) != 0 || item.Rollout == nil || len(item.Rollout.Devices) != 0 || item.Rollout.CanaryDeviceID != "" ||
			item.Rollout.Error != "" || item.Rollout.State != store.RolloutRolledBack {
			t.Fatalf("a member sees others' devices: %+v %+v", item.DeviceVersions, item.Rollout)
		}
		for _, version := range item.Versions {
			if version.Check != nil && (version.Check.DeviceID != "" || version.Check.DeviceName != "" || len(version.Check.Steps) != 0) {
				t.Fatalf("a member sees another device's check: %+v", version.Check)
			}
		}
	}
	if listed := repository(bundle.ID); len(listed.DeviceVersions) != 1 || listed.Rollout.CanaryDeviceID != "dev_alice" || listed.Rollout.Error == "" {
		t.Fatalf("an Admin sees every device: %+v %+v", listed.DeviceVersions, listed.Rollout)
	}
	expectSession("after the drill", "1.2.0", "1.2.0")
	// Resumed while manual: the library follows 1.3.0 again, the device
	// stays on 1.2.0 until Update, and its sessions with it.
	call(http.MethodPost, "/api/skill-repositories/"+bundle.ID+"/resume", `{}`, http.StatusOK)
	if listed := repository(bundle.ID); listed.Paused || listed.Version != "1.3.0" || listed.DeviceVersions[0].State != store.DeviceBundleBehind || listed.Rollout.ID != rollout.ID {
		t.Fatalf("resumed while manual: paused %v, version %s, devices %+v, rollout %+v", listed.Paused, listed.Version, listed.DeviceVersions, listed.Rollout)
	}
	if got := steps(); len(got) != 0 {
		t.Fatalf("resuming a manual bundle installed: %v", got)
	}
	expectSession("resumed while manual", "1.2.0", "1.2.0")

	// A device that is offline waits without holding the bundle back: the
	// canary and the online devices move, and the next version's rollout
	// takes the offline device over.
	if err := f.server.store.SetDeviceToolVersion(ctx, "dev_bob", "corpcli", "1.2.0"); err != nil {
		t.Fatal(err)
	}
	call(http.MethodPost, "/api/skill-repositories/"+bundle.ID+"/update", `{}`, http.StatusOK)
	var waiting store.SkillBundleRollout
	waitFor(t, "the canary and online devices", func() bool {
		item, err := f.server.store.(skillRepositoryStore).GetSkillRepository(ctx, bundle.ID)
		if err != nil || item.Rollout == nil || item.Rollout.Tag != "1.3.0" || item.Rollout.State != store.RolloutRolling {
			return false
		}
		waiting = *item.Rollout
		for _, device := range waiting.Devices {
			if device.DeviceID == "dev_bob" && device.State != store.RolloutDeviceOffline {
				return false
			}
		}
		return true
	})
	if waiting.CanaryDeviceID != "dev_alice" || waiting.Finished() {
		t.Fatalf("rollout waiting for an offline device: %+v", waiting)
	}
	steps()
	expectSession("updated while another device is offline", "1.3.0", "1.3.0")
	// Rollout rows name devices as they are called now, with whose they
	// are when not the viewer's, and tell one owner's alike names apart.
	if _, err := f.server.store.RenameDevice(ctx, "dev_bob", "linux-dev"); err != nil {
		t.Fatal(err)
	}
	pairOverHTTP(t, f.handler, f.alice, "machine-alice-2", "dev_alice_twin")
	registerDeviceForTest(t, f.server, registrationBody("dev_alice_twin", "ws_alice_twin"))
	if _, err := f.server.store.RenameDevice(ctx, "dev_alice_twin", "linux-dev"); err != nil {
		t.Fatal(err)
	}
	named := map[string]store.SkillBundleRolloutDevice{}
	for _, device := range repository(bundle.ID).Rollout.Devices {
		named[device.DeviceID] = device
	}
	if bob := named["dev_bob"]; bob.DeviceName != "linux-dev" || bob.Owner != "bob" {
		t.Fatalf("another person's device: %+v", bob)
	}
	if alice := named["dev_alice"]; alice.Owner != "" || alice.DeviceName != "linux-dev …lice" {
		t.Fatalf("the viewer's device that shares a name with another of theirs: %+v", alice)
	}
	publish("1.4.0", "skill for 1.4.0")
	call(http.MethodPost, "/api/skill-repositories/"+bundle.ID+"/check", `{}`, http.StatusOK)
	call(http.MethodPost, "/api/skill-repositories/"+bundle.ID+"/update", `{}`, http.StatusOK)
	waitFor(t, "the next version's rollout", func() bool {
		item, err := f.server.store.(skillRepositoryStore).GetSkillRepository(ctx, bundle.ID)
		return err == nil && item.Rollout != nil && item.Rollout.Tag == "1.4.0" && item.Rollout.State == store.RolloutRolling
	})
	if got := steps(); !slices.Equal(got, []string{"install:1.4.0:staged", "check:1.4.0", "activate:1.4.0"}) {
		t.Fatalf("next version's canary steps: %v", got)
	}
}

// DEV-154 with DEV-136: once devices run a feishu-cli whose preset asks
// for more scopes, each Feishu account that lacks them is one item to
// authorize again, never a silent failure; authorized again, it settles.
func TestPendingItemAsksForTheScopesANewFeishuCLINeeds(t *testing.T) {
	f := newIsolationFixture(t)
	ctx := context.Background()
	backing := f.server.store
	t.Cleanup(func() { externalaccounts.SetToolVersion(externalaccounts.FeishuCLITool, "") })
	externalaccounts.SetToolVersion(externalaccounts.FeishuCLITool, "v1.41.0")
	oldPreset := externalaccounts.FeishuPresetScopes(false)
	app, err := backing.CreateExternalProviderApp(ctx, store.ExternalProviderApp{ID: "fs-app", Provider: "feishu", OwnerUserID: f.aliceID, ClientID: "fixture-public", CreatedVia: "dynamic_registration"})
	if err != nil {
		t.Fatal(err)
	}
	account, err := backing.SaveExternalAccount(ctx, store.ExternalAccount{ID: "fs-account", AppID: app.ID, Provider: "feishu", OwnerUserID: f.aliceID, Label: "Alice Feishu",
		Mode: store.ExternalCredentialServerHeld, Status: store.ExternalAccountReady, Subject: "ou_alice", GrantedScopes: oldPreset})
	if err != nil {
		t.Fatal(err)
	}
	scopeItems := func() []pendingItemView {
		t.Helper()
		recorder := doAuthCall(t, f.handler, f.as(f.alice, http.MethodGet, "/api/pending-items", ""))
		expectStatus(t, recorder, http.StatusOK, "list pending items")
		var items pendingItemList
		_ = json.Unmarshal(recorder.Body.Bytes(), &items)
		found := []pendingItemView{}
		for _, item := range items.Items {
			if item.Source == store.PendingSourceAccount && strings.HasPrefix(item.EventID, "account-scopes:") {
				found = append(found, item)
			}
		}
		return found
	}
	setDeviceCLI := func(version string) {
		t.Helper()
		if err := backing.SetDeviceToolVersion(ctx, "dev_alice", "feishu-cli", version); err != nil {
			t.Fatal(err)
		}
		f.server.syncConnectorToolVersions(ctx)
	}

	setDeviceCLI("v1.41.0")
	if got := scopeItems(); len(got) != 0 {
		t.Fatalf("nothing new on v1.41.0: %+v", got)
	}
	setDeviceCLI("v1.44.0")
	got := scopeItems()
	if len(got) != 1 || got[0].State != store.PendingOpen || got[0].Title != "Alice Feishu" || got[0].Context != "feishu-cli v1.44.0" ||
		len(strings.Fields(got[0].Excerpt)) != 31 || !strings.Contains(got[0].Excerpt, "slides:presentation:screenshot") {
		t.Fatalf("v1.44.0 over a v1.41.0 login: %+v", got)
	}
	account.GrantedScopes = externalaccounts.FeishuPresetScopes(false)
	if _, err := backing.SaveExternalAccount(ctx, account); err != nil {
		t.Fatal(err)
	}
	if got := scopeItems(); len(got) != 1 || got[0].State != store.PendingSuperseded {
		t.Fatalf("authorized again: %+v", got)
	}
}

// DEV-154: a check is kept and shown as one line per step. The Feishu
// catalog's commands give their kinds, the version comes from --version,
// a passed command's output (name, ids, scopes, token profile) is dropped,
// and a failed one's identity values are masked.
func TestCheckStepsAreKeptAsOneLine(t *testing.T) {
	server := NewServer(newTestStore(t))
	steps := server.keptCheckSteps("feishu-cli", []store.SkillBundleCheckStep{
		{Name: "feishu-cli --version", State: store.CheckPassed, Detail: "feishu-cli version v1.44.0 (built 2026-11-05_19:01:20)"},
		{Name: "feishu-cli auth status -o json", State: store.CheckPassed, Detail: `…mail:user_mailbox.rule:write offline_access", "token_from_profile": "foundry-7a3ec9ed-a293-446e-863b-712ba5e7d899-a3533468d4", "token_status": "valid" }`},
		{Name: "feishu-cli auth refresh -o json", State: store.CheckPassed, Detail: `…"status": "ok" }`},
		{Name: "feishu-cli api GET /open-apis/authen/v1/user_info --as user", State: store.CheckFailed,
			Detail: `exit 1: {"avatar_url": "https://s3-imfile.feishucdn.com/x.webp", "en_name": "Alice", "name": "爱丽丝", "open_id": "ou_34eaff16f21d3f8d1a3541bd5c4ca6d9", "tenant_key": "736588c9260f175d", "msg": "rate limited"}`},
	})
	if steps[0].Kind != "version" || steps[0].Value != "v1.44.0" || steps[0].Detail != "" {
		t.Fatalf("version step: %+v", steps[0])
	}
	if steps[1].Kind != "status" || steps[1].Service != "Feishu" || steps[1].Detail != "" ||
		steps[2].Kind != "refresh" || steps[2].Detail != "" {
		t.Fatalf("passed account steps: %+v %+v", steps[1], steps[2])
	}
	failed := steps[3]
	if failed.Kind != "read" || failed.Service != "Feishu" || !strings.Contains(failed.Detail, `"msg": "rate limited"`) {
		t.Fatalf("failed read step: %+v", failed)
	}
	for _, leaked := range []string{"Alice", "爱丽丝", "ou_34eaff", "736588c9", "feishucdn"} {
		if strings.Contains(failed.Detail, leaked) {
			t.Fatalf("a failed step keeps %q: %s", leaked, failed.Detail)
		}
	}
	// A device that reports the value keeps it; its output never.
	reported := server.keptCheckSteps("feishu-cli", []store.SkillBundleCheckStep{
		{Name: "feishu-cli api GET /open-apis/authen/v1/user_info --as user", State: store.CheckPassed, Kind: "read", Value: "爱丽丝", Detail: "anything"},
	})
	if reported[0].Value != "爱丽丝" || reported[0].Detail != "" || reported[0].Service != "Feishu" {
		t.Fatalf("reported read step: %+v", reported[0])
	}
}
