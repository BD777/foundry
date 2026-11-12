package sqlitestore

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// memory_sorts is the log of memory upkeep's sorting between layers
// (store.MemorySort): metadata, the entry's title and the reviewer's
// reason, never an entry body.
func (s *Store) setupMemorySorts(ctx context.Context) error {
	for _, q := range []string{
		`CREATE TABLE IF NOT EXISTS memory_sorts(user_id TEXT NOT NULL,id TEXT NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL,payload_json TEXT NOT NULL,PRIMARY KEY(user_id,id))`,
		`CREATE INDEX IF NOT EXISTS idx_memory_sorts_recent ON memory_sorts(user_id,created_at)`,
		`CREATE INDEX IF NOT EXISTS idx_memory_sorts_status ON memory_sorts(status,created_at)`,
	} {
		if _, err := s.conn().ExecContext(ctx, q); err != nil {
			return fmt.Errorf("setup memory_sorts: %w", err)
		}
	}
	return nil
}

func scanMemorySort(row interface{ Scan(...any) error }) (store.MemorySort, error) {
	var v store.MemorySort
	var raw string
	err := row.Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return v, store.ErrNotFound
	}
	if err != nil {
		return v, err
	}
	err = json.Unmarshal([]byte(raw), &v)
	return v, err
}

func (s *Store) RecordMemorySort(ctx context.Context, v store.MemorySort) (store.MemorySort, bool, error) {
	if v.ID == "" || v.UserID == "" || v.AssistantID == "" || v.Status == "" || (v.Kind != store.MemorySortMove && v.Kind != store.MemorySortSuggestion) {
		return store.MemorySort{}, false, fmt.Errorf("invalid memory sort")
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	v.CreatedAt, v.UpdatedAt = now, now
	if v.Mentions == nil {
		v.Mentions = []string{}
	}
	raw, err := json.Marshal(v)
	if err != nil {
		return store.MemorySort{}, false, err
	}
	result, err := s.conn().ExecContext(ctx, `INSERT OR IGNORE INTO memory_sorts(user_id,id,status,created_at,payload_json) VALUES(?,?,?,?,?)`, v.UserID, v.ID, v.Status, v.CreatedAt, string(raw))
	if err != nil {
		return store.MemorySort{}, false, err
	}
	inserted, err := result.RowsAffected()
	if err != nil {
		return store.MemorySort{}, false, err
	}
	stored, err := s.GetMemorySort(ctx, v.UserID, v.ID)
	return stored, inserted == 1, err
}

func (s *Store) GetMemorySort(ctx context.Context, user, id string) (store.MemorySort, error) {
	v, err := scanMemorySort(s.reader().QueryRowContext(ctx, `SELECT payload_json FROM memory_sorts WHERE user_id=? AND id=?`, user, id))
	v.UserID = user
	return v, err
}

func (s *Store) UpdateMemorySort(ctx context.Context, v store.MemorySort, fromStatus string) (store.MemorySort, error) {
	if v.Mentions == nil {
		v.Mentions = []string{}
	}
	v.UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
	raw, err := json.Marshal(v)
	if err != nil {
		return store.MemorySort{}, err
	}
	result, err := s.conn().ExecContext(ctx, `UPDATE memory_sorts SET status=?,payload_json=? WHERE user_id=? AND id=? AND status=?`, v.Status, string(raw), v.UserID, v.ID, fromStatus)
	if err != nil {
		return store.MemorySort{}, err
	}
	if n, err := result.RowsAffected(); err != nil {
		return store.MemorySort{}, err
	} else if n != 1 {
		return store.MemorySort{}, store.ErrPersonalAgentRevision
	}
	return v, nil
}

func (s *Store) ListMemorySorts(ctx context.Context, user string, limit int) ([]store.MemorySort, error) {
	rows, err := s.reader().QueryContext(ctx, `SELECT payload_json FROM memory_sorts WHERE user_id=? ORDER BY created_at DESC, id LIMIT ?`, user, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []store.MemorySort{}
	for rows.Next() {
		v, err := scanMemorySort(rows)
		if err != nil {
			return nil, err
		}
		v.UserID = user
		out = append(out, v)
	}
	return out, rows.Err()
}

func (s *Store) MovingMemorySorts(ctx context.Context, limit int) ([]store.MemorySort, error) {
	rows, err := s.reader().QueryContext(ctx, `SELECT user_id,payload_json FROM memory_sorts WHERE status=? ORDER BY created_at LIMIT ?`, store.MemorySortMoving, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []store.MemorySort{}
	for rows.Next() {
		var user, raw string
		if err := rows.Scan(&user, &raw); err != nil {
			return nil, err
		}
		var v store.MemorySort
		if err := json.Unmarshal([]byte(raw), &v); err != nil {
			return nil, err
		}
		v.UserID = user
		out = append(out, v)
	}
	return out, rows.Err()
}
