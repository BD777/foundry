package sqlitestore

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// setupPendingItems keeps what waits for the person in their sessions
// (DEV-079). Items are found as sessions record them, never backfilled.
func (s *Store) setupPendingItems(ctx context.Context) error {
	statements := []string{
		`CREATE TABLE IF NOT EXISTS pending_items (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL,
			workspace_id TEXT NOT NULL,
			session_id TEXT NOT NULL DEFAULT '',
			issue_id TEXT NOT NULL DEFAULT '',
			source TEXT NOT NULL,
			item_key TEXT NOT NULL,
			state TEXT NOT NULL,
			payload_json TEXT NOT NULL,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			resolved_at TEXT NOT NULL DEFAULT ''
		)`,
		`CREATE INDEX IF NOT EXISTS pending_items_user ON pending_items (user_id, state, updated_at)`,
		`CREATE INDEX IF NOT EXISTS pending_items_session ON pending_items (session_id, state)`,
		`CREATE INDEX IF NOT EXISTS pending_items_issue ON pending_items (issue_id, state)`,
		`CREATE INDEX IF NOT EXISTS pending_items_key ON pending_items (item_key, state)`,
	}
	for _, statement := range statements {
		if _, err := s.conn().ExecContext(ctx, statement); err != nil {
			return fmt.Errorf("migrate pending items: %w", err)
		}
	}
	return nil
}

// pendingStates are the states an item may be in.
var pendingStates = []string{store.PendingOpen, store.PendingReplied, store.PendingSuperseded, store.PendingDone, store.PendingDismissed}

const pendingItemColumns = `id, user_id, state, payload_json, created_at, updated_at, resolved_at`

func scanPendingItem(row interface{ Scan(...any) error }) (store.PendingItem, error) {
	var id, userID, state, payload, createdAt, updatedAt, resolvedAt string
	if err := row.Scan(&id, &userID, &state, &payload, &createdAt, &updatedAt, &resolvedAt); err != nil {
		return store.PendingItem{}, err
	}
	var stored pendingPayload
	if err := json.Unmarshal([]byte(payload), &stored); err != nil {
		return store.PendingItem{}, fmt.Errorf("decode pending item: %w", err)
	}
	item := stored.PendingItem
	item.Key = stored.Key
	item.ID, item.UserID, item.State = id, userID, state
	item.CreatedAt, item.UpdatedAt, item.ResolvedAt = createdAt, updatedAt, resolvedAt
	return item, nil
}

// pendingPayload is what the row keeps beyond its columns.
type pendingPayload struct {
	store.PendingItem
	Key string `json:"key"`
}

func (s *Store) savePendingItem(ctx context.Context, item store.PendingItem) error {
	payload, err := encode(pendingPayload{PendingItem: item, Key: item.Key})
	if err != nil {
		return err
	}
	_, err = s.conn().ExecContext(ctx, `INSERT INTO pending_items
		(id, user_id, workspace_id, session_id, issue_id, source, item_key, state, payload_json, created_at, updated_at, resolved_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
			state = excluded.state,
			payload_json = excluded.payload_json,
			updated_at = excluded.updated_at,
			resolved_at = excluded.resolved_at`,
		item.ID, item.UserID, item.WorkspaceID, item.SessionID, item.IssueID, item.Source, item.Key, item.State,
		payload, item.CreatedAt, item.UpdatedAt, item.ResolvedAt)
	if err != nil {
		return fmt.Errorf("save pending item: %w", err)
	}
	return nil
}

func (s *Store) RecordPendingItem(ctx context.Context, item store.PendingItem) (store.PendingItem, bool, error) {
	if item.UserID == "" || item.WorkspaceID == "" || item.Key == "" || item.Source == "" {
		return store.PendingItem{}, false, fmt.Errorf("a pending item needs a person, a workspace, a source and a key")
	}
	var result store.PendingItem
	changed := false
	err := s.withTx(ctx, func(tx *Store) error {
		now := formatTime(time.Now().UTC())
		existing, err := scanPendingItem(tx.conn().QueryRowContext(ctx, `SELECT `+pendingItemColumns+`
			FROM pending_items WHERE item_key = ? ORDER BY state = ? DESC, created_at DESC LIMIT 1`, item.Key, store.PendingOpen))
		if err == nil && existing.State != store.PendingOpen && existing.EventID == item.EventID {
			// An event reported again after its item was resolved stays resolved.
			result = existing
			return nil
		}
		if errors.Is(err, sql.ErrNoRows) || (err == nil && existing.State != store.PendingOpen) {
			item.ID = evidenceID("pnd")
			item.State = store.PendingOpen
			item.Occurrences = 1
			item.CreatedAt, item.UpdatedAt, item.ResolvedAt = now, now, ""
			result, changed = item, true
			return tx.savePendingItem(ctx, item)
		}
		if err != nil {
			return fmt.Errorf("read pending item: %w", err)
		}
		// The same event reported again (a growing answer keeps its id)
		// takes its newest words without counting twice.
		next := existing
		next.Title, next.Excerpt, next.Context = item.Title, item.Excerpt, item.Context
		next.Options, next.Recommendation, next.Rule = item.Options, item.Recommendation, item.Rule
		if item.EventID != existing.EventID {
			next.Occurrences++
			next.EventID, next.MessageID = item.EventID, item.MessageID
		}
		if pendingSame(existing, next) {
			result = existing
			return nil
		}
		next.UpdatedAt = now
		result, changed = next, true
		return tx.savePendingItem(ctx, next)
	})
	return result, changed, err
}

func pendingSame(a, b store.PendingItem) bool {
	return a.Title == b.Title && a.Excerpt == b.Excerpt && a.Context == b.Context &&
		slices.Equal(a.Options, b.Options) && a.Recommendation == b.Recommendation && a.Rule == b.Rule &&
		a.Occurrences == b.Occurrences && a.EventID == b.EventID && a.MessageID == b.MessageID
}

func (s *Store) ResolvePendingItems(ctx context.Context, resolution store.PendingResolution) (int, error) {
	if resolution.SessionID == "" && resolution.IssueID == "" {
		return 0, fmt.Errorf("resolving pending items needs a session or an Issue")
	}
	if !slices.Contains(pendingStates, resolution.State) || resolution.State == store.PendingOpen {
		return 0, fmt.Errorf("unknown resolution %q", resolution.State)
	}
	query := `SELECT ` + pendingItemColumns + ` FROM pending_items WHERE state = ?`
	args := []any{store.PendingOpen}
	if resolution.SessionID != "" {
		query += ` AND session_id = ?`
		args = append(args, resolution.SessionID)
	}
	if resolution.IssueID != "" {
		query += ` AND issue_id = ?`
		args = append(args, resolution.IssueID)
	}
	if len(resolution.Sources) > 0 {
		query += ` AND source IN (` + strings.TrimSuffix(strings.Repeat("?,", len(resolution.Sources)), ",") + `)`
		for _, source := range resolution.Sources {
			args = append(args, source)
		}
	}
	if resolution.ExceptKey != "" {
		query += ` AND item_key != ?`
		args = append(args, resolution.ExceptKey)
	}
	resolved := 0
	err := s.withTx(ctx, func(tx *Store) error {
		rows, err := tx.conn().QueryContext(ctx, query, args...)
		if err != nil {
			return fmt.Errorf("read pending items: %w", err)
		}
		var items []store.PendingItem
		for rows.Next() {
			item, err := scanPendingItem(rows)
			if err != nil {
				rows.Close()
				return err
			}
			items = append(items, item)
		}
		if err := rows.Close(); err != nil {
			return err
		}
		before := time.Time{}
		if resolution.Before != "" {
			before = parseStoredTime(resolution.Before)
		}
		now := formatTime(time.Now().UTC())
		for _, item := range items {
			// Compared as times: stored and given times differ in precision.
			if !before.IsZero() && !parseStoredTime(item.CreatedAt).Before(before) {
				continue
			}
			item.State, item.UpdatedAt, item.ResolvedAt = resolution.State, now, now
			if err := tx.savePendingItem(ctx, item); err != nil {
				return err
			}
			resolved++
		}
		return nil
	})
	return resolved, err
}

func (s *Store) ListPendingItems(ctx context.Context, userID string, states []string, resolvedSince string, limit int) ([]store.PendingItem, error) {
	if limit <= 0 || limit > 500 {
		limit = 500
	}
	var wanted []string
	for _, state := range states {
		if slices.Contains(pendingStates, state) && !slices.Contains(wanted, state) {
			wanted = append(wanted, state)
		}
	}
	if len(wanted) == 0 {
		return nil, nil
	}
	query := `SELECT ` + pendingItemColumns + ` FROM pending_items WHERE user_id = ? AND state IN (` +
		strings.TrimSuffix(strings.Repeat("?,", len(wanted)), ",") + `)`
	args := []any{userID}
	for _, state := range wanted {
		args = append(args, state)
	}
	if resolvedSince != "" {
		query += ` AND (state = ? OR resolved_at >= ?)`
		args = append(args, store.PendingOpen, resolvedSince)
	}
	query += ` ORDER BY updated_at DESC LIMIT ?`
	args = append(args, limit)
	rows, err := s.reader().QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("list pending items: %w", err)
	}
	defer rows.Close()
	var items []store.PendingItem
	for rows.Next() {
		item, err := scanPendingItem(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (s *Store) SetPendingItemState(ctx context.Context, userID, id, state string) (store.PendingItem, error) {
	if state != store.PendingOpen && state != store.PendingDone && state != store.PendingDismissed {
		return store.PendingItem{}, fmt.Errorf("an item can be marked done, dismissed or open")
	}
	var result store.PendingItem
	err := s.withTx(ctx, func(tx *Store) error {
		item, err := scanPendingItem(tx.conn().QueryRowContext(ctx, `SELECT `+pendingItemColumns+` FROM pending_items WHERE id = ? AND user_id = ?`, id, userID))
		if errors.Is(err, sql.ErrNoRows) {
			return store.ErrNotFound
		}
		if err != nil {
			return fmt.Errorf("read pending item: %w", err)
		}
		if item.State == state {
			result = item
			return nil
		}
		now := formatTime(time.Now().UTC())
		item.State, item.UpdatedAt = state, now
		item.ResolvedAt = now
		if state == store.PendingOpen {
			item.ResolvedAt = ""
		}
		result = item
		return tx.savePendingItem(ctx, item)
	})
	return result, err
}
