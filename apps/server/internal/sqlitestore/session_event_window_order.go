package sqlitestore

import (
	"cmp"
	"context"
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// readChronologicalWindow uses the existing text index across seconds, then
// compares parsed times within the two boundary seconds. RFC3339Nano trims
// zeros: for example .12Z sorts after .123Z, and a whole second after both.
// Include both boundary seconds in full before applying the cursor and limit;
// sorting just the SQL page would still omit rows on the other side of it.
// This costs a page plus its boundary seconds, without rewriting old rows or
// sorting the session's entire history.
func (s *Store) readChronologicalWindow(ctx context.Context, sessionID, before string, limit int) ([]windowRow, error) {
	args := []any{sessionID}
	capacity := limit + 1
	var cursorAt time.Time
	var cursorRowID int64
	if before != "" {
		createdAt, rowID, err := decodeEventsCursor(before)
		if err != nil {
			return nil, err
		}
		cursorAt, err = time.Parse(time.RFC3339Nano, createdAt)
		if err != nil || len(createdAt) < len(secondPrefixLayout) {
			return nil, store.ErrInvalidEventsCursor
		}
		cursorRowID = rowID
		second := createdAt[:len(secondPrefixLayout)]
		var count int
		if err := s.reader().QueryRowContext(ctx, eventsInSecondQuery, sessionID, second, second+"~").Scan(&count); err != nil {
			return nil, err
		}
		capacity += count
		args = append(args, second+"~")
	}
	args = append(args, capacity)
	rows, err := s.readWindowRows(ctx, eventWindowQuery(before != ""), capacity, args...)
	if err != nil || len(rows) == 0 {
		return rows, err
	}
	last := rows[len(rows)-1].createdAt
	if len(last) < len(secondPrefixLayout) {
		return nil, fmt.Errorf("invalid stored event time %q", last)
	}
	second := last[:len(secondPrefixLayout)]
	boundary, err := s.readWindowRows(ctx, eventWindowBoundaryQuery, 0, sessionID, second, second+"~")
	if err != nil {
		return nil, err
	}
	// The index groups a second's rows together, so replace that suffix.
	firstBoundary := len(rows) - 1
	for firstBoundary > 0 && strings.HasPrefix(rows[firstBoundary-1].createdAt, second) {
		firstBoundary--
	}
	rows = append(rows[:firstBoundary], boundary...)
	type timedRow struct {
		row windowRow
		at  time.Time
	}
	parsed := make([]timedRow, 0, len(rows))
	for _, row := range rows {
		at, err := time.Parse(time.RFC3339Nano, row.createdAt)
		if err != nil {
			return nil, fmt.Errorf("read event time %q: %w", row.createdAt, err)
		}
		if before != "" && (at.After(cursorAt) || (at.Equal(cursorAt) && row.rowID >= cursorRowID)) {
			continue
		}
		parsed = append(parsed, timedRow{row, at})
	}
	slices.SortFunc(parsed, func(a, b timedRow) int {
		if order := b.at.Compare(a.at); order != 0 {
			return order
		}
		return cmp.Compare(b.row.rowID, a.row.rowID)
	})
	rows = make([]windowRow, min(len(parsed), limit+1))
	for i := range rows {
		rows[i] = parsed[i].row
	}
	return rows, nil
}

const eventWindowBoundaryQuery = `SELECT rowid, created_at, payload_json FROM agent_session_events
 WHERE session_id = ? AND created_at >= ? AND created_at < ? ORDER BY created_at DESC, rowid DESC`
