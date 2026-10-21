package sqlitestore

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func (s *Store) setupPersonalAgentRunControls(ctx context.Context) error {
	_, err := s.conn().ExecContext(ctx, `CREATE TABLE IF NOT EXISTS pa_run_controls(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,session_id TEXT NOT NULL,input_id TEXT NOT NULL UNIQUE,state TEXT NOT NULL,revision INTEGER NOT NULL,payload_json TEXT NOT NULL)`)
	return err
}
func scanPARunControl(row interface{ Scan(...any) error }) (store.PersonalAgentRunControl, error) {
	var v store.PersonalAgentRunControl
	var raw string
	err := row.Scan(&v.UserID, &raw)
	if errors.Is(err, sql.ErrNoRows) {
		return v, store.ErrNotFound
	}
	if err != nil {
		return v, err
	}
	err = json.Unmarshal([]byte(raw), &v)
	return v, err
}
func (s *Store) GetPersonalAgentRunControl(ctx context.Context, user, id string) (store.PersonalAgentRunControl, error) {
	return scanPARunControl(s.reader().QueryRowContext(ctx, `SELECT user_id,payload_json FROM pa_run_controls WHERE user_id=? AND id=?`, user, id))
}
func (s *Store) EnsurePersonalAgentRunControl(ctx context.Context, v store.PersonalAgentRunControl) (store.PersonalAgentRunControl, error) {
	if v.ID == "" || v.UserID == "" || v.SessionID == "" || v.InputID == "" {
		return v, fmt.Errorf("run control requires an exact accepted input")
	}
	var saved store.PersonalAgentRunControl
	err := s.withTx(ctx, func(tx *Store) error {
		old, err := tx.GetPersonalAgentRunControl(ctx, v.UserID, v.ID)
		if err == nil {
			if old.SessionID != v.SessionID || old.InputID != v.InputID {
				return store.ErrIdempotencyConflict
			}
			saved = old
			return nil
		}
		if !errors.Is(err, store.ErrNotFound) {
			return err
		}
		v.State, v.Revision, v.UpdatedAt, v.UsageState = "monitoring", 1, paNow(), "not_observed"
		if agent, e := tx.GetPersonalAgent(ctx, v.UserID); e == nil && agent.State == store.PersonalAgentStopped {
			v.State = "stop_requested"
			v.StopReason = "assistant_stopped"
		}
		raw, err := json.Marshal(v)
		if err != nil {
			return err
		}
		_, err = tx.conn().ExecContext(ctx, `INSERT INTO pa_run_controls(id,user_id,session_id,input_id,state,revision,payload_json) VALUES(?,?,?,?,?,?,?)`, v.ID, v.UserID, v.SessionID, v.InputID, v.State, v.Revision, string(raw))
		saved = v
		return err
	})
	return saved, err
}
func (s *Store) writePARunControl(ctx context.Context, v store.PersonalAgentRunControl) (store.PersonalAgentRunControl, error) {
	v.Revision++
	v.UpdatedAt = paNow()
	raw, err := json.Marshal(v)
	if err != nil {
		return v, err
	}
	_, err = s.conn().ExecContext(ctx, `UPDATE pa_run_controls SET state=?,revision=?,payload_json=? WHERE user_id=? AND id=?`, v.State, v.Revision, string(raw), v.UserID, v.ID)
	return v, err
}
func (s *Store) SavePersonalAgentRunControl(ctx context.Context, v store.PersonalAgentRunControl) (store.PersonalAgentRunControl, error) {
	var saved store.PersonalAgentRunControl
	err := s.withTx(ctx, func(tx *Store) error {
		old, err := tx.GetPersonalAgentRunControl(ctx, v.UserID, v.ID)
		if err != nil {
			return err
		}
		if old.Revision != v.Revision {
			return store.ErrPersonalAgentRevision
		}
		if old.State != "monitoring" && old.State != "stop_requested" {
			return fmt.Errorf("run control is settled")
		}
		if v.State != "monitoring" && v.State != "stop_requested" && v.State != "stopped" && v.State != "settled" && v.State != "input_moved" {
			return fmt.Errorf("unknown run control state")
		}
		if old.State == "stop_requested" && v.State == "monitoring" {
			return fmt.Errorf("a stop request cannot be silently cleared")
		}
		old.WaitingReason = v.WaitingReason
		old.State, old.StopReason, old.ObservedTokens, old.UsageState, old.LastUsageAt, old.ConfirmedAt = v.State, v.StopReason, max(old.ObservedTokens, v.ObservedTokens), v.UsageState, v.LastUsageAt, v.ConfirmedAt
		saved, err = tx.writePARunControl(ctx, old)
		return err
	})
	return saved, err
}
func (s *Store) RequestPersonalAgentRunStop(ctx context.Context, user, id, reason string) (store.PersonalAgentRunControl, error) {
	var saved store.PersonalAgentRunControl
	err := s.withTx(ctx, func(tx *Store) error {
		v, err := tx.GetPersonalAgentRunControl(ctx, user, id)
		if err != nil {
			return err
		}
		if v.State != "monitoring" {
			saved = v
			return nil
		}
		v.State, v.StopReason = "stop_requested", reason
		saved, err = tx.writePARunControl(ctx, v)
		return err
	})
	return saved, err
}
func (s *Store) queryPARunControls(ctx context.Context, where string, args ...any) ([]store.PersonalAgentRunControl, error) {
	rows, err := s.reader().QueryContext(ctx, `SELECT user_id,payload_json FROM pa_run_controls WHERE `+where, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []store.PersonalAgentRunControl{}
	for rows.Next() {
		v, err := scanPARunControl(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, v)
	}
	return items, rows.Err()
}
func (s *Store) ListPersonalAgentRunControls(ctx context.Context, user string) ([]store.PersonalAgentRunControl, error) {
	return s.queryPARunControls(ctx, `user_id=? AND (state IN ('monitoring','stop_requested') OR id IN (SELECT id FROM pa_run_controls WHERE user_id=? ORDER BY rowid DESC LIMIT 200)) ORDER BY CASE WHEN state IN ('monitoring','stop_requested') THEN 0 ELSE 1 END,rowid DESC`, user, user)
}
func (s *Store) ActivePersonalAgentRunControls(ctx context.Context) ([]store.PersonalAgentRunControl, error) {
	return s.queryPARunControls(ctx, `state IN ('monitoring','stop_requested') ORDER BY CASE state WHEN 'stop_requested' THEN 0 ELSE 1 END,json_extract(payload_json,'$.updatedAt') LIMIT 100`)
}
func (s *Store) CancelPersonalAgentInput(ctx context.Context, sessionID, inputID, reason string) (store.AgentSession, bool, error) {
	var result store.AgentSession
	changed := false
	err := s.withTx(ctx, func(tx *Store) error {
		current, err := tx.GetAgentSessionSummary(ctx, sessionID)
		if err != nil {
			return err
		}
		if current.Input.ID != inputID {
			return store.ErrPersonalAgentRevision
		}
		if isTerminalAgentSession(current.Status) {
			result = current
			return nil
		}
		result, err = tx.CancelAgentSession(ctx, sessionID, reason)
		changed = err == nil
		return err
	})
	return result, changed, err
}

// Reserve the possibility of a side effect before queuing it to the device.
// A concurrent stop either wins this transaction or waits for a native receipt.
func (s *Store) AuthorizePersonalAgentDispatch(ctx context.Context, sessionID, inputID string) (bool, error) {
	allowed := true
	err := s.withTx(ctx, func(tx *Store) error {
		v, err := scanPARunControl(tx.conn().QueryRowContext(ctx, `SELECT user_id,payload_json FROM pa_run_controls WHERE session_id=? AND input_id=?`, sessionID, inputID))
		if errors.Is(err, store.ErrNotFound) {
			return nil
		}
		if err != nil {
			return err
		}
		if agent, e := tx.GetPersonalAgent(ctx, v.UserID); e == nil && agent.State == store.PersonalAgentStopped && v.State == "monitoring" {
			v.State = "stop_requested"
			v.StopReason = "assistant_stopped"
			if _, e = tx.writePARunControl(ctx, v); e != nil {
				return e
			}
		}
		if v.State != "monitoring" {
			allowed = false
			return nil
		}
		if !v.DispatchAttempted {
			v.DispatchAttempted = true
			_, err = tx.writePARunControl(ctx, v)
		}
		return err
	})
	return allowed, err
}

func (s *Store) checkPARunInput(ctx context.Context, user, inputID string, budget *store.SessionExecutionBudget) error {
	if budget == nil {
		return nil
	}
	account, e := s.GetUser(ctx, user)
	if e != nil {
		return e
	}
	if !account.Active() {
		return fmt.Errorf("assistant account is disabled")
	}
	snapshot, err := s.GetPersonalAgentRunSnapshot(ctx, user, budget.SnapshotID)
	if err != nil {
		return err
	}
	if snapshot.InputID != inputID {
		return store.ErrIdempotencyConflict
	}
	roles, e := s.WorkspaceRolesForUser(ctx, user)
	if e != nil {
		return e
	}
	role := roles[snapshot.WorkspaceID]
	if role != store.WorkspaceRoleOwner && (role != store.WorkspaceRoleMember || snapshot.Role == "memory" || snapshot.Role == "governance") {
		return fmt.Errorf("assistant workspace permission changed")
	}
	workspace, e := s.GetWorkspace(ctx, snapshot.WorkspaceID)
	if e != nil {
		return e
	}
	if workspace.DeviceID != snapshot.DeviceID || workspace.ArchivedAt != "" || workspace.UnavailableOnDevice != nil {
		return fmt.Errorf("assistant execution location changed")
	}

	agent, err := s.GetPersonalAgent(ctx, user)
	if err != nil {
		return err
	}
	if agent.State == store.PersonalAgentStopped {
		return fmt.Errorf("assistant dispatch is paused")
	}
	return nil
}

func (s *Store) ActivePersonalAgentRunControlsForUser(ctx context.Context, user string) ([]store.PersonalAgentRunControl, error) {
	return s.queryPARunControls(ctx, `user_id=? AND state IN ('monitoring','stop_requested') ORDER BY rowid`, user)
}

// Only the authenticated device-completion path calls this method. A Server
// desired terminal projection, including cancellation, is not this receipt.
func (s *Store) NotePersonalAgentNativeEnd(ctx context.Context, sessionID, inputID, status string) error {
	if inputID == "" {
		return nil
	}
	return s.withTx(ctx, func(tx *Store) error {
		v, e := scanPARunControl(tx.reader().QueryRowContext(ctx, `SELECT user_id,payload_json FROM pa_run_controls WHERE session_id=? AND input_id=?`, sessionID, inputID))
		if errors.Is(e, store.ErrNotFound) {
			return nil
		}
		if e != nil {
			return e
		}
		if v.NativeEndedAt != "" {
			return nil
		}
		v.NativeEndedAt = paNow()
		v.NativeStatus = status
		v.ConfirmedAt = v.NativeEndedAt
		v.WaitingReason = ""
		if v.State == "stop_requested" {
			v.State = "stopped"
		} else if v.State == "monitoring" {
			v.State = "settled"
		}
		_, e = tx.writePARunControl(ctx, v)
		return e
	})
}
func (s *Store) personalAgentInputAccepted(ctx context.Context, user, input string) (bool, error) {
	var accepted bool
	e := s.reader().QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM pa_run_snapshots WHERE user_id=? AND session_id<>'' AND json_extract(payload_json,'$.inputId')=?) OR EXISTS(SELECT 1 FROM agent_session_events WHERE id=?)`, user, input, "evt_"+input).Scan(&accepted)
	return accepted, e
}
