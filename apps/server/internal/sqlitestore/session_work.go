package sqlitestore

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strconv"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func (s *Store) setupSessionWork(ctx context.Context) error {
	for _, statement := range []string{
		`CREATE TABLE IF NOT EXISTS session_work (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, session_id TEXT NOT NULL, device_id TEXT NOT NULL, payload_json TEXT NOT NULL)`,
		`CREATE INDEX IF NOT EXISTS session_work_thread ON session_work(thread_id)`,
		`CREATE INDEX IF NOT EXISTS session_work_device ON session_work(device_id)`,
		`CREATE TABLE IF NOT EXISTS session_work_scopes (thread_id TEXT PRIMARY KEY, stopped INTEGER NOT NULL DEFAULT 0)`,
		`CREATE TABLE IF NOT EXISTS session_work_operations (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, request_json TEXT NOT NULL, payload_json TEXT NOT NULL)`,
		`CREATE INDEX IF NOT EXISTS session_work_operations_thread ON session_work_operations(thread_id)`,
		`CREATE TABLE IF NOT EXISTS session_work_runs (id TEXT PRIMARY KEY, work_id TEXT NOT NULL, payload_json TEXT NOT NULL)`,
		`CREATE INDEX IF NOT EXISTS session_work_runs_work ON session_work_runs(work_id)`,
		`CREATE TABLE IF NOT EXISTS session_work_coverage (device_id TEXT PRIMARY KEY, payload_json TEXT NOT NULL)`,
	} {
		if _, err := s.conn().ExecContext(ctx, statement); err != nil {
			return err
		}
	}
	return nil
}

func workKey(parts ...string) string {
	hash := sha256.New()
	for _, p := range parts {
		hash.Write([]byte(p))
		hash.Write([]byte{0})
	}
	return hex.EncodeToString(hash.Sum(nil))[:32]
}

func (s *Store) SessionWorkSources(ctx context.Context, id string) ([]store.AgentSession, error) {
	return listJSON[store.AgentSession](ctx, s.conn(), `SELECT json_remove(payload_json,'$.events','$.response') FROM agent_sessions WHERE id=? OR thread_id=?`, id, id)
}

func (s *Store) ListSessionWork(ctx context.Context, threadID, deviceID string) (store.SessionWorkList, error) {
	result := store.SessionWorkList{Items: []store.SessionWork{}, Operations: []store.WorkOperation{}, Coverage: map[string]string{"hostSchedules": "not_observed", "processes": "not_observed"}}
	query := `SELECT payload_json FROM session_work WHERE thread_id=?1 OR session_id IN (SELECT id FROM agent_sessions WHERE id=?1 OR thread_id=?1) OR EXISTS (SELECT 1 FROM json_each(session_work.payload_json,'$.relatedSessionIds') link WHERE link.value=?1 OR link.value IN (SELECT id FROM agent_sessions WHERE thread_id=?1))`
	arg := threadID
	if deviceID != "" {
		query = `SELECT payload_json FROM session_work WHERE device_id = ?`
		arg = deviceID
	}
	err := scanRows(ctx, s.conn(), query+` ORDER BY id`, func(rows *sql.Rows) error {
		var raw string
		if err := rows.Scan(&raw); err != nil {
			return err
		}
		var item store.SessionWork
		if err := json.Unmarshal([]byte(raw), &item); err != nil {
			return err
		}
		result.Items = append(result.Items, item)
		return nil
	}, arg)
	if err != nil {
		return result, err
	}
	// Older imports may already contain explicit exit evidence, while their
	// task IDs disappeared from the latest native snapshot. Repair from the
	// retained evidence as well; rereading the transcript cannot rediscover them.
	// Save rechecks the current generation/observation inside its transaction.
	for index, item := range result.Items {
		candidate := item
		if !confirmNativeWorkHistory(&candidate, item) {
			continue
		}
		saved, saveErr := s.SaveSessionWork(ctx, item)
		if saveErr != nil {
			return result, saveErr
		}
		result.Items[index] = saved
	}
	coverageDevice := deviceID
	if coverageDevice == "" && threadID != "" {
		_ = s.conn().QueryRowContext(ctx, `SELECT device_id FROM agent_sessions WHERE id=? OR thread_id=? LIMIT 1`, threadID, threadID).Scan(&coverageDevice)
	}
	if coverageDevice == "" && len(result.Items) > 0 {
		coverageDevice = result.Items[0].DeviceID
	}
	var coverageRaw string
	if err := s.conn().QueryRowContext(ctx, `SELECT payload_json FROM session_work_coverage WHERE device_id=?`, coverageDevice).Scan(&coverageRaw); err == nil {
		_ = json.Unmarshal([]byte(coverageRaw), &result.Coverage)
	}
	if deviceID != "" {
		_ = s.conn().QueryRowContext(ctx, `SELECT COALESCE(MAX(rowid),0) FROM session_work_operations WHERE thread_id IN (SELECT id FROM agent_sessions WHERE device_id=?)`, deviceID).Scan(&result.SweepRevision)
		_ = scanRows(ctx, s.conn(), `SELECT DISTINCT thread_id FROM session_work_operations WHERE thread_id IN (SELECT id FROM agent_sessions WHERE device_id=?)`, func(rows *sql.Rows) error {
			var id string
			if err := rows.Scan(&id); err != nil {
				return err
			}
			result.ScopeIDs = append(result.ScopeIDs, id)
			return nil
		}, deviceID)
		_ = scanRows(ctx, s.conn(), `SELECT thread_id FROM session_work_scopes WHERE stopped=1 AND thread_id IN (SELECT id FROM agent_sessions WHERE device_id=?)`, func(rows *sql.Rows) error {
			var id string
			if err := rows.Scan(&id); err != nil {
				return err
			}
			result.StoppedThreads = append(result.StoppedThreads, id)
			return nil
		}, deviceID)
	}

	for _, item := range result.Items {
		if item.Source == "process" && item.Observation.ProcessRole == "" && item.DesiredState != "removed" &&
			!slices.Contains([]string{"completed", "stopped", "failed"}, item.Observation.Status) {
			result.Coverage["processes"] = "unverified"
			break
		}
	}
	if threadID != "" {
		var stopped bool
		err = s.conn().QueryRowContext(ctx, `SELECT stopped FROM session_work_scopes WHERE thread_id = ?`, threadID).Scan(&stopped)
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return result, err
		}
		result.Barrier = stopped
		err = scanRows(ctx, s.conn(), `SELECT rowid,payload_json FROM session_work_operations WHERE thread_id = ? ORDER BY rowid DESC LIMIT 30`, func(rows *sql.Rows) error {
			var raw string
			var sequence int64
			if err := rows.Scan(&sequence, &raw); err != nil {
				return err
			}
			var op store.WorkOperation
			if err := json.Unmarshal([]byte(raw), &op); err != nil {
				return err
			}
			op.Sequence = sequence
			if op.Action == "stop_all" || op.Action == "pause_all" {
				n := 0
				for _, item := range result.Items {
					if item.Management == "observed" && item.Native == nil && item.DesiredState != "removed" {
						n++
					}
				}
				op.Unmanaged = max(op.Unmanaged, n)
			}
			op.State = workOperationState(op, result.Items, result.Coverage)
			result.Operations = append(result.Operations, op)
			return nil
		}, threadID)
		// Historical receipts can name targets no longer shown. Query them
		// after closing rows, including on single-connection transactions.
		for i, op := range result.Operations {
			receiptItems := append([]store.SessionWork{}, result.Items...)
			for _, target := range op.Items {
				if slices.ContainsFunc(receiptItems, func(w store.SessionWork) bool { return w.ID == target.ID }) {
					continue
				}
				var raw string
				if readErr := s.conn().QueryRowContext(ctx, `SELECT payload_json FROM session_work WHERE id=?`, target.ID).Scan(&raw); readErr == nil {
					var prior store.SessionWork
					if json.Unmarshal([]byte(raw), &prior) == nil {
						receiptItems = append(receiptItems, prior)
					}
				}
			}
			result.Operations[i].State = workOperationState(op, receiptItems, result.Coverage)
		}
	}
	return result, err
}

func workOperationState(op store.WorkOperation, items []store.SessionWork, coverage map[string]string) string {
	if op.Action == "link" || op.Action == "unlink" {
		return "verified"
	}
	if op.Unmanaged > 0 {
		return "unknown"
	}
	state := "verified"
	if op.Action == "stop_all" || op.Action == "pause_all" {
		observed, err := strconv.ParseInt(coverage["sweepRevision"], 10, 64)
		if err != nil || op.Sequence == 0 || observed < op.Sequence {
			return "pending"
		}
		if coverage["processes"] == "unverified" {
			return "unknown"
		}
		if coverage["hostSchedules"] != "observed" {
			return "unknown"
		}
	}
	if op.Action == "stop_all" {
		for _, item := range items {
			if len(item.RelatedSessionIDs) > 0 || item.Management != "managed" || !slices.Contains(item.AllowedActions, "stop") || item.DesiredState == "removed" || !store.StandaloneSessionWork(item) {
				continue
			}
			if confirmedWorkEnded(item) {
				continue
			}
			if item.DesiredState != "stopped" {
				return "unknown"
			}
			if item.Observation.Error != "" {
				return "failed"
			}
			if item.Observation.ConfirmedRevision < item.Revision {
				state = "pending"
			} else if item.Observation.Status == "unknown" {
				return "unknown"
			}
		}
	}
	if op.Action == "pause_all" {
		for _, item := range items {
			if len(item.RelatedSessionIDs) > 0 || item.Management != "managed" || item.Kind != "schedule" || item.DesiredState == "removed" || item.DesiredState == "stopped" || confirmedWorkEnded(item) || workObservationBefore(op.CreatedAt, item.CreatedAt) {
				continue
			}
			if item.DesiredState != "paused" {
				return "unknown"
			}
			if item.Observation.Error != "" {
				return "failed"
			}
			if item.Observation.ConfirmedRevision < item.Revision {
				state = "pending"
			} else if item.Observation.Status == "unknown" {
				return "unknown"
			}
		}
	}

	for _, target := range op.Items {
		index := slices.IndexFunc(items, func(w store.SessionWork) bool { return w.ID == target.ID })
		if index < 0 {
			return "unknown"
		}
		w := items[index]
		if w.Revision != target.Revision {
			return "unknown"
		}
		// A legacy stop may predate process classification. Acknowledging that
		// the target is runtime infrastructure does not prove it was stopped.
		if w.Source == "process" && !store.StandaloneSessionWork(w) &&
			slices.Contains([]string{"stop", "stop_all", "remove"}, op.Action) && !confirmedWorkEnded(w) {
			return "unknown"
		}
		if w.Observation.Error != "" {
			return "failed"
		}
		if w.Observation.ConfirmedRevision < target.Revision {
			state = "pending"
			if w.Observation.Error != "" {
				return "failed"
			}
		}
		if w.Observation.ConfirmedRevision >= target.Revision && w.Observation.Status == "unknown" {
			return "unknown"
		}
		if w.Observation.ConfirmedRevision >= target.Revision {
			if slices.Contains([]string{"stop", "stop_all", "remove"}, op.Action) && !confirmedWorkEnded(w) {
				return "unknown"
			}
			if op.Action == "pause" && w.Kind != "schedule" && w.Observation.Status == "running" {
				return "unknown"
			}
		}

	}
	return state
}

func (s *Store) SaveSessionWork(ctx context.Context, item store.SessionWork) (store.SessionWork, error) {
	if item.Kind == "agent" && (item.Source == "claude" || item.Source == "codex") {
		item.Management = "observed"
		item.AllowedActions = []string{}
		if item.Native == nil {
			item.Native = &store.NativeWorkInfo{Runtime: item.Source, Version: "unknown", SessionID: item.Spec.NativeSessionID, TaskID: item.SourceID, Discovery: "legacy native agent lifecycle", Observation: "unknown", Controls: map[string]string{"stop": "unavailable", "pause": "unknown", "resume": "unknown"}}
		}
	}

	err := s.withTx(ctx, func(tx *Store) error {
		var raw string
		err := tx.conn().QueryRowContext(ctx, `SELECT payload_json FROM session_work WHERE id = ?`, item.ID).Scan(&raw)
		if err == nil {
			evidence := item
			if err = json.Unmarshal([]byte(raw), &item); err != nil {
				return err
			}
			changed := confirmNativeWorkHistory(&item, evidence)
			if item.Native != nil && evidence.Native != nil && item.Source == evidence.Source && item.SourceID == evidence.SourceID && (item.Native.SessionID == "" || evidence.Native.SessionID == "" || item.Native.SessionID == evidence.Native.SessionID) && item.Kind != "schedule" && item.Generation == 1 && evidence.Observation.EndedAt != "" && evidence.Observation.Error == "" && workObservationBefore(item.Observation.At, evidence.Observation.At) && slices.Contains([]string{"completed", "failed", "stopped"}, evidence.Observation.Status) {
				item.Observation = evidence.Observation
				item.Observation.ConfirmedRevision = item.Revision
				changed = true
			}
			if evidence.Native != nil && (evidence.Source == "claude" || evidence.Source == "codex") && evidence.Kind == item.Kind {
				// An already adopted historical schedule keeps its executor.
				legacySchedule := item.Kind == "schedule" && item.Native == nil && item.Management == "managed"
				if !legacySchedule && (item.Native == nil || evidence.Native.Version != "unknown") {
					item.Native = evidence.Native
					item.Management = evidence.Management
					item.AllowedActions = evidence.AllowedActions
					changed = true
				}
				// Native subagents are always observational, including old imports.
				if item.Kind == "agent" {
					item.Native = evidence.Native
					item.Management = "observed"
					item.AllowedActions = []string{}
					changed = true
				}
			}
			if changed {
				return tx.writeWork(ctx, item)
			}
			return nil
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		var stopped bool
		err = tx.conn().QueryRowContext(ctx, `SELECT stopped FROM session_work_scopes WHERE thread_id = ?`, item.ThreadID).Scan(&stopped)
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		if item.CreatedAt == "" {
			item.CreatedAt = formatTime(time.Now().UTC())
		}
		if stopped && slices.Contains(item.AllowedActions, "stop") {
			item.DesiredState = "stopped"
		} else if item.Kind == "schedule" && item.Management == "managed" && slices.Contains(item.AllowedActions, "pause") {
			var rawPause string
			pauseErr := tx.conn().QueryRowContext(ctx, `SELECT payload_json FROM session_work_operations WHERE thread_id=? AND json_extract(payload_json,'$.action')='pause_all' ORDER BY rowid DESC LIMIT 1`, item.ThreadID).Scan(&rawPause)
			if pauseErr != nil && !errors.Is(pauseErr, sql.ErrNoRows) {
				return pauseErr
			}
			if pauseErr == nil {
				var pause store.WorkOperation
				if err := json.Unmarshal([]byte(rawPause), &pause); err != nil {
					return err
				}
				if !workObservationBefore(pause.CreatedAt, item.CreatedAt) {
					item.DesiredState = "paused"
				}
			}
		}
		item.Revision = 1
		item.Generation = 1
		confirmNativeWorkHistory(&item, item)
		if item.CreatedAt == "" {
			item.CreatedAt = formatTime(time.Now().UTC())
		}
		item.UpdatedAt = item.CreatedAt
		if item.AllowedActions == nil {
			item.AllowedActions = []string{}
		}
		return tx.writeWork(ctx, item)
	})
	return item, err
}

// Native tasks are one-shot identities. An explicit terminal event with an end
// timestamp is already evidence of cessation, not an unacknowledged command.
// Only repair transcript imports that have never received a device observation;
// later runs, errors and authoritative observations must not be overwritten.
func confirmNativeWorkHistory(item *store.SessionWork, evidence store.SessionWork) bool {
	if (item.Source != "claude" && item.Source != "codex") || item.Kind == "schedule" ||
		item.Generation != 1 || item.Observation.ConfirmedRevision != 0 || item.Observation.Error != "" ||
		item.Spec.ManualRunAt != "" || item.DesiredState == "paused" ||
		evidence.Source != item.Source || evidence.Kind != item.Kind || evidence.SourceID != item.SourceID || evidence.Observation.Error != "" {
		return false
	}
	if item.Spec.NativeSessionID != "" && evidence.Spec.NativeSessionID != "" && item.Spec.NativeSessionID != evidence.Spec.NativeSessionID {
		return false
	}
	if _, err := time.Parse(time.RFC3339Nano, evidence.Observation.EndedAt); err != nil {
		return false
	}
	if !slices.Contains([]string{"completed", "failed", "stopped"}, evidence.Observation.Status) {
		return false
	}
	item.Observation = evidence.Observation
	item.Observation.ConfirmedRevision = item.Revision
	return true
}

func confirmedWorkEnded(item store.SessionWork) bool {
	if item.Kind == "schedule" && item.DesiredState == "enabled" && item.Spec.Recurring {
		expires, err := time.Parse(time.RFC3339Nano, item.Spec.ExpiresAt)
		if err != nil || expires.After(time.Now()) {
			return false
		}
	}
	return item.Observation.ConfirmedRevision >= item.Revision && item.Observation.Error == "" &&
		slices.Contains([]string{"completed", "failed", "stopped"}, item.Observation.Status) &&
		(item.Kind != "schedule" || item.DesiredState != "paused")
}

func (s *Store) writeWork(ctx context.Context, item store.SessionWork) error {
	raw, err := json.Marshal(item)
	if err != nil {
		return err
	}
	_, err = s.conn().ExecContext(ctx, `INSERT INTO session_work(id,thread_id,session_id,device_id,payload_json) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload_json=excluded.payload_json`, item.ID, item.ThreadID, item.SessionID, item.DeviceID, string(raw))
	return err
}

func (s *Store) ObserveSessionWork(ctx context.Context, id string, observation store.WorkObservation) error {
	return s.withTx(ctx, func(tx *Store) error {
		var raw string
		if err := tx.conn().QueryRowContext(ctx, `SELECT payload_json FROM session_work WHERE id = ?`, id).Scan(&raw); err != nil {
			return err
		}
		var w store.SessionWork
		if err := json.Unmarshal([]byte(raw), &w); err != nil {
			return err
		}
		if observation.ConfirmedRevision > w.Revision {
			return errors.New("observation names a future control revision")
		}
		if w.Kind == "schedule" && w.Observation.RunID != "" && observation.RunID == "" &&
			slices.Contains([]string{"running", "unknown"}, w.Observation.Status) {
			return nil // A pre-claim snapshot cannot erase the current run identity.
		}
		if w.Kind == "schedule" && w.Observation.RunID != "" && observation.RunID != "" {
			if w.Observation.RunID != observation.RunID {
				return nil // A late result belongs to an older execution.
			}
			if slices.Contains([]string{"completed", "failed", "stopped"}, w.Observation.Status) &&
				observation.Status == "running" {
				// A fast completion can precede delivery acknowledgement, which
				// may advance confirmation but must never revive that execution.
				if observation.ConfirmedRevision > w.Observation.ConfirmedRevision {
					w.Observation.ConfirmedRevision = observation.ConfirmedRevision
					return tx.writeWork(ctx, w)
				}
				return nil
			}
		}
		if w.Source == "process" {
			// Old workers omit classification and report missing PIDs as unknown.
			// Preserve verified role/exit evidence across those legacy snapshots.
			if observation.ProcessRole == "" {
				observation.ProcessRole = w.Observation.ProcessRole
			}
			if w.Observation.Error == "" && slices.Contains([]string{"completed", "stopped"}, w.Observation.Status) &&
				!slices.Contains([]string{"completed", "stopped"}, observation.Status) {
				return nil
			}
		}
		if observation.ConfirmedRevision < w.Observation.ConfirmedRevision || workObservationBefore(observation.At, w.Observation.At) {
			return nil
		}
		w.Observation = observation
		return tx.writeWork(ctx, w)
	})
}

func workObservationBefore(a, b string) bool {
	x, xe := time.Parse(time.RFC3339Nano, a)
	y, ye := time.Parse(time.RFC3339Nano, b)
	return xe == nil && ye == nil && x.Before(y)
}

func (s *Store) ControlSessionWork(ctx context.Context, threadID, sessionID string, input store.WorkControlInput) (store.WorkOperation, error) {
	op := store.WorkOperation{ID: "wop_" + workKey(threadID, input.IdempotencyKey), SessionID: sessionID, Action: input.Action, State: "pending", CreatedAt: formatTime(time.Now().UTC()), Items: []store.WorkOperationItem{}}
	request, _ := json.Marshal(input)
	err := s.withTx(ctx, func(tx *Store) error {
		var prior, raw string
		err := tx.conn().QueryRowContext(ctx, `SELECT request_json,payload_json FROM session_work_operations WHERE id=?`, op.ID).Scan(&prior, &raw)
		if err == nil {
			if prior != string(request) {
				return errors.New("idempotency key already used for another operation")
			}
			return json.Unmarshal([]byte(raw), &op)
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		listed, err := tx.ListSessionWork(ctx, threadID, "")
		if err != nil {
			return err
		}
		all := input.Action == "stop_all" || input.Action == "pause_all"
		if input.Action == "stop_all" {
			if _, err = tx.conn().ExecContext(ctx, `INSERT INTO session_work_scopes(thread_id,stopped) VALUES(?,1) ON CONFLICT(thread_id) DO UPDATE SET stopped=1`, threadID); err != nil {
				return err
			}
		}
		found := false
		for _, item := range listed.Items {
			if !all && item.ID != input.ID {
				continue
			}
			// Shared services have a global lifecycle. A conversation bulk
			// action never stops work used from another conversation.
			if all && len(item.RelatedSessionIDs) > 0 {
				continue
			}
			if input.Action == "pause_all" && item.Kind != "schedule" {
				continue
			}
			if item.DesiredState == "removed" {
				continue
			}
			if all && !store.StandaloneSessionWork(item) {
				continue
			}
			if all && item.Management == "managed" && confirmedWorkEnded(item) {
				continue
			}
			if input.Action == "pause_all" && item.DesiredState != "enabled" {
				continue
			}
			if all && item.Management == "observed" {
				if item.Native != nil {
					continue
				}
				op.Unmanaged++
				continue
			}
			if input.Action == "stop_all" && !slices.Contains(item.AllowedActions, "stop") {
				continue
			}
			if input.Action == "pause_all" && !slices.Contains(item.AllowedActions, "pause") {
				op.Unmanaged++
				continue
			}
			found = true
			if !all && input.ExpectedRevision != item.Revision {
				return errors.New("work revision changed; refresh before controlling")
			}
			if !store.StandaloneSessionWork(item) && (input.Action != "remove" || !confirmedWorkEnded(item)) {
				if all {
					continue
				}
				return errors.New("external process is not a verified standalone background task")
			}
			exitedIdentity := confirmedWorkEnded(item) && (item.Source == "process" ||
				(item.Source == "claude" && item.Kind != "schedule" && item.Generation == 1 && item.Observation.EndedAt != ""))
			action := input.Action
			if action == "stop_all" {
				action = "stop"
			}
			if action == "pause_all" {
				action = "pause"
			}
			if !all && item.Source == "foundry" && item.Kind == "process" && input.ExpectedReferenceRevision != item.ReferenceRevision {
				return errors.New("service associations changed; refresh the impact scope before controlling")
			}
			if action == "link" || action == "unlink" {
				if item.Source != "foundry" || item.Kind != "process" || input.RelatedSessionID == "" || input.RelatedSessionID == item.SessionID {
					return errors.New("only durable services can link another session")
				}
				if action == "link" && !slices.Contains(item.RelatedSessionIDs, input.RelatedSessionID) {
					item.ReferenceRevision++
					item.RelatedSessionIDs = append(item.RelatedSessionIDs, input.RelatedSessionID)
					slices.Sort(item.RelatedSessionIDs)
				}
				if action == "unlink" && slices.Contains(item.RelatedSessionIDs, input.RelatedSessionID) {
					item.ReferenceRevision++
					item.RelatedSessionIDs = slices.DeleteFunc(item.RelatedSessionIDs, func(id string) bool { return id == input.RelatedSessionID })
				}
				item.UpdatedAt = op.CreatedAt
				if err := tx.writeWork(ctx, item); err != nil {
					return err
				}
				op.Items = append(op.Items, store.WorkOperationItem{ID: item.ID, Revision: item.Revision})
				continue
			}
			if !all && !slices.Contains(item.AllowedActions, action) {
				return errors.New("this work source does not support that action")
			}
			// Bulk stop records intent even if a source is currently unreachable.
			switch action {
			case "pause":
				item.DesiredState = "paused"
			case "resume":
				item.DesiredState = "enabled"
				item.Generation++
			case "stop":
				item.DesiredState = "stopped"
			case "remove":
				item.DesiredState = "removed"
			case "run":
				item.Generation++
				item.Spec.ManualRunAt = op.CreatedAt
			case "adopt":
				item.Management = "managed"
				item.DesiredState = "paused"
				item.AllowedActions = []string{"pause", "resume", "stop", "remove"}
				if item.Source == "launchd" {
					item.DesiredState = "stopped"
					item.AllowedActions = []string{"resume", "stop", "remove"}
				}
			default:
				return errors.New("unsupported work action")
			}
			if action != "run" {
				item.Spec.ManualRunAt = ""
			}
			item.Revision++
			if exitedIdentity && (action == "stop" || action == "remove") {
				item.Observation.ConfirmedRevision = item.Revision
			}
			item.UpdatedAt = op.CreatedAt
			item.Observation.Error = ""
			if action == "run" {
				item.Observation.NextFireAt = op.CreatedAt
			}
			if err := tx.writeWork(ctx, item); err != nil {
				return err
			}
			op.Items = append(op.Items, store.WorkOperationItem{ID: item.ID, Revision: item.Revision})
		}
		if !all && !found {
			return store.ErrNotFound
		}
		rawBytes, _ := json.Marshal(op)
		result, err := tx.conn().ExecContext(ctx, `INSERT INTO session_work_operations(id,thread_id,request_json,payload_json) VALUES(?,?,?,?)`, op.ID, threadID, string(request), string(rawBytes))
		if err != nil {
			return err
		}
		op.Sequence, err = result.LastInsertId()
		if err != nil {
			return err
		}
		rawBytes, _ = json.Marshal(op)
		_, err = tx.conn().ExecContext(ctx, `UPDATE session_work_operations SET payload_json=? WHERE id=?`, string(rawBytes), op.ID)
		return err
	})
	return op, err
}

func (s *Store) ClaimWorkRun(ctx context.Context, id string, generation int64, scheduledAt string) (store.WorkRun, bool, error) {
	instant, err := time.Parse(time.RFC3339Nano, scheduledAt)
	if err != nil {
		return store.WorkRun{}, false, errors.New("invalid scheduled instant")
	}
	scheduledAt = instant.UTC().Format(time.RFC3339Nano)
	run := store.WorkRun{ID: "wrun_" + workKey(id, fmt.Sprint(generation), scheduledAt), WorkID: id, Generation: generation, ScheduledAt: scheduledAt, StartedAt: formatTime(time.Now().UTC()), Status: "unknown"}
	claimed := false
	err = s.withTx(ctx, func(tx *Store) error {
		var raw string
		if err := tx.conn().QueryRowContext(ctx, `SELECT payload_json FROM session_work WHERE id=?`, id).Scan(&raw); err != nil {
			return err
		}
		var w store.SessionWork
		if err := json.Unmarshal([]byte(raw), &w); err != nil {
			return err
		}
		if w.Native != nil || w.Management != "managed" || w.Kind != "schedule" {
			return errors.New("native schedules are observed, not executed by Foundry")
		}
		var existing string
		if priorErr := tx.conn().QueryRowContext(ctx, `SELECT payload_json FROM session_work_runs WHERE id=?`, run.ID).Scan(&existing); priorErr == nil {
			return json.Unmarshal([]byte(existing), &run)
		} else if !errors.Is(priorErr, sql.ErrNoRows) {
			return priorErr
		}
		// Keep idempotency with pre-normalization workers using .000Z or an
		// offset spelling of the same instant. Compare parsed instants exactly.
		candidates, err := listJSON[store.WorkRun](ctx, tx.conn(), `SELECT payload_json FROM session_work_runs WHERE work_id=? AND json_extract(payload_json,'$.generation')=? AND julianday(json_extract(payload_json,'$.scheduledAt'))=julianday(?)`, id, generation, scheduledAt)
		if err != nil {
			return err
		}
		for _, prior := range candidates {
			at, parseErr := time.Parse(time.RFC3339Nano, prior.ScheduledAt)
			if parseErr == nil && at.Equal(instant) {
				run = prior
				return nil
			}
		}
		manualAt, manualErr := time.Parse(time.RFC3339Nano, w.Spec.ManualRunAt)
		manual := manualErr == nil && manualAt.Equal(instant)
		if w.Generation != generation || (w.DesiredState != "enabled" && !(manual && (w.DesiredState == "paused" || w.DesiredState == "stopped"))) {
			return errors.New("work is not enabled at this generation")
		}
		if w.Observation.Status == "running" || (w.Observation.RunID != "" && w.Observation.EndedAt == "" && w.Observation.Status == "unknown") {
			return errors.New("work is already running")
		}
		run.InputID = store.WorkRunInputID(w.SessionID, run.ID)
		encoded, _ := json.Marshal(run)
		result, err := tx.conn().ExecContext(ctx, `INSERT OR IGNORE INTO session_work_runs(id,work_id,payload_json) VALUES(?,?,?)`, run.ID, id, string(encoded))
		if err != nil {
			return err
		}
		n, _ := result.RowsAffected()
		claimed = n > 0
		if claimed {
			w.Observation = store.WorkObservation{Status: "unknown", At: run.StartedAt, RunID: run.ID, StartedAt: run.StartedAt, ConfirmedRevision: w.Observation.ConfirmedRevision} // Claiming is not delivery acknowledgement.
			return tx.writeWork(ctx, w)
		}
		return nil
	})
	return run, claimed, err
}

func (s *Store) SaveWorkCoverage(ctx context.Context, deviceID string, coverage map[string]string) error {
	raw, err := json.Marshal(coverage)
	if err != nil {
		return err
	}
	_, err = s.conn().ExecContext(ctx, `INSERT INTO session_work_coverage(device_id,payload_json) VALUES(?,?) ON CONFLICT(device_id) DO UPDATE SET payload_json=excluded.payload_json`, deviceID, string(raw))
	return err
}
func (s *Store) FinishWorkRun(ctx context.Context, run store.WorkRun) error {
	return s.withTx(ctx, func(tx *Store) error {
		var raw string
		if err := tx.conn().QueryRowContext(ctx, `SELECT payload_json FROM session_work_runs WHERE id=?`, run.ID).Scan(&raw); err != nil {
			return err
		}
		var saved store.WorkRun
		if err := json.Unmarshal([]byte(raw), &saved); err != nil {
			return err
		}
		if (run.WorkID != "" && run.WorkID != saved.WorkID) || (run.Generation != 0 && run.Generation != saved.Generation) {
			return errors.New("run identity changed")
		}
		if saved.EndedAt != "" {
			return nil
		}
		if run.ExecutionSessionID != "" {
			saved.ExecutionSessionID = run.ExecutionSessionID
		}
		saved.Status, saved.Error, saved.EndedAt = run.Status, run.Error, run.EndedAt
		if saved.EndedAt != "" {
			var workRaw string
			if err := tx.conn().QueryRowContext(ctx, `SELECT payload_json FROM session_work WHERE id=?`, saved.WorkID).Scan(&workRaw); err != nil {
				return err
			}
			var item store.SessionWork
			if err := json.Unmarshal([]byte(workRaw), &item); err != nil {
				return err
			}
			manualAt, me := time.Parse(time.RFC3339Nano, item.Spec.ManualRunAt)
			slot, se := time.Parse(time.RFC3339Nano, saved.ScheduledAt)
			if item.Generation == saved.Generation && me == nil && se == nil && manualAt.Equal(slot) {
				item.Spec.ManualRunAt = ""
				if err := tx.writeWork(ctx, item); err != nil {
					return err
				}
			}
		}
		encoded, err := json.Marshal(saved)
		if err != nil {
			return err
		}
		_, err = tx.conn().ExecContext(ctx, `UPDATE session_work_runs SET payload_json=? WHERE id=?`, string(encoded), saved.ID)
		return err
	})
}
func (s *Store) ListWorkRuns(ctx context.Context, id string) ([]store.WorkRun, error) {
	result := []store.WorkRun{}
	err := scanRows(ctx, s.conn(), `SELECT payload_json FROM session_work_runs WHERE work_id=? ORDER BY rowid DESC LIMIT 100`, func(rows *sql.Rows) error {
		var raw string
		if err := rows.Scan(&raw); err != nil {
			return err
		}
		var run store.WorkRun
		if err := json.Unmarshal([]byte(raw), &run); err != nil {
			return err
		}
		result = append(result, run)
		return nil
	}, id)
	return result, err
}

func (s *Store) WorkRunInputSession(ctx context.Context, inputID string) (string, error) {
	var id string
	err := s.conn().QueryRowContext(ctx, `SELECT session_id FROM agent_session_events WHERE id=?`, "evt_"+inputID).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return "", store.ErrNotFound
	}
	return id, err
}

// Durable services belong to a workspace. Session IDs retain creation audit and
// execution compatibility; active or linked sessions are not required to manage one.
func (s *Store) ListWorkspaceServices(ctx context.Context, workspaceID string) ([]store.SessionWork, error) {
	return listJSON[store.SessionWork](ctx, s.conn(), `SELECT payload_json FROM session_work WHERE json_extract(payload_json,'$.workspaceId')=? AND json_extract(payload_json,'$.kind')='process' AND json_extract(payload_json,'$.source')='foundry' ORDER BY id`, workspaceID)
}
