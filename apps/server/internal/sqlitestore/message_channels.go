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

// Message channels (DEV-203): docs/devlog/DEV-203-message-channels.md.

func (s *Store) setupMessageChannels(ctx context.Context) error {
	for _, statement := range []string{
		`CREATE TABLE IF NOT EXISTS message_channels (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL,
			assistant_id TEXT NOT NULL,
			data_json TEXT NOT NULL,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)`,
		`CREATE INDEX IF NOT EXISTS idx_message_channels_assistant ON message_channels(user_id, assistant_id)`,
		`CREATE TABLE IF NOT EXISTS message_channel_runtime (
			channel_id TEXT PRIMARY KEY,
			cursor TEXT NOT NULL DEFAULT '',
			state TEXT NOT NULL DEFAULT '',
			detail TEXT NOT NULL DEFAULT '',
			last_poll_at TEXT NOT NULL DEFAULT '',
			last_event_at TEXT NOT NULL DEFAULT '',
			last_error_at TEXT NOT NULL DEFAULT '',
			gap_at TEXT NOT NULL DEFAULT '',
			updated_at TEXT NOT NULL DEFAULT ''
		)`,
		`CREATE TABLE IF NOT EXISTS message_channel_deliveries (
			id TEXT PRIMARY KEY,
			channel_id TEXT NOT NULL,
			envelope_id TEXT NOT NULL,
			user_id TEXT NOT NULL,
			assistant_id TEXT NOT NULL,
			status TEXT NOT NULL,
			reason TEXT NOT NULL DEFAULT '',
			rule TEXT NOT NULL DEFAULT '',
			session_key TEXT NOT NULL DEFAULT '',
			envelope_json TEXT NOT NULL,
			inbox_id TEXT NOT NULL DEFAULT '',
			session_id TEXT NOT NULL DEFAULT '',
			actions_json TEXT NOT NULL DEFAULT '',
			created_at TEXT NOT NULL,
			delivered_at TEXT NOT NULL DEFAULT ''
		)`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_message_channel_deliveries_envelope ON message_channel_deliveries(channel_id, envelope_id)`,
		`CREATE INDEX IF NOT EXISTS idx_message_channel_deliveries_recent ON message_channel_deliveries(channel_id, created_at)`,
		`CREATE INDEX IF NOT EXISTS idx_message_channel_deliveries_status ON message_channel_deliveries(channel_id, status)`,
		`CREATE INDEX IF NOT EXISTS idx_message_channel_deliveries_session ON message_channel_deliveries(session_id) WHERE session_id <> ''`,
		`CREATE TABLE IF NOT EXISTS message_channel_keys (
			channel_id TEXT NOT NULL,
			session_key TEXT NOT NULL,
			segment INTEGER NOT NULL DEFAULT 0,
			reset_pending TEXT NOT NULL DEFAULT '',
			updated_at TEXT NOT NULL DEFAULT '',
			PRIMARY KEY (channel_id, session_key)
		)`,
		`CREATE TABLE IF NOT EXISTS message_channel_sessions (
			session_id TEXT PRIMARY KEY,
			channel_id TEXT NOT NULL,
			assistant_id TEXT NOT NULL,
			session_key TEXT NOT NULL,
			segment INTEGER NOT NULL DEFAULT 0,
			created_at TEXT NOT NULL
		)`,
		`CREATE INDEX IF NOT EXISTS idx_message_channel_sessions_channel ON message_channel_sessions(channel_id)`,
		`CREATE TABLE IF NOT EXISTS message_channel_instructions (
			id TEXT PRIMARY KEY,
			channel_id TEXT NOT NULL,
			sha256 TEXT NOT NULL,
			bytes INTEGER NOT NULL,
			content TEXT NOT NULL,
			source TEXT NOT NULL,
			created_at TEXT NOT NULL
		)`,
		`CREATE INDEX IF NOT EXISTS idx_message_channel_instructions_channel ON message_channel_instructions(channel_id, created_at)`,
		// Filtered-out messages keep no text (an earlier build kept their
		// opening for a preview).
		`UPDATE message_channel_deliveries SET envelope_json = json_set(envelope_json, '$.text', '', '$.textTruncated', json('false'))
			WHERE status = 'dropped' AND json_extract(envelope_json, '$.text') <> ''`,
	} {
		if _, err := s.conn().ExecContext(ctx, statement); err != nil {
			return fmt.Errorf("setup message channels: %w", err)
		}
	}
	for _, column := range []string{
		`segment INTEGER NOT NULL DEFAULT 0`, `session_new INTEGER NOT NULL DEFAULT 0`, `new_reason TEXT NOT NULL DEFAULT ''`,
		`inbox_channel TEXT NOT NULL DEFAULT ''`, `raw_json TEXT NOT NULL DEFAULT ''`,
	} {
		if _, err := s.conn().ExecContext(ctx, `ALTER TABLE message_channel_deliveries ADD COLUMN `+column); err != nil && !strings.Contains(err.Error(), "duplicate column name") {
			return fmt.Errorf("setup message channel deliveries: %w", err)
		}
	}
	return nil
}

func scanMessageChannel(row rowScanner) (store.MessageChannelRecord, error) {
	var record store.MessageChannelRecord
	var raw string
	if err := row.Scan(&record.UserID, &raw); err != nil {
		return record, err
	}
	if err := json.Unmarshal([]byte(raw), &record.MessageChannel); err != nil {
		return record, fmt.Errorf("decode message channel: %w", err)
	}
	return record, nil
}

func (s *Store) listMessageChannels(ctx context.Context, where string, args ...any) ([]store.MessageChannelRecord, error) {
	rows, err := s.reader().QueryContext(ctx, `SELECT user_id, data_json FROM message_channels `+where+` ORDER BY created_at, id`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []store.MessageChannelRecord
	for rows.Next() {
		record, err := scanMessageChannel(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, record)
	}
	return out, rows.Err()
}

func (s *Store) ListMessageChannels(ctx context.Context, userID, assistantID string) ([]store.MessageChannelRecord, error) {
	if assistantID == "" {
		return s.listMessageChannels(ctx, `WHERE user_id = ?`, userID)
	}
	return s.listMessageChannels(ctx, `WHERE user_id = ? AND assistant_id = ?`, userID, assistantID)
}

func (s *Store) ListAllMessageChannels(ctx context.Context) ([]store.MessageChannelRecord, error) {
	return s.listMessageChannels(ctx, ``)
}

func (s *Store) GetMessageChannel(ctx context.Context, id string) (store.MessageChannelRecord, error) {
	record, err := scanMessageChannel(s.reader().QueryRowContext(ctx, `SELECT user_id, data_json FROM message_channels WHERE id = ?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return record, store.ErrNotFound
	}
	return record, err
}

func (s *Store) SaveMessageChannel(ctx context.Context, record store.MessageChannelRecord) error {
	raw, err := json.Marshal(record.MessageChannel)
	if err != nil {
		return err
	}
	result, err := s.conn().ExecContext(ctx, `INSERT INTO message_channels (id, user_id, assistant_id, data_json, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET data_json = excluded.data_json, updated_at = excluded.updated_at
		WHERE message_channels.user_id = excluded.user_id AND message_channels.assistant_id = excluded.assistant_id`,
		record.ID, record.UserID, record.AssistantID, string(raw), record.CreatedAt, record.UpdatedAt)
	if err != nil {
		return err
	}
	if changed, _ := result.RowsAffected(); changed == 0 {
		return store.ErrNotFound
	}
	return nil
}

func (s *Store) DeleteMessageChannel(ctx context.Context, userID, id string) error {
	return s.withTx(ctx, func(tx *Store) error {
		result, err := tx.conn().ExecContext(ctx, `DELETE FROM message_channels WHERE id = ? AND user_id = ?`, id, userID)
		if err != nil {
			return err
		}
		if changed, _ := result.RowsAffected(); changed == 0 {
			return store.ErrNotFound
		}
		for _, table := range []string{"message_channel_runtime", "message_channel_keys", "message_channel_instructions"} {
			if _, err := tx.conn().ExecContext(ctx, `DELETE FROM `+table+` WHERE channel_id = ?`, id); err != nil {
				return err
			}
		}
		_, err = tx.conn().ExecContext(ctx, `DELETE FROM message_channel_deliveries WHERE channel_id = ?`, id)
		return err
	})
}

func (s *Store) GetMessageChannelRuntime(ctx context.Context, channelID string) (store.MessageChannelRuntime, error) {
	runtime := store.MessageChannelRuntime{ChannelID: channelID}
	err := s.reader().QueryRowContext(ctx, `SELECT cursor, state, detail, last_poll_at, last_event_at, last_error_at, gap_at, updated_at
		FROM message_channel_runtime WHERE channel_id = ?`, channelID).Scan(&runtime.Cursor, &runtime.State, &runtime.Detail,
		&runtime.LastPollAt, &runtime.LastEventAt, &runtime.LastErrorAt, &runtime.GapAt, &runtime.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return runtime, store.ErrNotFound
	}
	return runtime, err
}

func (s *Store) SaveMessageChannelRuntime(ctx context.Context, runtime store.MessageChannelRuntime) error {
	if runtime.UpdatedAt == "" {
		runtime.UpdatedAt = paNow()
	}
	// A poll that was running when its channel was deleted leaves nothing.
	_, err := s.conn().ExecContext(ctx, `INSERT INTO message_channel_runtime
		(channel_id, cursor, state, detail, last_poll_at, last_event_at, last_error_at, gap_at, updated_at)
		SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM message_channels WHERE id = ?1)
		ON CONFLICT(channel_id) DO UPDATE SET cursor = excluded.cursor, state = excluded.state, detail = excluded.detail,
			last_poll_at = excluded.last_poll_at, last_event_at = excluded.last_event_at,
			last_error_at = excluded.last_error_at, gap_at = excluded.gap_at, updated_at = excluded.updated_at`,
		runtime.ChannelID, runtime.Cursor, runtime.State, runtime.Detail, runtime.LastPollAt, runtime.LastEventAt,
		runtime.LastErrorAt, runtime.GapAt, runtime.UpdatedAt)
	return err
}

func (s *Store) RecordMessageChannelBatch(ctx context.Context, channelID string, records []store.MessageChannelDeliveryRecord, cursor string) ([]store.MessageChannelDeliveryRecord, error) {
	var stored []store.MessageChannelDeliveryRecord
	err := s.withTx(ctx, func(tx *Store) error {
		var exists int
		if err := tx.conn().QueryRowContext(ctx, `SELECT COUNT(*) FROM message_channels WHERE id = ?`, channelID).Scan(&exists); err != nil || exists == 0 {
			return err
		}
		for _, record := range records {
			inserted, err := tx.insertMessageChannelDelivery(ctx, record)
			if err != nil {
				return err
			}
			if inserted {
				stored = append(stored, record)
			}
		}
		_, err := tx.conn().ExecContext(ctx, `INSERT INTO message_channel_runtime (channel_id, cursor, updated_at) VALUES (?, ?, ?)
			ON CONFLICT(channel_id) DO UPDATE SET cursor = excluded.cursor, updated_at = excluded.updated_at`,
			channelID, cursor, paNow())
		return err
	})
	return stored, err
}

func (s *Store) insertMessageChannelDelivery(ctx context.Context, record store.MessageChannelDeliveryRecord) (bool, error) {
	envelope, err := json.Marshal(record.Envelope)
	if err != nil {
		return false, err
	}
	actions, err := json.Marshal(record.Actions)
	if err != nil {
		return false, err
	}
	result, err := s.conn().ExecContext(ctx, `INSERT INTO message_channel_deliveries
		(id, channel_id, envelope_id, user_id, assistant_id, status, reason, rule, session_key, envelope_json, inbox_id, session_id, actions_json, created_at, delivered_at,
		 segment, session_new, new_reason, inbox_channel, raw_json)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(channel_id, envelope_id) DO NOTHING`,
		record.ID, record.ChannelID, record.Envelope.ID, record.UserID, record.AssistantID, record.Status, record.Reason,
		record.Rule, record.SessionKey, string(envelope), record.InboxID, record.SessionID, string(actions), record.CreatedAt, record.DeliveredAt,
		record.Segment, record.SessionNew, record.NewReason, record.InboxChannel, record.RawJSON)
	if err != nil {
		return false, err
	}
	changed, _ := result.RowsAffected()
	return changed > 0, nil
}

const messageDeliveryColumns = `id, channel_id, user_id, assistant_id, status, reason, rule, session_key, envelope_json, inbox_id, session_id, actions_json, created_at, delivered_at, segment, session_new, new_reason, inbox_channel, raw_json`

func scanMessageChannelDelivery(row rowScanner) (store.MessageChannelDeliveryRecord, error) {
	var record store.MessageChannelDeliveryRecord
	var envelope, actions string
	err := row.Scan(&record.ID, &record.ChannelID, &record.UserID, &record.AssistantID, &record.Status, &record.Reason, &record.Rule,
		&record.SessionKey, &envelope, &record.InboxID, &record.SessionID, &actions, &record.CreatedAt, &record.DeliveredAt,
		&record.Segment, &record.SessionNew, &record.NewReason, &record.InboxChannel, &record.RawJSON)
	if err != nil {
		return record, err
	}
	if err := json.Unmarshal([]byte(envelope), &record.Envelope); err != nil {
		return record, fmt.Errorf("decode message envelope: %w", err)
	}
	if actions != "" && actions != "null" {
		if err := json.Unmarshal([]byte(actions), &record.Actions); err != nil {
			return record, fmt.Errorf("decode message actions: %w", err)
		}
	}
	return record, nil
}

func (s *Store) ListMessageChannelDeliveries(ctx context.Context, channelID string, statuses []string, limit int) ([]store.MessageChannelDeliveryRecord, error) {
	if limit <= 0 || limit > 500 {
		limit = 500
	}
	query := `SELECT ` + messageDeliveryColumns + ` FROM message_channel_deliveries WHERE channel_id = ?`
	args := []any{channelID}
	if len(statuses) > 0 {
		query += ` AND status IN (` + strings.TrimSuffix(strings.Repeat("?,", len(statuses)), ",") + `)`
		for _, status := range statuses {
			args = append(args, status)
		}
	}
	query += ` ORDER BY created_at DESC, id DESC LIMIT ?`
	args = append(args, limit)
	rows, err := s.reader().QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []store.MessageChannelDeliveryRecord
	for rows.Next() {
		record, err := scanMessageChannelDelivery(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, record)
	}
	return out, rows.Err()
}

func (s *Store) SaveMessageChannelDelivery(ctx context.Context, record store.MessageChannelDeliveryRecord) error {
	actions, err := json.Marshal(record.Actions)
	if err != nil {
		return err
	}
	result, err := s.conn().ExecContext(ctx, `UPDATE message_channel_deliveries SET status = ?, reason = ?, inbox_id = ?, session_id = ?,
		actions_json = ?, delivered_at = ?, segment = ?, session_new = ?, new_reason = ?, inbox_channel = ? WHERE id = ? AND channel_id = ?`,
		record.Status, record.Reason, record.InboxID, record.SessionID, string(actions), record.DeliveredAt,
		record.Segment, record.SessionNew, record.NewReason, record.InboxChannel, record.ID, record.ChannelID)
	if err != nil {
		return err
	}
	if changed, _ := result.RowsAffected(); changed == 0 {
		return store.ErrNotFound
	}
	return nil
}

func (s *Store) CountMessageChannelDeliveries(ctx context.Context, channelID, since string) (store.MessageChannelCounts, error) {
	var counts store.MessageChannelCounts
	rows, err := s.reader().QueryContext(ctx, `SELECT status, COUNT(*) FROM message_channel_deliveries
		WHERE channel_id = ? AND created_at >= ? GROUP BY status`, channelID, since)
	if err != nil {
		return counts, err
	}
	defer rows.Close()
	for rows.Next() {
		var status string
		var count int
		if err := rows.Scan(&status, &count); err != nil {
			return counts, err
		}
		counts.Received += count
		switch status {
		case store.MessageDeliveryDropped:
			counts.Dropped += count
		case store.MessageDeliveryHeld:
			counts.Held += count
			counts.Matched += count
		case store.MessageDeliveryDelivered, store.MessageDeliveryDone:
			counts.Delivered += count
			counts.Matched += count
		default:
			counts.Matched += count
		}
	}
	return counts, rows.Err()
}

func (s *Store) MessageChannelOfSession(ctx context.Context, sessionID string) (store.MessageChannelRecord, error) {
	var channelID string
	err := s.reader().QueryRowContext(ctx, `SELECT channel_id FROM message_channel_sessions WHERE session_id = ?
		UNION ALL SELECT channel_id FROM message_channel_deliveries WHERE session_id = ? LIMIT 1`, sessionID, sessionID).Scan(&channelID)
	if errors.Is(err, sql.ErrNoRows) {
		return store.MessageChannelRecord{}, store.ErrNotFound
	}
	if err != nil {
		return store.MessageChannelRecord{}, err
	}
	return s.GetMessageChannel(ctx, channelID)
}

func (s *Store) MessageChannelSessions(ctx context.Context, assistantID, channelID string) ([]string, error) {
	query := `SELECT session_id FROM message_channel_deliveries WHERE assistant_id = ? AND session_id <> ''`
	args := []any{assistantID}
	if channelID != "" {
		query += ` AND channel_id = ?`
		args = append(args, channelID)
	}
	query += ` UNION SELECT session_id FROM message_channel_sessions WHERE assistant_id = ?`
	args = append(args, assistantID)
	if channelID != "" {
		query += ` AND channel_id = ?`
		args = append(args, channelID)
	} else {
		// Turns of channels that no longer exist still went to sessions.
		query += ` UNION SELECT session_id FROM pa_inbox WHERE assistant_id = ? AND channel LIKE 'mc:%' AND session_id <> ''`
		args = append(args, assistantID)
	}
	rows, err := s.reader().QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

func (s *Store) PruneMessageChannelDeliveries(ctx context.Context, droppedBefore, keptBefore string) error {
	if _, err := s.conn().ExecContext(ctx, `DELETE FROM message_channel_deliveries WHERE status = ? AND created_at < ?`,
		store.MessageDeliveryDropped, droppedBefore); err != nil {
		return err
	}
	// Older records keep their row, which ties a session to its channel
	// (and so to the channel's scope), but not the message's text.
	_, err := s.conn().ExecContext(ctx, `UPDATE message_channel_deliveries SET envelope_json = json_set(envelope_json, '$.text', '')
		WHERE created_at < ? AND json_extract(envelope_json, '$.text') <> ''`, keptBefore)
	return err
}

var _ store.MessageChannelStore = (*Store)(nil)

func (s *Store) GetMessageChannelKey(ctx context.Context, channelID, sessionKey string) (store.MessageChannelKeyState, error) {
	state := store.MessageChannelKeyState{ChannelID: channelID, SessionKey: sessionKey}
	err := s.reader().QueryRowContext(ctx, `SELECT segment, reset_pending, updated_at FROM message_channel_keys WHERE channel_id = ? AND session_key = ?`,
		channelID, sessionKey).Scan(&state.Segment, &state.ResetPending, &state.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return state, nil
	}
	return state, err
}

func (s *Store) SaveMessageChannelKey(ctx context.Context, state store.MessageChannelKeyState) error {
	if state.UpdatedAt == "" {
		state.UpdatedAt = paNow()
	}
	_, err := s.conn().ExecContext(ctx, `INSERT INTO message_channel_keys (channel_id, session_key, segment, reset_pending, updated_at) VALUES (?, ?, ?, ?, ?)
		ON CONFLICT(channel_id, session_key) DO UPDATE SET segment = excluded.segment, reset_pending = excluded.reset_pending, updated_at = excluded.updated_at`,
		state.ChannelID, state.SessionKey, state.Segment, state.ResetPending, state.UpdatedAt)
	return err
}

func (s *Store) RecordMessageChannelSession(ctx context.Context, session store.MessageChannelSession) error {
	if session.CreatedAt == "" {
		session.CreatedAt = paNow()
	}
	_, err := s.conn().ExecContext(ctx, `INSERT INTO message_channel_sessions (session_id, channel_id, assistant_id, session_key, segment, created_at)
		VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(session_id) DO NOTHING`,
		session.SessionID, session.ChannelID, session.AssistantID, session.SessionKey, session.Segment, session.CreatedAt)
	return err
}

func (s *Store) GetMessageChannelSession(ctx context.Context, sessionID string) (store.MessageChannelSession, error) {
	session := store.MessageChannelSession{SessionID: sessionID}
	err := s.reader().QueryRowContext(ctx, `SELECT channel_id, assistant_id, session_key, segment, created_at FROM message_channel_sessions WHERE session_id = ?`,
		sessionID).Scan(&session.ChannelID, &session.AssistantID, &session.SessionKey, &session.Segment, &session.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return session, store.ErrNotFound
	}
	return session, err
}

func (s *Store) ListMessageChannelInstructionRevisions(ctx context.Context, channelID string, limit int) ([]store.MessageChannelInstructionsRevision, error) {
	if limit <= 0 || limit > 200 {
		limit = 200
	}
	rows, err := s.reader().QueryContext(ctx, `SELECT id, created_at, sha256, bytes, source FROM message_channel_instructions
		WHERE channel_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`, channelID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []store.MessageChannelInstructionsRevision{}
	for rows.Next() {
		var revision store.MessageChannelInstructionsRevision
		if err := rows.Scan(&revision.ID, &revision.At, &revision.Sha256, &revision.Bytes, &revision.Source); err != nil {
			return nil, err
		}
		out = append(out, revision)
	}
	return out, rows.Err()
}

func (s *Store) GetMessageChannelInstructionRevision(ctx context.Context, channelID, id string) (store.MessageChannelInstructionsRevision, string, error) {
	var revision store.MessageChannelInstructionsRevision
	var content string
	err := s.reader().QueryRowContext(ctx, `SELECT id, created_at, sha256, bytes, source, content FROM message_channel_instructions WHERE channel_id = ? AND id = ?`,
		channelID, id).Scan(&revision.ID, &revision.At, &revision.Sha256, &revision.Bytes, &revision.Source, &content)
	if errors.Is(err, sql.ErrNoRows) {
		return revision, "", store.ErrNotFound
	}
	return revision, content, err
}

func (s *Store) AddMessageChannelInstructionRevision(ctx context.Context, channelID string, revision store.MessageChannelInstructionsRevision, content string) error {
	_, err := s.conn().ExecContext(ctx, `INSERT INTO message_channel_instructions (id, channel_id, sha256, bytes, content, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
		revision.ID, channelID, revision.Sha256, revision.Bytes, content, revision.Source, revision.At)
	return err
}

func (s *Store) MessageChannelSessionEvents(ctx context.Context, sessionIDs []string, label string, limit int) ([]store.MessageChannelSessionEvent, error) {
	if len(sessionIDs) == 0 {
		return nil, nil
	}
	if limit <= 0 || limit > 500 {
		limit = 500
	}
	args := []any{label}
	for _, id := range sessionIDs {
		args = append(args, id)
	}
	args = append(args, limit)
	rows, err := s.reader().QueryContext(ctx, `SELECT session_id, created_at, COALESCE(json_extract(payload_json, '$.detail'), '') FROM agent_session_events
		WHERE json_extract(payload_json, '$.label') = ? AND session_id IN (`+strings.TrimSuffix(strings.Repeat("?,", len(sessionIDs)), ",")+`)
		ORDER BY created_at DESC LIMIT ?`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []store.MessageChannelSessionEvent
	for rows.Next() {
		var event store.MessageChannelSessionEvent
		var detail any
		if err := rows.Scan(&event.SessionID, &event.At, &detail); err != nil {
			return nil, err
		}
		event.Detail = fmt.Sprint(detail)
		out = append(out, event)
	}
	return out, rows.Err()
}
