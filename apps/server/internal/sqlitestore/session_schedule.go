package sqlitestore

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// sessionSchedule reads the schedule a session keeps; nil when it has none.
func (s *Store) sessionSchedule(ctx context.Context, sessionID string) (*store.AgentSessionSchedule, error) {
	var raw sql.NullString
	err := s.conn().QueryRowContext(ctx, `SELECT json_extract(payload_json, '$.scheduled') FROM agent_sessions WHERE id = ?`, sessionID).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read session schedule: %w", err)
	}
	if !raw.Valid {
		return nil, nil
	}
	var schedule store.AgentSessionSchedule
	if err := json.Unmarshal([]byte(raw.String), &schedule); err != nil {
		return nil, nil
	}
	return &schedule, nil
}

// latestTimerSnapshotSQL is the payload of a session's newest timer
// snapshot event.
const latestTimerSnapshotSQL = `(SELECT e.payload_json FROM agent_session_events e
	WHERE e.session_id = agent_sessions.id AND e.state_key = 'timers'
	ORDER BY e.created_at DESC, e.rowid DESC LIMIT 1)`

// backfillSessionSchedules gives a session the schedule of its newest timer
// snapshot where it has none, or one whose timers do not say when they were
// first seen: snapshots stored before the server kept schedules (or kept
// when a timer was first seen). A session whose newest snapshot lists no
// timers (CronDelete) keeps none.
func (s *Store) backfillSessionSchedules(ctx context.Context) error {
	var sessionIDs []string
	if err := scanRows(ctx, s.conn(), `SELECT id FROM agent_sessions
		WHERE (json_extract(payload_json, '$.scheduled') IS NULL
			OR EXISTS (SELECT 1 FROM json_each(payload_json, '$.scheduled.timers') t
				WHERE json_extract(t.value, '$.firstSeenAt') IS NULL))
		AND COALESCE(json_array_length(json_extract(`+latestTimerSnapshotSQL+`, '$.metadata.timerSnapshot')), 0) > 0`,
		func(rows *sql.Rows) error {
			var id string
			if err := rows.Scan(&id); err != nil {
				return err
			}
			sessionIDs = append(sessionIDs, id)
			return nil
		}); err != nil {
		return fmt.Errorf("find sessions without a schedule: %w", err)
	}
	for _, sessionID := range sessionIDs {
		if err := s.backfillSessionSchedule(ctx, sessionID); err != nil {
			return err
		}
	}
	return nil
}

// backfillSessionSchedule derives the session's schedule from its timer
// snapshots in the order they arrived, as storing each one would have.
func (s *Store) backfillSessionSchedule(ctx context.Context, sessionID string) error {
	var schedule *store.AgentSessionSchedule
	if err := scanRows(ctx, s.conn(), `SELECT payload_json FROM agent_session_events
		WHERE session_id = ? AND state_key = 'timers' ORDER BY created_at ASC, rowid ASC`,
		func(rows *sql.Rows) error {
			var payload []byte
			if err := rows.Scan(&payload); err != nil {
				return err
			}
			var event store.AgentSessionEvent
			if json.Unmarshal(payload, &event) != nil || event.Metadata == nil || event.Metadata.TimerSnapshot == nil {
				return nil
			}
			schedule = store.SessionScheduleFromSnapshot(schedule, *event.Metadata.TimerSnapshot, event.At)
			return nil
		}, sessionID); err != nil {
		return fmt.Errorf("read timer snapshots of %s: %w", sessionID, err)
	}
	if schedule == nil {
		return nil
	}
	encoded, err := encode(schedule)
	if err != nil {
		return err
	}
	if _, err := s.conn().ExecContext(ctx, `UPDATE agent_sessions SET payload_json = json_set(payload_json, '$.scheduled', json(?)) WHERE id = ?`, encoded, sessionID); err != nil {
		return fmt.Errorf("backfill session schedule: %w", err)
	}
	return nil
}

// DeviceSessionTimers returns the timers the device's Claude chat sessions
// hold, with the prompts their newest snapshot reported.
func (s *Store) DeviceSessionTimers(ctx context.Context, deviceID string, now time.Time) ([]store.SessionTimers, error) {
	var result []store.SessionTimers
	err := scanRows(ctx, s.reader(), `SELECT id, COALESCE(json_extract(payload_json, '$.nativeSessionId'), ''),
			json_extract(payload_json, '$.scheduled'), COALESCE(`+latestTimerSnapshotSQL+`, '')
		FROM agent_sessions
		WHERE device_id = ? AND provider = 'claude' AND COALESCE(json_extract(payload_json, '$.role'), '') = ''
			AND json_extract(payload_json, '$.scheduled') IS NOT NULL AND `+visibleAgentSessionSQL+`
		ORDER BY created_at`,
		func(rows *sql.Rows) error {
			var sessionID, nativeSessionID, rawSchedule, rawSnapshot string
			if err := rows.Scan(&sessionID, &nativeSessionID, &rawSchedule, &rawSnapshot); err != nil {
				return err
			}
			var schedule store.AgentSessionSchedule
			var event store.AgentSessionEvent
			if json.Unmarshal([]byte(rawSchedule), &schedule) != nil || json.Unmarshal([]byte(rawSnapshot), &event) != nil ||
				event.Metadata == nil || event.Metadata.TimerSnapshot == nil {
				return nil
			}
			prompts := map[string]store.AgentScheduledTask{}
			for _, task := range *event.Metadata.TimerSnapshot {
				prompts[task.ID] = task
			}
			kept := store.SessionTimers{SessionID: sessionID, NativeSessionID: nativeSessionID}
			for _, timer := range schedule.Timers {
				task, ok := prompts[timer.ID]
				if !ok || task.Prompt == "" || timer.Expired(now) {
					continue
				}
				firstSeenAt := timer.FirstSeenAt
				if firstSeenAt == "" {
					firstSeenAt = schedule.ReportedAt
				}
				kept.Timers = append(kept.Timers, store.SessionKeptTimer{AgentScheduledTask: task, FirstSeenAt: firstSeenAt})
			}
			if len(kept.Timers) > 0 {
				result = append(result, kept)
			}
			return nil
		}, deviceID)
	if err != nil {
		return nil, fmt.Errorf("list device session timers: %w", err)
	}
	return result, nil
}
