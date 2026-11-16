package sqlitestore

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func (s *Store) setupSessionMemberSwitches(ctx context.Context) error {
	if _, err := s.conn().ExecContext(ctx, `CREATE TABLE IF NOT EXISTS session_member_switches (
		session_id TEXT PRIMARY KEY,
		profile_id TEXT NOT NULL,
		model TEXT NOT NULL,
		requested_at TEXT NOT NULL
	)`); err != nil {
		return fmt.Errorf("migrate sqlite session member switches: %w", err)
	}
	return nil
}

func (s *Store) SetPendingSessionMember(ctx context.Context, sessionID string, member store.PendingSessionMember) error {
	_, err := s.conn().ExecContext(ctx, `INSERT INTO session_member_switches (session_id, profile_id, model, requested_at)
		VALUES (?, ?, ?, ?)
		ON CONFLICT(session_id) DO UPDATE SET
			profile_id = excluded.profile_id,
			model = excluded.model,
			requested_at = excluded.requested_at`,
		sessionID, strings.TrimSpace(member.ProfileID), strings.TrimSpace(member.Model), formatTime(member.RequestedAt.UTC()))
	if err != nil {
		return fmt.Errorf("set pending session member: %w", err)
	}
	return nil
}

func (s *Store) GetPendingSessionMember(ctx context.Context, sessionID string) (store.PendingSessionMember, bool, error) {
	var member store.PendingSessionMember
	var requested string
	err := s.conn().QueryRowContext(ctx, `SELECT profile_id, model, requested_at
		FROM session_member_switches WHERE session_id = ?`, sessionID).Scan(&member.ProfileID, &member.Model, &requested)
	if errors.Is(err, sql.ErrNoRows) {
		return store.PendingSessionMember{}, false, nil
	}
	if err != nil {
		return store.PendingSessionMember{}, false, fmt.Errorf("get pending session member: %w", err)
	}
	member.RequestedAt = parseStoredTime(requested)
	return member, true, nil
}

func (s *Store) TakePendingSessionMember(ctx context.Context, sessionID string) (store.PendingSessionMember, bool, error) {
	var member store.PendingSessionMember
	var requested string
	err := s.withTx(ctx, func(tx *Store) error {
		err := tx.conn().QueryRowContext(ctx, `SELECT profile_id, model, requested_at
			FROM session_member_switches WHERE session_id = ?`, sessionID).Scan(&member.ProfileID, &member.Model, &requested)
		if errors.Is(err, sql.ErrNoRows) {
			return store.ErrNotFound
		}
		if err != nil {
			return err
		}
		_, err = tx.conn().ExecContext(ctx, `DELETE FROM session_member_switches WHERE session_id = ?`, sessionID)
		return err
	})
	if errors.Is(err, store.ErrNotFound) {
		return store.PendingSessionMember{}, false, nil
	}
	if err != nil {
		return store.PendingSessionMember{}, false, fmt.Errorf("take pending session member: %w", err)
	}
	member.RequestedAt = parseStoredTime(requested)
	return member, true, nil
}
