package sqlitestore

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// Saved versions of the files the person edits in an assistant's
// workspaces (DEV-223); a channel's AGENTS.md versions (DEV-203) moved here.

func (s *Store) setupWorkspaceFiles(ctx context.Context) error {
	for _, statement := range []string{
		`CREATE TABLE IF NOT EXISTS workspace_file_revisions (
			id TEXT PRIMARY KEY,
			workspace_id TEXT NOT NULL,
			path TEXT NOT NULL,
			sha256 TEXT NOT NULL,
			bytes INTEGER NOT NULL,
			content TEXT NOT NULL,
			source TEXT NOT NULL,
			created_at TEXT NOT NULL
		)`,
		`CREATE INDEX IF NOT EXISTS idx_workspace_file_revisions_file ON workspace_file_revisions(workspace_id, path, created_at)`,
		`CREATE TABLE IF NOT EXISTS assistant_instructions_defaults (
			assistant_id TEXT PRIMARY KEY,
			sha256 TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)`,
		// The channel AGENTS.md versions of DEV-203 phase 2, once.
		`INSERT OR IGNORE INTO workspace_file_revisions (id, workspace_id, path, sha256, bytes, content, source, created_at)
			SELECT i.id, json_extract(c.data_json, '$.workspaceId'), 'AGENTS.md', i.sha256, i.bytes, i.content, i.source, i.created_at
			FROM message_channel_instructions i JOIN message_channels c ON c.id = i.channel_id
			WHERE COALESCE(json_extract(c.data_json, '$.workspaceId'), '') <> ''`,
	} {
		if _, err := s.conn().ExecContext(ctx, statement); err != nil {
			return fmt.Errorf("setup workspace files: %w", err)
		}
	}
	return nil
}

func (s *Store) ListWorkspaceFileRevisions(ctx context.Context, workspaceID, path string, limit int) ([]store.WorkspaceFileRevision, error) {
	if limit <= 0 || limit > store.MaxWorkspaceFileRevisions {
		limit = store.MaxWorkspaceFileRevisions
	}
	rows, err := s.reader().QueryContext(ctx, `SELECT id, created_at, sha256, bytes, source FROM workspace_file_revisions
		WHERE workspace_id = ? AND path = ? ORDER BY created_at DESC, id DESC LIMIT ?`, workspaceID, path, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []store.WorkspaceFileRevision{}
	for rows.Next() {
		var revision store.WorkspaceFileRevision
		if err := rows.Scan(&revision.ID, &revision.At, &revision.Sha256, &revision.Bytes, &revision.Source); err != nil {
			return nil, err
		}
		out = append(out, revision)
	}
	return out, rows.Err()
}

func (s *Store) GetWorkspaceFileRevision(ctx context.Context, workspaceID, path, id string) (store.WorkspaceFileRevision, string, error) {
	var revision store.WorkspaceFileRevision
	var content string
	err := s.reader().QueryRowContext(ctx, `SELECT id, created_at, sha256, bytes, source, content FROM workspace_file_revisions
		WHERE workspace_id = ? AND path = ? AND id = ?`, workspaceID, path, id).
		Scan(&revision.ID, &revision.At, &revision.Sha256, &revision.Bytes, &revision.Source, &content)
	if errors.Is(err, sql.ErrNoRows) {
		return revision, "", store.ErrNotFound
	}
	return revision, content, err
}

func (s *Store) AddWorkspaceFileRevision(ctx context.Context, workspaceID, path string, revision store.WorkspaceFileRevision, content string) error {
	return s.withTx(ctx, func(tx *Store) error {
		return tx.insertWorkspaceFileRevision(ctx, workspaceID, path, revision, content, false)
	})
}

func (s *Store) AddWorkspaceFileRevisionUnlessLatest(ctx context.Context, workspaceID, path string, revision store.WorkspaceFileRevision, content string) error {
	return s.withTx(ctx, func(tx *Store) error {
		return tx.insertWorkspaceFileRevision(ctx, workspaceID, path, revision, content, true)
	})
}

// insertWorkspaceFileRevision adds the version and prunes the file's older
// ones. unlessLatest skips it in the same statement when the newest version
// already has this content, so a repeated read adds nothing even when two
// reads race.
func (s *Store) insertWorkspaceFileRevision(ctx context.Context, workspaceID, path string, revision store.WorkspaceFileRevision, content string, unlessLatest bool) error {
	if revision.At == "" {
		revision.At = paNow()
	}
	args := []any{revision.ID, workspaceID, path, revision.Sha256, revision.Bytes, content, revision.Source, revision.At}
	statement := `INSERT INTO workspace_file_revisions (id, workspace_id, path, sha256, bytes, content, source, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
	if unlessLatest {
		// Insert only when the newest version's sha256 is not this one
		// (also when the file has no version yet).
		statement = `INSERT INTO workspace_file_revisions (id, workspace_id, path, sha256, bytes, content, source, created_at)
			SELECT ?, ?, ?, ?, ?, ?, ?, ?
			WHERE (SELECT sha256 FROM workspace_file_revisions WHERE workspace_id = ? AND path = ?
				ORDER BY created_at DESC, id DESC LIMIT 1) IS NOT ?`
		args = append(args, workspaceID, path, revision.Sha256)
	}
	if _, err := s.conn().ExecContext(ctx, statement, args...); err != nil {
		return err
	}
	_, err := s.conn().ExecContext(ctx, `DELETE FROM workspace_file_revisions WHERE workspace_id = ? AND path = ? AND id NOT IN (
		SELECT id FROM workspace_file_revisions WHERE workspace_id = ? AND path = ? ORDER BY created_at DESC, id DESC LIMIT ?)`,
		workspaceID, path, workspaceID, path, store.MaxWorkspaceFileRevisions)
	return err
}

func (s *Store) MoveWorkspaceFileRevisions(ctx context.Context, workspaceID, from, to string) error {
	_, err := s.conn().ExecContext(ctx, `UPDATE workspace_file_revisions SET path = ? WHERE workspace_id = ? AND path = ?`, to, workspaceID, from)
	return err
}

func (s *Store) AssistantInstructionsDefault(ctx context.Context, assistantID string) (string, error) {
	var sha string
	err := s.reader().QueryRowContext(ctx, `SELECT sha256 FROM assistant_instructions_defaults WHERE assistant_id = ?`, assistantID).Scan(&sha)
	if errors.Is(err, sql.ErrNoRows) {
		return "", store.ErrNotFound
	}
	return sha, err
}

func (s *Store) SetAssistantInstructionsDefault(ctx context.Context, assistantID, sha256 string) error {
	_, err := s.conn().ExecContext(ctx, `INSERT INTO assistant_instructions_defaults (assistant_id, sha256, updated_at) VALUES (?, ?, ?)
		ON CONFLICT(assistant_id) DO UPDATE SET sha256 = excluded.sha256, updated_at = excluded.updated_at`, assistantID, sha256, paNow())
	return err
}

var _ store.WorkspaceFileStore = (*Store)(nil)
