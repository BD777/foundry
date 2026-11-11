package sqlitestore

import (
	"context"
	"path/filepath"
	"strings"
	"testing"
)

func TestRetiredOpenLarkTableDropsOnlyWhenEmpty(t *testing.T) {
	ctx := context.Background()
	db, err := OpenWithOptions(filepath.Join(t.TempDir(), "db"), Options{SecretKeyPath: filepath.Join(t.TempDir(), "key")})
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	if _, err := db.conn().ExecContext(ctx, `CREATE TABLE openlark_instances (app_id TEXT PRIMARY KEY)`); err != nil {
		t.Fatal(err)
	}
	if err := db.dropRetiredOpenLarkInstances(ctx); err != nil {
		t.Fatal(err)
	}
	var present int
	if err := db.conn().QueryRowContext(ctx, `SELECT count(*) FROM sqlite_master WHERE type='table' AND name='openlark_instances'`).Scan(&present); err != nil {
		t.Fatal(err)
	}
	if present != 0 {
		t.Fatal("the empty retired table was not dropped")
	}

	if _, err := db.conn().ExecContext(ctx, `CREATE TABLE openlark_instances (app_id TEXT PRIMARY KEY)`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.conn().ExecContext(ctx, `INSERT INTO openlark_instances (app_id) VALUES ('one')`); err != nil {
		t.Fatal(err)
	}
	if err := db.dropRetiredOpenLarkInstances(ctx); err == nil || !strings.Contains(err.Error(), "still has 1 row") {
		t.Fatalf("non-empty migration = %v", err)
	}
}
