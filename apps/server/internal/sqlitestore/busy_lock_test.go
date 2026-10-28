package sqlitestore

import (
	"context"
	"database/sql"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// holdWriteLock plays a second process (an admin CLI, a backup) that takes
// the database's write lock and keeps it for hold before committing.
// It returns once the lock is held, and a channel that closes when it
// is released.
func holdWriteLock(t *testing.T, path string, hold time.Duration) <-chan struct{} {
	t.Helper()
	other, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = other.Close() })
	conn, err := other.Conn(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := conn.ExecContext(context.Background(), "BEGIN IMMEDIATE"); err != nil {
		t.Fatal(err)
	}
	if _, err := conn.ExecContext(context.Background(), `INSERT INTO session_work_coverage(device_id, payload_json) VALUES('dev_other_process', '{}')
		ON CONFLICT(device_id) DO UPDATE SET payload_json = excluded.payload_json`); err != nil {
		t.Fatal(err)
	}
	released := make(chan struct{})
	go func() {
		defer close(released)
		time.Sleep(hold)
		_, _ = conn.ExecContext(context.Background(), "COMMIT")
		_ = conn.Close()
	}()
	t.Cleanup(func() { <-released })
	return released
}

func busyTestWork(id string) store.SessionWork {
	return store.SessionWork{ID: id, ThreadID: "thread", SessionID: "session", DeviceID: "dev_busy", Source: "process", Kind: "process", Management: "observed", DesiredState: "enabled", Observation: store.WorkObservation{Status: "running", At: "2026-01-01T00:00:00Z"}}
}

// DEV-059: a write transaction used to begin deferred, read, and then
// upgrade to a write. SQLite does not run the busy handler for that
// upgrade, so another process holding the write lock failed the request at
// once with "database is locked (SQLITE_BUSY)" instead of waiting.
func TestWriteTransactionWaitsForAnotherProcessWriteLock(t *testing.T) {
	path := t.TempDir() + "/foundry.db"
	db := newTestStoreAtPath(t, path)
	ctx := context.Background()

	const hold = 700 * time.Millisecond
	released := holdWriteLock(t, path, hold)
	started := time.Now()
	saved, err := db.SaveSessionWork(ctx, busyTestWork("new_while_locked"))
	if err != nil {
		t.Fatalf("save while another process holds the write lock: %v (after %s)", err, time.Since(started))
	}
	select {
	case <-released:
	default:
		t.Fatalf("save returned after %s, before the other process released its lock", time.Since(started))
	}
	if saved.Revision != 1 {
		t.Fatalf("saved = %+v", saved)
	}
}

// A save that changes nothing (every GET of a session's work re-imports
// its timers and tasks) must not need the write lock at all.
func TestUnchangedWorkSaveDoesNotWaitForTheWriteLock(t *testing.T) {
	path := t.TempDir() + "/foundry.db"
	db := newTestStoreAtPath(t, path)
	ctx := context.Background()
	item, err := db.SaveSessionWork(ctx, busyTestWork("existing"))
	if err != nil {
		t.Fatal(err)
	}

	released := holdWriteLock(t, path, 2*time.Second)
	started := time.Now()
	again, err := db.SaveSessionWork(ctx, item)
	if err != nil {
		t.Fatalf("unchanged save while locked: %v", err)
	}
	select {
	case <-released:
		t.Fatalf("unchanged save waited %s for the other process's write lock", time.Since(started))
	default:
	}
	if again.Revision != item.Revision || again.UpdatedAt != item.UpdatedAt {
		t.Fatalf("unchanged save returned %+v, want %+v", again, item)
	}
	if err := db.ObserveSessionWork(ctx, item.ID, store.WorkObservation{Status: "running", At: "2000-01-01T00:00:00Z"}); err != nil {
		t.Fatalf("stale observation while locked: %v", err)
	}
	select {
	case <-released:
		t.Fatalf("stale observation waited %s for the other process's write lock", time.Since(started))
	default:
	}
}

// Every write transaction begins IMMEDIATE, so a deferred read can never
// turn into a write that fails without waiting, and the writer connection
// keeps its pragmas even when database/sql reopens it.
func TestWriterBeginsImmediateTransactions(t *testing.T) {
	path := t.TempDir() + "/foundry.db"
	db := newTestStoreAtPath(t, path)
	ctx := context.Background()
	other, err := sql.Open("sqlite", path+"?_pragma=busy_timeout(0)")
	if err != nil {
		t.Fatal(err)
	}
	defer other.Close()
	err = db.withTx(ctx, func(tx *Store) error {
		// The transaction has not written yet; it holds the write lock
		// only when it began IMMEDIATE.
		_, otherErr := other.ExecContext(ctx, `INSERT INTO session_work_coverage(device_id, payload_json) VALUES('dev_probe', '{}')`)
		if !store.IsBusy(otherErr) {
			t.Fatalf("another writer during a write transaction: %v, want busy", otherErr)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	db.db.SetConnMaxLifetime(time.Nanosecond) // force a fresh writer connection
	time.Sleep(time.Millisecond)
	var timeout, foreignKeys int
	if err := db.db.QueryRowContext(ctx, `PRAGMA busy_timeout`).Scan(&timeout); err != nil || timeout < 5000 {
		t.Fatalf("writer busy_timeout = %d, %v", timeout, err)
	}
	if err := db.db.QueryRowContext(ctx, `PRAGMA foreign_keys`).Scan(&foreignKeys); err != nil || foreignKeys != 1 {
		t.Fatalf("writer foreign_keys = %d, %v", foreignKeys, err)
	}
}
