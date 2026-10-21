package sqlitestore

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func (s *Store) setupPersonalAgentContextPatch(ctx context.Context) error {
	_, err := s.conn().ExecContext(ctx, `CREATE TABLE IF NOT EXISTS pa_context_patches(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,workspace_id TEXT NOT NULL,status TEXT NOT NULL,revision INTEGER NOT NULL,payload_json TEXT NOT NULL)`)
	if err != nil {
		return err
	}
	_, err = s.conn().ExecContext(ctx, `CREATE UNIQUE INDEX IF NOT EXISTS idx_pa_context_patch_fence ON pa_context_patches(workspace_id) WHERE status='applying'`)
	return err
}
func scanPAContextPatch(row interface{ Scan(...any) error }) (store.PersonalAgentContextPatch, error) {
	var v store.PersonalAgentContextPatch
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

// Called inside the same transaction accepting every new/resumed Foundry input.
// The fence has no timeout: a missing remote receipt cannot prove no write ran.
func (s *Store) checkPAContextPatchFence(ctx context.Context, workspace string) error {
	var busy bool
	err := s.reader().QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM pa_context_patches WHERE workspace_id=? AND status='applying')`, workspace).Scan(&busy)
	if err != nil {
		return err
	}
	if busy {
		return fmt.Errorf("workspace_context_update_pending: waiting for the approved file patch receipt")
	}
	return nil
}
func (s *Store) BeginPersonalAgentContextPatch(ctx context.Context, v store.PersonalAgentContextPatch, jobRevision int64) (store.PersonalAgentContextPatch, error) {
	var out store.PersonalAgentContextPatch
	err := s.withTx(ctx, func(tx *Store) error {
		old, err := scanPAContextPatch(tx.reader().QueryRowContext(ctx, `SELECT user_id,payload_json FROM pa_context_patches WHERE user_id=? AND id=?`, v.UserID, v.ID))
		if err == nil {
			out = old
			return nil
		}
		if !errors.Is(err, store.ErrNotFound) {
			return err
		}
		job, err := tx.GetPersonalAgentMaintenance(ctx, v.UserID, v.JobID)
		if err != nil {
			return err
		}
		if job.Revision != jobRevision || job.Status != "review" || job.Result == nil || job.Role != "governance" || v.Index < 0 || v.Index >= len(job.Result.Patches) {
			return store.ErrPersonalAgentRevision
		}
		patch := job.Result.Patches[v.Index]
		if patch.Path != v.Path || patch.BaseHash != v.BaseHash || job.WorkspaceID != v.WorkspaceID {
			return store.ErrIdempotencyConflict
		}
		if err = tx.checkPAContextPatchFence(ctx, v.WorkspaceID); err != nil {
			return err
		}
		var active bool
		err = tx.reader().QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM agent_sessions WHERE workspace_id=? AND status IN ('queued','running','blocked')) OR EXISTS(SELECT 1 FROM pa_run_controls c JOIN agent_sessions a ON a.id=c.session_id WHERE a.workspace_id=? AND c.state IN ('monitoring','stop_requested') AND json_extract(c.payload_json,'$.dispatchAttempted')=1)`, v.WorkspaceID, v.WorkspaceID).Scan(&active)
		if err != nil {
			return err
		}
		if active {
			return fmt.Errorf("workspace_active: wait for its sessions before changing their context")
		}
		workspace, err := tx.GetWorkspace(ctx, v.WorkspaceID)
		if err != nil {
			return err
		}
		if workspace.DeviceID != v.DeviceID || workspace.ArchivedAt != "" || workspace.UnavailableOnDevice != nil {
			return store.ErrPersonalAgentRevision
		}
		roles, err := tx.WorkspaceRolesForUser(ctx, v.UserID)
		if err != nil {
			return err
		}
		if roles[v.WorkspaceID] != store.WorkspaceRoleOwner {
			return store.ErrNotFound
		}
		v.Status = "applying"
		v.Revision = 1
		v.CreatedAt = paNow()
		v.UpdatedAt = v.CreatedAt
		raw, err := json.Marshal(v)
		if err != nil {
			return err
		}
		_, err = tx.conn().ExecContext(ctx, `INSERT INTO pa_context_patches VALUES(?,?,?,?,?,?)`, v.ID, v.UserID, v.WorkspaceID, v.Status, v.Revision, string(raw))
		out = v
		return err
	})
	return out, err
}
func (s *Store) listPAContextPatches(ctx context.Context, q string, args ...any) ([]store.PersonalAgentContextPatch, error) {
	rows, err := s.reader().QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []store.PersonalAgentContextPatch{}
	for rows.Next() {
		v, e := scanPAContextPatch(rows)
		if e != nil {
			return nil, e
		}
		out = append(out, v)
	}
	return out, rows.Err()
}
func (s *Store) ListPersonalAgentContextPatches(ctx context.Context, user string) ([]store.PersonalAgentContextPatch, error) {
	return s.listPAContextPatches(ctx, `SELECT user_id,payload_json FROM pa_context_patches WHERE user_id=? ORDER BY rowid DESC LIMIT 200`, user)
}
func (s *Store) PendingPersonalAgentContextPatches(ctx context.Context) ([]store.PersonalAgentContextPatch, error) {
	return s.listPAContextPatches(ctx, `SELECT user_id,payload_json FROM pa_context_patches WHERE status='applying' ORDER BY rowid LIMIT 20`)
}
func (s *Store) SavePersonalAgentContextPatch(ctx context.Context, v store.PersonalAgentContextPatch) (store.PersonalAgentContextPatch, error) {
	old := v.Revision
	v.Revision++
	v.UpdatedAt = paNow()
	raw, err := json.Marshal(v)
	if err != nil {
		return v, err
	}
	res, err := s.conn().ExecContext(ctx, `UPDATE pa_context_patches SET status=?,revision=?,payload_json=? WHERE user_id=? AND id=? AND revision=? AND status='applying'`, v.Status, v.Revision, string(raw), v.UserID, v.ID, old)
	if err != nil {
		return v, err
	}
	n, _ := res.RowsAffected()
	if n != 1 {
		return v, store.ErrPersonalAgentRevision
	}
	return v, nil
}
