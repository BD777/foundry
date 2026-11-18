package sqlitestore

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"
)

// timeEdgeRowID returns the rowid of the row among those matching where whose
// time in column is the latest (newest) or the earliest, ties going to the
// higher (or lower) rowid. Text order finds the edge second, which is exact:
// the second prefix sorts by time. Only that second's rows are compared by
// parsed time, because within a second text does not (see timeLayout for
// the fixed-width rows, and the trimmed rows written before it).
func timeEdgeRowID(ctx context.Context, db dbExecutor, table, column, where string, args []any, newest bool) (int64, bool, error) {
	direction, bound := "ASC", column+" < ?"
	if newest {
		direction, bound = "DESC", column+" >= ?"
	}
	var edge string
	err := db.QueryRowContext(ctx, `SELECT `+column+` FROM `+table+` WHERE (`+where+`) ORDER BY `+column+` `+direction+` LIMIT 1`, args...).Scan(&edge)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, false, nil
	}
	if err != nil {
		return 0, false, fmt.Errorf("find edge of %s.%s: %w", table, column, err)
	}
	if len(edge) < len(secondPrefixLayout) {
		return 0, false, fmt.Errorf("invalid stored %s.%s time %q", table, column, edge)
	}
	// Newest: the edge is the last text, so every row of its second is at or
	// after the prefix. Oldest: the rows of its second are below prefix+"~".
	second := edge[:len(secondPrefixLayout)]
	boundArg := second
	if !newest {
		boundArg = second + "~"
	}
	queryArgs := append(append([]any{}, args...), boundArg)
	var rowID int64
	var at time.Time
	found := false
	err = scanRows(ctx, db, `SELECT rowid, `+column+` FROM `+table+` WHERE (`+where+`) AND `+bound+` ORDER BY rowid`, func(rows *sql.Rows) error {
		var id int64
		var stored string
		if err := rows.Scan(&id, &stored); err != nil {
			return err
		}
		parsed, err := time.Parse(time.RFC3339Nano, stored)
		if err != nil {
			return fmt.Errorf("read %s.%s time %q: %w", table, column, stored, err)
		}
		later := parsed.After(at) || (parsed.Equal(at) && id > rowID)
		earlier := parsed.Before(at) || (parsed.Equal(at) && id < rowID)
		if !found || (newest && later) || (!newest && earlier) {
			rowID, at, found = id, parsed, true
		}
		return nil
	}, queryArgs...)
	if err != nil {
		return 0, false, fmt.Errorf("compare %s.%s times: %w", table, column, err)
	}
	return rowID, found, nil
}
