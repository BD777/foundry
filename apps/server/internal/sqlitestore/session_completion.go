package sqlitestore

import (
	"context"
	"errors"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func (s *Store) SettleAgentSessionInput(ctx context.Context, sessionID, inputID, response, nativeSessionID, failure string) (store.AgentSession, bool, error) {
	var session store.AgentSession
	applied := false
	err := s.withTx(ctx, func(tx *Store) error {
		var err error
		session, err = tx.GetAgentSessionRecord(ctx, sessionID)
		if err != nil {
			return err
		}
		if (inputID != "" && session.Input.ID != "" && inputID != session.Input.ID) || isTerminalAgentSession(session.Status) {
			return nil
		}
		if failure != "" {
			session, err = tx.FailAgentSession(ctx, sessionID, failure)
		} else {
			session, err = tx.completeAgentSession(ctx, sessionID, response, nativeSessionID)
			if err == nil {
				// Completion recovery can be the first report of the full answer.
				// Carry only the fallback event recordInputAnswer persisted so the
				// caller can stream it; a slim status change carries no transcript.
				answer, readErr := getJSON[store.AgentSessionEvent](ctx, tx.conn(), `SELECT payload_json FROM agent_session_events WHERE id = ? AND session_id = ?`, "evt_"+session.Input.ID+"_answer", sessionID)
				if readErr == nil {
					session.Events = []store.AgentSessionEvent{answer}
				} else if !errors.Is(readErr, store.ErrNotFound) {
					return readErr
				}
			}
		}
		applied = err == nil
		return err
	})
	return session, applied && err == nil, err
}
