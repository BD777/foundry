package main

import (
	"bytes"
	"context"
	"database/sql"
	"strings"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/sqlitestore"
)

// DEV-059: `users reset-password` beside a running server opened the store
// fully, migrating and pruning for seconds under the write lock, and the
// server's requests failed with "database is locked". Operator commands on
// an existing database now run no migrations or maintenance, and their
// short writes wait for the server's lock.
func TestUsersCommandBesideALiveServerRunsNoMaintenance(t *testing.T) {
	dbPath := t.TempDir() + "/foundry.db"
	getenv := func(key string) string {
		if key == "FOUNDRY_DB_PATH" {
			return dbPath
		}
		return ""
	}
	var out bytes.Buffer
	if err := runUsers([]string{"create", "--username", "admin", "--role", "admin"}, getenv, strings.NewReader(""), &out); err != nil {
		t.Fatal(err)
	}

	// The running server holds its own connection; a migration would
	// recreate this index.
	server, err := sqlitestore.Open(dbPath)
	if err != nil {
		t.Fatal(err)
	}
	defer server.Close()
	raw, err := sql.Open("sqlite", dbPath)
	if err != nil {
		t.Fatal(err)
	}
	defer raw.Close()
	ctx := context.Background()
	if _, err := raw.ExecContext(ctx, `DROP INDEX idx_user_sessions_user`); err != nil {
		t.Fatal(err)
	}

	// The server is mid-write when the operator runs the command.
	conn, err := raw.Conn(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := conn.ExecContext(ctx, "BEGIN IMMEDIATE"); err != nil {
		t.Fatal(err)
	}
	released := make(chan struct{})
	go func() {
		defer close(released)
		time.Sleep(500 * time.Millisecond)
		_, _ = conn.ExecContext(ctx, "COMMIT")
		_ = conn.Close()
	}()
	out.Reset()
	if err := runUsers([]string{"reset-password", "--username", "admin"}, getenv, strings.NewReader(""), &out); err != nil {
		t.Fatalf("reset-password while the server holds the write lock: %v", err)
	}
	<-released
	var indexes int
	if err := raw.QueryRowContext(ctx, `SELECT COUNT(*) FROM sqlite_master WHERE name = 'idx_user_sessions_user'`).Scan(&indexes); err != nil {
		t.Fatal(err)
	}
	if indexes != 0 {
		t.Fatal("the operator command ran the server's migrations")
	}
	if _, _, err := server.GetUserCredentials(ctx, "admin"); err != nil {
		t.Fatalf("the server reads the account after the reset: %v", err)
	}
}
