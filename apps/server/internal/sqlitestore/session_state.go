package sqlitestore

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log"
	"slices"
	"strings"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// migrateSessionStateKeys gives events the state key (store.SessionStateKey)
// a windowed read finds the side panel's older state by, through a partial
// index that holds only the events that have one. An event's key is NULL
// until it is computed ("" when it has none): events a binary unaware of
// the column wrote, before it was added or after a downgrade, get theirs
// on every start, found through a partial index of the NULL ones.
func (s *Store) migrateSessionStateKeys(ctx context.Context) error {
	return s.withTx(ctx, func(tx *Store) error {
		var present, notNull int
		if err := tx.conn().QueryRowContext(ctx, `SELECT COUNT(*), COALESCE(MAX("notnull"), 0) FROM pragma_table_info('agent_session_events') WHERE name = 'state_key'`).Scan(&present, &notNull); err != nil {
			return fmt.Errorf("inspect agent_session_events columns: %w", err)
		}
		if present == 1 && notNull == 1 {
			// An earlier build stored "" for an unknown key too: computed
			// again, as NULL until then.
			for _, statement := range []string{
				`DROP INDEX IF EXISTS idx_agent_session_events_state`,
				`ALTER TABLE agent_session_events DROP COLUMN state_key`,
			} {
				if _, err := tx.conn().ExecContext(ctx, statement); err != nil {
					return fmt.Errorf("recreate agent_session_events.state_key: %w", err)
				}
			}
			present = 0
		}
		if present == 0 {
			if _, err := tx.conn().ExecContext(ctx, `ALTER TABLE agent_session_events ADD COLUMN state_key TEXT`); err != nil {
				return fmt.Errorf("add agent_session_events.state_key: %w", err)
			}
		}
		for _, statement := range []string{
			`CREATE INDEX IF NOT EXISTS idx_agent_session_events_state ON agent_session_events (session_id, created_at, state_key) WHERE state_key <> ''`,
			`CREATE INDEX IF NOT EXISTS idx_agent_session_events_unkeyed ON agent_session_events (session_id) WHERE state_key IS NULL`,
		} {
			if _, err := tx.conn().ExecContext(ctx, statement); err != nil {
				return fmt.Errorf("index session state events: %w", err)
			}
		}
		if err := tx.rekeySessionStateEvents(ctx); err != nil {
			return err
		}
		return tx.backfillSessionStateKeys(ctx)
	})
}

// sessionStateKeyRevision counts the changes to store.SessionStateKey
// that give a key to events stored without one. Revision 2 keys the
// context's size, compactions and each turn's usage. Tool frames need no
// revision: a binary before them does not keep their metadata at all.
const sessionStateKeyRevision = 2

// rekeySessionStateEvents computes again, once per revision, the keys of
// the stored events the newer rules may key: those that carry usage. A
// binary of an older revision writes no such keys; after a downgrade its
// events keep none.
func (s *Store) rekeySessionStateEvents(ctx context.Context) error {
	if _, err := s.conn().ExecContext(ctx, `CREATE TABLE IF NOT EXISTS session_state_key_revision (
		id INTEGER PRIMARY KEY CHECK (id = 1),
		revision INTEGER NOT NULL
	)`); err != nil {
		return fmt.Errorf("create session state key revision: %w", err)
	}
	var revision int
	if err := s.conn().QueryRowContext(ctx, `SELECT COALESCE(MAX(revision), 0) FROM session_state_key_revision`).Scan(&revision); err != nil {
		return fmt.Errorf("read session state key revision: %w", err)
	}
	if revision >= sessionStateKeyRevision {
		return nil
	}
	if _, err := s.conn().ExecContext(ctx, `UPDATE agent_session_events SET state_key = NULL
		WHERE state_key = '' AND (payload_json LIKE '%"turnUsage"%' OR payload_json LIKE '%"requestUsage"%' OR payload_json LIKE '%"contextUsage"%')`); err != nil {
		return fmt.Errorf("rekey session state events: %w", err)
	}
	if _, err := s.conn().ExecContext(ctx, `INSERT INTO session_state_key_revision (id, revision) VALUES (1, ?)
		ON CONFLICT (id) DO UPDATE SET revision = excluded.revision`, sessionStateKeyRevision); err != nil {
		return fmt.Errorf("record session state key revision: %w", err)
	}
	return nil
}

// backfillSessionStateKeys computes the keys of the events that have none
// yet. An event whose payload does not decode gets "" (no key): it is
// logged, and does not stop the server from starting.
func (s *Store) backfillSessionStateKeys(ctx context.Context) error {
	type keyed struct {
		rowID int64
		key   string
	}
	var keys []keyed
	unreadable := 0
	if err := scanRows(ctx, s.conn(), `SELECT rowid, payload_json FROM agent_session_events WHERE state_key IS NULL`, func(rows *sql.Rows) error {
		var rowID int64
		var payload []byte
		if err := rows.Scan(&rowID, &payload); err != nil {
			return err
		}
		var event store.AgentSessionEvent
		if err := json.Unmarshal(payload, &event); err != nil {
			unreadable++
			keys = append(keys, keyed{rowID, ""})
			return nil
		}
		keys = append(keys, keyed{rowID, store.SessionStateKey(event)})
		return nil
	}); err != nil {
		return fmt.Errorf("read events for their state keys: %w", err)
	}
	if unreadable > 0 {
		log.Printf("session state keys: %d stored events do not decode; they have none", unreadable)
	}
	for _, row := range keys {
		if _, err := s.conn().ExecContext(ctx, `UPDATE agent_session_events SET state_key = ? WHERE rowid = ?`, row.key, row.rowID); err != nil {
			return fmt.Errorf("backfill event state key: %w", err)
		}
	}
	return nil
}

// sessionStateKeysQuery lists a session's state keys, before a cursor when
// paged, from the partial state index alone: it covers every column read.
func sessionStateKeysQuery(paged bool) string {
	query := `SELECT rowid, created_at, state_key FROM agent_session_events WHERE session_id = ? AND state_key <> ''`
	if paged {
		query += ` AND (created_at < ? OR (created_at = ? AND rowid < ?))`
	}
	return query
}

// stateEventPayloadsAtOnce bounds the rowids one payload read names.
const stateEventPayloadsAtOnce = 500

// AgentSessionStateEvents implements store.SessionStateStore. The keys come
// from the state index; only the chosen events' payloads are read.
func (s *Store) AgentSessionStateEvents(ctx context.Context, sessionID string, before string) ([]store.AgentSessionEvent, error) {
	args := []any{sessionID}
	if before != "" {
		createdAt, rowID, err := decodeEventsCursor(before)
		if err != nil {
			return nil, err
		}
		args = append(args, createdAt, createdAt, rowID)
	}
	type stateRow struct {
		rowID     int64
		createdAt string
	}
	// Events are ordered as the transcript orders them: by created_at, then
	// by rowid.
	newer := func(left, right stateRow) bool {
		return left.createdAt > right.createdAt || (left.createdAt == right.createdAt && left.rowID > right.rowID)
	}
	chosen := map[string]stateRow{}
	if err := scanRows(ctx, s.reader(), sessionStateKeysQuery(before != ""), func(rows *sql.Rows) error {
		var row stateRow
		var key string
		if err := rows.Scan(&row.rowID, &row.createdAt, &key); err != nil {
			return err
		}
		held, seen := chosen[key]
		switch {
		case !seen,
			store.SessionStateLatest(key) && newer(row, held),
			!store.SessionStateLatest(key) && newer(held, row):
			chosen[key] = row
		}
		return nil
	}, args...); err != nil {
		return nil, err
	}
	rowIDs := make([]any, 0, len(chosen))
	for key, row := range chosen {
		// Background commands report progress and ends as subagents do;
		// a task counts only under its subagent's start.
		if taskID, ok := strings.CutPrefix(key, store.SessionStateTask); ok {
			if _, subagent := chosen[store.SessionStateSubagent+taskID]; !subagent {
				continue
			}
		}
		rowIDs = append(rowIDs, row.rowID)
	}
	type eventRow struct {
		stateRow
		payload []byte
	}
	page := make([]eventRow, 0, len(rowIDs))
	for start := 0; start < len(rowIDs); start += stateEventPayloadsAtOnce {
		batch := rowIDs[start:min(start+stateEventPayloadsAtOnce, len(rowIDs))]
		query := `SELECT rowid, created_at, payload_json FROM agent_session_events WHERE rowid IN (?` + strings.Repeat(", ?", len(batch)-1) + `)`
		if err := scanRows(ctx, s.reader(), query, func(rows *sql.Rows) error {
			var row eventRow
			if err := rows.Scan(&row.rowID, &row.createdAt, &row.payload); err != nil {
				return err
			}
			page = append(page, row)
			return nil
		}, batch...); err != nil {
			return nil, err
		}
	}
	slices.SortFunc(page, func(left, right eventRow) int {
		switch {
		case newer(right.stateRow, left.stateRow):
			return -1
		case newer(left.stateRow, right.stateRow):
			return 1
		}
		return 0
	})
	events := make([]store.AgentSessionEvent, len(page))
	for index, row := range page {
		if err := json.Unmarshal(row.payload, &events[index]); err != nil {
			return nil, err
		}
	}
	return events, nil
}

// AgentSessionFrames implements store.SessionFrameStore: the frames of the
// session's events, found through the state index, oldest first.
func (s *Store) AgentSessionFrames(ctx context.Context, sessionID string) ([]store.SessionToolFrame, error) {
	frames := []store.SessionToolFrame{}
	err := scanRows(ctx, s.reader(), `SELECT payload_json FROM agent_session_events
		WHERE session_id = ? AND state_key <> '' AND state_key = ? ORDER BY created_at ASC, rowid ASC`, func(rows *sql.Rows) error {
		var payload []byte
		if err := rows.Scan(&payload); err != nil {
			return err
		}
		var event store.AgentSessionEvent
		if err := json.Unmarshal(payload, &event); err != nil || event.Metadata == nil || event.Metadata.ToolFrame == nil {
			return nil
		}
		frames = append(frames, *event.Metadata.ToolFrame)
		return nil
	}, sessionID, store.SessionStateFrame)
	return frames, err
}
