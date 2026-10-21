package sqlitestore

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"slices"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

var _ store.PersonalAgentInboxStore = (*Store)(nil)

func (s *Store) setupPersonalAgentInbox(ctx context.Context) error {
	for _, statement := range []string{
		`CREATE TABLE IF NOT EXISTS pa_inbox (
			id TEXT PRIMARY KEY, user_id TEXT NOT NULL, channel TEXT NOT NULL,
			message_id TEXT NOT NULL, text TEXT NOT NULL, status TEXT NOT NULL,
			revision INTEGER NOT NULL, input_id TEXT NOT NULL UNIQUE,
			session_id TEXT NOT NULL DEFAULT '', waiting_reason TEXT NOT NULL DEFAULT '',
			lease_until TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
			UNIQUE(user_id, channel, message_id))`,
		`CREATE INDEX IF NOT EXISTS idx_pa_inbox_user ON pa_inbox(user_id, created_at DESC)`,
		`CREATE INDEX IF NOT EXISTS idx_pa_inbox_due ON pa_inbox(status, lease_until, created_at)`,
	} {
		if _, err := s.conn().ExecContext(ctx, statement); err != nil {
			return fmt.Errorf("migrate personal agent inbox: %w", err)
		}
	}
	for _, column := range []struct{ name, definition string }{
		{"origin_json", "TEXT NOT NULL DEFAULT 'null'"},
		{"root_id", "TEXT NOT NULL DEFAULT ''"},
		{"timezone", "TEXT NOT NULL DEFAULT ''"},
		{"result_status", "TEXT NOT NULL DEFAULT ''"},
		{"result_text", "TEXT NOT NULL DEFAULT ''"},
		{"result_error", "TEXT NOT NULL DEFAULT ''"},
		{"result_truncated", "INTEGER NOT NULL DEFAULT 0"},
		{"notify_pending", "INTEGER NOT NULL DEFAULT 0"},
	} {
		if err := s.ensureColumn(ctx, "pa_inbox", column.name, "ALTER TABLE pa_inbox ADD COLUMN "+column.name+" "+column.definition); err != nil {
			return err
		}
	}
	_, err := s.conn().ExecContext(ctx, `UPDATE pa_inbox SET root_id=id WHERE root_id=''`)
	return err
}

const inboxColumns = `id,user_id,channel,message_id,text,status,revision,input_id,session_id,waiting_reason,lease_until,created_at,updated_at,origin_json,root_id,result_status,result_text,result_error,result_truncated,notify_pending,timezone`

func scanInbox(row interface{ Scan(...any) error }) (store.PersonalAgentInboxEntry, error) {
	var entry store.PersonalAgentInboxEntry
	var origin string
	err := row.Scan(&entry.ID, &entry.UserID, &entry.Channel, &entry.MessageID, &entry.Text,
		&entry.Status, &entry.Revision, &entry.InputID, &entry.SessionID, &entry.WaitingReason,
		&entry.LeaseUntil, &entry.CreatedAt, &entry.UpdatedAt, &origin, &entry.RootID,
		&entry.ResultStatus, &entry.ResultText, &entry.ResultError, &entry.ResultTruncated, &entry.NotificationPending, &entry.Timezone)
	if errors.Is(err, sql.ErrNoRows) {
		err = store.ErrNotFound
	}
	if err == nil {
		err = json.Unmarshal([]byte(origin), &entry.Origin)
	}
	return entry, err
}

func (s *Store) CapturePersonalAgentInbox(ctx context.Context, entry store.PersonalAgentInboxEntry) (store.PersonalAgentInboxEntry, error) {
	if entry.ID == "" || entry.UserID == "" || entry.MessageID == "" || entry.Text == "" ||
		!slices.Contains([]string{"web", "feishu"}, entry.Channel) || !store.ValidSessionInputID(entry.InputID) {
		return entry, errors.New("inbox requires a source, person, text and native input identity")
	}
	var saved store.PersonalAgentInboxEntry
	err := s.withTx(ctx, func(tx *Store) error {
		existing, err := scanInbox(tx.conn().QueryRowContext(ctx, `SELECT `+inboxColumns+` FROM pa_inbox
			WHERE user_id=? AND channel=? AND message_id=?`, entry.UserID, entry.Channel, entry.MessageID))
		if err == nil {
			if existing.Text != entry.Text || existing.InputID != entry.InputID || !reflect.DeepEqual(existing.Origin, entry.Origin) {
				return store.ErrIdempotencyConflict
			}
			saved = existing
			return nil
		}
		if !errors.Is(err, store.ErrNotFound) {
			return err
		}
		entry.Status, entry.Revision = "pending", 1
		if entry.RootID == "" {
			entry.RootID = entry.ID
		}
		entry.ResultStatus, entry.ResultText, entry.ResultError, entry.ResultTruncated, entry.NotificationPending = "", "", "", false, false
		entry.SessionID, entry.WaitingReason, entry.LeaseUntil = "", "", ""
		entry.CreatedAt, entry.UpdatedAt = paNow(), paNow()
		origin, err := json.Marshal(entry.Origin)
		if err != nil {
			return err
		}
		_, err = tx.conn().ExecContext(ctx, `INSERT INTO pa_inbox (`+inboxColumns+`) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
			entry.ID, entry.UserID, entry.Channel, entry.MessageID, entry.Text, entry.Status, entry.Revision,
			entry.InputID, entry.SessionID, entry.WaitingReason, entry.LeaseUntil, entry.CreatedAt, entry.UpdatedAt, string(origin),
			entry.RootID, "", "", "", false, false, entry.Timezone)
		saved = entry
		return err
	})
	return saved, err
}

func (s *Store) PersonalAgentInboxByInput(ctx context.Context, userID, inputID string) (store.PersonalAgentInboxEntry, error) {
	return scanInbox(s.reader().QueryRowContext(ctx, `SELECT `+inboxColumns+` FROM pa_inbox WHERE user_id=? AND input_id=?`, userID, inputID))
}

func (s *Store) PendingPersonalAgentInboxNotifications(ctx context.Context, now string, limit int) ([]store.PersonalAgentInboxEntry, error) {
	return s.queryInbox(ctx, `notify_pending=1 AND result_status<>'' AND (lease_until='' OR julianday(lease_until)<=julianday(?)) ORDER BY updated_at LIMIT ?`, now, min(max(limit, 1), 100))
}

func (s *Store) UnresolvedPersonalAgentInboxResults(ctx context.Context, limit int) ([]store.PersonalAgentInboxEntry, error) {
	return s.queryInbox(ctx, `status='delivered' AND result_status='' AND session_id<>'' ORDER BY created_at LIMIT ?`, min(max(limit, 1), 100))
}

func (s *Store) PersonalAgentInboxSession(ctx context.Context, userID, channel string) (string, error) {
	var id string
	err := s.reader().QueryRowContext(ctx, `SELECT session_id FROM pa_inbox WHERE user_id=? AND channel=? AND session_id<>'' ORDER BY created_at DESC,rowid DESC LIMIT 1`, userID, channel).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return "", store.ErrNotFound
	}
	return id, err
}

func (s *Store) GetPersonalAgentInbox(ctx context.Context, userID, id string) (store.PersonalAgentInboxEntry, error) {
	return scanInbox(s.reader().QueryRowContext(ctx, `SELECT `+inboxColumns+` FROM pa_inbox WHERE user_id=? AND id=?`, userID, id))
}

func (s *Store) queryInbox(ctx context.Context, where string, args ...any) ([]store.PersonalAgentInboxEntry, error) {
	rows, err := s.reader().QueryContext(ctx, `SELECT `+inboxColumns+` FROM pa_inbox WHERE `+where, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []store.PersonalAgentInboxEntry{}
	for rows.Next() {
		item, err := scanInbox(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (s *Store) ListPersonalAgentInbox(ctx context.Context, userID string, limit int) ([]store.PersonalAgentInboxEntry, error) {
	return s.queryInbox(ctx, `user_id=? ORDER BY created_at DESC,id LIMIT ?`, userID, min(max(limit, 1), 200))
}

func (s *Store) DuePersonalAgentInbox(ctx context.Context, now string, limit int) ([]store.PersonalAgentInboxEntry, error) {
	return s.queryInbox(ctx, `status IN ('pending','waiting','dispatching')
		AND (lease_until='' OR julianday(lease_until)<=julianday(?))
		AND NOT EXISTS (SELECT 1 FROM pa_inbox AS earlier
			WHERE earlier.user_id=pa_inbox.user_id AND earlier.status IN ('pending','waiting','dispatching')
			AND (earlier.created_at<pa_inbox.created_at OR
				(earlier.created_at=pa_inbox.created_at AND earlier.rowid<pa_inbox.rowid)))
		ORDER BY lease_until,created_at,id LIMIT ?`, now, min(max(limit, 1), 200))
}

func (s *Store) SavePersonalAgentInbox(ctx context.Context, entry store.PersonalAgentInboxEntry) (store.PersonalAgentInboxEntry, error) {
	if entry.Revision < 1 || !slices.Contains([]string{"pending", "waiting", "dispatching", "delivered", "resolved", "cancelled"}, entry.Status) {
		return entry, errors.New("invalid inbox update")
	}
	if entry.LeaseUntil != "" {
		if _, err := time.Parse(time.RFC3339Nano, entry.LeaseUntil); err != nil {
			return entry, errors.New("invalid inbox lease deadline")
		}
	}
	var saved store.PersonalAgentInboxEntry
	err := s.withTx(ctx, func(tx *Store) error {
		current, err := tx.GetPersonalAgentInbox(ctx, entry.UserID, entry.ID)
		if err != nil {
			return err
		}
		if current.Revision != entry.Revision {
			return store.ErrPersonalAgentRevision
		}
		if (current.Status == "resolved" || current.Status == "cancelled") && current.Status != entry.Status {
			return errors.New("closed inbox input cannot be redispatched")
		}
		if current.SessionID != "" && entry.SessionID != current.SessionID {
			return errors.New("an inbox receipt cannot change its execution")
		}
		if entry.Status == "delivered" && entry.SessionID == "" {
			return errors.New("delivered requires a session receipt")
		}
		_, err = tx.conn().ExecContext(ctx, `UPDATE pa_inbox SET status=?,revision=revision+1,session_id=?,waiting_reason=?,lease_until=?,updated_at=?,
			result_status=?,result_text=?,result_error=?,result_truncated=?,notify_pending=?
			WHERE user_id=? AND id=? AND revision=?`,
			entry.Status, entry.SessionID, entry.WaitingReason, entry.LeaseUntil, paNow(),
			entry.ResultStatus, entry.ResultText, entry.ResultError, entry.ResultTruncated, entry.NotificationPending,
			entry.UserID, entry.ID, entry.Revision)
		if err != nil {
			return err
		}
		saved, err = tx.GetPersonalAgentInbox(ctx, entry.UserID, entry.ID)
		return err
	})
	return saved, err
}

// Retry preserves the root source while giving the explicitly requested new
// attempt its own input fence. It never races an unknown/in-flight dispatch.
func (s *Store) RetryPersonalAgentInbox(ctx context.Context, userID, id string, revision int64, next store.PersonalAgentInboxEntry) (store.PersonalAgentInboxEntry, error) {
	var result store.PersonalAgentInboxEntry
	err := s.withTx(ctx, func(tx *Store) error {
		if existing, err := tx.GetPersonalAgentInbox(ctx, userID, next.ID); err == nil {
			result = existing
			return nil
		} else if !errors.Is(err, store.ErrNotFound) {
			return err
		}
		current, err := tx.GetPersonalAgentInbox(ctx, userID, id)
		if err != nil {
			return err
		}
		if current.Revision != revision {
			return store.ErrPersonalAgentRevision
		}
		if current.Status == "dispatching" || current.Status == "cancelled" || (current.Status == "resolved" && current.ResultStatus != "failed" && current.ResultStatus != "canceled") {
			return errors.New("this input cannot be retried in its current state")
		}
		if current.SessionID != "" {
			if current.ResultStatus != "failed" && current.ResultStatus != "canceled" {
				return errors.New("wait for the original input's confirmed failure before retrying")
			}
			// ResultStatus is the durable result of this exact input, not
			// the session's newer input, which may already be running.

		} else if recorded, err := tx.WorkRunInputSession(ctx, current.InputID); err == nil && recorded != "" {
			return errors.New("the previous dispatch has a receipt; reconcile it before retrying")
		} else if err != nil && !errors.Is(err, store.ErrNotFound) {
			return err
		}
		if current.SessionID == "" {
			accepted, e := tx.personalAgentInputAccepted(ctx, userID, current.InputID)
			if e != nil {
				return e
			}
			if accepted {
				return errors.New("previous input acceptance needs reconciliation before retry")
			}
		}
		next.UserID, next.Channel, next.Text, next.Origin, next.RootID = userID, current.Channel, current.Text, current.Origin, current.RootID
		next.Timezone = current.Timezone
		if current.SessionID != "" {
			control, e := scanPARunControl(tx.reader().QueryRowContext(ctx, `SELECT user_id,payload_json FROM pa_run_controls WHERE user_id=? AND input_id=?`, userID, current.InputID))
			if e != nil {
				return errors.New("the original input needs its exact native end receipt before retrying")
			}
			if control.DispatchAttempted && control.NativeEndedAt == "" {
				return errors.New("cancellation or failure is not yet confirmed by the native runtime")
			}
		}
		if _, err := tx.conn().ExecContext(ctx, `UPDATE pa_inbox SET status='cancelled',revision=revision+1,lease_until='',notify_pending=0,updated_at=? WHERE user_id=? AND id=? AND revision=?`, paNow(), userID, current.ID, current.Revision); err != nil {
			return err
		}
		result, err = tx.CapturePersonalAgentInbox(ctx, next)
		return err
	})
	return result, err
}
