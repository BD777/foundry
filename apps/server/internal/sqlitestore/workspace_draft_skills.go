package sqlitestore

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func (s *Store) setupWorkspaceDraftSkills(ctx context.Context) error {
	for _, q := range []string{
		`CREATE TABLE IF NOT EXISTS workspace_draft_revisions (workspace_id TEXT NOT NULL, execution_root_id TEXT NOT NULL, id TEXT NOT NULL, digest TEXT NOT NULL, payload_json TEXT NOT NULL, PRIMARY KEY(workspace_id,execution_root_id,id,digest))`,
		`CREATE TABLE IF NOT EXISTS workspace_draft_settings (workspace_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL)`,
		`CREATE TABLE IF NOT EXISTS workspace_draft_skills (workspace_id TEXT NOT NULL, execution_root_id TEXT NOT NULL, payload_json TEXT NOT NULL, PRIMARY KEY(workspace_id,execution_root_id))`,
	} {
		if _, err := s.conn().ExecContext(ctx, q); err != nil {
			return err
		}
	}
	return nil
}
func (s *Store) WorkspaceDrafts(ctx context.Context, workspaceID, rootID string) (store.WorkspaceDraftSkills, error) {
	result := store.WorkspaceDraftSkills{Enabled: true, Skills: []store.WorkspaceDraftSkill{}}
	var raw string
	err := s.conn().QueryRowContext(ctx, `SELECT payload_json FROM workspace_draft_skills WHERE workspace_id=? AND execution_root_id=?`, workspaceID, rootID).Scan(&raw)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return result, err
	}
	if err == nil {
		if err = json.Unmarshal([]byte(raw), &result); err != nil {
			return result, err
		}
	}
	enabled := true
	err = s.conn().QueryRowContext(ctx, `SELECT enabled FROM workspace_draft_settings WHERE workspace_id=?`, workspaceID).Scan(&enabled)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return result, err
	}
	result.Enabled = enabled
	if result.Skills == nil {
		result.Skills = []store.WorkspaceDraftSkill{}
	}
	return result, nil
}
func (s *Store) SetWorkspaceDraftsEnabled(ctx context.Context, id string, enabled bool) error {
	if _, err := s.GetWorkspace(ctx, id); err != nil {
		return err
	}
	_, err := s.conn().ExecContext(ctx, `INSERT INTO workspace_draft_settings(workspace_id,enabled) VALUES(?,?) ON CONFLICT(workspace_id) DO UPDATE SET enabled=excluded.enabled`, id, enabled)
	return err
}
func (s *Store) SaveWorkspaceDrafts(ctx context.Context, id, root string, value store.WorkspaceDraftSkills) error {
	for _, draft := range value.Skills {
		if draft.Status != "ready" {
			continue
		}
		raw, err := json.Marshal(draft)
		if err != nil {
			return err
		}
		if _, err = s.conn().ExecContext(ctx, `INSERT INTO workspace_draft_revisions(workspace_id,execution_root_id,id,digest,payload_json) VALUES(?,?,?,?,?) ON CONFLICT(workspace_id,execution_root_id,id,digest) DO UPDATE SET payload_json=excluded.payload_json`, id, root, draft.ID, draft.Digest, string(raw)); err != nil {
			return err
		}
	}
	raw, err := json.Marshal(value)
	if err != nil {
		return err
	}
	_, err = s.conn().ExecContext(ctx, `INSERT INTO workspace_draft_skills(workspace_id,execution_root_id,payload_json) VALUES(?,?,?) ON CONFLICT(workspace_id,execution_root_id) DO UPDATE SET payload_json=excluded.payload_json`, id, root, string(raw))
	return err
}

func (s *Store) WorkspaceDraftRevision(ctx context.Context, workspace, root, id, digest string) (store.WorkspaceDraftSkill, error) {
	var raw string
	var result store.WorkspaceDraftSkill
	err := s.conn().QueryRowContext(ctx, `SELECT payload_json FROM workspace_draft_revisions WHERE workspace_id=? AND execution_root_id=? AND id=? AND digest=?`, workspace, root, id, digest).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return result, store.ErrNotFound
	}
	if err != nil {
		return result, err
	}
	err = json.Unmarshal([]byte(raw), &result)
	return result, err
}
