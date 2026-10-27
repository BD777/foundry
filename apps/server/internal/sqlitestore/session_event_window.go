package sqlitestore

import (
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// AgentSessionEventWindow reads one page of a session's events, newest
// first through idx_agent_session_events_session_created, so a long chat
// costs a page and its boundary seconds rather than its whole history.
// Parsed event times, then rowid, define the order. The cursor names the
// oldest returned event by its original stored timestamp and rowid.
func (s *Store) AgentSessionEventWindow(ctx context.Context, sessionID string, before string, limit int) ([]store.AgentSessionEvent, string, error) {
	events, older, _, err := s.AgentSessionEventWindowSpan(ctx, sessionID, before, limit)
	return events, older, err
}

// AgentSessionEventWindowSpan is AgentSessionEventWindow that also names
// the window's newest event ("" for an empty window): a reader holding the
// newest window catches up from it (AgentSessionEventsAfter).
func (s *Store) AgentSessionEventWindowSpan(ctx context.Context, sessionID string, before string, limit int) (events []store.AgentSessionEvent, older, newest string, err error) {
	if limit <= 0 {
		return nil, "", "", fmt.Errorf("events window limit must be positive, got %d", limit)
	}
	// Counting the cursor's second and reading the page must see one snapshot:
	// a concurrent append in that second cannot consume the page's headroom.
	var page []windowRow
	err = s.readSnapshot(ctx, func(db dbExecutor) error {
		snapshot := &Store{db: s.db, read: s.read, exec: db}
		page, err = snapshot.readChronologicalWindow(ctx, sessionID, before, limit)
		return err
	})
	if err != nil {
		return nil, "", "", err
	}
	if len(page) > limit {
		page = page[:limit]
		older = page[len(page)-1].cursor()
	}
	if len(page) > 0 {
		newest = page[0].cursor()
	}
	events = make([]store.AgentSessionEvent, len(page))
	for index, row := range page {
		if err := json.Unmarshal(row.payload, &events[len(page)-1-index]); err != nil {
			return nil, "", "", err
		}
	}
	return events, older, newest, nil
}

// windowRow is a stored event as the transcript reads read it: its order
// keys and its payload, decoded once the statement is closed so decoding
// no longer holds its connection.
type windowRow struct {
	rowID     int64
	createdAt string
	payload   []byte
}

func (row windowRow) cursor() string {
	return encodeEventsCursor(row.createdAt, row.rowID)
}

// readWindowRows runs a query of rowid, created_at and payload_json.
func (s *Store) readWindowRows(ctx context.Context, query string, capacity int, args ...any) ([]windowRow, error) {
	page := make([]windowRow, 0, capacity)
	err := scanRows(ctx, s.reader(), query, func(rows *sql.Rows) error {
		var row windowRow
		if err := rows.Scan(&row.rowID, &row.createdAt, &row.payload); err != nil {
			return err
		}
		page = append(page, row)
		return nil
	}, args...)
	return page, err
}

func eventWindowQuery(paged bool) string {
	query := `SELECT rowid, created_at, payload_json FROM agent_session_events WHERE session_id = ?`
	if paged {
		query += ` AND created_at < ?`
	}
	return query + ` ORDER BY created_at DESC, rowid DESC LIMIT ?`
}

// An events cursor is opaque to clients: base64url of "<rowid>:<created_at>".
func encodeEventsCursor(createdAt string, rowID int64) string {
	return base64.RawURLEncoding.EncodeToString([]byte(strconv.FormatInt(rowID, 10) + ":" + createdAt))
}

func decodeEventsCursor(cursor string) (string, int64, error) {
	raw, err := base64.RawURLEncoding.DecodeString(cursor)
	if err != nil {
		return "", 0, store.ErrInvalidEventsCursor
	}
	rowText, createdAt, found := strings.Cut(string(raw), ":")
	rowID, err := strconv.ParseInt(rowText, 10, 64)
	if !found || err != nil || rowID <= 0 || createdAt == "" {
		return "", 0, store.ErrInvalidEventsCursor
	}
	return createdAt, rowID, nil
}
