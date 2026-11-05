package httpapi

import (
	"os"
	"path/filepath"
	"testing"
)

// requireWorkerBuild is the built Worker (packages/worker/dist) that
// tests drive real CLIs and the Worker's own modules through. rel names a file
// the test loads from it. A missing build is a failure where one is promised
// (CI, and scripts/check-changed.sh, which set FOUNDRY_REQUIRE_WORKER_BUILD=1):
// a test that skips silently on a stale path or a forgotten build covers
// nothing. Elsewhere it skips, so a plain `go test` before a first build works.
func requireWorkerBuild(t *testing.T, rel string) string {
	t.Helper()
	dist, err := filepath.Abs("../../../../packages/worker/dist")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dist, rel)); err != nil {
		if os.Getenv("CI") != "" || os.Getenv("FOUNDRY_REQUIRE_WORKER_BUILD") == "1" {
			t.Fatalf("the Worker build lacks %s (packages/worker/dist): build it first (pnpm --filter @bd777/foundry-worker build)", rel)
		}
		t.Skipf("the Worker is not built: no %s under packages/worker/dist", rel)
	}
	return dist
}
