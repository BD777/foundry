package sqlitestore

import (
	"context"
	"database/sql"
	"errors"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

var _ store.SessionInspectionStore = (*Store)(nil)

func (s *Store) AgentSessionCreatedAt(ctx context.Context, sessionID string) (string, error) {
	var createdAt string
	err := s.conn().QueryRowContext(ctx, `SELECT created_at FROM agent_sessions WHERE id = ? AND `+visibleAgentSessionSQL, sessionID).Scan(&createdAt)
	if errors.Is(err, sql.ErrNoRows) {
		return "", store.ErrNotFound
	}
	return createdAt, err
}

func (s *Store) NativeSessionOwner(ctx context.Context, provider, nativeID string) (string, error) {
	return s.nativeSessionOwner(ctx, provider, nativeID)
}
