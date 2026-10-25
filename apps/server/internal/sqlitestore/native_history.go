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

// A session that continues a device's native chat starts with the chat's
// latest part (adoptNativeChat). The rest of the chat's log stays on the
// device until someone scrolls back to it; then it is imported a page at a
// time, oldest events first in the session's order, so the session reads
// like any other from then on. agent_session_native_ids.history_before is
// where the log not yet imported ends.

// nativeHistoryColumn adds history_before to the ownership table.
func (s *Store) nativeHistoryColumn(ctx context.Context) error {
	return s.ensureColumn(ctx, "agent_session_native_ids", "history_before",
		`ALTER TABLE agent_session_native_ids ADD COLUMN history_before INTEGER NOT NULL DEFAULT 0`)
}

// keepNativeHistory records that the session holds its native chat's log
// only from byte before on.
func (s *Store) keepNativeHistory(ctx context.Context, sessionID, provider, nativeID string, before int64) error {
	if before <= 0 {
		return nil
	}
	_, err := s.conn().ExecContext(ctx, `UPDATE agent_session_native_ids SET history_before = ?
		WHERE provider = ? AND native_id = ? AND session_id = ?`, before, provider, nativeID, sessionID)
	if err != nil {
		return fmt.Errorf("record native history: %w", err)
	}
	return nil
}

func (s *Store) SessionNativeHistory(ctx context.Context, sessionID string) (store.NativeHistory, bool, error) {
	var history store.NativeHistory
	err := s.reader().QueryRowContext(ctx, `SELECT provider, native_id, device_id, history_before
		FROM agent_session_native_ids WHERE session_id = ? AND history_before > 0
		ORDER BY attached_at LIMIT 1`, sessionID).
		Scan(&history.Provider, &history.NativeSessionID, &history.DeviceID, &history.Before)
	if errors.Is(err, sql.ErrNoRows) {
		return store.NativeHistory{}, false, nil
	}
	return history, err == nil, err
}

func (s *Store) AgentSessionOldestEventCursor(ctx context.Context, sessionID string) (string, error) {
	var rowID int64
	var createdAt string
	err := s.reader().QueryRowContext(ctx, `SELECT rowid, created_at FROM agent_session_events
		WHERE session_id = ? ORDER BY created_at, rowid LIMIT 1`, sessionID).Scan(&rowID, &createdAt)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	return encodeEventsCursor(createdAt, rowID), nil
}

// nativeHistoryTimeLayout writes every fraction digit: event order is
// created_at's text, and an imported event must sort before the oldest.
const nativeHistoryTimeLayout = "2006-01-02T15:04:05.000000000Z07:00"

func (s *Store) ImportNativeHistory(ctx context.Context, sessionID string, history store.NativeHistory, page []store.TranscriptMessage, next int64) error {
	return s.withTx(ctx, func(tx *Store) error {
		var before int64
		err := tx.conn().QueryRowContext(ctx, `SELECT history_before FROM agent_session_native_ids
			WHERE provider = ? AND native_id = ? AND session_id = ?`,
			history.Provider, history.NativeSessionID, sessionID).Scan(&before)
		if errors.Is(err, sql.ErrNoRows) || (err == nil && before != history.Before) {
			// Someone else imported this page meanwhile.
			return nil
		}
		if err != nil {
			return err
		}
		var oldest string
		if err := tx.conn().QueryRowContext(ctx, `SELECT COALESCE(MIN(created_at), '') FROM agent_session_events
			WHERE session_id = ?`, sessionID).Scan(&oldest); err != nil {
			return err
		}
		first := time.Now().UTC()
		if oldest != "" {
			if first, err = time.Parse(time.RFC3339Nano, oldest); err != nil {
				return fmt.Errorf("read oldest event time: %w", err)
			}
		}
		for index, message := range page {
			message := message
			createdAt := first.Add(-time.Duration(len(page)-index) * time.Microsecond)
			at := strings.TrimSpace(message.At)
			if at == "" {
				at = formatTime(createdAt)
			}
			event := store.AgentSessionEvent{
				ID: "evt_native_" + sessionID + "_h" + message.ID, SessionID: sessionID, At: at,
				Label: "Native transcript", Level: "info", Message: &message,
			}
			payload, err := encode(event)
			if err != nil {
				return err
			}
			// A step a page shares with the part imported before keeps its place.
			if _, err := tx.conn().ExecContext(ctx, `INSERT INTO agent_session_events
				(id, session_id, level, payload_json, created_at, state_key) VALUES (?, ?, ?, ?, ?, ?)
				ON CONFLICT(id) DO NOTHING`,
				event.ID, sessionID, event.Level, payload, createdAt.Format(nativeHistoryTimeLayout), store.SessionStateKey(event)); err != nil {
				return fmt.Errorf("import native history: %w", err)
			}
		}
		if next < 0 {
			next = 0
		}
		_, err = tx.conn().ExecContext(ctx, `UPDATE agent_session_native_ids SET history_before = ?
			WHERE provider = ? AND native_id = ? AND session_id = ?`,
			next, history.Provider, history.NativeSessionID, sessionID)
		return err
	})
}
