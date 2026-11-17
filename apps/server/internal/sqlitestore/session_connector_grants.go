package sqlitestore

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// setupSessionConnectorGrants keeps what a session may write without the
// person's confirmation (DEV-265). Grants are per account and object; the
// channel layer writes the originating conversation's grant on each turn.
func (s *Store) setupSessionConnectorGrants(ctx context.Context) error {
	statements := []string{
		`CREATE TABLE IF NOT EXISTS session_connector_grants (
			session_id TEXT NOT NULL,
			account_id TEXT NOT NULL,
			object_type TEXT NOT NULL,
			object_id TEXT NOT NULL,
			label TEXT NOT NULL DEFAULT '',
			created_at TEXT NOT NULL,
			PRIMARY KEY (session_id, account_id, object_type, object_id)
		)`,
		`CREATE INDEX IF NOT EXISTS session_connector_grants_session ON session_connector_grants (session_id)`,
	}
	for _, statement := range statements {
		if _, err := s.conn().ExecContext(ctx, statement); err != nil {
			return fmt.Errorf("migrate session connector grants: %w", err)
		}
	}
	return nil
}

func (s *Store) SessionConnectorGrants(ctx context.Context, sessionID string) ([]store.SessionConnectorGrant, error) {
	rows, err := s.reader().QueryContext(ctx, `SELECT session_id, account_id, object_type, object_id, label
		FROM session_connector_grants WHERE session_id = ? ORDER BY account_id, object_type, object_id`, sessionID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var grants []store.SessionConnectorGrant
	for rows.Next() {
		var grant store.SessionConnectorGrant
		if err := rows.Scan(&grant.SessionID, &grant.AccountID, &grant.ObjectType, &grant.ObjectID, &grant.Label); err != nil {
			return nil, err
		}
		grants = append(grants, grant)
	}
	return grants, rows.Err()
}

func (s *Store) SetSessionConnectorGrants(ctx context.Context, sessionID, accountID string, grants []store.SessionConnectorGrant) error {
	return s.withTx(ctx, func(tx *Store) error {
		if _, err := tx.conn().ExecContext(ctx,
			`DELETE FROM session_connector_grants WHERE session_id = ? AND account_id = ?`, sessionID, accountID); err != nil {
			return err
		}
		now := time.Now().UTC().Format(time.RFC3339Nano)
		seen := map[string]bool{}
		for _, grant := range grants {
			grant.ObjectType, grant.ObjectID = strings.TrimSpace(grant.ObjectType), strings.TrimSpace(grant.ObjectID)
			if grant.ObjectType == "" || grant.ObjectID == "" {
				continue
			}
			key := grant.ObjectType + "\x00" + grant.ObjectID
			if seen[key] {
				continue
			}
			seen[key] = true
			if _, err := tx.conn().ExecContext(ctx, `INSERT INTO session_connector_grants
				(session_id, account_id, object_type, object_id, label, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
				sessionID, accountID, grant.ObjectType, grant.ObjectID, grant.Label, now); err != nil {
				return err
			}
		}
		return nil
	})
}
