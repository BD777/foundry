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

// backfillSessionStateKeys computes the keys of the events that have none
// yet. An event whose payload does not decode gets "" (no key) and is
// logged.
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
