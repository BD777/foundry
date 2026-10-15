package sqlitestore

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"
)

// setupSessionInputSenders keeps which session sent a message steered into
// a running turn. Its device writes that message's transcript event
// (evt_<input id>), later than the steer is answered when its outbox lags;
// the server names the sender on the event when it arrives.
func (s *Store) setupSessionInputSenders(ctx context.Context) error {
	if _, err := s.conn().ExecContext(ctx, `CREATE TABLE IF NOT EXISTS session_input_senders (
		session_id TEXT NOT NULL,
		input_id TEXT NOT NULL,
		sender_session_id TEXT NOT NULL,
		created_at TEXT NOT NULL,
		PRIMARY KEY (session_id, input_id)
	)`); err != nil {
		return fmt.Errorf("migrate session input senders: %w", err)
	}
	return nil
}

// RecordSessionInputSender records that senderSessionID sent the input
// inputID of sessionID. Recording it again keeps the first sender.
func (s *Store) RecordSessionInputSender(ctx context.Context, sessionID, inputID, senderSessionID string) error {
	sessionID, inputID, senderSessionID = strings.TrimSpace(sessionID), strings.TrimSpace(inputID), strings.TrimSpace(senderSessionID)
	if sessionID == "" || inputID == "" || senderSessionID == "" {
		return errors.New("session, input and sender are required")
	}
	if _, err := s.conn().ExecContext(ctx, `INSERT OR IGNORE INTO session_input_senders (session_id, input_id, sender_session_id, created_at) VALUES (?, ?, ?, ?)`,
		sessionID, inputID, senderSessionID, formatTime(time.Now().UTC())); err != nil {
		return fmt.Errorf("record session input sender: %w", err)
	}
	return nil
}

// SessionInputSender is the session that sent the input inputID of
// sessionID; empty when the person sent it or nothing recorded it.
func (s *Store) SessionInputSender(ctx context.Context, sessionID, inputID string) (string, error) {
	var sender string
	err := s.reader().QueryRowContext(ctx, `SELECT sender_session_id FROM session_input_senders WHERE session_id = ? AND input_id = ?`,
		sessionID, inputID).Scan(&sender)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("read session input sender: %w", err)
	}
	return sender, nil
}
