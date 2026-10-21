package sqlitestore

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func (s *Store) setupPersonalAgentRuntime(ctx context.Context) error {
	for _, q := range []string{
		`CREATE TABLE IF NOT EXISTS pa_run_snapshots(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,session_id TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL,payload_json TEXT NOT NULL)`,
		`CREATE INDEX IF NOT EXISTS idx_pa_run_snapshots_user ON pa_run_snapshots(user_id,created_at DESC)`,
	} {
		if _, err := s.conn().ExecContext(ctx, q); err != nil {
			return err
		}
	}
	return nil
}

func (s *Store) GetPersonalAgentRunSnapshot(ctx context.Context, userID, id string) (store.PersonalAgentRunSnapshot, error) {
	var result store.PersonalAgentRunSnapshot
	var raw, sessionID string
	err := s.reader().QueryRowContext(ctx, `SELECT payload_json,session_id FROM pa_run_snapshots WHERE user_id=? AND id=?`, userID, id).Scan(&raw, &sessionID)
	if errors.Is(err, sql.ErrNoRows) {
		return result, store.ErrNotFound
	}
	if err != nil {
		return result, err
	}
	err = json.Unmarshal([]byte(raw), &result)
	result.UserID, result.SessionID = userID, sessionID
	return result, err
}

func (s *Store) RecordPersonalAgentRunSnapshot(ctx context.Context, input store.PersonalAgentRunSnapshot) (store.PersonalAgentRunSnapshot, error) {
	if input.ID == "" || input.UserID == "" || input.ConfigHash == "" || input.WorkspaceID == "" {
		return input, fmt.Errorf("incomplete run snapshot")
	}
	var result store.PersonalAgentRunSnapshot
	err := s.withTx(ctx, func(tx *Store) error {
		if err := tx.assertDeviceNotRemoved(ctx, input.DeviceID); err != nil {
			return err
		}
		existing, err := tx.GetPersonalAgentRunSnapshot(ctx, input.UserID, input.ID)
		if err == nil {
			a, b := existing, input
			a.CreatedAt, b.CreatedAt = "", ""
			a.SessionID, b.SessionID = "", ""
			if !reflect.DeepEqual(a, b) {
				return store.ErrIdempotencyConflict
			}
			result = existing
			return nil
		}
		if !errors.Is(err, store.ErrNotFound) {
			return err
		}
		input.CreatedAt = paNow()
		input.SessionID = ""
		raw, err := json.Marshal(input)
		if err != nil {
			return err
		}
		_, err = tx.conn().ExecContext(ctx, `INSERT INTO pa_run_snapshots(id,user_id,created_at,payload_json) VALUES(?,?,?,?)`, input.ID, input.UserID, input.CreatedAt, string(raw))
		result = input
		return err
	})
	return result, err
}

func (s *Store) BindPersonalAgentRunSnapshot(ctx context.Context, userID, id, sessionID string) error {
	if sessionID == "" {
		return fmt.Errorf("session receipt required")
	}
	result, err := s.conn().ExecContext(ctx, `UPDATE pa_run_snapshots SET session_id=? WHERE user_id=? AND id=? AND (session_id='' OR session_id=?)`, sessionID, userID, id, sessionID)
	if err != nil {
		return err
	}
	n, _ := result.RowsAffected()
	if n == 0 {
		return store.ErrPersonalAgentRevision
	}
	return nil
}

func (s *Store) ListPersonalAgentRunSnapshots(ctx context.Context, userID string, limit int) ([]store.PersonalAgentRunSnapshot, error) {
	rows, err := s.reader().QueryContext(ctx, `SELECT payload_json,session_id FROM pa_run_snapshots WHERE user_id=? AND (id IN (SELECT id FROM pa_run_snapshots WHERE user_id=? ORDER BY created_at DESC,id LIMIT ?) OR id IN (SELECT json_extract(payload_json,'$.snapshotId') FROM pa_run_controls WHERE user_id=? AND state IN ('monitoring','stop_requested'))) ORDER BY created_at DESC,id`, userID, userID, min(max(limit, 1), 200), userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []store.PersonalAgentRunSnapshot{}
	for rows.Next() {
		var raw, sessionID string
		if err := rows.Scan(&raw, &sessionID); err != nil {
			return nil, err
		}
		var item store.PersonalAgentRunSnapshot
		if err := json.Unmarshal([]byte(raw), &item); err != nil {
			return nil, err
		}
		item.UserID, item.SessionID = userID, sessionID
		result = append(result, item)
	}
	return result, rows.Err()
}
