package sqlitestore

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func (s *Store) setupExecutionDefaults(ctx context.Context) error {
	if _, err := s.conn().ExecContext(ctx, `CREATE TABLE IF NOT EXISTS execution_defaults (
		owner_user_id TEXT NOT NULL,
		workspace_id TEXT NOT NULL DEFAULT '',
		provider_id TEXT NOT NULL,
		runtime TEXT NOT NULL,
		model TEXT NOT NULL,
		effort TEXT NOT NULL DEFAULT '',
		updated_by TEXT NOT NULL DEFAULT '',
		updated_at TEXT NOT NULL,
		PRIMARY KEY (owner_user_id, workspace_id)
	)`); err != nil {
		return fmt.Errorf("migrate sqlite execution defaults: %w", err)
	}
	return nil
}

func (s *Store) GetExecutionDefault(ctx context.Context, ownerUserID, workspaceID string) (store.StoredExecutionModelDefault, error) {
	var value store.StoredExecutionModelDefault
	err := s.reader().QueryRowContext(ctx, `SELECT owner_user_id, workspace_id, provider_id, runtime, model, effort, updated_by, updated_at
		FROM execution_defaults WHERE owner_user_id = ? AND workspace_id = ?`,
		strings.TrimSpace(ownerUserID), strings.TrimSpace(workspaceID)).
		Scan(&value.OwnerUserID, &value.WorkspaceID, &value.ProviderID, &value.Runtime, &value.Model,
			&value.Effort, &value.UpdatedBy, &value.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return store.StoredExecutionModelDefault{}, store.ErrExecutionDefaultNotFound
	}
	if err != nil {
		return store.StoredExecutionModelDefault{}, fmt.Errorf("get execution default: %w", err)
	}
	value.Scope = "global"
	if value.WorkspaceID != "" {
		value.Scope = "workspace"
	}
	return value, nil
}

func (s *Store) SetExecutionDefault(ctx context.Context, value store.StoredExecutionModelDefault) error {
	value.OwnerUserID = strings.TrimSpace(value.OwnerUserID)
	value.WorkspaceID = strings.TrimSpace(value.WorkspaceID)
	value.ProviderID = strings.TrimSpace(value.ProviderID)
	value.Runtime = strings.TrimSpace(value.Runtime)
	value.Model = strings.TrimSpace(value.Model)
	value.Effort = strings.TrimSpace(value.Effort)
	value.UpdatedBy = strings.TrimSpace(value.UpdatedBy)
	if value.OwnerUserID == "" {
		return errors.New("execution default owner is required")
	}
	if value.ProviderID == "" && value.Runtime == "" && value.Model == "" && value.Effort == "" {
		_, err := s.conn().ExecContext(ctx, `DELETE FROM execution_defaults WHERE owner_user_id = ? AND workspace_id = ?`,
			value.OwnerUserID, value.WorkspaceID)
		return err
	}
	if value.ProviderID == "" || (value.Runtime != "claude" && value.Runtime != "codex") || value.Model == "" {
		return errors.New("execution default needs a provider, runtime and model")
	}
	_, err := s.conn().ExecContext(ctx, `INSERT INTO execution_defaults
		(owner_user_id, workspace_id, provider_id, runtime, model, effort, updated_by, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(owner_user_id, workspace_id) DO UPDATE SET
			provider_id = excluded.provider_id, runtime = excluded.runtime, model = excluded.model,
			effort = excluded.effort, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
		value.OwnerUserID, value.WorkspaceID, value.ProviderID, value.Runtime, value.Model, value.Effort,
		value.UpdatedBy, formatTime(time.Now()))
	if err != nil {
		return fmt.Errorf("save execution default: %w", err)
	}
	return nil
}
