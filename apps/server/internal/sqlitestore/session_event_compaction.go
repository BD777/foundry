package sqlitestore

import (
	"cmp"
	"context"
	"database/sql"
	"errors"
	"fmt"
	"slices"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// Event compaction (docs/refactor/storage-compression.md) removes what a
// session's transcript stores more than once, without changing what any
// reader shows:
//
//   - every payload is stored slim (session_event_payload.go);
//   - a step's in-progress snapshot goes once its later snapshot shows in
//     its place (R3);
//   - a model request's usage report goes once the steps it reaches carry
//     its tokens, and a context report once a newer one says the same for
//     the side panel (R4);
//   - of the background task snapshots only the newest, and the newest that
//     lists any task, stay (R4).
//
// The rules (session_event_compaction_plan.go) follow the web's transcript
// projection (apps/web/src/features/chat/thread/transcript-adapters.ts,
// transcript-projection.ts, components/conversation/chat-process-display.ts)
// and its side panel (features/chat/context/chat-context-model.ts): a row
// goes only where those read the same with and without it. Anything the
// rules do not recognise stays.
//
// Compaction only touches idle sessions, quiet for sessionCompactionQuiet,
// from the event after the last one it compacted
// (agent_session_event_compactions), so a reader catching up from its
// newest event keeps its place; one catching up from a row it removed is
// told to read the newest window again (ErrEventsCursorGone).

// sessionCompactionQuiet is how long a session stays idle, with no new
// event, before its events are compacted.
const sessionCompactionQuiet = 2 * time.Minute

// sessionCompactionReadChunk bounds the events one read of a session takes.
const sessionCompactionReadChunk = 1000

func (s *Store) setupSessionEventCompaction(ctx context.Context) error {
	_, err := s.conn().ExecContext(ctx, `CREATE TABLE IF NOT EXISTS agent_session_event_compactions (
		session_id TEXT PRIMARY KEY,
		through_created_at TEXT NOT NULL,
		through_rowid INTEGER NOT NULL,
		compacted_at TEXT NOT NULL
	)`)
	if err != nil {
		return fmt.Errorf("migrate session event compactions: %w", err)
	}
	return nil
}

var _ store.SessionEventCompactionStore = (*Store)(nil)

// CompactSessionEvents implements store.SessionEventCompactionStore: the
// sessions idle and quiet since now-sessionCompactionQuiet, oldest first,
// a turn per transaction, until maxSessions are done or ctx ends.
func (s *Store) CompactSessionEvents(ctx context.Context, now time.Time, maxSessions int) (store.SessionEventCompaction, error) {
	var report store.SessionEventCompaction
	quietSince := formatTime(now.Add(-sessionCompactionQuiet))
	var ids []string
	err := scanRows(ctx, s.reader(), `SELECT s.id FROM agent_sessions AS s
		LEFT JOIN agent_session_event_compactions AS c ON c.session_id = s.id
		WHERE s.status NOT IN ('queued', 'running', 'blocked') AND s.updated_at < ?1
			AND (SELECT MAX(created_at) FROM agent_session_events WHERE session_id = s.id) < ?1
			AND EXISTS (SELECT 1 FROM agent_session_events AS e WHERE e.session_id = s.id
				AND (c.session_id IS NULL OR e.created_at > c.through_created_at
					OR (e.created_at = c.through_created_at AND e.rowid > c.through_rowid)))
		ORDER BY s.updated_at, s.id`, func(rows *sql.Rows) error {
		var id string
		if err := rows.Scan(&id); err != nil {
			return err
		}
		ids = append(ids, id)
		return nil
	}, quietSince)
	if err != nil {
		return report, fmt.Errorf("find sessions to compact: %w", err)
	}
	for index, id := range ids {
		if ctx.Err() != nil || (maxSessions > 0 && index >= maxSessions) {
			report.Remaining = len(ids) - index
			return report, ctx.Err()
		}
		done, err := s.compactSession(ctx, id, quietSince, &report)
		if errors.Is(err, errCompactionConflict) {
			report.Conflicts++
			continue
		}
		if err != nil {
			return report, fmt.Errorf("compact events of session %s: %w", id, err)
		}
		if done {
			report.Sessions++
		}
	}
	return report, nil
}

// errCompactionConflict says a session changed while it was compacted; it
// is compacted again later.
var errCompactionConflict = errors.New("session events changed while compacting")

// compactionRow is one stored event being compacted.
type compactionRow struct {
	rowID int64
	sessionEventRow
	at      time.Time
	event   store.AgentSessionEvent
	removed bool
	changed bool
}

// compactSession compacts the session's events after its watermark that
// were written before quietSince, a turn (an input's events) at a time.
// It reports false when the session got a newer event meanwhile.
func (s *Store) compactSession(ctx context.Context, sessionID, quietSince string, report *store.SessionEventCompaction) (bool, error) {
	var throughAt string
	var throughRowID int64
	err := s.reader().QueryRowContext(ctx, `SELECT through_created_at, through_rowid FROM agent_session_event_compactions WHERE session_id = ?`, sessionID).Scan(&throughAt, &throughRowID)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return false, err
	}
	var turn []*compactionRow
	for {
		chunk, err := s.readCompactionRows(ctx, sessionID, throughAt, throughRowID)
		if err != nil {
			return false, err
		}
		for _, row := range chunk {
			if row.createdAt >= quietSince {
				// Written since the session went quiet: a turn runs again.
				return false, nil
			}
			if sessionInputEvent(row.event) && len(turn) > 0 {
				if err := s.compactTurn(ctx, sessionID, turn, report); err != nil {
					return false, err
				}
				turn = turn[:0]
			}
			turn = append(turn, row)
		}
		if len(chunk) < sessionCompactionReadChunk {
			break
		}
		last := chunk[len(chunk)-1]
		throughAt, throughRowID = last.createdAt, last.rowID
	}
	if len(turn) > 0 {
		if err := s.compactTurn(ctx, sessionID, turn, report); err != nil {
			return false, err
		}
	}
	removed, err := s.compactBackgroundSnapshots(ctx, sessionID)
	if err != nil {
		return false, err
	}
	report.Removed += removed
	return true, nil
}

// readCompactionRows reads the next chunk of the session's events after
// (afterAt, afterRowID), in stored order.
func (s *Store) readCompactionRows(ctx context.Context, sessionID, afterAt string, afterRowID int64) ([]*compactionRow, error) {
	var rows []*compactionRow
	err := scanRows(ctx, s.reader(), `SELECT rowid, `+sessionEventColumns+` FROM agent_session_events
		WHERE session_id = ? AND (created_at > ? OR (created_at = ? AND rowid > ?))
		ORDER BY created_at, rowid LIMIT ?`, func(result *sql.Rows) error {
		row := &compactionRow{}
		if err := scanSessionEventRow(result, &row.sessionEventRow, &row.rowID); err != nil {
			return err
		}
		rows = append(rows, row)
		return nil
	}, sessionID, afterAt, afterAt, afterRowID, sessionCompactionReadChunk)
	if err != nil {
		return nil, err
	}
	for _, row := range rows {
		var err error
		if row.event, err = row.decode(); err != nil {
			return nil, err
		}
		if row.at, err = time.Parse(time.RFC3339Nano, row.createdAt); err != nil {
			return nil, fmt.Errorf("read event time %q: %w", row.createdAt, err)
		}
	}
	return rows, nil
}

// compactTurn plans and applies the compaction of one turn's events, in
// one transaction that first checks they are still what was read. Events
// before the session's first input (a turn without one) are only stored
// slim.
func (s *Store) compactTurn(ctx context.Context, sessionID string, turn []*compactionRow, report *store.SessionEventCompaction) error {
	// The transcript orders events by time, then rowid; stored order is
	// created_at's text, which differs within a second when a time ends in
	// zeros. A turn where the two differ is only stored slim.
	ordered := slices.IsSortedFunc(turn, func(a, b *compactionRow) int {
		if order := a.at.Compare(b.at); order != 0 {
			return order
		}
		return cmp.Compare(a.rowID, b.rowID)
	})
	if ordered && sessionInputEvent(turn[0].event) && entryMetadataOnly(turn[0].event.Metadata, true) {
		planTurnCompaction(turn)
	}
	type write struct {
		row     *compactionRow
		payload string
	}
	var writes []write
	for _, row := range turn {
		if row.removed {
			continue
		}
		payload, err := encodeSessionEvent(row.event, row.createdAt)
		if err != nil {
			return err
		}
		if payload != string(row.payload) {
			writes = append(writes, write{row, payload})
		}
	}
	last := turn[len(turn)-1]
	return s.withTx(ctx, func(tx *Store) error {
		// Nothing was written into the turn meanwhile.
		var count int
		if err := tx.conn().QueryRowContext(ctx, `SELECT COUNT(*) FROM agent_session_events
			WHERE session_id = ? AND (created_at > ? OR (created_at = ? AND rowid >= ?))
				AND (created_at < ? OR (created_at = ? AND rowid <= ?))`,
			sessionID, turn[0].createdAt, turn[0].createdAt, turn[0].rowID, last.createdAt, last.createdAt, last.rowID).Scan(&count); err != nil {
			return err
		}
		if count != len(turn) {
			return errCompactionConflict
		}
		for _, row := range turn {
			if !row.removed {
				continue
			}
			if err := expectOneRow(tx.conn().ExecContext(ctx, `DELETE FROM agent_session_events WHERE rowid = ? AND payload_json = ?`, row.rowID, string(row.payload))); err != nil {
				return err
			}
			report.Removed++
		}
		for _, item := range writes {
			if err := expectOneRow(tx.conn().ExecContext(ctx, `UPDATE agent_session_events SET payload_json = ? WHERE rowid = ? AND payload_json = ?`,
				item.payload, item.row.rowID, string(item.row.payload))); err != nil {
				return err
			}
			report.Rewritten++
		}
		_, err := tx.conn().ExecContext(ctx, `INSERT INTO agent_session_event_compactions (session_id, through_created_at, through_rowid, compacted_at)
			VALUES (?, ?, ?, ?) ON CONFLICT (session_id) DO UPDATE SET
				through_created_at = excluded.through_created_at, through_rowid = excluded.through_rowid,
				compacted_at = excluded.compacted_at`,
			sessionID, last.createdAt, last.rowID, formatTime(time.Now()))
		return err
	})
}

func expectOneRow(result sql.Result, err error) error {
	if err != nil {
		return err
	}
	changed, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if changed != 1 {
		return errCompactionConflict
	}
	return nil
}

// compactBackgroundSnapshots removes the session's background task
// snapshots but its newest one and the newest that lists any task: the
// panel and every server reader read only the newest, and the panel asks
// whether any snapshot listed a task. Snapshots carrying anything else
// stay.
func (s *Store) compactBackgroundSnapshots(ctx context.Context, sessionID string) (int, error) {
	type snapshot struct {
		rowID   int64
		payload []byte
		event   store.AgentSessionEvent
	}
	var snapshots []snapshot
	err := scanRows(ctx, s.reader(), `SELECT rowid, `+sessionEventColumns+` FROM agent_session_events
		WHERE session_id = ? AND state_key <> '' AND state_key = ? ORDER BY created_at, rowid`, func(rows *sql.Rows) error {
		var item snapshot
		var row sessionEventRow
		if err := scanSessionEventRow(rows, &row, &item.rowID); err != nil {
			return err
		}
		var err error
		if item.event, err = row.decode(); err != nil {
			return err
		}
		item.payload = row.payload
		snapshots = append(snapshots, item)
		return nil
	}, sessionID, sessionStateBackgroundKey)
	if err != nil || len(snapshots) < 2 {
		return 0, err
	}
	// The session's first event stays: a transcript without the session's
	// start time counts its duration from it.
	var firstRowID int64
	if err := s.reader().QueryRowContext(ctx, `SELECT rowid FROM agent_session_events WHERE session_id = ? ORDER BY created_at, rowid LIMIT 1`, sessionID).Scan(&firstRowID); err != nil {
		return 0, err
	}
	keep := map[int]bool{len(snapshots) - 1: true}
	for index, item := range snapshots {
		if item.rowID == firstRowID {
			keep[index] = true
		}
	}
	for index := len(snapshots) - 1; index >= 0; index-- {
		if tasks := snapshots[index].event.Metadata.BackgroundTaskSnapshot; tasks != nil && len(*tasks) > 0 {
			keep[index] = true
			break
		}
	}
	removed := 0
	err = s.withTx(ctx, func(tx *Store) error {
		for index, item := range snapshots {
			if keep[index] || !backgroundSnapshotOnly(item.event) {
				continue
			}
			result, err := tx.conn().ExecContext(ctx, `DELETE FROM agent_session_events WHERE rowid = ? AND payload_json = ?`, item.rowID, string(item.payload))
			if err != nil {
				return err
			}
			if changed, _ := result.RowsAffected(); changed == 1 {
				removed++
			}
		}
		return nil
	})
	return removed, err
}

// sessionStateBackgroundKey is the state key of background task snapshots.
var sessionStateBackgroundKey = store.SessionStateKey(store.AgentSessionEvent{
	Metadata: &store.AgentSessionEventMetadata{BackgroundTaskSnapshot: &[]store.AgentBackgroundTask{}},
})
