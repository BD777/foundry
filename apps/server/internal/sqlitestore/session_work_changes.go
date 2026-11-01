package sqlitestore

import (
	"cmp"
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"slices"
	"strconv"
	"strings"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// setupSessionWorkChanges numbers every write and delete of session work
// with one database-wide change sequence, so a device reads only what
// changed since its cursor instead of every item it ever reported (DEV-085).
// Triggers assign the number: the generic workspace deletion and prune
// write without knowing about it.
func (s *Store) setupSessionWorkChanges(ctx context.Context) error {
	return s.withTx(ctx, func(tx *Store) error {
		epoch := make([]byte, 8)
		rand.Read(epoch) // never fails since Go 1.24
		for _, statement := range []string{
			`CREATE TABLE IF NOT EXISTS session_work_clock (id INTEGER PRIMARY KEY CHECK (id = 1), seq INTEGER NOT NULL, epoch TEXT NOT NULL)`,
			`INSERT OR IGNORE INTO session_work_clock(id, seq, epoch) VALUES (1, (SELECT COALESCE(MAX(change_seq), 0) FROM session_work), '` + hex.EncodeToString(epoch) + `')`,
			`CREATE TABLE IF NOT EXISTS session_work_removed (id TEXT PRIMARY KEY, device_id TEXT NOT NULL, change_seq INTEGER NOT NULL)`,
			`CREATE INDEX IF NOT EXISTS session_work_removed_device_seq ON session_work_removed(device_id, change_seq)`,
			`CREATE INDEX IF NOT EXISTS session_work_device_seq ON session_work(device_id, change_seq)`,
			`CREATE INDEX IF NOT EXISTS session_work_settle ON session_work(device_id) WHERE ` + sessionWorkSettleSQL,
			`CREATE TRIGGER IF NOT EXISTS session_work_inserted AFTER INSERT ON session_work BEGIN
			 UPDATE session_work_clock SET seq = seq + 1 WHERE id = 1;
			 UPDATE session_work SET change_seq = (SELECT seq FROM session_work_clock WHERE id = 1) WHERE rowid = NEW.rowid;
			END`,
			`CREATE TRIGGER IF NOT EXISTS session_work_updated AFTER UPDATE OF payload_json, device_id ON session_work BEGIN
			 UPDATE session_work_clock SET seq = seq + 1 WHERE id = 1;
			 UPDATE session_work SET change_seq = (SELECT seq FROM session_work_clock WHERE id = 1) WHERE rowid = NEW.rowid;
			END`,
			`CREATE TRIGGER IF NOT EXISTS session_work_deleted AFTER DELETE ON session_work BEGIN
			 UPDATE session_work_clock SET seq = seq + 1 WHERE id = 1;
			 INSERT INTO session_work_removed(id, device_id, change_seq) VALUES (OLD.id, OLD.device_id, (SELECT seq FROM session_work_clock WHERE id = 1))
			  ON CONFLICT(id) DO UPDATE SET device_id = excluded.device_id, change_seq = excluded.change_seq;
			END`,
		} {
			if _, err := tx.conn().ExecContext(ctx, statement); err != nil {
				return fmt.Errorf("session work changes: %w", err)
			}
		}
		return nil
	})
}

// sessionWorkSettleSQL selects the payloads that may name a scheduled run or
// a Foundry child session. It must match the session_work_settle index text.
const sessionWorkSettleSQL = `(instr(payload_json,'"runId":')>0 OR instr(payload_json,'"source":"foundry"')>0)`

func (s *Store) DeviceSessionWorkToSettle(ctx context.Context, deviceID string) ([]store.SessionWork, error) {
	items, err := listJSON[store.SessionWork](ctx, s.reader(), `SELECT payload_json FROM session_work WHERE device_id = ? AND `+sessionWorkSettleSQL+` ORDER BY id`, deviceID)
	if err != nil {
		return nil, err
	}
	return slices.DeleteFunc(items, func(item store.SessionWork) bool {
		if item.Kind == "schedule" {
			return item.Observation.RunID == ""
		}
		if item.Source != "foundry" || item.Kind != "agent" {
			return true
		}
		// A confirmed end is final unless someone asks it to stop.
		return confirmedWorkEnded(item) && item.DesiredState != "stopped" && item.DesiredState != "removed"
	}), nil
}

// workCursor is "<epoch>.<seq>"; the epoch is the database's, so a cursor
// from another database, or a copy restored behind it, reads from the start.
func parseWorkCursor(cursor, epoch string, current int64) int64 {
	prefix, seq, ok := strings.Cut(cursor, ".")
	if !ok || prefix != epoch {
		return 0
	}
	n, err := strconv.ParseInt(seq, 10, 64)
	if err != nil || n < 0 || n > current {
		return 0
	}
	return n
}

func (s *Store) DeviceSessionWorkChanges(ctx context.Context, deviceID, cursor string, limit int) (store.SessionWorkList, error) {
	result := store.SessionWorkList{Items: []store.SessionWork{}, Operations: []store.WorkOperation{}, Coverage: map[string]string{"hostSchedules": "not_observed", "processes": "not_observed"}}
	type change struct {
		seq     int64
		removed string
		item    store.SessionWork
	}
	var changes []change
	// One read transaction: an item and its later deletion are never both
	// reported, and the cursor names exactly what this read saw.
	err := s.readSnapshot(ctx, func(db dbExecutor) error {
		var current int64
		var epoch string
		if err := db.QueryRowContext(ctx, `SELECT seq, epoch FROM session_work_clock WHERE id = 1`).Scan(&current, &epoch); err != nil {
			return err
		}
		since := parseWorkCursor(cursor, epoch, current)
		err := scanRows(ctx, db, `SELECT change_seq, payload_json FROM session_work WHERE device_id = ? AND change_seq > ? ORDER BY change_seq LIMIT ?`, func(rows *sql.Rows) error {
			var c change
			var raw string
			if err := rows.Scan(&c.seq, &raw); err != nil {
				return err
			}
			if err := json.Unmarshal([]byte(raw), &c.item); err != nil {
				return err
			}
			changes = append(changes, c)
			return nil
		}, deviceID, since, limit)
		if err != nil {
			return err
		}
		items := len(changes)
		err = scanRows(ctx, db, `SELECT change_seq, id FROM session_work_removed r WHERE device_id = ? AND change_seq > ? AND NOT EXISTS (SELECT 1 FROM session_work w WHERE w.id = r.id) ORDER BY change_seq LIMIT ?`, func(rows *sql.Rows) error {
			var c change
			if err := rows.Scan(&c.seq, &c.removed); err != nil {
				return err
			}
			changes = append(changes, c)
			return nil
		}, deviceID, since, limit)
		if err != nil {
			return err
		}
		next := current
		result.More = items == limit || len(changes)-items == limit
		if result.More {
			slices.SortFunc(changes, func(a, b change) int { return cmp.Compare(a.seq, b.seq) })
			changes = changes[:min(len(changes), limit)]
			next = changes[len(changes)-1].seq
		}
		result.Cursor = epoch + "." + strconv.FormatInt(next, 10)
		var coverageRaw string
		if err := db.QueryRowContext(ctx, `SELECT payload_json FROM session_work_coverage WHERE device_id=?`, deviceID).Scan(&coverageRaw); err == nil {
			_ = json.Unmarshal([]byte(coverageRaw), &result.Coverage)
		}
		return deviceWorkControls(ctx, db, deviceID, &result)
	})
	if err != nil {
		return result, err
	}
	for _, c := range changes {
		if c.removed != "" {
			result.RemovedIDs = append(result.RemovedIDs, c.removed)
			continue
		}
		// Repair legacy exit evidence as the full list does.
		if candidate := c.item; confirmNativeWorkHistory(&candidate, c.item) {
			saved, saveErr := s.SaveSessionWork(ctx, c.item)
			if saveErr != nil {
				return result, saveErr
			}
			c.item = saved
		}
		result.Items = append(result.Items, c.item)
	}
	return result, nil
}

// deviceWorkControls reads what a device's reconciler needs besides its
// items: the latest control sequence, the threads with controls, and the
// stopped threads.
func deviceWorkControls(ctx context.Context, db dbExecutor, deviceID string, result *store.SessionWorkList) error {
	_ = db.QueryRowContext(ctx, `SELECT COALESCE(MAX(rowid),0) FROM session_work_operations WHERE thread_id IN (SELECT id FROM agent_sessions WHERE device_id=?)`, deviceID).Scan(&result.SweepRevision)
	_ = scanRows(ctx, db, `SELECT DISTINCT thread_id FROM session_work_operations WHERE thread_id IN (SELECT id FROM agent_sessions WHERE device_id=?)`, func(rows *sql.Rows) error {
		var id string
		if err := rows.Scan(&id); err != nil {
			return err
		}
		result.ScopeIDs = append(result.ScopeIDs, id)
		return nil
	}, deviceID)
	return scanRows(ctx, db, `SELECT thread_id FROM session_work_scopes WHERE stopped=1 AND thread_id IN (SELECT id FROM agent_sessions WHERE device_id=?)`, func(rows *sql.Rows) error {
		var id string
		if err := rows.Scan(&id); err != nil {
			return err
		}
		result.StoppedThreads = append(result.StoppedThreads, id)
		return nil
	}, deviceID)
}
