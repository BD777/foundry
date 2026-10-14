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

// setupWorkspaceLifecycle adds what the server decides about a workspace
// (docs/personal-agent.md §2, §4): its kind, when it was archived, and its
// purpose. They are columns the device's registration (saveWorkspace) never
// writes; reads lay them over the device's payload (workspaceProjectionSQL).
func (s *Store) setupWorkspaceLifecycle(ctx context.Context) error {
	columns := []struct{ name, statement string }{
		{"kind", `ALTER TABLE workspaces ADD COLUMN kind TEXT NOT NULL DEFAULT 'project'`},
		{"archived_at", `ALTER TABLE workspaces ADD COLUMN archived_at TEXT NOT NULL DEFAULT ''`},
		{"purpose", `ALTER TABLE workspaces ADD COLUMN purpose TEXT NOT NULL DEFAULT ''`},
	}
	for _, column := range columns {
		if err := s.ensureColumn(ctx, "workspaces", column.name, column.statement); err != nil {
			return err
		}
	}
	return nil
}

// workspaceProjectionSQL is a workspace's projection, for a query over
// workspaces w LEFT JOIN workspace_display_names d: the device's payload
// with the server's display name, kind (absent for a project) and archive
// time (absent unless archived).
const workspaceProjectionSQL = `json_set(
	json_remove(
		CASE WHEN d.name IS NULL THEN w.payload_json ELSE json_set(w.payload_json, '$.name', d.name) END,
		'$.kind', '$.archivedAt'),
	'$.kind', CASE WHEN w.kind = 'project' THEN NULL ELSE w.kind END,
	'$.archivedAt', NULLIF(w.archived_at, ''))`

func (s *Store) SetWorkspaceKind(ctx context.Context, workspaceID string, kind string) error {
	if kind != store.WorkspaceKindProject && kind != store.WorkspaceKindPersonalAgent {
		return fmt.Errorf("unknown workspace kind %q", kind)
	}
	return s.updateWorkspaceColumn(ctx, `UPDATE workspaces SET kind = ? WHERE id = ?`, kind, workspaceID)
}

func (s *Store) SetWorkspaceArchived(ctx context.Context, workspaceID string, at time.Time) (store.WorkspaceProjection, error) {
	var err error
	if at.IsZero() {
		err = s.updateWorkspaceColumn(ctx, `UPDATE workspaces SET archived_at = '' WHERE id = ?`, workspaceID)
	} else {
		err = s.updateWorkspaceColumn(ctx, `UPDATE workspaces
			SET archived_at = CASE WHEN archived_at = '' THEN ? ELSE archived_at END WHERE id = ?`, formatTime(at), workspaceID)
	}
	if err != nil {
		return store.WorkspaceProjection{}, err
	}
	return s.GetWorkspace(ctx, workspaceID)
}

func (s *Store) SetWorkspacePurpose(ctx context.Context, workspaceID string, purpose string) error {
	return s.updateWorkspaceColumn(ctx, `UPDATE workspaces SET purpose = ? WHERE id = ?`, strings.TrimSpace(purpose), workspaceID)
}

func (s *Store) WorkspacePurpose(ctx context.Context, workspaceID string) (string, error) {
	var purpose string
	if err := s.reader().QueryRowContext(ctx, `SELECT purpose FROM workspaces WHERE id = ?`, workspaceID).Scan(&purpose); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return "", store.ErrNotFound
		}
		return "", err
	}
	return purpose, nil
}

// updateWorkspaceColumn runs an UPDATE of one workspace, the last argument
// its id; no such workspace is store.ErrNotFound.
func (s *Store) updateWorkspaceColumn(ctx context.Context, statement string, args ...any) error {
	result, err := s.conn().ExecContext(ctx, statement, args...)
	if err != nil {
		return fmt.Errorf("update workspace: %w", err)
	}
	if changed, _ := result.RowsAffected(); changed == 0 {
		return store.ErrNotFound
	}
	return nil
}
