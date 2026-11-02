package sqlitestore

import (
	"context"
	"log"
	"time"
)

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
