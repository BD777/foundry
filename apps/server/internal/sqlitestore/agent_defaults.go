package sqlitestore

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// setupAgentDefaults creates the table of default agents (DEV-068): one
// row per workspace, its Feishu bot and each chat with an override.
func (s *Store) setupAgentDefaults(ctx context.Context) error {
	if _, err := s.conn().ExecContext(ctx, `CREATE TABLE IF NOT EXISTS agent_defaults (
		workspace_id TEXT NOT NULL,
		scope TEXT NOT NULL,
		route_id TEXT NOT NULL DEFAULT '',
		profile_id TEXT NOT NULL DEFAULT '',
		runtime TEXT NOT NULL DEFAULT '',
		model TEXT NOT NULL DEFAULT '',
		effort TEXT NOT NULL DEFAULT '',
		updated_by TEXT NOT NULL DEFAULT '',
		updated_at TEXT NOT NULL,
		PRIMARY KEY (workspace_id, scope, route_id)
	)`); err != nil {
		return fmt.Errorf("migrate sqlite agent defaults: %w", err)
	}
	return nil
}

// ListAgentDefaults lists the workspace's defaults. A chat's override is
// listed while the chat routes to the workspace: one unbound or paired
// elsewhere no longer applies here.
func (s *Store) ListAgentDefaults(ctx context.Context, workspaceID string) ([]store.AgentDefault, error) {
	rows, err := s.reader().QueryContext(ctx, `
		SELECT workspace_id, scope, route_id, profile_id, runtime, model, effort, updated_by, updated_at
		FROM agent_defaults
		WHERE workspace_id = ?1 AND (scope <> 'feishu_chat'
			OR route_id IN (SELECT id FROM feishu_bot_routes WHERE workspace_id = ?1 AND kind <> 'pairing'))
		ORDER BY scope, route_id`, workspaceID)
	if err != nil {
		return nil, fmt.Errorf("list agent defaults: %w", err)
	}
	defer rows.Close()
	defaults := []store.AgentDefault{}
	for rows.Next() {
		var value store.AgentDefault
		if err := rows.Scan(&value.WorkspaceID, &value.Scope, &value.RouteID, &value.ProfileID, &value.Runtime,
			&value.Model, &value.Effort, &value.UpdatedBy, &value.UpdatedAt); err != nil {
			return nil, err
		}
		defaults = append(defaults, value)
	}
	return defaults, rows.Err()
}

// SetAgentDefault replaces one level's default; one that sets nothing is
// removed.
func (s *Store) SetAgentDefault(ctx context.Context, value store.AgentDefault) error {
	value.WorkspaceID = strings.TrimSpace(value.WorkspaceID)
	if value.WorkspaceID == "" || !store.ValidAgentDefaultScope(value.Scope) {
		return fmt.Errorf("agent default needs a workspace and a scope")
	}
	if value.Scope != store.AgentDefaultFeishuChat {
		value.RouteID = ""
	} else if value.RouteID == "" {
		return fmt.Errorf("a chat's agent default needs its route")
	}
	if value.Empty() {
		_, err := s.conn().ExecContext(ctx, `DELETE FROM agent_defaults WHERE workspace_id = ? AND scope = ? AND route_id = ?`,
			value.WorkspaceID, value.Scope, value.RouteID)
		return err
	}
	_, err := s.conn().ExecContext(ctx, `
		INSERT INTO agent_defaults (workspace_id, scope, route_id, profile_id, runtime, model, effort, updated_by, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(workspace_id, scope, route_id) DO UPDATE SET
			profile_id = excluded.profile_id, runtime = excluded.runtime, model = excluded.model,
			effort = excluded.effort, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
		value.WorkspaceID, value.Scope, value.RouteID, value.ProfileID, value.Runtime, value.Model, value.Effort,
		value.UpdatedBy, formatTime(time.Now()))
	if err != nil {
		return fmt.Errorf("save agent default: %w", err)
	}
	return nil
}
