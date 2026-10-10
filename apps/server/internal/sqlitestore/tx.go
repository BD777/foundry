package sqlitestore

import (
	"context"
	"database/sql"
	"fmt"
	"log"
	"runtime"
	"time"
)

// slowTransactionThreshold is when a transaction is worth a log line: the
// writer has one connection, so every other write waits for it meanwhile.
const slowTransactionThreshold = time.Second

func logSlowTransaction(started time.Time) {
	elapsed := time.Since(started)
	if elapsed < slowTransactionThreshold {
		return
	}
	caller := "unknown"
	if pc, _, _, ok := runtime.Caller(2); ok {
		if fn := runtime.FuncForPC(pc); fn != nil {
			caller = fn.Name()
		}
	}
	log.Printf("slow database transaction: %s held the connection for %s", caller, elapsed.Round(time.Millisecond))
}

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

// reader returns the executor for a read that takes no write decision of
// its own: inside a transaction the transaction (it must see its own
// writes), otherwise the read-only pool, so the read neither waits for nor
// delays the writer. A read in WAL mode sees every committed write; one
// that ran while a transaction was open sees the state before it, as it
// would have had it run a moment earlier. Reads whose result decides a
// write outside a transaction stay on conn.
func (s *Store) reader() dbExecutor {
	if s.exec != nil {
		return s.exec
	}
	if s.read != nil {
		return s.read
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
	defer logSlowTransaction(time.Now())
	defer tx.Rollback()

	if err := fn(&Store{db: s.db, read: s.read, exec: tx, kek: s.kek}); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit transaction: %w", err)
	}
	return nil
}
