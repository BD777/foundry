package sqlitestore

import (
	"context"
	"errors"
	"testing"
)

func TestOnceRunsAOneTimeMigrationUntilItCompletes(t *testing.T) {
	ctx := context.Background()
	path := t.TempDir() + "/foundry.db"
	db := openTestStore(t, path)
	defer db.Close()

	runs := 0
	failing := db.once("test/failing", func(context.Context) error { runs++; return errors.New("not yet") })
	if err := failing(ctx); err == nil || runs != 1 {
		t.Fatalf("failing step = %v after %d runs, want its error", err, runs)
	}
	if err := failing(ctx); err == nil || runs != 2 {
		t.Fatalf("a failed step was recorded: %d runs", runs)
	}

	runs = 0
	step := db.once("test/step", func(context.Context) error { runs++; return nil })
	for range 2 {
		if err := step(ctx); err != nil {
			t.Fatal(err)
		}
	}
	if runs != 1 {
		t.Fatalf("completed step ran %d times, want once", runs)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}

	// The record outlives the process: a later start skips the step.
	reopened := openTestStore(t, path)
	defer reopened.Close()
	if err := reopened.once("test/step", func(context.Context) error { runs++; return nil })(ctx); err != nil || runs != 1 {
		t.Fatalf("reopened store ran the completed step again (%d runs, %v)", runs, err)
	}
	if got := countRows(t, reopened, `SELECT count(*) FROM applied_migrations WHERE name IN ('backfillSessionSchedules', 'backfillAnswerRevisions', 'pruneAgentSessionInlineEvents')`); got != 3 {
		t.Fatalf("open recorded %d of the 3 one-time migrations", got)
	}
}
