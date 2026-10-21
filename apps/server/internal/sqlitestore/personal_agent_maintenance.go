package sqlitestore

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"time"
)

func (s *Store) setupPersonalAgentMaintenance(ctx context.Context) error {
	for _, q := range []string{
		`CREATE TABLE IF NOT EXISTS pa_maintenance(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,role TEXT NOT NULL,workspace_id TEXT NOT NULL,event_key TEXT NOT NULL,status TEXT NOT NULL,revision INTEGER NOT NULL,due_at TEXT NOT NULL,payload_json TEXT NOT NULL,UNIQUE(user_id,role,workspace_id,event_key))`,
		`CREATE INDEX IF NOT EXISTS idx_pa_maintenance_due ON pa_maintenance(status,due_at)`,
	} {
		if _, err := s.conn().ExecContext(ctx, q); err != nil {
			return err
		}
	}
	return nil
}
func scanPAMaintenance(row interface{ Scan(...any) error }) (store.PersonalAgentMaintenance, error) {
	var v store.PersonalAgentMaintenance
	var raw string
	err := row.Scan(&v.UserID, &raw)
	if errors.Is(err, sql.ErrNoRows) {
		return v, store.ErrNotFound
	}
	if err != nil {
		return v, err
	}
	err = json.Unmarshal([]byte(raw), &v)
	return v, err
}
func (s *Store) GetPersonalAgentMaintenance(ctx context.Context, user, id string) (store.PersonalAgentMaintenance, error) {
	return scanPAMaintenance(s.reader().QueryRowContext(ctx, `SELECT user_id,payload_json FROM pa_maintenance WHERE user_id=? AND id=?`, user, id))
}
func (s *Store) EnqueuePersonalAgentMaintenance(ctx context.Context, v store.PersonalAgentMaintenance) (store.PersonalAgentMaintenance, error) {
	if v.ID == "" || v.EventKey == "" || v.WorkspaceID == "" || (v.Role != "memory" && v.Role != "governance") {
		return v, fmt.Errorf("invalid maintenance event")
	}
	var out store.PersonalAgentMaintenance
	err := s.withTx(ctx, func(tx *Store) error {
		old, err := scanPAMaintenance(tx.reader().QueryRowContext(ctx, `SELECT user_id,payload_json FROM pa_maintenance WHERE user_id=? AND role=? AND workspace_id=? AND event_key=?`, v.UserID, v.Role, v.WorkspaceID, v.EventKey))
		if err == nil {
			out = old
			return nil
		}
		if !errors.Is(err, store.ErrNotFound) {
			return err
		}
		// Only not-yet-accepted work is coalesced. A native receipt must be recovered
		// before a newer event can replace a claimed run.
		_, err = tx.conn().ExecContext(ctx, `UPDATE pa_maintenance SET status='superseded',revision=revision+1,payload_json=json_set(payload_json,'$.status','superseded','$.revision',revision+1) WHERE user_id=? AND role=? AND workspace_id=? AND status IN ('pending','waiting') AND json_extract(payload_json,'$.inputId') IS NULL AND COALESCE(json_extract(payload_json,'$.vaultId'),'')=?`, v.UserID, v.Role, v.WorkspaceID, v.VaultID)
		if err != nil {
			return err
		}
		if v.Role == "memory" {
			// A changed authority invalidates old derived recommendations, including
			// facts forgotten since the previous review. Native transcripts remain
			// explicit historical records; they are not recalled as current knowledge.
			_, err = tx.conn().ExecContext(ctx, `UPDATE pa_maintenance SET status='superseded',revision=revision+1,payload_json=json_set(payload_json,'$.status','superseded','$.revision',revision+1,'$.result',NULL) WHERE user_id=? AND role='memory' AND workspace_id=? AND status IN ('review','complete','failed','dismissed')`, v.UserID, v.WorkspaceID)
			if err != nil {
				return err
			}
		}
		v.Status = "pending"
		v.Revision = 1
		v.CreatedAt = paNow()
		v.UpdatedAt = v.CreatedAt
		if v.DueAt == "" {
			v.DueAt = v.CreatedAt
		}
		raw, err := json.Marshal(v)
		if err != nil {
			return err
		}
		_, err = tx.conn().ExecContext(ctx, `INSERT INTO pa_maintenance VALUES(?,?,?,?,?,?,?,?,?)`, v.ID, v.UserID, v.Role, v.WorkspaceID, v.EventKey, v.Status, v.Revision, v.DueAt, string(raw))
		out = v
		return err
	})
	return out, err
}
func (s *Store) listPAMaintenance(ctx context.Context, q string, args ...any) ([]store.PersonalAgentMaintenance, error) {
	rows, err := s.reader().QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []store.PersonalAgentMaintenance{}
	for rows.Next() {
		v, err := scanPAMaintenance(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}
func (s *Store) ListPersonalAgentMaintenance(ctx context.Context, user string) ([]store.PersonalAgentMaintenance, error) {
	return s.listPAMaintenance(ctx, `SELECT user_id,payload_json FROM pa_maintenance WHERE user_id=? ORDER BY rowid DESC LIMIT 200`, user)
}
func (s *Store) DuePersonalAgentMaintenance(ctx context.Context, now string) ([]store.PersonalAgentMaintenance, error) {
	return s.listPAMaintenance(ctx, `SELECT user_id,payload_json FROM pa_maintenance WHERE status IN ('pending','waiting','starting','running') AND due_at<=? ORDER BY due_at LIMIT 20`, now)
}
func (s *Store) SavePersonalAgentMaintenance(ctx context.Context, v store.PersonalAgentMaintenance) (store.PersonalAgentMaintenance, error) {
	err := s.withTx(ctx, func(tx *Store) error {
		old, err := tx.GetPersonalAgentMaintenance(ctx, v.UserID, v.ID)
		if err != nil {
			return err
		}
		if old.Revision != v.Revision {
			return store.ErrPersonalAgentRevision
		}
		if old.EventKey != v.EventKey || old.Role != v.Role || old.WorkspaceID != v.WorkspaceID || old.VaultID != v.VaultID {
			return store.ErrIdempotencyConflict
		}

		if v.Attempt != old.Attempt {
			if (old.Status != "failed" && old.Status != "waiting") || old.Attempt >= 2 || v.Attempt != old.Attempt+1 || v.Status != "pending" || v.InputID != "" || v.SessionID != "" || v.SnapshotID != "" {
				return fmt.Errorf("invalid maintenance retry")
			}
			if old.InputID != "" {
				accepted, e := tx.personalAgentInputAccepted(ctx, old.UserID, old.InputID)
				if e != nil {
					return e
				}
				control, e := scanPARunControl(tx.reader().QueryRowContext(ctx, `SELECT user_id,payload_json FROM pa_run_controls WHERE user_id=? AND input_id=?`, old.UserID, old.InputID))
				if e != nil && !errors.Is(e, store.ErrNotFound) {
					return e
				}
				if (e != nil && accepted) || (e == nil && control.DispatchAttempted && control.NativeEndedAt == "") {
					return store.ErrPersonalAgentInputUnconfirmed
				}
			}
		}
		if v.Status == "starting" && old.Status != "starting" && old.Status != "running" {
			var busy bool
			err = tx.conn().QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM pa_maintenance WHERE user_id=? AND id<>? AND status IN ('starting','running'))`, v.UserID, v.ID).Scan(&busy)
			if err != nil {
				return err
			}
			if busy {
				return fmt.Errorf("maintenance_busy")
			}
			var count int
			err = tx.reader().QueryRowContext(ctx, `SELECT COUNT(*) FROM pa_run_snapshots WHERE user_id=? AND session_id<>'' AND created_at>? AND json_extract(payload_json,'$.role') IN ('memory','governance')`, v.UserID, time.Now().Add(-24*time.Hour).UTC().Format(time.RFC3339Nano)).Scan(&count)
			if err != nil {
				return err
			}
			if count >= 4 {
				return fmt.Errorf("daily_maintenance_limit")
			}

		}
		v.Revision++
		v.UpdatedAt = paNow()
		raw, err := json.Marshal(v)
		if err != nil {
			return err
		}
		res, err := tx.conn().ExecContext(ctx, `UPDATE pa_maintenance SET status=?,revision=?,due_at=?,payload_json=? WHERE user_id=? AND id=? AND revision=?`, v.Status, v.Revision, v.DueAt, string(raw), v.UserID, v.ID, old.Revision)
		if err != nil {
			return err
		}
		n, _ := res.RowsAffected()
		if n != 1 {
			return store.ErrPersonalAgentRevision
		}
		return nil
	})
	return v, err
}

func (s *Store) PersonalAgentMaintenanceInputs(ctx context.Context, workspace string) (map[string]bool, error) {
	rows, err := s.reader().QueryContext(ctx, `SELECT json_extract(payload_json,'$.inputId') FROM pa_run_snapshots WHERE json_extract(payload_json,'$.workspaceId')=? AND json_extract(payload_json,'$.role') IN ('memory','governance')`, workspace)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]bool{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out[id] = true
	}
	return out, rows.Err()
}
