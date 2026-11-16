package sqlitestore

import (
	"context"
	"errors"
	"testing"
)

func TestRunDataMigrationAppliesEachVersionOnce(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	runs := 0
	apply := func(*Store) error {
		runs++
		return nil
	}
	for _, version := range []int{1, 1, 2, 2} {
		if err := s.runDataMigration(ctx, "example", version, apply); err != nil {
			t.Fatalf("version %d: %v", version, err)
		}
	}
	if runs != 2 {
		t.Fatalf("apply ran %d times, want once per version (2)", runs)
	}
}

func TestRunDataMigrationRecordsNothingWhenApplyFails(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	if err := s.runDataMigration(ctx, "failing", 1, func(*Store) error { return errors.New("boom") }); err == nil {
		t.Fatal("failing apply: want an error")
	}
	var recorded int
	if err := s.conn().QueryRowContext(ctx, `SELECT count(*) FROM data_migrations WHERE name = 'failing'`).Scan(&recorded); err != nil {
		t.Fatalf("count records: %v", err)
	}
	if recorded != 0 {
		t.Fatalf("failed run left %d records, want none", recorded)
	}
	runs := 0
	if err := s.runDataMigration(ctx, "failing", 1, func(*Store) error {
		runs++
		return nil
	}); err != nil {
		t.Fatalf("retry: %v", err)
	}
	if runs != 1 {
		t.Fatalf("retry ran %d times, want 1", runs)
	}
}
