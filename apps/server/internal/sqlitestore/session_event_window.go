package sqlitestore

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// AgentSessionEventWindow reads one page of a session's events, newest
// first through idx_agent_session_events_session_created, so a long chat
// costs a page rather than its whole history. Events are ordered as
// attachAgentSessionEvents orders them: by created_at, then by rowid,
// which is how that index breaks ties. The cursor names the oldest event
// returned by both keys.
func (s *Store) AgentSessionEventWindow(ctx context.Context, sessionID string, before string, limit int) ([]store.AgentSessionEvent, string, error) {
	if limit <= 0 {
		return nil, "", fmt.Errorf("events window limit must be positive, got %d", limit)
	}
	args := []any{sessionID}
	if before != "" {
		createdAt, rowID, err := decodeEventsCursor(before)
		if err != nil {
			return nil, "", err
		}
		args = append(args, createdAt, createdAt, rowID)
	}
	// One more than asked says whether anything is older.
	args = append(args, limit+1)
	type windowRow struct {
		rowID     int64
		createdAt string
		payload   []byte
	}
	page, err := func() ([]windowRow, error) {
		rows, err := s.reader().QueryContext(ctx, eventWindowQuery(before != ""), args...)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		page := make([]windowRow, 0, limit+1)
		for rows.Next() {
			var row windowRow
			if err := rows.Scan(&row.rowID, &row.createdAt, &row.payload); err != nil {
				return nil, err
			}
			page = append(page, row)
		}
		return page, rows.Err()
	}()
	if err != nil {
		return nil, "", err
	}
	// The statement is closed: decoding no longer holds its connection.
	older := ""
	if len(page) > limit {
		page = page[:limit]
		oldest := page[len(page)-1]
		older = encodeEventsCursor(oldest.createdAt, oldest.rowID)
	}
	events := make([]store.AgentSessionEvent, len(page))
	for index, row := range page {
		if err := json.Unmarshal(row.payload, &events[len(page)-1-index]); err != nil {
			return nil, "", err
		}
	}
	return events, older, nil
}

func eventWindowQuery(paged bool) string {
	query := `SELECT rowid, created_at, payload_json FROM agent_session_events WHERE session_id = ?`
	if paged {
		query += ` AND (created_at < ? OR (created_at = ? AND rowid < ?))`
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
