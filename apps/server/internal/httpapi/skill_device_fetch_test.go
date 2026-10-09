package httpapi

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/skillrepo"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"github.com/gorilla/websocket"
)

// serverMustNotRead fails the test when the server reads a repository
// itself instead of through the device.
type serverMustNotRead struct{ t *testing.T }

func (s serverMustNotRead) fail(remote string) error {
	s.t.Errorf("the server read %s itself", remote)
	return os.ErrPermission
}
func (s serverMustNotRead) Resolve(_ context.Context, remote, _ string) (string, error) {
	return "", s.fail(remote)
}
func (s serverMustNotRead) Fetch(_ context.Context, remote, _ string) (*skillrepo.Checkout, error) {
	return nil, s.fail(remote)
}
func (s serverMustNotRead) LatestRelease(_ context.Context, remote string) (string, string, bool, error) {
	return "", "", false, s.fail(remote)
}
func (s serverMustNotRead) Describe(_ context.Context, remote string) (string, error) {
	return "", s.fail(remote)
}

// fakeFetchWorker is a worker on its own device: it reads a local git
// repository (whatever remote the server names) and a local npm package,
// the way the real worker reads them with the device's own settings.
type fakeFetchWorker struct {
	t          *testing.T
	serverURL  string
	credential string
	repo       localRepo
	conn       *websocket.Conn
	mu         sync.Mutex
	remotes    []string
	npm        map[string][]byte // version -> tarball
	npmLatest  string
	installs   []store.SkillBundleTool
	done       chan struct{}
}

func (w *fakeFetchWorker) connect(capabilities ...string) {
	w.t.Helper()
	headers := http.Header{}
	headers.Set(deviceCredentialHeader, w.credential)
	conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(w.serverURL, "http")+"/api/daemon/ws", headers)
	if err != nil {
		w.t.Fatalf("dial: %v", err)
	}
	w.conn = conn
	w.done = make(chan struct{})
	writeWSForTest(w.t, conn, "hello", map[string]any{
		"capabilities": capabilities,
		"device":       map[string]any{"id": "dev_alice", "label": "byte-dev", "status": "connected", "lastSeenLabel": "online"},
		"workspace":    map[string]any{"id": "ws_alice", "name": "W", "localPath": "/tmp/w", "baseline": "main"},
	})
	go w.serve()
}

func (w *fakeFetchWorker) disconnect() {
	_ = w.conn.Close()
	<-w.done
}

func (w *fakeFetchWorker) reply(id, messageType string, payload any) {
	w.mu.Lock()
	defer w.mu.Unlock()
	_ = w.conn.WriteJSON(map[string]any{"id": id, "type": messageType, "payload": payload})
}

func (w *fakeFetchWorker) serve() {
	defer close(w.done)
	for {
		var envelope wsEnvelope
		if err := w.conn.ReadJSON(&envelope); err != nil {
			return
		}
		switch envelope.Type {
		case wsReadRepositoryRefsType:
			var request wsReadRepositoryRefs
			_ = json.Unmarshal(envelope.Payload, &request)
			w.record(request.Remote)
			w.reply(envelope.ID, wsRepositoryRefsReadType, w.refs(request))
		case wsFetchSkillRepositoryType:
			var request wsFetchSkillRepository
			_ = json.Unmarshal(envelope.Payload, &request)
			w.record(request.Remote)
			go func() { w.reply(envelope.ID, wsSkillRepositoryFetchedType, w.fetch(request)) }()
		case wsInstallToolType:
			var request wsInstallTool
			_ = json.Unmarshal(envelope.Payload, &request)
			w.mu.Lock()
			w.installs = append(w.installs, request.Tool)
			w.mu.Unlock()
			w.reply(envelope.ID, wsToolInstalledType, wsToolInstalled{Name: request.Tool.Name, Version: request.Tool.Version})
		}
	}
}

func (w *fakeFetchWorker) record(remote string) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.remotes = append(w.remotes, remote)
}

func (w *fakeFetchWorker) refs(request wsReadRepositoryRefs) wsRepositoryRefs {
	if skillrepo.IsNPM(request.Remote) {
		versions := []string{}
		for version := range w.npm {
			versions = append(versions, version)
		}
		return wsRepositoryRefs{DistTags: map[string]string{"latest": w.npmLatest}, Versions: versions}
	}
	if strings.Contains(request.Remote, "unreachable") {
		return wsRepositoryRefs{Error: "fatal: unable to access '" + request.Remote + "': Could not resolve host: unreachable.internal"}
	}
	args := []string{"ls-remote"}
	if request.Tags {
		args = append(args, "--tags")
	}
	args = append(args, "--", w.repo.dir)
	out, err := exec.Command("git", append(args, request.Patterns...)...).Output()
	if err != nil {
		return wsRepositoryRefs{Error: err.Error()}
	}
	return wsRepositoryRefs{Refs: string(out)}
}

func (w *fakeFetchWorker) fetch(request wsFetchSkillRepository) wsSkillRepositoryFetched {
	var body []byte
	commit := ""
	if skillrepo.IsNPM(request.Remote) {
		commit = request.Ref
		if commit == "" || commit == "latest" {
			commit = w.npmLatest
		}
		body = w.npm[commit]
	} else {
		checkout, err := (localRepo{t: w.t, dir: w.repo.dir}).Fetch(context.Background(), request.Remote, request.Ref)
		if err != nil {
			return wsSkillRepositoryFetched{Error: err.Error()}
		}
		defer checkout.Close()
		commit = checkout.Commit
		var buffer bytes.Buffer
		archive := zip.NewWriter(&buffer)
		_ = filepath.WalkDir(checkout.Dir, func(path string, entry fs.DirEntry, err error) error {
			if err != nil || entry.Name() == ".git" {
				return fs.SkipDir
			}
			if entry.IsDir() {
				return nil
			}
			rel, _ := filepath.Rel(checkout.Dir, path)
			data, _ := os.ReadFile(path)
			out, _ := archive.Create(filepath.ToSlash(rel))
			_, _ = out.Write(data)
			return nil
		})
		_ = archive.Close()
		body = buffer.Bytes()
	}
	upload, _ := http.NewRequest(http.MethodPost, w.serverURL+request.UploadPath, bytes.NewReader(body))
	upload.Header.Set(deviceCredentialHeader, w.credential)
	response, err := http.DefaultClient.Do(upload)
	if err != nil {
		return wsSkillRepositoryFetched{Error: err.Error()}
	}
	response.Body.Close()
	if response.StatusCode != http.StatusNoContent {
		return wsSkillRepositoryFetched{Error: "upload " + response.Status}
	}
	return wsSkillRepositoryFetched{Commit: commit}
}

func waitFor(t *testing.T, what string, done func() bool) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for !done() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// A repository the server cannot reach is read through the device its
// owner chose: added, checked, rolled back and resumed like any other,
// with the server never reading the URL itself. While the device is
// offline its checks wait, and they run when it is back.
func TestSkillRepositoryReadThroughDevice(t *testing.T) {
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
		"skills/review/SKILL.md": "---\nname: review\ndescription: Reviews\n---\nv1\n",
		"skills/notes/SKILL.md":  "---\nname: notes\n---\n",
		"LICENSE":                "MIT",
	})
	repo.git("tag", "v1.0.0")
	worker := &fakeFetchWorker{t: t, serverURL: httpServer.URL, credential: f.aliceDevice, repo: repo}
	worker.connect(skillRepositoryFetchCapability)
	defer worker.disconnect()
	waitFor(t, "the device to connect", func() bool { return f.server.hub.HasConnection("dev_alice") })

	call := func(method, path, body string, want int) []byte {
		t.Helper()
		recorder := doAuthCall(t, f.handler, f.as(f.alice, method, path, body))
		expectStatus(t, recorder, want, method+" "+path)
		return recorder.Body.Bytes()
	}
	const remote = "https://code.internal.example/team/skills"

	// Only the device's owner may have it read a repository.
	call(http.MethodPost, "/api/skill-repositories", `{"url":"`+remote+`","subpath":"skills","mode":"bundle","deviceId":"dev_bob"}`, http.StatusNotFound)
	// An ssh remote needs a device's keys.
	call(http.MethodGet, "/api/skill-repositories/preview?url=git@code.internal.example:team/skills.git", "", http.StatusBadRequest)

	var preview struct {
		Label     string                        `json:"label"`
		Available []store.RepositorySkillFolder `json:"available"`
		Release   string                        `json:"release"`
	}
	_ = json.Unmarshal(call(http.MethodGet, "/api/skill-repositories/preview?subpath=skills&deviceId=dev_alice&url=git@code.internal.example:team/skills.git", "", http.StatusOK), &preview)
	if preview.Label != "code.internal.example/team/skills" || len(preview.Available) != 2 || preview.Release != "v1.0.0" {
		t.Fatalf("preview through the device: %+v", preview)
	}

	var added store.SkillRepositoryView
	_ = json.Unmarshal(call(http.MethodPost, "/api/skill-repositories", `{"url":"`+remote+`","subpath":"skills","mode":"bundle","deviceId":"dev_alice"}`, http.StatusCreated), &added)
	bundle := added.Repository
	if bundle.FetchDeviceID != "dev_alice" || bundle.FetchDeviceName != "byte-dev" || !bundle.FetchDeviceOnline || bundle.Version != "v1.0.0" || len(bundle.Skills) != 2 {
		t.Fatalf("bundle read through the device: %+v", bundle)
	}
	if bundle.Description != "" {
		t.Fatalf("a repository a device reads is not described by its host: %q", bundle.Description)
	}
	review := ""
	for _, skill := range bundle.Skills {
		if skill.Name == "review" {
			review = skill.SkillID
		}
	}
	if text, revision := skillContent(t, f.server.store, review); !strings.Contains(text, "v1") || revision != 1 {
		t.Fatalf("review from the device: revision %d %q", revision, text)
	}

	// A new release is found and taken through the device.
	repo.commit(map[string]string{"skills/review/SKILL.md": "---\nname: review\n---\nv2\n"})
	repo.git("tag", "v1.1.0")
	var checked store.SkillRepository
	_ = json.Unmarshal(call(http.MethodPost, "/api/skill-repositories/"+bundle.ID+"/check", `{}`, http.StatusOK), &checked)
	if checked.Version != "v1.1.0" {
		t.Fatalf("checked through the device: %+v", checked)
	}
	if text, revision := skillContent(t, f.server.store, review); !strings.Contains(text, "v2") || revision != 2 {
		t.Fatalf("review after the update: revision %d %q", revision, text)
	}

	// Rolling back and resuming work as for any repository.
	var rolled store.SkillRepository
	_ = json.Unmarshal(call(http.MethodPost, "/api/skill-repositories/"+bundle.ID+"/rollback", `{"seq":1}`, http.StatusOK), &rolled)
	if !rolled.Paused {
		t.Fatalf("rolled back: %+v", rolled)
	}
	if text, _ := skillContent(t, f.server.store, review); !strings.Contains(text, "v1") {
		t.Fatalf("review after rollback: %q", text)
	}
	var resumed store.SkillRepository
	_ = json.Unmarshal(call(http.MethodPost, "/api/skill-repositories/"+bundle.ID+"/resume", `{}`, http.StatusOK), &resumed)
	if resumed.Paused || resumed.Version != "v1.1.0" {
		t.Fatalf("resumed: %+v", resumed)
	}

	// Picking skills through the device works the same way.
	var picked store.SkillRepositoryView
	_ = json.Unmarshal(call(http.MethodPost, "/api/skill-repositories", `{"url":"`+remote+`","ref":"main","subpath":"skills","dirs":["skills/notes"],"deviceId":"dev_alice"}`, http.StatusCreated), &picked)
	if len(picked.Repository.Skills) != 1 || len(picked.Available) != 2 || picked.Repository.FetchDeviceID != "dev_alice" {
		t.Fatalf("picked through the device: %+v", picked)
	}

	// The device's own words reach people, naming it.
	recorder := doAuthCall(t, f.handler, f.as(f.alice, http.MethodGet, "/api/skill-repositories/preview?deviceId=dev_alice&url=https://unreachable.internal/x/y", ""))
	expectStatus(t, recorder, http.StatusBadGateway, "preview of a host the device cannot reach")
	if !strings.Contains(recorder.Body.String(), "byte-dev could not reach unreachable.internal") {
		t.Fatalf("device error: %s", recorder.Body.String())
	}

	// Another device cannot post files for this device's fetch.
	expectStatus(t, doAuthCall(t, f.handler, deviceCall(http.MethodPost, "/api/daemon/skill-repository-fetches/nobody-waits", "x", f.bobDevice)), http.StatusNotFound, "upload for no fetch")

	// Offline: checks wait instead of failing, and run when it is back.
	worker.disconnect()
	waitFor(t, "the device to drop", func() bool { return !f.server.hub.HasConnection("dev_alice") })
	repo.commit(map[string]string{"skills/review/SKILL.md": "---\nname: review\n---\nv3\n"})
	repo.git("tag", "v1.2.0")
	var waiting store.SkillRepository
	_ = json.Unmarshal(call(http.MethodPost, "/api/skill-repositories/"+bundle.ID+"/check", `{}`, http.StatusOK), &waiting)
	if !waiting.CheckWaiting || waiting.Error != "" {
		t.Fatalf("check now while offline = %+v; want it waiting, not failed", waiting)
	}
	var listed []store.SkillRepository
	_ = json.Unmarshal(call(http.MethodGet, "/api/skill-repositories", "", http.StatusOK), &listed)
	for _, item := range listed {
		if item.ID == bundle.ID && (!item.CheckWaiting || item.FetchDeviceOnline || item.Version != "v1.1.0" || item.Error != "") {
			t.Fatalf("offline device's repository: %+v", item)
		}
	}
	// The daily check skips it the same way, without an error.
	current, _ := f.server.store.(skillRepositoryStore).GetSkillRepository(context.Background(), bundle.ID)
	if err := f.server.checkSkillRepository(context.Background(), f.server.store.(skillRepositoryStore), current); err == nil || !strings.Contains(err.Error(), "offline") {
		t.Fatalf("check while offline: %v", err)
	}

	worker.connect(skillRepositoryFetchCapability)
	waitFor(t, "the waiting check to run", func() bool {
		item, err := f.server.store.(skillRepositoryStore).GetSkillRepository(context.Background(), bundle.ID)
		return err == nil && item.Version == "v1.2.0" && !item.CheckWaiting
	})
	for _, remoteSeen := range worker.remotes {
		if remoteSeen != remote && !strings.Contains(remoteSeen, "code.internal.example") && !strings.Contains(remoteSeen, "unreachable") {
			t.Fatalf("the device was asked for %q", remoteSeen)
		}
	}
}

// An npm package on a registry only the device reaches is followed through
// the device: its versions and tarball come from there, and its command
// installs from the same registry, with the sign-in it needs shown.
func TestNPMBundleReadThroughDevice(t *testing.T) {
	f := newIsolationFixture(t)
	f.server.skillRepos = serverMustNotRead{t: t}
	httpServer := httptest.NewServer(f.handler)
	defer httpServer.Close()
	packageJSON := `{"name":"@acme/bytedcli","version":"%s","bin":{"bytedcli":"cli.js"}}`
	worker := &fakeFetchWorker{t: t, serverURL: httpServer.URL, credential: f.aliceDevice, npm: map[string][]byte{}}
	worker.npm["1.0.0"] = npmPackageTarball(t, map[string]string{
		"package.json":             strings.Replace(packageJSON, "%s", "1.0.0", 1),
		"cli.js":                   "#!/usr/bin/env node\n",
		"skills/bytedcli/SKILL.md": "---\nname: bytedcli\ndescription: Internal tools\n---\n",
	})
	worker.npmLatest = "1.0.0"
	worker.connect(skillRepositoryFetchCapability, toolInstallCapability, toolSourcesCapability, toolRegistryCapability)
	defer worker.disconnect()
	waitFor(t, "the device to connect", func() bool { return f.server.hub.HasConnection("dev_alice") })
	call := func(method, path, body string, want int) []byte {
		t.Helper()
		recorder := doAuthCall(t, f.handler, f.as(f.alice, method, path, body))
		expectStatus(t, recorder, want, method+" "+path)
		return recorder.Body.Bytes()
	}

	call(http.MethodPost, "/api/skill-repositories", `{"url":"npm:@acme/bytedcli","mode":"bundle","deviceId":"dev_alice","registry":"http://npm.internal.example"}`, http.StatusBadRequest)
	var added store.SkillRepositoryView
	_ = json.Unmarshal(call(http.MethodPost, "/api/skill-repositories", `{"url":"npm:@acme/bytedcli","mode":"bundle","deviceId":"dev_alice","registry":"https://npm.internal.example/"}`, http.StatusCreated), &added)
	bundle := added.Repository
	if bundle.Version != "1.0.0" || len(bundle.Skills) != 1 || bundle.Registry != "https://npm.internal.example" || len(bundle.Tools) != 1 {
		t.Fatalf("npm bundle through the device: %+v", bundle)
	}
	tool := bundle.Tools[0]
	if tool.Name != "bytedcli" || tool.Source != "npm" || tool.Registry != "https://npm.internal.example" || strings.Join(tool.SignIn, " ") != "auth login" {
		t.Fatalf("its tool: %+v", tool)
	}

	worker.npm["1.1.0"] = npmPackageTarball(t, map[string]string{
		"package.json":             strings.Replace(packageJSON, "%s", "1.1.0", 1),
		"cli.js":                   "#!/usr/bin/env node\n",
		"skills/bytedcli/SKILL.md": "---\nname: bytedcli\ndescription: Internal tools v2\n---\n",
	})
	worker.npmLatest = "1.1.0"
	var checked store.SkillRepository
	_ = json.Unmarshal(call(http.MethodPost, "/api/skill-repositories/"+bundle.ID+"/check", `{}`, http.StatusOK), &checked)
	if checked.Version != "1.1.0" || checked.Tools[0].Version != "1.1.0" {
		t.Fatalf("npm bundle after a release: %+v", checked)
	}

	call(http.MethodPost, "/api/devices/dev_alice/tools/install", `{"repositoryId":"`+bundle.ID+`","tool":"bytedcli"}`, http.StatusOK)
	if len(worker.installs) != 1 || worker.installs[0].Registry != "https://npm.internal.example" || worker.installs[0].Version != "1.1.0" {
		t.Fatalf("install asked of the device: %+v", worker.installs)
	}

	// Only the owner's devices may read it; without a registry its tools
	// install with the device's own npm settings.
	var moved store.SkillRepository
	recorder := doAuthCall(t, f.handler, f.as(f.alice, http.MethodPut, "/api/skill-repositories/"+bundle.ID+"/source", `{"deviceId":"dev_bob"}`))
	expectStatus(t, recorder, http.StatusNotFound, "another person's device")
	_ = json.Unmarshal(call(http.MethodPut, "/api/skill-repositories/"+bundle.ID+"/source", `{"deviceId":"dev_alice","registry":""}`, http.StatusOK), &moved)
	if moved.FetchDeviceID != "dev_alice" || moved.Registry != "" {
		t.Fatalf("source changed: %+v", moved)
	}
	if moved.Tools[0].Registry != deviceRegistry {
		t.Fatalf("a device-read package without a registry installs with the device's npm settings: %+v", moved.Tools[0])
	}
}
