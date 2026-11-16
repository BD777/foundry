package sqlitestore

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"
)

// setupDataMigrations creates the record of one-time data migrations: the
// name of each one that ran and the version it ran at.
func (s *Store) setupDataMigrations(ctx context.Context) error {
	if _, err := s.conn().ExecContext(ctx, `CREATE TABLE IF NOT EXISTS data_migrations (
		name TEXT PRIMARY KEY,
		version INTEGER NOT NULL,
		applied_at TEXT NOT NULL
	)`); err != nil {
		return fmt.Errorf("setup data migrations: %w", err)
	}
	return nil
}

// runDataMigration applies the one-time data migration name at version,
// unless the database already records that version or a later one. The record
// is written in the same transaction as the changes, so a run that fails
// records nothing and runs again at the next start.
func (s *Store) runDataMigration(ctx context.Context, name string, version int, apply func(tx *Store) error) error {
	var recorded int
	err := s.conn().QueryRowContext(ctx, `SELECT version FROM data_migrations WHERE name = ?`, name).Scan(&recorded)
	if err == nil && recorded >= version {
		return nil
	}
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return fmt.Errorf("read data migration %s: %w", name, err)
	}
	return s.withTx(ctx, func(tx *Store) error {
		if err := apply(tx); err != nil {
			return fmt.Errorf("data migration %s: %w", name, err)
		}
		if _, err := tx.conn().ExecContext(ctx, `INSERT INTO data_migrations (name, version, applied_at) VALUES (?, ?, ?)
			ON CONFLICT (name) DO UPDATE SET version = excluded.version, applied_at = excluded.applied_at`,
			name, version, formatTime(time.Now())); err != nil {
			return fmt.Errorf("record data migration %s: %w", name, err)
		}
		return nil
	})
}
