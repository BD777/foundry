package sqlitestore

import (
	"context"
	"fmt"
	"log"
	"time"
)

// PrepareSessionEventCompaction makes sure the compaction's bookkeeping
// exists, for an operator command (OpenAdmin runs no migrations).
func (s *Store) PrepareSessionEventCompaction(ctx context.Context) error {
	return s.setupSessionEventCompaction(ctx)
}

// FileStats is the database file's pages: how many, how big, and how many
// of them hold nothing (what VACUUM gives back).
type FileStats struct {
	PageSize  int64
	Pages     int64
	FreePages int64
}

func (s *Store) FileStats(ctx context.Context) (FileStats, error) {
	var stats FileStats
	for _, pragma := range []struct {
		name  string
		value *int64
	}{{"page_size", &stats.PageSize}, {"page_count", &stats.Pages}, {"freelist_count", &stats.FreePages}} {
		if err := s.db.QueryRowContext(ctx, `PRAGMA `+pragma.name).Scan(pragma.value); err != nil {
			return stats, fmt.Errorf("read %s: %w", pragma.name, err)
		}
	}
	return stats, nil
}

// Vacuum rebuilds the database file without its free pages. It holds the
// database for as long as that takes (about 20 s per GB) and needs free
// disk of about twice the rebuilt size meanwhile (a temporary copy, then
// the write-ahead log), so it runs only from an operator command while no
// server serves the database.
func (s *Store) Vacuum(ctx context.Context) error {
	for _, statement := range []string{`PRAGMA wal_checkpoint(TRUNCATE)`, `VACUUM`, `PRAGMA wal_checkpoint(TRUNCATE)`} {
		if _, err := s.db.ExecContext(ctx, statement); err != nil {
			return fmt.Errorf("%s: %w", statement, err)
		}
	}
	return nil
}

// RunMaintenance runs the recurring cleanup each start does once the server
// answers: removed devices that still own rows are purged, then orphaned
// rows are pruned. Each step writes in short statements or transactions, so
// requests keep being served meanwhile; on a large database
// the steps take seconds that would otherwise delay every start (DEV-062).
func (s *Store) RunMaintenance(ctx context.Context) error {
	steps := []struct {
		name string
		run  func(context.Context) error
	}{
		{"purge removed devices", s.PurgeRemovedDevices},
		{"prune orphaned rows", s.pruneOrphanedRows},
		{"rekey session states", s.rekeySessionStates},
	}
	for _, step := range steps {
		started := time.Now()
		if err := step.run(ctx); err != nil {
			return err
		}
		if elapsed := time.Since(started); elapsed >= slowMigrationThreshold {
			log.Printf("startup maintenance: %s took %s", step.name, elapsed.Round(time.Millisecond))
		}
	}
	return nil
}
