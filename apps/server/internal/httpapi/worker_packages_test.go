package httpapi

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/sqlitestore"
)

func newWorkerPackagesServer(t *testing.T, dir string) http.Handler {
	t.Helper()
	db, err := sqlitestore.Open(t.TempDir() + "/foundry.db")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return NewServerWithOptions(db, ServerOptions{AllowedOrigin: accountsTestOrigin, WorkerPackagesDir: dir}).Routes()
}

func TestWorkerReleaseWithoutPackagesPointsToNPM(t *testing.T) {
	handler := newWorkerPackagesServer(t, "")
	recorder := doAuthCall(t, handler, authCall{method: http.MethodGet, path: "/api/worker/release"})
	expectStatus(t, recorder, http.StatusOK, "release")
	var release workerRelease
	if err := json.Unmarshal(recorder.Body.Bytes(), &release); err != nil {
		t.Fatal(err)
	}
	if release.Source != "npm" || len(release.Packages) != 0 {
		t.Fatalf("release = %+v, want npm", release)
	}
	expectStatus(t, doAuthCall(t, handler, authCall{method: http.MethodGet, path: "/api/worker/packages/worker.tgz"}), http.StatusNotFound, "package")
}

func TestWorkerReleaseServesListedPackagesWithoutSignIn(t *testing.T) {
	dir := t.TempDir()
	for name, content := range map[string]string{
		"release.json": `{"version":"0.5.7-dev.2.gabc1234","packages":[{"name":"@bd777/foundry-protocol","file":"protocol.tgz"},{"name":"@bd777/foundry-worker","file":"worker.tgz"}]}`,
		"protocol.tgz": "protocol-bytes",
		"worker.tgz":   "worker-bytes",
		"other.tgz":    "not listed",
	} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	handler := newWorkerPackagesServer(t, dir)
	recorder := doAuthCall(t, handler, authCall{method: http.MethodGet, path: "/api/worker/release"})
	expectStatus(t, recorder, http.StatusOK, "release")
	var release workerRelease
	if err := json.Unmarshal(recorder.Body.Bytes(), &release); err != nil {
		t.Fatal(err)
	}
	if release.Source != "server" || release.Version != "0.5.7-dev.2.gabc1234" || len(release.Packages) != 2 ||
		release.Packages[1].URL != "/api/worker/packages/worker.tgz" {
		t.Fatalf("release = %+v", release)
	}
	recorder = doAuthCall(t, handler, authCall{method: http.MethodGet, path: release.Packages[1].URL})
	expectStatus(t, recorder, http.StatusOK, "worker package")
	if recorder.Body.String() != "worker-bytes" {
		t.Fatalf("package body = %q", recorder.Body.String())
	}
	if release.Packages[1].LatestURL != "/api/worker/packages/latest/foundry-worker.tgz" {
		t.Fatalf("latest url = %q", release.Packages[1].LatestURL)
	}
	recorder = doAuthCall(t, handler, authCall{method: http.MethodGet, path: release.Packages[1].LatestURL})
	expectStatus(t, recorder, http.StatusOK, "latest worker package")
	if recorder.Body.String() != "worker-bytes" {
		t.Fatalf("latest package body = %q", recorder.Body.String())
	}
	for _, path := range []string{"/api/worker/packages/latest/other.tgz", "/api/worker/packages/other.tgz", "/api/worker/packages/release.json", "/api/worker/packages/..%2Frelease.json"} {
		expectStatus(t, doAuthCall(t, handler, authCall{method: http.MethodGet, path: path}), http.StatusNotFound, path)
	}
}
