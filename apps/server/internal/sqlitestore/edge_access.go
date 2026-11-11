package sqlitestore

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func (s *Store) setupEdgeAccess(ctx context.Context) error {
	for _, statement := range []string{
		`CREATE TABLE IF NOT EXISTS edge_access (
			id TEXT PRIMARY KEY,
			owner_user_id TEXT NOT NULL,
			label TEXT NOT NULL,
			provider TEXT NOT NULL,
			host TEXT NOT NULL,
			path_prefix TEXT NOT NULL DEFAULT '',
			team TEXT NOT NULL DEFAULT '',
			audience TEXT NOT NULL DEFAULT '',
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			last_used_at TEXT NOT NULL DEFAULT ''
		)`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_edge_access_address
			ON edge_access(owner_user_id, host, path_prefix)`,
	} {
		if _, err := s.conn().ExecContext(ctx, statement); err != nil {
			return fmt.Errorf("setup edge access: %w", err)
		}
	}
	return nil
}

const edgeAccessColumns = `id, label, provider, host, path_prefix, team, audience, created_at, updated_at, last_used_at`

func (s *Store) ListEdgeAccess(ctx context.Context, ownerUserID string) ([]store.EdgeAccess, error) {
	rows, err := s.reader().QueryContext(ctx, `SELECT `+edgeAccessColumns+`
		FROM edge_access WHERE owner_user_id = ? ORDER BY host, path_prefix, id`, ownerUserID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var items []store.EdgeAccess
	for rows.Next() {
		item, err := scanEdgeAccess(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (s *Store) GetEdgeAccess(ctx context.Context, ownerUserID, id string) (store.EdgeAccess, error) {
	item, err := scanEdgeAccess(s.reader().QueryRowContext(ctx, `SELECT `+edgeAccessColumns+`
		FROM edge_access WHERE owner_user_id = ? AND id = ?`, ownerUserID, id))
	if errors.Is(err, sql.ErrNoRows) {
		return store.EdgeAccess{}, store.ErrNotFound
	}
	return item, err
}

func (s *Store) SaveEdgeAccess(ctx context.Context, ownerUserID string, item store.EdgeAccess) error {
	_, err := s.conn().ExecContext(ctx, `
		INSERT INTO edge_access (id, owner_user_id, label, provider, host, path_prefix, team, audience, created_at, updated_at, last_used_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
			label = excluded.label, provider = excluded.provider, host = excluded.host,
			path_prefix = excluded.path_prefix, team = excluded.team, audience = excluded.audience,
			updated_at = excluded.updated_at
		WHERE edge_access.owner_user_id = excluded.owner_user_id`,
		item.ID, ownerUserID, item.Label, string(item.Provider), item.Match.Host, item.Match.PathPrefix,
		item.Team, item.Audience, item.CreatedAt, item.UpdatedAt, item.LastUsedAt)
	if err != nil && strings.Contains(err.Error(), "UNIQUE constraint failed") {
		return store.ErrEdgeAccessConflict
	}
	return err
}

func (s *Store) DeleteEdgeAccess(ctx context.Context, ownerUserID, id string) error {
	result, err := s.conn().ExecContext(ctx, `DELETE FROM edge_access WHERE owner_user_id = ? AND id = ?`, ownerUserID, id)
	if err != nil {
		return err
	}
	if changed, _ := result.RowsAffected(); changed == 0 {
		return store.ErrNotFound
	}
	return nil
}

func (s *Store) TouchEdgeAccess(ctx context.Context, ownerUserID, id, usedAt string) error {
	_, err := s.conn().ExecContext(ctx, `UPDATE edge_access SET last_used_at = ? WHERE owner_user_id = ? AND id = ?`, usedAt, ownerUserID, id)
	return err
}

func scanEdgeAccess(row rowScanner) (store.EdgeAccess, error) {
	var item store.EdgeAccess
	var provider string
	err := row.Scan(&item.ID, &item.Label, &provider, &item.Match.Host, &item.Match.PathPrefix,
		&item.Team, &item.Audience, &item.CreatedAt, &item.UpdatedAt, &item.LastUsedAt)
	item.Provider = store.EdgeAccessProvider(provider)
	return item, err
}
