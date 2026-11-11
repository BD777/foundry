package sqlitestore

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"github.com/google/uuid"
)

func (s *Store) setupSessionAlerts(ctx context.Context) error {
	statements := []string{
		`CREATE TABLE IF NOT EXISTS session_alerts (
			id TEXT PRIMARY KEY,
			recipient_session_id TEXT NOT NULL,
			child_session_id TEXT NOT NULL,
			source_input_id TEXT NOT NULL DEFAULT '',
			code TEXT NOT NULL,
			dedupe_key TEXT NOT NULL,
			detail TEXT NOT NULL DEFAULT '',
			will_retry INTEGER NOT NULL DEFAULT 0,
			occurrences INTEGER NOT NULL DEFAULT 1,
			first_seen_at TEXT NOT NULL,
			last_seen_at TEXT NOT NULL,
			notify_after TEXT NOT NULL,
			notified_at TEXT,
			resolved_at TEXT,
			inbox_input_id TEXT NOT NULL DEFAULT ''
		)`,
		`CREATE INDEX IF NOT EXISTS session_alerts_due
			ON session_alerts (notify_after) WHERE notified_at IS NULL AND resolved_at IS NULL`,
		`CREATE INDEX IF NOT EXISTS session_alerts_child
			ON session_alerts (child_session_id, last_seen_at DESC)`,
		`CREATE UNIQUE INDEX IF NOT EXISTS session_alerts_active_dedupe
			ON session_alerts (recipient_session_id, child_session_id, dedupe_key)
			WHERE resolved_at IS NULL`,
	}
	for _, statement := range statements {
		if _, err := s.conn().ExecContext(ctx, statement); err != nil {
			return fmt.Errorf("migrate session alerts: %w", err)
		}
	}
	return nil
}

const sessionAlertColumns = `id, recipient_session_id, child_session_id, source_input_id, code, dedupe_key,
	detail, will_retry, occurrences, first_seen_at, last_seen_at, notify_after, notified_at, resolved_at, inbox_input_id`

func scanSessionAlert(row interface{ Scan(...any) error }) (store.SessionAlert, error) {
	var alert store.SessionAlert
	var willRetry int
	var firstSeenAt, lastSeenAt, notifyAfter string
	var notifiedAt, resolvedAt sql.NullString
	if err := row.Scan(&alert.ID, &alert.RecipientSessionID, &alert.ChildSessionID, &alert.SourceInputID,
		&alert.Code, &alert.DedupeKey, &alert.Detail, &willRetry, &alert.Occurrences, &firstSeenAt,
		&lastSeenAt, &notifyAfter, &notifiedAt, &resolvedAt, &alert.InboxInputID); err != nil {
		return store.SessionAlert{}, err
	}
	alert.WillRetry = willRetry != 0
	alert.FirstSeenAt = parseStoredTime(firstSeenAt)
	alert.LastSeenAt = parseStoredTime(lastSeenAt)
	alert.NotifyAfter = parseStoredTime(notifyAfter)
	alert.NotifiedAt = parseOptionalTime(notifiedAt)
	alert.ResolvedAt = parseOptionalTime(resolvedAt)
	return alert, nil
}

// RecordSessionAlert inserts an incident or folds another observation into
// its unresolved instance. The unique partial index makes concurrent
// observations converge on one alert.
func (s *Store) RecordSessionAlert(ctx context.Context, input store.SessionAlertInput) (store.SessionAlert, bool, error) {
	input.RecipientSessionID = strings.TrimSpace(input.RecipientSessionID)
	input.ChildSessionID = strings.TrimSpace(input.ChildSessionID)
	input.Code = strings.TrimSpace(input.Code)
	input.DedupeKey = strings.TrimSpace(input.DedupeKey)
	if input.RecipientSessionID == "" || input.ChildSessionID == "" || input.Code == "" || input.DedupeKey == "" {
		return store.SessionAlert{}, false, errors.New("alert recipient, child, code and dedupe key are required")
	}
	if input.NotifyAfter.IsZero() {
		input.NotifyAfter = time.Now().UTC()
	}
	if input.ObservedAt.IsZero() {
		input.ObservedAt = input.NotifyAfter
	}
	input.ObservedAt = input.ObservedAt.UTC()
	input.NotifyAfter = input.NotifyAfter.UTC()
	var recorded store.SessionAlert
	created := false
	err := s.withTx(ctx, func(tx *Store) error {
		db := tx.conn()
		existing, err := scanSessionAlert(db.QueryRowContext(ctx, `SELECT `+sessionAlertColumns+`
			FROM session_alerts
			WHERE recipient_session_id = ? AND child_session_id = ? AND dedupe_key = ? AND resolved_at IS NULL`,
			input.RecipientSessionID, input.ChildSessionID, input.DedupeKey))
		switch {
		case err == nil:
			recorded = existing
			notifyAfter := input.NotifyAfter
			if existing.NotifyAfter.Before(notifyAfter) {
				notifyAfter = existing.NotifyAfter
			}
			if _, err := db.ExecContext(ctx, `UPDATE session_alerts
				SET source_input_id = ?, code = ?, detail = ?, will_retry = ?, occurrences = occurrences + 1,
					last_seen_at = ?, notify_after = ?
				WHERE id = ?`,
				input.SourceInputID, input.Code, input.Detail, boolInt(input.WillRetry),
				formatTime(input.ObservedAt), formatTime(notifyAfter), existing.ID); err != nil {
				return fmt.Errorf("update session alert: %w", err)
			}
			recorded.SourceInputID = input.SourceInputID
			recorded.Code, recorded.Detail, recorded.WillRetry = input.Code, input.Detail, input.WillRetry
			recorded.Occurrences++
			recorded.LastSeenAt = input.ObservedAt
			recorded.NotifyAfter = notifyAfter
			return nil
		case !errors.Is(err, sql.ErrNoRows):
			return fmt.Errorf("find session alert: %w", err)
		}
		created = true
		recorded = store.SessionAlert{
			ID: uuid.NewString(), RecipientSessionID: input.RecipientSessionID, ChildSessionID: input.ChildSessionID,
			SourceInputID: input.SourceInputID, Code: input.Code, DedupeKey: input.DedupeKey, Detail: input.Detail,
			WillRetry: input.WillRetry, Occurrences: 1, FirstSeenAt: input.ObservedAt, LastSeenAt: input.ObservedAt,
			NotifyAfter: input.NotifyAfter,
		}
		if _, err := db.ExecContext(ctx, `INSERT INTO session_alerts (`+sessionAlertColumns+`)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, '')`,
			recorded.ID, recorded.RecipientSessionID, recorded.ChildSessionID, recorded.SourceInputID, recorded.Code,
			recorded.DedupeKey, recorded.Detail, boolInt(recorded.WillRetry), recorded.Occurrences,
			formatTime(recorded.FirstSeenAt), formatTime(recorded.LastSeenAt), formatTime(recorded.NotifyAfter)); err != nil {
			return fmt.Errorf("insert session alert: %w", err)
		}
		return nil
	})
	return recorded, created, err
}

// DueSessionAlerts lists unresolved, unnotified alerts whose delay expired.
func (s *Store) DueSessionAlerts(ctx context.Context, now time.Time, limit int) ([]store.SessionAlert, error) {
	if limit <= 0 {
		limit = 100
	}
	rows, err := s.reader().QueryContext(ctx, `SELECT `+sessionAlertColumns+`
		FROM session_alerts
		WHERE notified_at IS NULL AND resolved_at IS NULL AND notify_after <= ?
		ORDER BY notify_after, id LIMIT ?`, formatTime(now.UTC()), limit)
	if err != nil {
		return nil, fmt.Errorf("list due session alerts: %w", err)
	}
	defer rows.Close()
	var alerts []store.SessionAlert
	for rows.Next() {
		alert, err := scanSessionAlert(rows)
		if err != nil {
			return nil, fmt.Errorf("scan due session alert: %w", err)
		}
		alerts = append(alerts, alert)
	}
	return alerts, rows.Err()
}

// MarkSessionAlertNotified records the inbox message that carried an alert.
func (s *Store) MarkSessionAlertNotified(ctx context.Context, id, inboxInputID string, at time.Time) (bool, error) {
	result, err := s.conn().ExecContext(ctx, `UPDATE session_alerts
		SET notified_at = ?, inbox_input_id = ?
		WHERE id = ? AND notified_at IS NULL AND resolved_at IS NULL`,
		formatTime(at.UTC()), inboxInputID, id)
	if err != nil {
		return false, fmt.Errorf("mark session alert notified: %w", err)
	}
	changed, err := result.RowsAffected()
	return changed == 1, err
}

// ResolveSessionAlerts closes unresolved alerts of one child.
func (s *Store) ResolveSessionAlerts(ctx context.Context, childSessionID, code string, at time.Time) (int, error) {
	query := `UPDATE session_alerts SET resolved_at = ? WHERE child_session_id = ? AND resolved_at IS NULL`
	args := []any{formatTime(at.UTC()), childSessionID}
	if code != "" {
		query += ` AND code = ?`
		args = append(args, code)
	}
	result, err := s.conn().ExecContext(ctx, query, args...)
	if err != nil {
		return 0, fmt.Errorf("resolve session alerts: %w", err)
	}
	count, err := result.RowsAffected()
	return int(count), err
}

// SessionAlertsForChild lists a child's alerts, newest first.
func (s *Store) SessionAlertsForChild(ctx context.Context, childSessionID string, limit int) ([]store.SessionAlert, error) {
	if limit <= 0 {
		limit = 100
	}
	rows, err := s.reader().QueryContext(ctx, `SELECT `+sessionAlertColumns+`
		FROM session_alerts WHERE child_session_id = ? ORDER BY last_seen_at DESC, id DESC LIMIT ?`,
		childSessionID, limit)
	if err != nil {
		return nil, fmt.Errorf("list session alerts: %w", err)
	}
	defer rows.Close()
	var alerts []store.SessionAlert
	for rows.Next() {
		alert, err := scanSessionAlert(rows)
		if err != nil {
			return nil, fmt.Errorf("scan session alert: %w", err)
		}
		alerts = append(alerts, alert)
	}
	return alerts, rows.Err()
}
