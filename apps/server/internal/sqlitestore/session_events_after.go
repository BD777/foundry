package sqlitestore

import (
	"cmp"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

var _ store.SessionEventCatchUpStore = (*Store)(nil)

// AgentSessionEventsAfter implements store.SessionEventCatchUpStore: the
// events stored after the cursor by time (then rowid), oldest first, read
// through idx_agent_session_events_session_created, so a reader that
// missed a few stream events reads those few.
func (s *Store) AgentSessionEventsAfter(ctx context.Context, sessionID string, after string, limit int) (events []store.AgentSessionEvent, newest string, more bool, err error) {
	if limit <= 0 {
		return nil, "", false, fmt.Errorf("events catch-up limit must be positive, got %d", limit)
	}
	createdAt, rowID, err := decodeEventsCursor(after)
	if err != nil {
		return nil, "", false, err
	}
	// A cursor of another session, or of an event since removed, places
	// the reader nowhere in this transcript.
	var named int
	err = s.reader().QueryRowContext(ctx, `SELECT 1 FROM agent_session_events WHERE rowid = ? AND session_id = ?`, rowID, sessionID).Scan(&named)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, "", false, store.ErrEventsCursorGone
	}
	if err != nil {
		return nil, "", false, err
	}
	cursorAt, err := time.Parse(time.RFC3339Nano, createdAt)
	if err != nil || len(createdAt) < len(secondPrefixLayout) {
		return nil, "", false, store.ErrInvalidEventsCursor
	}
	// created_at is RFC3339Nano text, which drops trailing zeros, so within
	// one second its text order is not time order ("…05Z" sorts after
	// "…05.1Z"); across seconds it is. Every event of the cursor's second
	// or later sorts at or after that second's prefix: rows are read from
	// there, and those of the cursor's second compared by time.
	second := createdAt[:len(secondPrefixLayout)]
	var sameSecond int
	if err := s.reader().QueryRowContext(ctx, eventsInSecondQuery, sessionID, second, second+"~").Scan(&sameSecond); err != nil {
		return nil, "", false, err
	}
	// One more than asked says the reader is too far behind to catch up.
	rows, err := s.readWindowRows(ctx, eventsAfterQuery, sameSecond+limit+1, sessionID, second, sameSecond+limit+1)
	if err != nil {
		return nil, "", false, err
	}
	type laterRow struct {
		windowRow
		at time.Time
	}
	page := make([]laterRow, 0, len(rows))
	for _, row := range rows {
		at, err := time.Parse(time.RFC3339Nano, row.createdAt)
		if err != nil {
			return nil, "", false, fmt.Errorf("read event time %q: %w", row.createdAt, err)
		}
		if at.Before(cursorAt) || (at.Equal(cursorAt) && row.rowID <= rowID) {
			continue
		}
		page = append(page, laterRow{windowRow: row, at: at})
	}
	if len(page) > limit {
		return nil, after, true, nil
	}
	slices.SortStableFunc(page, func(a, b laterRow) int {
		if order := a.at.Compare(b.at); order != 0 {
			return order
		}
		return cmp.Compare(a.rowID, b.rowID)
	})
	newest = after
	if len(page) > 0 {
		newest = page[len(page)-1].cursor()
	}
	events = make([]store.AgentSessionEvent, len(page))
	for index, row := range page {
		if err := json.Unmarshal(row.payload, &events[index]); err != nil {
			return nil, "", false, err
		}
	}
	return events, newest, false, nil
}

// secondPrefixLayout is the part of an RFC3339 time up to its seconds.
const secondPrefixLayout = "2006-01-02T15:04:05"

const eventsInSecondQuery = `SELECT COUNT(*) FROM agent_session_events
	WHERE session_id = ? AND created_at >= ? AND created_at < ?`

const eventsAfterQuery = `SELECT rowid, created_at, payload_json FROM agent_session_events
	WHERE session_id = ? AND created_at >= ?
	ORDER BY created_at ASC, rowid ASC LIMIT ?`
