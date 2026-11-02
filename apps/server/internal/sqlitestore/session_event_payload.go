package sqlitestore

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// A stored event's payload leaves out what its row already holds: id,
// sessionId and level are the row's columns, at is created_at unless the
// two differ, and detail is message.text (or "" without a message) unless
// it is something else. The key's absence is what says so: detail has no
// omitempty, so a payload that holds "detail" holds the event's own.
// Every read decodes through decodeSessionEvent, which puts them back, so
// what readers get is the event as it was written.

// storedSessionEvent is the payload's shape. Its fields shadow the
// embedded event's (encoding/json prefers the shallower field), so a nil
// one is left out when encoding and tells a decoder the key was absent.
type storedSessionEvent struct {
	store.AgentSessionEvent
	ID        *string `json:"id,omitempty"`
	SessionID *string `json:"sessionId,omitempty"`
	At        *string `json:"at,omitempty"`
	Detail    *string `json:"detail,omitempty"`
	Level     *string `json:"level,omitempty"`
}

// sessionEventDetailDefault is the detail a payload without one stands for.
func sessionEventDetailDefault(event store.AgentSessionEvent) string {
	if event.Message != nil {
		return event.Message.Text
	}
	return ""
}

// encodeSessionEvent is the payload stored for event in a row whose
// id, session_id and level are the event's and whose created_at is
// createdAt.
func encodeSessionEvent(event store.AgentSessionEvent, createdAt string) (string, error) {
	stored := storedSessionEvent{AgentSessionEvent: event}
	if event.At != createdAt {
		stored.At = &event.At
	}
	if event.Detail != sessionEventDetailDefault(event) {
		stored.Detail = &event.Detail
	}
	return encode(stored)
}

// sessionEventColumns are the columns decodeSessionEvent reads, in its
// argument order.
const sessionEventColumns = `id, session_id, level, created_at, payload_json`

// sessionEventRow is a stored event as read: its columns and payload.
type sessionEventRow struct {
	id, sessionID, level, createdAt string
	payload                         []byte
}

// scanSessionEventRow scans the sessionEventColumns of rows, after any
// leading destinations.
func scanSessionEventRow(rows interface{ Scan(...any) error }, row *sessionEventRow, leading ...any) error {
	return rows.Scan(append(leading, &row.id, &row.sessionID, &row.level, &row.createdAt, &row.payload)...)
}

func (row sessionEventRow) decode() (store.AgentSessionEvent, error) {
	return decodeSessionEvent(row.id, row.sessionID, row.level, row.createdAt, row.payload)
}

// decodeSessionEvent is the event a row stores: its payload, with what the
// payload leaves out taken from the row's columns.
func decodeSessionEvent(id, sessionID, level, createdAt string, payload []byte) (store.AgentSessionEvent, error) {
	var stored storedSessionEvent
	if err := json.Unmarshal(payload, &stored); err != nil {
		return store.AgentSessionEvent{}, fmt.Errorf("decode session event %s: %w", id, err)
	}
	event := stored.AgentSessionEvent
	event.ID = valueOr(stored.ID, id)
	event.SessionID = valueOr(stored.SessionID, sessionID)
	event.Level = valueOr(stored.Level, level)
	event.At = valueOr(stored.At, createdAt)
	event.Detail = valueOr(stored.Detail, sessionEventDetailDefault(event))
	return event, nil
}

func valueOr(value *string, fallback string) string {
	if value != nil {
		return *value
	}
	return fallback
}

// listSessionEventRows runs a query of sessionEventColumns.
func listSessionEventRows(ctx context.Context, db dbExecutor, query string, args ...any) ([]sessionEventRow, error) {
	var rows []sessionEventRow
	err := scanRows(ctx, db, query, func(result *sql.Rows) error {
		var row sessionEventRow
		if err := scanSessionEventRow(result, &row); err != nil {
			return err
		}
		rows = append(rows, row)
		return nil
	}, args...)
	return rows, err
}

// listSessionEvents runs a query of sessionEventColumns and decodes each
// row once the statement is closed (see listJSON).
func listSessionEvents(ctx context.Context, db dbExecutor, query string, args ...any) ([]store.AgentSessionEvent, error) {
	rows, err := listSessionEventRows(ctx, db, query, args...)
	if err != nil {
		return nil, err
	}
	events := make([]store.AgentSessionEvent, len(rows))
	for index, row := range rows {
		if events[index], err = row.decode(); err != nil {
			return nil, err
		}
		rows[index].payload = nil
	}
	return events, nil
}

// getSessionEvent is the one event a query of sessionEventColumns finds;
// store.ErrNotFound without one.
func getSessionEvent(ctx context.Context, db dbExecutor, query string, args ...any) (store.AgentSessionEvent, error) {
	var row sessionEventRow
	if err := scanSessionEventRow(db.QueryRowContext(ctx, query, args...), &row); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return store.AgentSessionEvent{}, store.ErrNotFound
		}
		return store.AgentSessionEvent{}, err
	}
	return row.decode()
}
