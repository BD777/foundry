package sqlitestore

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func (s *Store) setupPersonalAgentOperations(ctx context.Context) error {
	for _, q := range []string{
		`CREATE TABLE IF NOT EXISTS pa_operations(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,item_id TEXT NOT NULL,intent_revision INTEGER NOT NULL,step_key TEXT NOT NULL,input_id TEXT NOT NULL UNIQUE,status TEXT NOT NULL,revision INTEGER NOT NULL,lease_until TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL,updated_at TEXT NOT NULL,request_hash TEXT NOT NULL,payload_json TEXT NOT NULL,UNIQUE(user_id,item_id,intent_revision,step_key))`,
		`CREATE INDEX IF NOT EXISTS idx_pa_operations_due ON pa_operations(status,lease_until,created_at)`,
	} {
		if _, err := s.conn().ExecContext(ctx, q); err != nil {
			return err
		}
	}
	return nil
}

func scanPAOperation(row interface{ Scan(...any) error }) (store.PersonalAgentOperation, error) {
	var op store.PersonalAgentOperation
	var raw string
	err := row.Scan(&raw, &op.UserID, &op.Status, &op.Revision, &op.LeaseUntil, &op.CreatedAt, &op.UpdatedAt, &op.RequestHash)
	if errors.Is(err, sql.ErrNoRows) {
		return op, store.ErrNotFound
	}
	if err != nil {
		return op, err
	}
	// State columns are included in payload too; all are updated atomically.
	err = json.Unmarshal([]byte(raw), &op)
	return op, err
}

const paOperationColumns = `payload_json,user_id,status,revision,lease_until,created_at,updated_at,request_hash`

func (s *Store) GetPersonalAgentOperation(ctx context.Context, user, id string) (store.PersonalAgentOperation, error) {
	return scanPAOperation(s.reader().QueryRowContext(ctx, `SELECT `+paOperationColumns+` FROM pa_operations WHERE user_id=? AND id=?`, user, id))
}
func (s *Store) CapturePersonalAgentOperation(ctx context.Context, op store.PersonalAgentOperation) (store.PersonalAgentOperation, error) {
	if op.ID == "" || op.UserID == "" || op.InputID == "" || op.RequestHash == "" || op.StepKey == "" || op.Prompt == "" || op.WorkspaceID == "" || op.SourceSessionID == "" {
		return op, fmt.Errorf("incomplete operation")
	}
	var result store.PersonalAgentOperation
	err := s.withTx(ctx, func(tx *Store) error {
		previous, err := tx.GetPersonalAgentOperation(ctx, op.UserID, op.ID)
		if err == nil {
			if previous.RequestHash != op.RequestHash {
				return store.ErrIdempotencyConflict
			}
			result = previous
			return nil
		}
		if !errors.Is(err, store.ErrNotFound) {
			return err
		}
		if agent, e := tx.GetPersonalAgent(ctx, op.UserID); e == nil && agent.State == store.PersonalAgentStopped {
			return fmt.Errorf("assistant dispatch is paused")
		} else if e != nil && !errors.Is(e, store.ErrNotFound) {
			return e
		}
		if op.SourceInputID != "" {
			var stopped bool
			if e := tx.reader().QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM pa_run_controls WHERE user_id=? AND session_id=? AND input_id=? AND state IN ('stop_requested','stopped'))`, op.UserID, op.SourceSessionID, op.SourceInputID).Scan(&stopped); e != nil {
				return e
			}
			if stopped {
				return fmt.Errorf("the sending input is stopping; it cannot authorize new dispatch")
			}
		}
		if err = tx.checkPAOperationIntent(ctx, op, false); err != nil {
			return err
		}
		var active bool
		if err = tx.conn().QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM pa_operations WHERE user_id=? AND item_id=? AND status IN ('pending','waiting','dispatching','unknown','delivered'))`, op.UserID, op.ItemID).Scan(&active); err != nil {
			return err
		}
		if active {
			return fmt.Errorf("item already has an unsettled dispatch; inspect and reuse it")
		}
		op.Status, op.Revision, op.CreatedAt, op.UpdatedAt = "pending", 1, paNow(), paNow()
		op.LeaseUntil, op.SessionID, op.SnapshotID, op.Reason = "", "", "", ""
		raw, err := json.Marshal(op)
		if err != nil {
			return err
		}
		_, err = tx.conn().ExecContext(ctx, `INSERT INTO pa_operations(id,user_id,item_id,intent_revision,step_key,input_id,status,revision,created_at,updated_at,request_hash,payload_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`, op.ID, op.UserID, op.ItemID, op.IntentRevision, op.StepKey, op.InputID, op.Status, op.Revision, op.CreatedAt, op.UpdatedAt, op.RequestHash, string(raw))
		result = op
		return err
	})
	return result, err
}
func (s *Store) checkPAOperationIntent(ctx context.Context, op store.PersonalAgentOperation, checkDependencies bool) error {
	item, err := s.GetPersonalAgentItem(ctx, op.UserID, op.ItemID)
	if err != nil {
		return err
	}
	if item.IntentRevision != op.IntentRevision {
		return store.ErrPersonalAgentRevision
	}
	if item.Plan != nil && item.Plan.Route != nil && (item.Plan.Route.NeedsClarification || item.Plan.Route.Kind == "clarify") {
		return fmt.Errorf("routing_needs_clarification")
	}
	if item.Text == "" || item.Status != store.PersonalAgentItemOpen || item.Plan == nil || item.Plan.Mode != "execute" || item.Plan.WorkspaceID != op.WorkspaceID {
		return fmt.Errorf("item does not authorize execution in this workspace")
	}
	if !checkDependencies {
		return nil
	}
	for _, id := range item.Plan.Dependencies {
		dep, err := s.GetPersonalAgentItem(ctx, op.UserID, id)
		if err != nil {
			return err
		}
		if dep.Status != store.PersonalAgentItemDone {
			return fmt.Errorf("dependency_pending: %s", id)
		}
	}
	return nil
}
func (s *Store) SavePersonalAgentOperation(ctx context.Context, op store.PersonalAgentOperation) (store.PersonalAgentOperation, error) {
	var result store.PersonalAgentOperation
	err := s.withTx(ctx, func(tx *Store) error {
		old, err := tx.GetPersonalAgentOperation(ctx, op.UserID, op.ID)
		if err != nil {
			return err
		}
		if old.Revision != op.Revision {
			return store.ErrPersonalAgentRevision
		}
		valid := false
		switch old.Status {
		case "pending", "waiting":
			valid = op.Status == "dispatching" || op.Status == "cancelled" || op.Status == "waiting" || op.Status == "delivered"
		case "dispatching":
			valid = op.Status == "dispatching" || op.Status == "delivered" || op.Status == "waiting" || op.Status == "unknown" || op.Status == "cancelled"
		case "unknown":
			valid = op.Status == "delivered" || op.Status == "unknown" // no automatic resend
		case "delivered":
			valid = op.Status == "review" || op.Status == "failed" || op.Status == "cancelled" || op.Status == "delivered"
		}
		if !valid {
			return fmt.Errorf("invalid operation transition %s to %s", old.Status, op.Status)
		}
		if op.Status == "dispatching" {
			if err = tx.checkPAOperationIntent(ctx, old, true); err != nil {
				return err
			}
		}
		if old.SessionID != "" && op.SessionID != old.SessionID {
			return store.ErrIdempotencyConflict
		}
		// Immutable instruction fields are never replaced by a worker's stale copy.
		old.Status, old.Reason, old.SessionID, old.LeaseUntil = op.Status, op.Reason, op.SessionID, op.LeaseUntil
		if old.SnapshotID != "" && old.SnapshotID != op.SnapshotID {
			return store.ErrIdempotencyConflict
		}
		old.SnapshotID = op.SnapshotID
		old.Revision++
		old.UpdatedAt = paNow()
		raw, err := json.Marshal(old)
		if err != nil {
			return err
		}
		_, err = tx.conn().ExecContext(ctx, `UPDATE pa_operations SET status=?,revision=?,lease_until=?,updated_at=?,payload_json=? WHERE user_id=? AND id=?`, old.Status, old.Revision, old.LeaseUntil, old.UpdatedAt, string(raw), old.UserID, old.ID)
		result = old
		return err
	})
	return result, err
}
func (s *Store) queryPAOperations(ctx context.Context, where string, args ...any) ([]store.PersonalAgentOperation, error) {
	rows, err := s.reader().QueryContext(ctx, `SELECT `+paOperationColumns+` FROM pa_operations WHERE `+where, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []store.PersonalAgentOperation{}
	for rows.Next() {
		op, err := scanPAOperation(rows)
		if err != nil {
			return nil, err
		}
		result = append(result, op)
	}
	return result, rows.Err()
}
func (s *Store) ListPersonalAgentOperations(ctx context.Context, user string) ([]store.PersonalAgentOperation, error) {
	return s.queryPAOperations(ctx, `user_id=? ORDER BY created_at DESC LIMIT 200`, user)
}
func (s *Store) DuePersonalAgentOperations(ctx context.Context, now string, limit int) ([]store.PersonalAgentOperation, error) {
	return s.queryPAOperations(ctx, `status IN ('pending','waiting','dispatching','unknown','delivered') AND (lease_until='' OR julianday(lease_until)<=julianday(?)) ORDER BY created_at,id LIMIT ?`, now, min(max(limit, 1), 100))
}

// Called inside the transaction that persists the native input. An edit or
// cancellation winning that transaction prevents a stale dispatch entirely.
func (s *Store) checkPAOperationInput(ctx context.Context, id string, revision int64, user, workspace, input string) error {
	if id == "" {
		return nil
	}
	op, err := s.GetPersonalAgentOperation(ctx, user, id)
	if err != nil {
		return err
	}
	if op.Revision != revision || op.Status != "dispatching" || op.InputID != input || op.WorkspaceID != workspace {
		return store.ErrPersonalAgentRevision
	}
	if err := s.checkPAOperationIntent(ctx, op, true); err != nil {
		return err
	}
	var unsettled bool
	if e := s.reader().QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM pa_run_controls c JOIN agent_sessions a ON a.id=c.session_id WHERE a.workspace_id=? AND c.state IN ('monitoring','stop_requested') AND json_extract(c.payload_json,'$.dispatchAttempted')=1)`, workspace).Scan(&unsettled); e != nil {
		return e
	}
	if unsettled {
		return fmt.Errorf("workspace_writer_busy: an earlier input still needs its native end receipt")
	}
	sessions, err := s.ListAgentSessionSummaries(ctx, workspace)
	if err != nil {
		return err
	}
	for _, session := range sessions {
		if session.Source == "verification" || session.Source == "naming" || session.Source == "diagnostic" || session.Source == store.DigestSessionSource {
			continue
		}
		if session.Status == "queued" || session.Status == "running" || session.Status == "blocked" {
			return fmt.Errorf("workspace_writer_busy: reuse or wait for the existing owner")
		}
	}
	return nil
}

// A stopped assistant cannot accept more inputs (checkPARunInput). Keep any
// accepted native identity reconcilable; cancel only instructions with none.
func (s *Store) CancelUndispatchedPersonalAgentOperations(ctx context.Context, user string) error {
	_, err := s.conn().ExecContext(ctx, `UPDATE pa_operations SET status='cancelled',revision=revision+1,lease_until='',payload_json=json_set(payload_json,'$.status','cancelled','$.reason','assistant_stopped_before_dispatch','$.revision',revision+1,'$.updatedAt',?) WHERE user_id=? AND status IN ('pending','waiting','dispatching') AND NOT EXISTS(SELECT 1 FROM agent_session_events e WHERE e.id='evt_'||pa_operations.input_id) AND NOT EXISTS(SELECT 1 FROM pa_run_snapshots r WHERE r.user_id=pa_operations.user_id AND r.session_id<>'' AND json_extract(r.payload_json,'$.inputId')=pa_operations.input_id)`, paNow(), user)
	return err
}

func (s *Store) CancelPendingPersonalAgentOperation(ctx context.Context, user, id string, revision int64) (store.PersonalAgentOperation, error) {
	var result store.PersonalAgentOperation
	err := s.withTx(ctx, func(tx *Store) error {
		op, e := tx.GetPersonalAgentOperation(ctx, user, id)
		if e != nil {
			return e
		}
		if op.Status == "cancelled" {
			result = op
			return nil
		}
		if op.Revision != revision {
			return store.ErrPersonalAgentRevision
		}
		if (op.Status != "pending" && op.Status != "waiting") || op.SessionID != "" {
			return fmt.Errorf("only an unaccepted pending dispatch can be cancelled here; stop the exact running input instead")
		}
		accepted, e := tx.personalAgentInputAccepted(ctx, user, op.InputID)
		if e != nil {
			return e
		}
		if accepted {
			return fmt.Errorf("native input acceptance exists; reconcile its receipt before changing this dispatch")
		}
		op.Status = "cancelled"
		op.Reason = "cancelled_before_dispatch"
		op.LeaseUntil = ""
		result, e = tx.SavePersonalAgentOperation(ctx, op)
		return e
	})
	return result, err
}
