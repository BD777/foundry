package sqlitestore

import (
	"context"
	"database/sql"
	"fmt"
)

// dbExecutor is the shared subset of *sql.DB and *sql.Tx used by Store
// helpers, so one helper can run standalone or inside a scoped transaction.
type dbExecutor interface {
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
}

// conn returns the executor for the current scope: the scoped transaction when
// the Store is a transaction clone, otherwise the pooled database handle.
func (s *Store) conn() dbExecutor {
	if s.exec != nil {
		return s.exec
	}
	return s.db
}

// withTx runs fn against a Store clone bound to a single transaction. Every
// helper reached through that clone uses the transaction, which matters because
// the pool is limited to one connection: a stray s.db call inside fn would
// block on the connection the transaction already holds.
func (s *Store) withTx(ctx context.Context, fn func(tx *Store) error) error {
	if s.exec != nil {
		return fn(s)
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin transaction: %w", err)
	}
	defer tx.Rollback()

	if err := fn(&Store{db: s.db, exec: tx, kek: s.kek}); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit transaction: %w", err)
	}
	return nil
}
