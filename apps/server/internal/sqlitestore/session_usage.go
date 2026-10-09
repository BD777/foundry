package sqlitestore

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func (s *Store) migrateSessionUsageBackfills(ctx context.Context) error {
	_, err := s.conn().ExecContext(ctx, `CREATE TABLE IF NOT EXISTS agent_session_usage_backfills (
		session_id TEXT PRIMARY KEY,
		backfilled_at TEXT NOT NULL
	)`)
	if err != nil {
		return fmt.Errorf("migrate session usage backfills: %w", err)
	}
	return nil
}

// SessionUsageBackfilled reports whether a session's usage was already read
// back from its agent's log.
func (s *Store) SessionUsageBackfilled(ctx context.Context, sessionID string) (bool, error) {
	var found int
	err := s.conn().QueryRowContext(ctx,
		`SELECT COUNT(*) FROM agent_session_usage_backfills WHERE session_id = ?`, sessionID).Scan(&found)
	return found > 0, err
}

// BackfillAgentSessionUsage stores usage read back from an agent's log on
// the session's events: turn usage on the events that ended turns, request
// usage on tool steps. Usage an event already carries is kept. The session
// is then marked, so its log is read once.
func (s *Store) BackfillAgentSessionUsage(ctx context.Context, sessionID string, turns map[string]store.AgentTurnUsage, requests map[string]store.ModelRequestUsage) error {
	return s.withTx(ctx, func(tx *Store) error {
		for eventID, usage := range turns {
			encoded, err := json.Marshal(usage)
			if err != nil {
				return err
			}
			if _, err := tx.conn().ExecContext(ctx, `UPDATE agent_session_events
				SET payload_json = json_set(payload_json, '$.metadata.turnUsage', json(?))
				WHERE id = ? AND session_id = ? AND json_extract(payload_json, '$.metadata.turnUsage') IS NULL`,
				string(encoded), eventID, sessionID); err != nil {
				return fmt.Errorf("backfill turn usage: %w", err)
			}
		}
		for eventID, usage := range requests {
			encoded, err := json.Marshal(usage)
			if err != nil {
				return err
			}
			if _, err := tx.conn().ExecContext(ctx, `UPDATE agent_session_events
				SET payload_json = json_set(payload_json, '$.message.requestUsage', json(?))
				WHERE id = ? AND session_id = ? AND json_extract(payload_json, '$.message') IS NOT NULL
					AND COALESCE(json_extract(payload_json, '$.message.requestUsage.inputTokens'), 0) = 0
					AND COALESCE(json_extract(payload_json, '$.message.requestUsage.outputTokens'), 0) = 0`,
				string(encoded), eventID, sessionID); err != nil {
				return fmt.Errorf("backfill request usage: %w", err)
			}
		}
		_, err := tx.conn().ExecContext(ctx, `INSERT INTO agent_session_usage_backfills (session_id, backfilled_at)
			VALUES (?, ?) ON CONFLICT (session_id) DO NOTHING`, sessionID, formatTime(time.Now()))
		return err
	})
}
