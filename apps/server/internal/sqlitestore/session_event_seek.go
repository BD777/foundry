package sqlitestore

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

var _ store.SessionEventSeekStore = (*Store)(nil)

// AgentSessionEventsThrough implements store.SessionEventSeekStore. The
// message's events are found by text first (instr), so only rows naming
// the id are parsed; the count is of every event from the message's second
// on (up to the cursor's), the same second-prefix bound the windows read
// by, so a window of that many reaches it whatever the order within a
// second.
func (s *Store) AgentSessionEventsThrough(ctx context.Context, sessionID string, before string, id string) (int, bool, error) {
	if id == "" {
		return 0, false, nil
	}
	var cursorAt time.Time
	var cursorRowID int64
	upper := ""
	if before != "" {
		createdAt, rowID, err := decodeEventsCursor(before)
		if err != nil {
			return 0, false, err
		}
		cursorAt, err = time.Parse(time.RFC3339Nano, createdAt)
		if err != nil || len(createdAt) < len(secondPrefixLayout) {
			return 0, false, store.ErrInvalidEventsCursor
		}
		cursorRowID = rowID
		upper = createdAt[:len(secondPrefixLayout)] + "~"
	}
	// The id as its payload text holds it (JSON-escaped, without quotes).
	encoded, err := json.Marshal(id)
	if err != nil {
		return 0, false, err
	}
	needle := strings.TrimSuffix(strings.TrimPrefix(string(encoded), `"`), `"`)
	var (
		found    bool
		oldestAt time.Time
		oldest   string
		oldestID int64
	)
	err = scanRows(ctx, s.reader(), eventsOfMessageQuery, func(rows *sql.Rows) error {
		var rowID int64
		var createdAt string
		if err := rows.Scan(&rowID, &createdAt); err != nil {
			return err
		}
		at, err := time.Parse(time.RFC3339Nano, createdAt)
		if err != nil {
			return fmt.Errorf("read event time %q: %w", createdAt, err)
		}
		if len(createdAt) < len(secondPrefixLayout) {
			return fmt.Errorf("invalid stored event time %q", createdAt)
		}
		if before != "" && (at.After(cursorAt) || (at.Equal(cursorAt) && rowID >= cursorRowID)) {
			return nil
		}
		if !found || at.Before(oldestAt) || (at.Equal(oldestAt) && rowID < oldestID) {
			found, oldestAt, oldest, oldestID = true, at, createdAt, rowID
		}
		return nil
	}, sessionID, id, needle, id)
	if err != nil || !found {
		return 0, false, err
	}
	query, args := eventsFromSecondQuery, []any{sessionID, oldest[:len(secondPrefixLayout)]}
	if upper != "" {
		query += ` AND created_at < ?`
		args = append(args, upper)
	}
	var count int
	if err := s.reader().QueryRowContext(ctx, query, args...).Scan(&count); err != nil {
		return 0, false, err
	}
	return count, true, nil
}

const eventsOfMessageQuery = `SELECT rowid, created_at FROM agent_session_events
	WHERE session_id = ? AND (id = ? OR (instr(payload_json, ?) > 0 AND json_extract(payload_json, '$.message.id') = ?))`

const eventsFromSecondQuery = `SELECT COUNT(*) FROM agent_session_events
	WHERE session_id = ? AND created_at >= ?`
