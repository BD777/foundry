package sqlitestore

import (
	"context"
	"database/sql"
	"fmt"
	"strings"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

var _ store.WorkspaceTermStore = (*Store)(nil)

// setupWorkspaceTerms creates the workspace terms (docs/personal-agent.md
// §3): per workspace, each counted source and the names it mentions. Both
// tables belong to their workspace (workspaceOwnedRows).
func (s *Store) setupWorkspaceTerms(ctx context.Context) error {
	statements := []string{
		`CREATE TABLE IF NOT EXISTS workspace_term_sources (
			workspace_id TEXT NOT NULL,
			source_id TEXT NOT NULL,
			kind TEXT NOT NULL,
			rev TEXT NOT NULL,
			title TEXT NOT NULL DEFAULT '',
			at TEXT NOT NULL DEFAULT '',
			PRIMARY KEY (workspace_id, source_id)
		)`,
		`CREATE TABLE IF NOT EXISTS workspace_terms (
			workspace_id TEXT NOT NULL,
			source_id TEXT NOT NULL,
			term TEXT NOT NULL,
			count INTEGER NOT NULL,
			PRIMARY KEY (workspace_id, source_id, term)
		)`,
		`CREATE INDEX IF NOT EXISTS idx_workspace_terms_term ON workspace_terms (term, workspace_id)`,
	}
	for _, statement := range statements {
		if _, err := s.conn().ExecContext(ctx, statement); err != nil {
			return fmt.Errorf("migrate sqlite workspace terms: %w", err)
		}
	}
	return nil
}

func (s *Store) WorkspaceTermSources(ctx context.Context, workspaceID string) ([]store.WorkspaceTermSource, error) {
	sources := []store.WorkspaceTermSource{}
	err := scanRows(ctx, s.reader(), `SELECT workspace_id, source_id, kind, rev, title, at FROM workspace_term_sources
		WHERE workspace_id = ? ORDER BY source_id`, func(rows *sql.Rows) error {
		var source store.WorkspaceTermSource
		if err := rows.Scan(&source.WorkspaceID, &source.SourceID, &source.Kind, &source.Rev, &source.Title, &source.At); err != nil {
			return err
		}
		sources = append(sources, source)
		return nil
	}, workspaceID)
	if err != nil {
		return nil, fmt.Errorf("list workspace term sources: %w", err)
	}
	return sources, nil
}

func (s *Store) SaveWorkspaceTermSource(ctx context.Context, source store.WorkspaceTermSource, terms map[string]int) error {
	if source.WorkspaceID == "" || source.SourceID == "" {
		return fmt.Errorf("save workspace term source: workspace and source are required")
	}
	return s.withTx(ctx, func(tx *Store) error {
		if _, err := tx.conn().ExecContext(ctx, `DELETE FROM workspace_terms WHERE workspace_id = ? AND source_id = ?`,
			source.WorkspaceID, source.SourceID); err != nil {
			return fmt.Errorf("replace workspace terms: %w", err)
		}
		if _, err := tx.conn().ExecContext(ctx, `INSERT INTO workspace_term_sources (workspace_id, source_id, kind, rev, title, at)
			VALUES (?, ?, ?, ?, ?, ?)
			ON CONFLICT (workspace_id, source_id) DO UPDATE SET kind = excluded.kind, rev = excluded.rev, title = excluded.title, at = excluded.at`,
			source.WorkspaceID, source.SourceID, source.Kind, source.Rev, source.Title, source.At); err != nil {
			return fmt.Errorf("save workspace term source: %w", err)
		}
		for term, count := range terms {
			if _, err := tx.conn().ExecContext(ctx, `INSERT INTO workspace_terms (workspace_id, source_id, term, count) VALUES (?, ?, ?, ?)`,
				source.WorkspaceID, source.SourceID, term, count); err != nil {
				return fmt.Errorf("save workspace term: %w", err)
			}
		}
		return nil
	})
}

func (s *Store) DeleteWorkspaceTermSources(ctx context.Context, workspaceID string, keep []string) error {
	kept := map[string]bool{}
	for _, id := range keep {
		kept[id] = true
	}
	sources, err := s.WorkspaceTermSources(ctx, workspaceID)
	if err != nil {
		return err
	}
	gone := []any{workspaceID}
	for _, source := range sources {
		if !kept[source.SourceID] {
			gone = append(gone, source.SourceID)
		}
	}
	if len(gone) == 1 {
		return nil
	}
	in := sqlPlaceholders(len(gone) - 1)
	return s.withTx(ctx, func(tx *Store) error {
		for _, table := range []string{"workspace_terms", "workspace_term_sources"} {
			if _, err := tx.conn().ExecContext(ctx, `DELETE FROM `+table+` WHERE workspace_id = ? AND source_id IN (`+in+`)`, gone...); err != nil {
				return fmt.Errorf("delete workspace term sources: %w", err)
			}
		}
		return nil
	})
}

func (s *Store) WorkspaceTermTotals(ctx context.Context, workspaceIDs []string, minCount int) ([]store.WorkspaceTermTotal, error) {
	totals := []store.WorkspaceTermTotal{}
	if len(workspaceIDs) == 0 {
		return totals, nil
	}
	args := make([]any, 0, len(workspaceIDs)+1)
	for _, id := range workspaceIDs {
		args = append(args, id)
	}
	args = append(args, minCount)
	err := scanRows(ctx, s.reader(), `SELECT workspace_id, term, SUM(count), COUNT(*) FROM workspace_terms
		WHERE workspace_id IN (`+sqlPlaceholders(len(workspaceIDs))+`)
		GROUP BY workspace_id, term HAVING SUM(count) >= ?`, func(rows *sql.Rows) error {
		var total store.WorkspaceTermTotal
		if err := rows.Scan(&total.WorkspaceID, &total.Term, &total.Count, &total.Sources); err != nil {
			return err
		}
		totals = append(totals, total)
		return nil
	}, args...)
	if err != nil {
		return nil, fmt.Errorf("total workspace terms: %w", err)
	}
	return totals, nil
}

func (s *Store) FindWorkspaceTerms(ctx context.Context, workspaceIDs []string, prefix string, limit int) ([]store.WorkspaceTermHit, error) {
	hits := []store.WorkspaceTermHit{}
	if len(workspaceIDs) == 0 || prefix == "" {
		return hits, nil
	}
	// Terms are stored lower-case UTF-8; no UTF-8 text has byte 0xff, so
	// [prefix, prefix+"\xff") is every term starting with prefix.
	args := []any{prefix, prefix + "\xff"}
	for _, id := range workspaceIDs {
		args = append(args, id)
	}
	args = append(args, limit)
	err := scanRows(ctx, s.reader(), `SELECT t.term, t.count, s.workspace_id, s.source_id, s.kind, s.rev, s.title, s.at
		FROM workspace_terms t JOIN workspace_term_sources s ON s.workspace_id = t.workspace_id AND s.source_id = t.source_id
		WHERE t.term >= ? AND t.term < ? AND t.workspace_id IN (`+sqlPlaceholders(len(workspaceIDs))+`)
		ORDER BY t.count DESC, s.at DESC LIMIT ?`, func(rows *sql.Rows) error {
		var hit store.WorkspaceTermHit
		if err := rows.Scan(&hit.Term, &hit.Count, &hit.Source.WorkspaceID, &hit.Source.SourceID, &hit.Source.Kind,
			&hit.Source.Rev, &hit.Source.Title, &hit.Source.At); err != nil {
			return err
		}
		hits = append(hits, hit)
		return nil
	}, args...)
	if err != nil {
		return nil, fmt.Errorf("find workspace terms: %w", err)
	}
	return hits, nil
}

// termMessageKinds are the messages terms are counted from: what the
// person and the agent wrote, not tool calls, their output or reasoning.
const termMessageKinds = `('user', 'assistant', 'commentary')`

func (s *Store) ChatTermTexts(ctx context.Context, chatID, sessionID string) ([]string, error) {
	texts := []string{}
	collect := func(rows *sql.Rows) error {
		var text sql.NullString
		if err := rows.Scan(&text); err != nil {
			return err
		}
		if strings.TrimSpace(text.String) != "" {
			texts = append(texts, text.String)
		}
		return nil
	}
	var err error
	switch {
	case sessionID != "":
		err = scanRows(ctx, s.reader(), `SELECT json_extract(payload_json, '$.message.text') FROM agent_session_events
			WHERE session_id = ? AND json_extract(payload_json, '$.message.kind') IN `+termMessageKinds+`
			ORDER BY created_at, id`, collect, sessionID)
	case chatID != "":
		err = scanRows(ctx, s.reader(), `SELECT text FROM (
			SELECT 0 AS part, 0 AS position, json_extract(payload_json, '$.title') AS text FROM chats WHERE id = ?1
			UNION ALL SELECT 2, 0, json_extract(payload_json, '$.handoffContext') FROM chats WHERE id = ?1
			UNION ALL SELECT 3, CAST(m.key AS INTEGER), json_extract(m.value, '$.text') FROM chats, json_each(chats.payload_json, '$.transcript') m
				WHERE chats.id = ?1 AND json_extract(m.value, '$.kind') IN `+termMessageKinds+`
		) ORDER BY part, position`, collect, chatID)
	}
	if err != nil {
		return nil, fmt.Errorf("read chat texts: %w", err)
	}
	return texts, nil
}
