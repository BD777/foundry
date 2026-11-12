package sqlitestore

import (
	"context"
	"database/sql"
	"encoding/json"
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
		provider_kind TEXT NOT NULL DEFAULT '',
		provider_id TEXT NOT NULL,
		runtime TEXT NOT NULL,
		model TEXT NOT NULL,
		worker_group_id TEXT NOT NULL DEFAULT '',
		effort TEXT NOT NULL DEFAULT '',
		alternatives TEXT NOT NULL DEFAULT '[]',
		updated_by TEXT NOT NULL DEFAULT '',
		updated_at TEXT NOT NULL,
		PRIMARY KEY (owner_user_id, workspace_id)
	)`); err != nil {
		return fmt.Errorf("migrate sqlite execution defaults: %w", err)
	}
	columns := map[string]bool{}
	rows, err := s.conn().QueryContext(ctx, `SELECT name FROM pragma_table_info('execution_defaults')`)
	if err != nil {
		return fmt.Errorf("migrate sqlite execution defaults: %w", err)
	}
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			rows.Close()
			return err
		}
		columns[name] = true
	}
	if err := rows.Close(); err != nil {
		return err
	}
	var statements []string
	if !columns["provider_kind"] {
		statements = append(statements, `ALTER TABLE execution_defaults ADD COLUMN provider_kind TEXT NOT NULL DEFAULT ''`)
	}
	if !columns["alternatives"] {
		statements = append(statements, `ALTER TABLE execution_defaults ADD COLUMN alternatives TEXT NOT NULL DEFAULT '[]'`)
	}
	switch {
	case columns["model_pool_id"] && !columns["worker_group_id"]:
		statements = append(statements, `ALTER TABLE execution_defaults RENAME COLUMN model_pool_id TO worker_group_id`)
	case !columns["worker_group_id"]:
		statements = append(statements, `ALTER TABLE execution_defaults ADD COLUMN worker_group_id TEXT NOT NULL DEFAULT ''`)
	}
	for _, statement := range statements {
		if _, err := s.conn().ExecContext(ctx, statement); err != nil {
			return fmt.Errorf("migrate sqlite execution defaults: %w", err)
		}
	}
	return nil
}

func (s *Store) GetExecutionDefault(ctx context.Context, ownerUserID, workspaceID string) (store.StoredExecutionModelDefault, error) {
	var value store.StoredExecutionModelDefault
	var alternatives string
	err := s.reader().QueryRowContext(ctx, `SELECT owner_user_id, workspace_id, provider_kind, provider_id, runtime, model, worker_group_id, effort, alternatives, updated_by, updated_at
		FROM execution_defaults WHERE owner_user_id = ? AND workspace_id = ?`,
		strings.TrimSpace(ownerUserID), strings.TrimSpace(workspaceID)).
		Scan(&value.OwnerUserID, &value.WorkspaceID, &value.ProviderKind, &value.ProviderID,
			&value.Runtime, &value.Model, &value.WorkerGroupID, &value.Effort, &alternatives,
			&value.UpdatedBy, &value.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return store.StoredExecutionModelDefault{}, store.ErrExecutionDefaultNotFound
	}
	if err != nil {
		return store.StoredExecutionModelDefault{}, fmt.Errorf("get execution default: %w", err)
	}
	if strings.TrimSpace(alternatives) == "" {
		value.Alternatives = []store.ExecutionModelChoice{}
	} else if err := json.Unmarshal([]byte(alternatives), &value.Alternatives); err != nil {
		return store.StoredExecutionModelDefault{}, fmt.Errorf("get execution default alternatives: %w", err)
	} else if value.Alternatives == nil {
		value.Alternatives = []store.ExecutionModelChoice{}
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
	value.ProviderKind = strings.TrimSpace(value.ProviderKind)
	value.ProviderID = strings.TrimSpace(value.ProviderID)
	value.Runtime = strings.TrimSpace(value.Runtime)
	value.Model = strings.TrimSpace(value.Model)
	value.WorkerGroupID = strings.TrimSpace(value.WorkerGroupID)
	value.Effort = strings.TrimSpace(value.Effort)
	value.UpdatedBy = strings.TrimSpace(value.UpdatedBy)
	alternatives := make([]store.ExecutionModelChoice, len(value.Alternatives))
	for index, alternative := range value.Alternatives {
		alternative.ProviderKind = store.ExecutionModelChoiceProviderKind(strings.TrimSpace(string(alternative.ProviderKind)))
		alternative.ProviderID = strings.TrimSpace(alternative.ProviderID)
		alternative.Runtime = store.NativeRuntimeID(strings.TrimSpace(string(alternative.Runtime)))
		alternative.Model = strings.TrimSpace(alternative.Model)
		alternative.WorkerGroupID = strings.TrimSpace(alternative.WorkerGroupID)
		alternative.Effort = strings.TrimSpace(alternative.Effort)
		alternative.Group = nil
		if alternative.WorkerGroupID != "" {
			if alternative.ProviderID != "" || alternative.Runtime != "" || alternative.Model != "" || alternative.Effort != "" || alternative.ProviderKind != "" {
				return errors.New("execution alternative is one model or one worker group, not both")
			}
		} else if alternative.ProviderID == "" || (alternative.Runtime != "claude" && alternative.Runtime != "codex") || alternative.Model == "" {
			return errors.New("execution alternative needs a provider, runtime and model, or a worker group")
		}
		alternatives[index] = alternative
	}
	value.Alternatives = alternatives
	if value.OwnerUserID == "" {
		return errors.New("execution default owner is required")
	}
	if value.ProviderID == "" && value.Runtime == "" && value.Model == "" && value.WorkerGroupID == "" && value.Effort == "" && len(value.Alternatives) == 0 {
		_, err := s.conn().ExecContext(ctx, `DELETE FROM execution_defaults WHERE owner_user_id = ? AND workspace_id = ?`,
			value.OwnerUserID, value.WorkspaceID)
		return err
	}
	if value.ProviderID != "" || value.Runtime != "" || value.Model != "" || value.WorkerGroupID != "" || value.Effort != "" {
		if value.WorkerGroupID != "" {
			if value.Model != "" || value.ProviderID != "" {
				return errors.New("execution default is one model or one worker group, not both")
			}
		} else if value.ProviderID == "" || (value.Runtime != "claude" && value.Runtime != "codex") || value.Model == "" {
			return errors.New("execution default needs a provider, runtime and model, or a worker group")
		}
	}
	encodedAlternatives, err := json.Marshal(value.Alternatives)
	if err != nil {
		return fmt.Errorf("encode execution default alternatives: %w", err)
	}
	_, err = s.conn().ExecContext(ctx, `INSERT INTO execution_defaults
		(owner_user_id, workspace_id, provider_kind, provider_id, runtime, model, worker_group_id, effort, alternatives, updated_by, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(owner_user_id, workspace_id) DO UPDATE SET
			provider_kind = excluded.provider_kind, provider_id = excluded.provider_id,
			runtime = excluded.runtime, model = excluded.model, worker_group_id = excluded.worker_group_id,
			effort = excluded.effort, alternatives = excluded.alternatives,
			updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
		value.OwnerUserID, value.WorkspaceID, value.ProviderKind, value.ProviderID, value.Runtime,
		value.Model, value.WorkerGroupID, value.Effort, string(encodedAlternatives), value.UpdatedBy, formatTime(time.Now()))
	if err != nil {
		return fmt.Errorf("save execution default: %w", err)
	}
	return nil
}
