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

func (s *Store) setupSessionRetries(ctx context.Context) error {
	if _, err := s.conn().ExecContext(ctx, `CREATE TABLE IF NOT EXISTS session_retries (
		session_id TEXT NOT NULL,
		input_id TEXT NOT NULL,
		attempt INTEGER NOT NULL,
		max_attempts INTEGER NOT NULL,
		previous_model TEXT NOT NULL DEFAULT '',
		next_model TEXT NOT NULL DEFAULT '',
		status TEXT NOT NULL,
		next_attempt_at TEXT NOT NULL,
		last_error TEXT NOT NULL DEFAULT '',
		created_at TEXT NOT NULL,
		updated_at TEXT NOT NULL,
		PRIMARY KEY (session_id, input_id)
	)`); err != nil {
		return fmt.Errorf("migrate sqlite session retries: %w", err)
	}
	if _, err := s.conn().ExecContext(ctx, `CREATE INDEX IF NOT EXISTS idx_session_retries_due
		ON session_retries (status, next_attempt_at)`); err != nil {
		return fmt.Errorf("index sqlite session retries: %w", err)
	}
	if _, err := s.conn().ExecContext(ctx, `ALTER TABLE session_retries ADD COLUMN next_profile_id TEXT NOT NULL DEFAULT ''`); err != nil && !strings.Contains(err.Error(), "duplicate column name") {
		return fmt.Errorf("add next_profile_id to sqlite session retries: %w", err)
	}
	return nil
}

const sessionRetryColumns = `session_id, input_id, attempt, max_attempts,
	previous_model, next_model, next_profile_id, status, next_attempt_at, last_error, created_at, updated_at`

func scanSessionRetry(row interface{ Scan(...any) error }) (store.SessionRetry, error) {
	var retry store.SessionRetry
	var next, created, updated string
	err := row.Scan(&retry.SessionID, &retry.InputID, &retry.Attempt, &retry.MaxAttempts,
		&retry.PreviousModel, &retry.NextModel, &retry.NextProfileID, &retry.Status, &next, &retry.LastError, &created, &updated)
	if errors.Is(err, sql.ErrNoRows) {
		return store.SessionRetry{}, store.ErrNotFound
	}
	if err != nil {
		return store.SessionRetry{}, err
	}
	retry.NextAttemptAt = parseStoredTime(next)
	retry.CreatedAt = parseStoredTime(created)
	retry.UpdatedAt = parseStoredTime(updated)
	return retry, nil
}

func (s *Store) GetSessionRetry(ctx context.Context, sessionID, inputID string) (store.SessionRetry, bool, error) {
	retry, err := scanSessionRetry(s.reader().QueryRowContext(ctx, `SELECT `+sessionRetryColumns+`
		FROM session_retries WHERE session_id = ? AND input_id = ?`,
		strings.TrimSpace(sessionID), strings.TrimSpace(inputID)))
	if errors.Is(err, store.ErrNotFound) {
		return store.SessionRetry{}, false, nil
	}
	if err != nil {
		return store.SessionRetry{}, false, fmt.Errorf("get session retry: %w", err)
	}
	return retry, true, nil
}

func (s *Store) DueSessionRetries(ctx context.Context, now time.Time, limit int) ([]store.SessionRetry, error) {
	if limit <= 0 {
		limit = 100
	}
	rows, err := s.reader().QueryContext(ctx, `SELECT `+sessionRetryColumns+`
		FROM session_retries
		WHERE next_attempt_at <= ? AND status IN (?, ?)
		ORDER BY next_attempt_at, session_id, input_id LIMIT ?`,
		formatTime(now.UTC()), store.SessionRetryPending, store.SessionRetryDispatching, limit)
	if err != nil {
		return nil, fmt.Errorf("list due session retries: %w", err)
	}
	defer rows.Close()
	retries := []store.SessionRetry{}
	for rows.Next() {
		retry, err := scanSessionRetry(rows)
		if err != nil {
			return nil, err
		}
		retries = append(retries, retry)
	}
	return retries, rows.Err()
}

func (s *Store) ScheduleAgentSessionRetry(ctx context.Context, retry store.SessionRetry, blockedReason string) (store.AgentSession, error) {
	retry.SessionID = strings.TrimSpace(retry.SessionID)
	retry.InputID = strings.TrimSpace(retry.InputID)
	retry.PreviousModel = strings.TrimSpace(retry.PreviousModel)
	retry.NextModel = strings.TrimSpace(retry.NextModel)
	retry.NextProfileID = strings.TrimSpace(retry.NextProfileID)
	retry.LastError = strings.TrimSpace(retry.LastError)
	blockedReason = strings.TrimSpace(blockedReason)
	if retry.SessionID == "" || retry.InputID == "" {
		return store.AgentSession{}, errors.New("session retry needs a session and input")
	}
	if retry.Attempt < 1 || retry.MaxAttempts < retry.Attempt {
		return store.AgentSession{}, errors.New("session retry attempt is invalid")
	}
	now := time.Now().UTC()
	if retry.CreatedAt.IsZero() {
		retry.CreatedAt = now
	}
	retry.Status = store.SessionRetryPending
	retry.UpdatedAt = now
	var result store.AgentSession
	err := s.withTx(ctx, func(tx *Store) error {
		session, err := tx.GetAgentSessionRecord(ctx, retry.SessionID)
		if err != nil {
			return err
		}
		if session.Input.ID != retry.InputID || !store.IsActiveSessionStatus(session.Status) {
			return store.ErrNotFound
		}
		session.Status = "blocked"
		session.BlockedReason = blockedReason
		session.UpdatedLabel = "blocked"
		if err := tx.saveAgentSession(ctx, session, time.Time{}, now); err != nil {
			return err
		}
		_, err = tx.conn().ExecContext(ctx, `INSERT INTO session_retries
			(session_id, input_id, attempt, max_attempts, previous_model, next_model, next_profile_id, status,
				next_attempt_at, last_error, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(session_id, input_id) DO UPDATE SET
				attempt = excluded.attempt,
				max_attempts = excluded.max_attempts,
				previous_model = excluded.previous_model,
				next_model = excluded.next_model,
				next_profile_id = excluded.next_profile_id,
				status = excluded.status,
				next_attempt_at = excluded.next_attempt_at,
				last_error = excluded.last_error,
				updated_at = excluded.updated_at`,
			retry.SessionID, retry.InputID, retry.Attempt, retry.MaxAttempts, retry.PreviousModel,
			retry.NextModel, retry.NextProfileID, retry.Status, formatTime(retry.NextAttemptAt.UTC()), retry.LastError,
			formatTime(retry.CreatedAt), formatTime(retry.UpdatedAt))
		if err != nil {
			return err
		}
		result = session
		return nil
	})
	if err != nil {
		return store.AgentSession{}, fmt.Errorf("schedule session retry: %w", err)
	}
	return result, nil
}

func (s *Store) ClaimAgentSessionRetry(ctx context.Context, retry store.SessionRetry, leaseUntil time.Time) (store.AgentSession, error) {
	now := time.Now().UTC()
	var result store.AgentSession
	err := s.withTx(ctx, func(tx *Store) error {
		stored, found, err := tx.GetSessionRetry(ctx, retry.SessionID, retry.InputID)
		if err != nil {
			return err
		}
		if !found || stored.Attempt != retry.Attempt ||
			(stored.Status != store.SessionRetryPending && stored.Status != store.SessionRetryDispatching) {
			return store.ErrNotFound
		}
		session, err := tx.GetAgentSessionRecord(ctx, retry.SessionID)
		if err != nil || session.Input.ID != retry.InputID || isTerminalAgentSession(session.Status) {
			return store.ErrNotFound
		}
		session.Model = stored.NextModel
		if stored.NextProfileID != "" {
			session.ProfileID = stored.NextProfileID
		}
		session.DispatchID = uuid.NewString()
		session.Status = "queued"
		session.BlockedReason = ""
		session.Response = ""
		session.Error = ""
		session.StartedAt = ""
		session.CompletedAt = ""
		session.UpdatedLabel = "queued"
		if err := tx.saveAgentSession(ctx, session, time.Time{}, now); err != nil {
			return err
		}
		_, err = tx.conn().ExecContext(ctx, `UPDATE session_retries
			SET status = ?, next_attempt_at = ?, updated_at = ?
			WHERE session_id = ? AND input_id = ?`,
			store.SessionRetryDispatching, formatTime(leaseUntil.UTC()), formatTime(now),
			retry.SessionID, retry.InputID)
		if err != nil {
			return err
		}
		result = session
		return nil
	})
	if err != nil {
		return store.AgentSession{}, fmt.Errorf("claim session retry: %w", err)
	}
	return result, nil
}

func (s *Store) UpdateSessionRetry(ctx context.Context, sessionID, inputID, status, detail string, at time.Time) error {
	_, err := s.conn().ExecContext(ctx, `UPDATE session_retries
		SET status = ?, last_error = ?, updated_at = ?
		WHERE session_id = ? AND input_id = ?`,
		strings.TrimSpace(status), strings.TrimSpace(detail), formatTime(at.UTC()),
		strings.TrimSpace(sessionID), strings.TrimSpace(inputID))
	if err != nil {
		return fmt.Errorf("update session retry: %w", err)
	}
	return nil
}

// SetSessionRetryNextMember moves a pending retry to another member and makes
// it due at at, so the next pump runs it on that member.
func (s *Store) SetSessionRetryNextMember(ctx context.Context, sessionID, inputID, profileID, model string, at time.Time) (bool, error) {
	result, err := s.conn().ExecContext(ctx, `UPDATE session_retries
		SET next_profile_id = ?, next_model = ?, next_attempt_at = ?, updated_at = ?
		WHERE session_id = ? AND input_id = ? AND status = ?`,
		strings.TrimSpace(profileID), strings.TrimSpace(model), formatTime(at.UTC()), formatTime(time.Now().UTC()),
		sessionID, inputID, store.SessionRetryPending)
	if err != nil {
		return false, fmt.Errorf("move session retry: %w", err)
	}
	changed, err := result.RowsAffected()
	return changed > 0, err
}
