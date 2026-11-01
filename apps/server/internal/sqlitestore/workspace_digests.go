package sqlitestore

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

var _ store.WorkspaceDigestStore = (*Store)(nil)

// setupWorkspaceDigests creates the Personal Agent's digests
// (docs/personal-agent.md §3): one row per person × workspace they read.
// A row goes with the membership it was read under, so losing access
// deletes it.
func (s *Store) setupWorkspaceDigests(ctx context.Context) error {
	statements := []string{
		`CREATE TABLE IF NOT EXISTS workspace_digests (
			user_id TEXT NOT NULL,
			workspace_id TEXT NOT NULL,
			digest_json TEXT NOT NULL,
			source_rev TEXT NOT NULL,
			content_rev TEXT NOT NULL,
			files_rev TEXT NOT NULL DEFAULT '',
			compiled_at TEXT NOT NULL,
			last_activity_at TEXT NOT NULL DEFAULT '',
			intro TEXT NOT NULL DEFAULT '',
			intro_rev TEXT NOT NULL DEFAULT '',
			l0 TEXT NOT NULL DEFAULT '',
			summary TEXT NOT NULL DEFAULT '',
			route_when TEXT NOT NULL DEFAULT '[]',
			not_when TEXT NOT NULL DEFAULT '[]',
			summary_rev TEXT NOT NULL DEFAULT '',
			summarized_at TEXT NOT NULL DEFAULT '',
			summary_due_at TEXT NOT NULL DEFAULT '',
			summary_session_id TEXT NOT NULL DEFAULT '',
			pending_rev TEXT NOT NULL DEFAULT '',
			evidence_json TEXT NOT NULL DEFAULT '{}',
			PRIMARY KEY (user_id, workspace_id),
			FOREIGN KEY (workspace_id, user_id) REFERENCES workspace_members (workspace_id, user_id) ON DELETE CASCADE
		)`,
		`CREATE INDEX IF NOT EXISTS idx_workspace_digests_workspace ON workspace_digests (workspace_id)`,
		`CREATE INDEX IF NOT EXISTS idx_workspace_digests_due ON workspace_digests (summary_due_at) WHERE summary_due_at <> ''`,
		`CREATE INDEX IF NOT EXISTS idx_workspace_digests_session ON workspace_digests (summary_session_id) WHERE summary_session_id <> ''`,
	}
	for _, statement := range statements {
		if _, err := s.conn().ExecContext(ctx, statement); err != nil {
			return fmt.Errorf("migrate sqlite workspace digests: %w", err)
		}
	}
	return nil
}

// digestEvidence is what a digest ranks by beyond its DTO.
type digestEvidence struct {
	History []string `json:"history"`
	Files   []string `json:"files"`
}

const workspaceDigestColumns = `user_id, workspace_id, digest_json, content_rev, files_rev, intro, intro_rev,
	l0, summary, route_when, not_when, summary_rev, summarized_at, summary_due_at, summary_session_id, pending_rev, evidence_json`

func (s *Store) ListWorkspaceDigests(ctx context.Context, userID string) ([]store.WorkspaceDigestRecord, error) {
	return s.queryWorkspaceDigests(ctx, `SELECT `+workspaceDigestColumns+` FROM workspace_digests WHERE user_id = ? ORDER BY workspace_id`, userID)
}

func (s *Store) ListWorkspaceDigestsOf(ctx context.Context, workspaceID string) ([]store.WorkspaceDigestRecord, error) {
	return s.queryWorkspaceDigests(ctx, `SELECT `+workspaceDigestColumns+` FROM workspace_digests WHERE workspace_id = ? ORDER BY user_id`, workspaceID)
}

func (s *Store) DueWorkspaceDigests(ctx context.Context, now string, limit int) ([]store.WorkspaceDigestRecord, error) {
	return s.queryWorkspaceDigests(ctx, `SELECT `+workspaceDigestColumns+` FROM workspace_digests
		WHERE summary_due_at <> '' AND summary_due_at <= ? AND summary_session_id = ''
		ORDER BY last_activity_at DESC, workspace_id LIMIT ?`, now, limit)
}

func (s *Store) WorkspaceDigestForSummarySession(ctx context.Context, sessionID string) (store.WorkspaceDigestRecord, error) {
	if strings.TrimSpace(sessionID) == "" {
		return store.WorkspaceDigestRecord{}, store.ErrNotFound
	}
	records, err := s.queryWorkspaceDigests(ctx, `SELECT `+workspaceDigestColumns+` FROM workspace_digests WHERE summary_session_id = ?`, sessionID)
	if err != nil {
		return store.WorkspaceDigestRecord{}, err
	}
	if len(records) == 0 {
		return store.WorkspaceDigestRecord{}, store.ErrNotFound
	}
	return records[0], nil
}

func (s *Store) SaveWorkspaceDigest(ctx context.Context, record store.WorkspaceDigestRecord) error {
	digest := record.Digest
	if digest.UserID == "" || digest.WorkspaceID == "" {
		return errors.New("a workspace digest needs a person and a workspace")
	}
	deterministic := digest
	deterministic.Intro, deterministic.L0, deterministic.Summary = "", "", ""
	deterministic.RouteWhen, deterministic.NotWhen, deterministic.SummarizedAt, deterministic.Dirty = nil, nil, "", false
	data, err := json.Marshal(deterministic)
	if err != nil {
		return err
	}
	evidence, err := json.Marshal(digestEvidence{History: nonNilStrings(record.History), Files: nonNilStrings(record.Files)})
	if err != nil {
		return err
	}
	_, err = s.conn().ExecContext(ctx, `INSERT INTO workspace_digests
		(user_id, workspace_id, digest_json, source_rev, content_rev, files_rev, compiled_at, last_activity_at, summary_due_at, evidence_json)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(user_id, workspace_id) DO UPDATE SET
			digest_json = excluded.digest_json, source_rev = excluded.source_rev, evidence_json = excluded.evidence_json,
			summary_due_at = CASE WHEN content_rev <> excluded.content_rev THEN excluded.summary_due_at ELSE summary_due_at END,
			content_rev = excluded.content_rev, files_rev = excluded.files_rev,
			compiled_at = excluded.compiled_at, last_activity_at = excluded.last_activity_at,
			intro = CASE WHEN excluded.files_rev = '' THEN '' ELSE intro END,
			intro_rev = CASE WHEN excluded.files_rev = '' THEN '' ELSE intro_rev END`,
		digest.UserID, digest.WorkspaceID, string(data), digest.SourceRev, record.ContentRev, record.FilesRev,
		digest.CompiledAt, digest.LastActivityAt, record.SummaryDueAt, string(evidence))
	if err != nil {
		return fmt.Errorf("save workspace digest: %w", err)
	}
	return nil
}

func (s *Store) DeleteWorkspaceDigests(ctx context.Context, userID string, keep []string) error {
	kept, err := json.Marshal(nonNilStrings(keep))
	if err != nil {
		return err
	}
	if _, err := s.conn().ExecContext(ctx, `DELETE FROM workspace_digests WHERE user_id = ?
		AND workspace_id NOT IN (SELECT value FROM json_each(?))`, userID, string(kept)); err != nil {
		return fmt.Errorf("delete workspace digests: %w", err)
	}
	return nil
}

func (s *Store) DeleteWorkspaceDigest(ctx context.Context, userID, workspaceID string) error {
	if _, err := s.conn().ExecContext(ctx, `DELETE FROM workspace_digests WHERE user_id = ? AND workspace_id = ?`, userID, workspaceID); err != nil {
		return fmt.Errorf("delete workspace digest: %w", err)
	}
	return nil
}

func (s *Store) SaveWorkspaceDigestIntro(ctx context.Context, workspaceID, filesRev, intro string) error {
	if _, err := s.conn().ExecContext(ctx, `UPDATE workspace_digests SET intro = ?, intro_rev = files_rev
		WHERE workspace_id = ? AND files_rev = ? AND files_rev <> ''`, intro, workspaceID, filesRev); err != nil {
		return fmt.Errorf("save workspace intro: %w", err)
	}
	return nil
}

func (s *Store) ScheduleWorkspaceDigestSummary(ctx context.Context, userID, workspaceID, dueAt string) error {
	if _, err := s.conn().ExecContext(ctx, `UPDATE workspace_digests SET summary_due_at = ?
		WHERE user_id = ? AND workspace_id = ?`, dueAt, userID, workspaceID); err != nil {
		return fmt.Errorf("schedule workspace summary: %w", err)
	}
	return nil
}

func (s *Store) ClaimWorkspaceDigestSummary(ctx context.Context, userID, workspaceID, sessionID, rev string) (bool, error) {
	result, err := s.conn().ExecContext(ctx, `UPDATE workspace_digests
		SET summary_session_id = ?, pending_rev = ?, summary_due_at = ''
		WHERE user_id = ? AND workspace_id = ? AND summary_session_id = ''`, sessionID, rev, userID, workspaceID)
	if err != nil {
		return false, fmt.Errorf("claim workspace summary: %w", err)
	}
	claimed, _ := result.RowsAffected()
	return claimed == 1, nil
}

func (s *Store) FinishWorkspaceDigestSummary(ctx context.Context, userID, workspaceID, sessionID string, summary *store.WorkspaceDigestSummary, rev, at, dueIfDirty string) error {
	var result sql.Result
	var err error
	if summary == nil {
		result, err = s.conn().ExecContext(ctx, `UPDATE workspace_digests
			SET summary_session_id = '', pending_rev = '',
				summary_due_at = CASE WHEN content_rev <> summary_rev THEN ? ELSE '' END
			WHERE user_id = ? AND workspace_id = ? AND summary_session_id = ?`, dueIfDirty, userID, workspaceID, sessionID)
	} else {
		routeWhen, _ := json.Marshal(nonNilStrings(summary.RouteWhen))
		notWhen, _ := json.Marshal(nonNilStrings(summary.NotWhen))
		result, err = s.conn().ExecContext(ctx, `UPDATE workspace_digests
			SET l0 = ?, summary = ?, route_when = ?, not_when = ?, summary_rev = ?, summarized_at = ?,
				summary_session_id = '', pending_rev = '',
				summary_due_at = CASE WHEN content_rev <> ? THEN ? ELSE '' END
			WHERE user_id = ? AND workspace_id = ? AND summary_session_id = ?`,
			summary.L0, summary.Summary, string(routeWhen), string(notWhen), rev, at, rev, dueIfDirty, userID, workspaceID, sessionID)
	}
	if err != nil {
		return fmt.Errorf("finish workspace summary: %w", err)
	}
	if finished, _ := result.RowsAffected(); finished == 0 {
		return store.ErrNotFound
	}
	return nil
}

func (s *Store) CountDigestSessionsSince(ctx context.Context, userID, since string) (int, error) {
	var count int
	if err := s.reader().QueryRowContext(ctx, `SELECT COUNT(*) FROM agent_sessions
		WHERE json_extract(payload_json, '$.source') = ? AND json_extract(payload_json, '$.createdByUserId') = ?
		AND created_at >= ?`, store.DigestSessionSource, userID, since).Scan(&count); err != nil {
		return 0, fmt.Errorf("count digest sessions: %w", err)
	}
	return count, nil
}

func (s *Store) queryWorkspaceDigests(ctx context.Context, query string, args ...any) ([]store.WorkspaceDigestRecord, error) {
	rows, err := s.reader().QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("list workspace digests: %w", err)
	}
	defer rows.Close()
	records := []store.WorkspaceDigestRecord{}
	for rows.Next() {
		var record store.WorkspaceDigestRecord
		var userID, workspaceID, data, routeWhen, notWhen, evidenceJSON string
		digest := &record.Digest
		if err := rows.Scan(&userID, &workspaceID, &data, &record.ContentRev, &record.FilesRev, &digest.Intro, &record.IntroRev,
			&digest.L0, &digest.Summary, &routeWhen, &notWhen, &record.SummaryRev, &digest.SummarizedAt,
			&record.SummaryDueAt, &record.SummarySessionID, &record.PendingRev, &evidenceJSON); err != nil {
			return nil, fmt.Errorf("scan workspace digest: %w", err)
		}
		intro, l0, summary, summarizedAt := digest.Intro, digest.L0, digest.Summary, digest.SummarizedAt
		if err := json.Unmarshal([]byte(data), digest); err != nil {
			return nil, fmt.Errorf("decode workspace digest %s: %w", workspaceID, err)
		}
		digest.UserID, digest.WorkspaceID = userID, workspaceID
		digest.Intro, digest.L0, digest.Summary, digest.SummarizedAt = intro, l0, summary, summarizedAt
		digest.RouteWhen, digest.NotWhen = []string{}, []string{}
		_ = json.Unmarshal([]byte(routeWhen), &digest.RouteWhen)
		_ = json.Unmarshal([]byte(notWhen), &digest.NotWhen)
		digest.Dirty = record.ContentRev != record.SummaryRev
		var evidence digestEvidence
		_ = json.Unmarshal([]byte(evidenceJSON), &evidence)
		record.History, record.Files = evidence.History, evidence.Files
		records = append(records, record)
	}
	return records, rows.Err()
}
