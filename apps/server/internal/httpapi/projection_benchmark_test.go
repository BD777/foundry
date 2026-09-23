package httpapi

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/sqlitestore"
)

// Opt-in diagnosis against a private SQLite backup, never the running database.
// Logs durations only; no conversation contents enter the benchmark output.
func TestLocalProjectionTimings(t *testing.T) {
	path := os.Getenv("FOUNDRY_PERF_DB_COPY")
	if path == "" {
		t.Skip("set FOUNDRY_PERF_DB_COPY to an isolated SQLite backup")
	}
	db, err := sqlitestore.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	ctx := context.Background()
	ws := os.Getenv("FOUNDRY_PERF_WORKSPACE")
	timed := func(name string, fn func() error) {
		t.Helper()
		start := time.Now()
		if err := fn(); err != nil {
			t.Fatal(err)
		}
		t.Logf("%s: %s", name, time.Since(start))
	}
	timed("workspaces", func() error { _, e := db.ListWorkspaces(ctx); return e })
	timed("session summaries", func() error { _, e := db.ListAgentSessionSummaries(ctx, ws); return e })
	timed("chat summaries", func() error { _, e := db.ListChats(ctx, ws); return e })
	timed("issues", func() error { _, e := db.ListIssues(ctx, ws); return e })
	timed("runs", func() error { _, e := db.ListRuns(ctx, ws); return e })
	s := NewServer(db)
	defer s.Shutdown(ctx)
	for i := 0; i < 3; i++ {
		timed("full projection", func() error { _, e := s.foundryData(ctx, ws, visibility{scope: accessScope{all: true}}); return e })
	}
}
