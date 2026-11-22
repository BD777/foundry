package sqlitestore

import (
	"cmp"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// Signals by item (store.PersonalAgentItemSignalStore, DEV-324):
// pa_item_helpers ties a workspace session's helper to an item, and
// pa_item_signals keeps the signals waiting on an item for a session that
// follows it.

var _ store.PersonalAgentItemSignalStore = (*Store)(nil)

var itemSignalSchema = []string{
	`CREATE TABLE IF NOT EXISTS pa_item_helpers (
		session_id TEXT PRIMARY KEY,
		assistant_id TEXT NOT NULL,
		item_id TEXT NOT NULL,
		created_at TEXT NOT NULL,
		status TEXT NOT NULL DEFAULT 'running',
		ended_at TEXT NOT NULL DEFAULT ''
	)`,
	`CREATE INDEX IF NOT EXISTS idx_pa_item_helpers_item ON pa_item_helpers (assistant_id, item_id)`,
	`CREATE TABLE IF NOT EXISTS pa_item_signals (
		id TEXT PRIMARY KEY,
		assistant_id TEXT NOT NULL,
		item_id TEXT NOT NULL,
		sender_session_id TEXT NOT NULL DEFAULT '',
		prompt TEXT NOT NULL,
		delivery TEXT NOT NULL,
		source_json TEXT NOT NULL DEFAULT '',
		merge_key TEXT NOT NULL DEFAULT '',
		created_at TEXT NOT NULL,
		sent_session_id TEXT NOT NULL DEFAULT '',
		sent_at TEXT NOT NULL DEFAULT ''
	)`,
	`CREATE INDEX IF NOT EXISTS idx_pa_item_signals_waiting ON pa_item_signals (assistant_id, item_id, sent_at, created_at)`,
}

func (s *Store) LinkPersonalAgentItemHelper(ctx context.Context, actor, assistantID, itemID, sessionID string) error {
	if err := checkActor(actor); err != nil {
		return err
	}
	if assistantID == "" || itemID == "" || sessionID == "" {
		return errors.New("link item helper: assistant, item and session are required")
	}
	return s.withTx(ctx, func(tx *Store) error {
		previous, err := tx.linkedHelper(ctx, sessionID)
		if err != nil && !errors.Is(err, store.ErrNotFound) {
			return err
		}
		next := store.PersonalAgentTask{AssistantID: assistantID, ItemID: itemID, SessionID: sessionID, Status: store.PersonalAgentTaskRunning}
		var status string
		err = tx.reader().QueryRowContext(ctx, `SELECT workspace_id, status, COALESCE(json_extract(payload_json, '$.title'), '') FROM agent_sessions WHERE id = ?`,
			sessionID).Scan(&next.WorkspaceID, &status, &next.Title)
		switch {
		case err == nil:
			next.Status = store.PersonalAgentTaskStatusOf(status)
		case !errors.Is(err, sql.ErrNoRows):
			return fmt.Errorf("link item helper: read session: %w", err)
		}
		now := paNow()
		if helperFinished(next.Status) {
			next.EndedAt = now
		}
		if previous.AssistantID != assistantID {
			// Linked to another assistant's item, the helper joins this one afresh.
			previous = store.PersonalAgentTask{}
		}
		if _, err := tx.conn().ExecContext(ctx, `INSERT INTO pa_item_helpers (session_id, assistant_id, item_id, created_at, status, ended_at) VALUES (?, ?, ?, ?, ?, ?)
			ON CONFLICT (session_id) DO UPDATE SET assistant_id = excluded.assistant_id, item_id = excluded.item_id, status = excluded.status, ended_at = excluded.ended_at`,
			sessionID, assistantID, itemID, now, next.Status, next.EndedAt); err != nil {
			return fmt.Errorf("link item helper: %w", err)
		}
		return tx.recordHelperEvents(ctx, actor, now, previous, next)
	})
}

func (s *Store) SetPersonalAgentItemHelperStatus(ctx context.Context, sessionID, status, endedAt string) error {
	return s.withTx(ctx, func(tx *Store) error {
		previous, err := tx.linkedHelper(ctx, sessionID)
		if errors.Is(err, store.ErrNotFound) {
			return nil
		}
		if err != nil {
			return err
		}
		if previous.Status == status {
			return nil
		}
		next := previous
		next.Status, next.EndedAt = status, ""
		if helperFinished(status) {
			next.EndedAt = cmp.Or(endedAt, paNow())
		}
		if _, err := tx.conn().ExecContext(ctx, `UPDATE pa_item_helpers SET status = ?, ended_at = ? WHERE session_id = ?`,
			next.Status, next.EndedAt, sessionID); err != nil {
			return fmt.Errorf("set item helper status: %w", err)
		}
		return tx.recordHelperEvents(ctx, store.PersonalAgentActorFoundry, paNow(), previous, next)
	})
}

func (s *Store) ListPersonalAgentItemHelpers(ctx context.Context, assistantID, itemID string) ([]store.PersonalAgentTask, error) {
	if assistantID == "" || itemID == "" {
		return []store.PersonalAgentTask{}, nil
	}
	helpers, err := s.itemHelpers(ctx, assistantID, []store.PersonalAgentListItem{{AssistantID: assistantID, ID: itemID}})
	if err != nil {
		return nil, err
	}
	return append([]store.PersonalAgentTask{}, helpers[itemID]...), nil
}

// linkedHelperColumns read a pa_item_helpers row joined to its session (h, a)
// as the task scanLinkedHelper makes of it.
const linkedHelperColumns = `h.session_id, h.assistant_id, h.item_id, h.status, h.created_at, h.ended_at,
	COALESCE(a.workspace_id, ''), COALESCE(json_extract(a.payload_json, '$.title'), '')`

const linkedHelperFrom = `pa_item_helpers h LEFT JOIN agent_sessions a ON a.id = h.session_id`

// scanLinkedHelper reads a linked helper in the shape of the assistant's
// tasks, so an item lists both alike.
func scanLinkedHelper(row interface{ Scan(...any) error }) (store.PersonalAgentTask, error) {
	var helper store.PersonalAgentTask
	err := row.Scan(&helper.SessionID, &helper.AssistantID, &helper.ItemID, &helper.Status, &helper.CreatedAt, &helper.EndedAt,
		&helper.WorkspaceID, &helper.Title)
	if errors.Is(err, sql.ErrNoRows) {
		return helper, store.ErrNotFound
	}
	if err != nil {
		return helper, fmt.Errorf("read item helper: %w", err)
	}
	helper.UpdatedAt = helper.CreatedAt
	return helper, nil
}

// linkedHelper is the helper linked by sessionID; ErrNotFound for none.
func (s *Store) linkedHelper(ctx context.Context, sessionID string) (store.PersonalAgentTask, error) {
	return scanLinkedHelper(s.reader().QueryRowContext(ctx, `SELECT `+linkedHelperColumns+` FROM `+linkedHelperFrom+` WHERE h.session_id = ?`, sessionID))
}

func (s *Store) PersonalAgentItemOfHelper(ctx context.Context, sessionID string) (store.PersonalAgentItemRef, error) {
	var ref store.PersonalAgentItemRef
	err := s.reader().QueryRowContext(ctx, `SELECT assistant_id, item_id FROM pa_item_helpers WHERE session_id = ?`, sessionID).Scan(&ref.AssistantID, &ref.ItemID)
	if errors.Is(err, sql.ErrNoRows) {
		return ref, store.ErrNotFound
	}
	if err != nil {
		return ref, fmt.Errorf("read item of helper: %w", err)
	}
	return ref, nil
}

func (s *Store) QueuePersonalAgentItemSignal(ctx context.Context, signal store.PersonalAgentItemSignal) (bool, error) {
	if signal.ID == "" || signal.AssistantID == "" || signal.ItemID == "" {
		return false, errors.New("queue item signal: id, assistant and item are required")
	}
	source := ""
	if signal.Source != nil {
		encoded, err := json.Marshal(signal.Source)
		if err != nil {
			return false, fmt.Errorf("queue item signal: encode source: %w", err)
		}
		source = string(encoded)
	}
	if signal.CreatedAt.IsZero() {
		signal.CreatedAt = time.Now()
	}
	created := false
	err := s.withTx(ctx, func(tx *Store) error {
		if signal.MergeKey != "" {
			if _, err := tx.conn().ExecContext(ctx, `DELETE FROM pa_item_signals WHERE assistant_id = ? AND item_id = ? AND merge_key = ? AND sent_at = '' AND id <> ?`,
				signal.AssistantID, signal.ItemID, signal.MergeKey, signal.ID); err != nil {
				return fmt.Errorf("merge item signal: %w", err)
			}
		}
		result, err := tx.conn().ExecContext(ctx, `INSERT INTO pa_item_signals (id, assistant_id, item_id, sender_session_id, prompt, delivery, source_json, merge_key, created_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING`,
			signal.ID, signal.AssistantID, signal.ItemID, signal.SenderSessionID, signal.Prompt, signal.Delivery, source, signal.MergeKey, formatTime(signal.CreatedAt))
		if err != nil {
			return fmt.Errorf("queue item signal: %w", err)
		}
		changed, err := result.RowsAffected()
		created = changed == 1
		return err
	})
	return created, err
}

func (s *Store) WaitingPersonalAgentItemSignals(ctx context.Context, assistantID, itemID string) ([]store.PersonalAgentItemSignal, error) {
	rows, err := s.reader().QueryContext(ctx, `SELECT id, assistant_id, item_id, sender_session_id, prompt, delivery, source_json, merge_key, created_at
		FROM pa_item_signals WHERE assistant_id = ? AND item_id = ? AND sent_at = '' ORDER BY created_at, rowid`, assistantID, itemID)
	if err != nil {
		return nil, fmt.Errorf("list waiting item signals: %w", err)
	}
	defer rows.Close()
	var signals []store.PersonalAgentItemSignal
	for rows.Next() {
		var signal store.PersonalAgentItemSignal
		var source, createdAt string
		if err := rows.Scan(&signal.ID, &signal.AssistantID, &signal.ItemID, &signal.SenderSessionID, &signal.Prompt, &signal.Delivery, &source, &signal.MergeKey, &createdAt); err != nil {
			return nil, fmt.Errorf("read waiting item signal: %w", err)
		}
		if source != "" {
			if err := json.Unmarshal([]byte(source), &signal.Source); err != nil {
				return nil, fmt.Errorf("read waiting item signal %s source: %w", signal.ID, err)
			}
		}
		signal.CreatedAt = parseStoredTime(createdAt)
		signals = append(signals, signal)
	}
	return signals, rows.Err()
}

func (s *Store) ItemsWithWaitingSignals(ctx context.Context, limit int) ([]store.PersonalAgentItemRef, error) {
	if limit <= 0 {
		limit = 100
	}
	rows, err := s.reader().QueryContext(ctx, `SELECT assistant_id, item_id FROM pa_item_signals WHERE sent_at = ''
		GROUP BY assistant_id, item_id ORDER BY min(created_at) LIMIT ?`, limit)
	if err != nil {
		return nil, fmt.Errorf("list items with waiting signals: %w", err)
	}
	defer rows.Close()
	var refs []store.PersonalAgentItemRef
	for rows.Next() {
		var ref store.PersonalAgentItemRef
		if err := rows.Scan(&ref.AssistantID, &ref.ItemID); err != nil {
			return nil, fmt.Errorf("read item with waiting signals: %w", err)
		}
		refs = append(refs, ref)
	}
	return refs, rows.Err()
}

func (s *Store) MarkPersonalAgentItemSignalSent(ctx context.Context, id, sessionID string, at time.Time) error {
	if _, err := s.conn().ExecContext(ctx, `UPDATE pa_item_signals SET sent_session_id = ?, sent_at = ? WHERE id = ? AND sent_at = ''`,
		sessionID, formatTime(at), id); err != nil {
		return fmt.Errorf("mark item signal sent: %w", err)
	}
	return nil
}
