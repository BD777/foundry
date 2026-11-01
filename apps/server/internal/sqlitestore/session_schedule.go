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
