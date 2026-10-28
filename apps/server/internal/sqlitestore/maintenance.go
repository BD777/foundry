package sqlitestore

import (
	"context"
	"log"
	"time"
)

// RunMaintenance runs the recurring cleanup each start does once the server
// answers: orphaned rows are pruned and digests kept before redaction are
// redacted. Each step reads on the read pool and writes in short
// statements, so requests keep being served meanwhile; on a large database
// the steps take seconds that would otherwise delay every start (DEV-062).
func (s *Store) RunMaintenance(ctx context.Context) error {
	steps := []struct {
		name string
		run  func(context.Context) error
	}{
		{"prune orphaned rows", s.pruneOrphanedRows},
		{"redact workspace digests", s.redactWorkspaceDigests},
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
