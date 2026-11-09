package sqlitestore

import (
	"context"
	"testing"
)

// Reading answers with a model (DEV-125 P2) is gone: reopening a database
// that has its settings and items drops both, and a second start is a no-op.
func TestPendingTriageStorageIsDropped(t *testing.T) {
	ctx := context.Background()
	path := t.TempDir() + "/foundry.db"
	db, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	for _, statement := range []string{
		`CREATE TABLE IF NOT EXISTS pending_triage_settings (user_id TEXT PRIMARY KEY, payload_json TEXT NOT NULL, updated_at TEXT NOT NULL)`,
		`INSERT INTO pending_triage_settings VALUES ('u', '{}', 'now')`,
		`INSERT INTO pending_items (id, user_id, workspace_id, source, item_key, state, payload_json, created_at, updated_at) VALUES ('p', 'u', 'w', 'answer', 'k', 'open', '{}', 'now', 'now')`,
	} {
		if _, err := db.conn().ExecContext(ctx, statement); err != nil {
			t.Fatal(err)
		}
	}
	_ = db.Close()
	for range 2 {
		db, err = Open(path)
		if err != nil {
			t.Fatal(err)
		}
		var tables, answers int
		_ = db.conn().QueryRowContext(ctx, `SELECT COUNT(*) FROM sqlite_master WHERE name = 'pending_triage_settings'`).Scan(&tables)
		_ = db.conn().QueryRowContext(ctx, `SELECT COUNT(*) FROM pending_items WHERE source = 'answer'`).Scan(&answers)
		if tables != 0 || answers != 0 {
			t.Fatalf("triage storage kept: %d tables, %d answer items", tables, answers)
		}
		_ = db.Close()
	}
}
