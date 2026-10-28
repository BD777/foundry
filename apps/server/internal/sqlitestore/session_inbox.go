package sqlitestore

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// setupSessionInbox keeps the messages sessions send each other until each
// reaches its session (DEV-057): one a session cannot take yet is held,
// never dropped, and the sender can see where it stands.
func (s *Store) setupSessionInbox(ctx context.Context) error {
	statements := []string{
		`CREATE TABLE IF NOT EXISTS session_inbox (
			session_id TEXT NOT NULL,
			input_id TEXT NOT NULL,
			sender_session_id TEXT NOT NULL,
			prompt TEXT NOT NULL,
			attachments_json TEXT NOT NULL DEFAULT '[]',
			requested_delivery TEXT NOT NULL,
			delivery TEXT NOT NULL,
			state TEXT NOT NULL,
			reason TEXT NOT NULL DEFAULT '',
			delivered_as TEXT NOT NULL DEFAULT '',
			delivered_input_id TEXT NOT NULL DEFAULT '',
			text_hash TEXT NOT NULL,
			attempts INTEGER NOT NULL DEFAULT 0,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			delivered_at TEXT,
			consumed_at TEXT,
			PRIMARY KEY (session_id, input_id)
		)`,
		`CREATE INDEX IF NOT EXISTS session_inbox_pending ON session_inbox (state, created_at)`,
		`CREATE INDEX IF NOT EXISTS session_inbox_sender ON session_inbox (sender_session_id, created_at)`,
		`CREATE INDEX IF NOT EXISTS session_inbox_delivered_input ON session_inbox (session_id, delivered_input_id)`,
	}
	for _, statement := range statements {
		if _, err := s.conn().ExecContext(ctx, statement); err != nil {
			return fmt.Errorf("migrate session inbox: %w", err)
		}
	}
	return nil
}

const sessionInboxColumns = `session_id, input_id, sender_session_id, prompt, attachments_json, requested_delivery,
	delivery, state, reason, delivered_as, delivered_input_id, text_hash, attempts, created_at, updated_at,
	delivered_at, consumed_at`

func scanSessionInboxItem(row interface{ Scan(...any) error }) (store.SessionInboxItem, error) {
	var item store.SessionInboxItem
	var attachments, createdAt, updatedAt string
	var deliveredAt, consumedAt sql.NullString
	if err := row.Scan(&item.SessionID, &item.InputID, &item.SenderSessionID, &item.Prompt, &attachments,
		&item.RequestedDelivery, &item.Delivery, &item.State, &item.Reason, &item.DeliveredAs, &item.DeliveredInputID,
		&item.TextHash, &item.Attempts, &createdAt, &updatedAt, &deliveredAt, &consumedAt); err != nil {
		return store.SessionInboxItem{}, err
	}
	if attachments != "" {
		if err := json.Unmarshal([]byte(attachments), &item.Attachments); err != nil {
			return store.SessionInboxItem{}, fmt.Errorf("decode inbox attachments: %w", err)
		}
	}
	item.CreatedAt = parseStoredTime(createdAt)
	item.UpdatedAt = parseStoredTime(updatedAt)
	item.DeliveredAt = parseOptionalTime(deliveredAt)
	item.ConsumedAt = parseOptionalTime(consumedAt)
	return item, nil
}

func (s *Store) sessionInboxItem(ctx context.Context, db dbExecutor, sessionID, inputID string) (store.SessionInboxItem, bool, error) {
	item, err := scanSessionInboxItem(db.QueryRowContext(ctx,
		`SELECT `+sessionInboxColumns+` FROM session_inbox WHERE session_id = ? AND input_id = ?`, sessionID, inputID))
	if errors.Is(err, sql.ErrNoRows) {
		return store.SessionInboxItem{}, false, nil
	}
	if err != nil {
		return store.SessionInboxItem{}, false, fmt.Errorf("read inbox message: %w", err)
	}
	return item, true, nil
}

// SessionInboxItem reads one message.
func (s *Store) SessionInboxItem(ctx context.Context, sessionID, inputID string) (store.SessionInboxItem, bool, error) {
	return s.sessionInboxItem(ctx, s.reader(), sessionID, inputID)
}

// AdmitSessionInboxItem holds a new message, unless it repeats one: the
// same id, or the same text from the same sender within the dedup window.
// An interrupt past its sender's allowance is admitted as a boundary.
func (s *Store) AdmitSessionInboxItem(ctx context.Context, item store.SessionInboxItem, rules store.SessionInboxRules) (store.SessionInboxAdmission, error) {
	item.SessionID, item.InputID = strings.TrimSpace(item.SessionID), strings.TrimSpace(item.InputID)
	if item.SessionID == "" || item.InputID == "" || strings.TrimSpace(item.SenderSessionID) == "" {
		return store.SessionInboxAdmission{}, errors.New("session, input and sender are required")
	}
	if !store.ValidDelivery(item.RequestedDelivery) {
		return store.SessionInboxAdmission{}, fmt.Errorf("unknown delivery %q", item.RequestedDelivery)
	}
	now := rules.Now.UTC()
	if now.IsZero() {
		now = time.Now().UTC()
	}
	if item.TextHash == "" {
		item.TextHash = store.InboxTextHash(item.Prompt, item.Attachments)
	}
	var admission store.SessionInboxAdmission
	err := s.withTx(ctx, func(tx *Store) error {
		db := tx.conn()
		if existing, ok, err := tx.sessionInboxItem(ctx, db, item.SessionID, item.InputID); err != nil {
			return err
		} else if ok {
			admission = store.SessionInboxAdmission{Item: existing, Duplicate: true}
			return nil
		}
		if rules.DedupWindow > 0 {
			repeat, err := scanSessionInboxItem(db.QueryRowContext(ctx, `SELECT `+sessionInboxColumns+` FROM session_inbox
				WHERE session_id = ? AND sender_session_id = ? AND text_hash = ? AND state != ? AND created_at >= ?
				ORDER BY created_at DESC LIMIT 1`,
				item.SessionID, item.SenderSessionID, item.TextHash, store.InboxFailed, formatTime(now.Add(-rules.DedupWindow))))
			if err == nil {
				admission = store.SessionInboxAdmission{Item: repeat, Duplicate: true}
				return nil
			}
			if !errors.Is(err, sql.ErrNoRows) {
				return fmt.Errorf("find repeated inbox message: %w", err)
			}
		}
		item.Delivery = item.RequestedDelivery
		if item.Delivery == store.DeliveryInterrupt && rules.InterruptLimit > 0 {
			var used int
			if err := db.QueryRowContext(ctx, `SELECT COUNT(*) FROM session_inbox
				WHERE sender_session_id = ? AND delivery = ? AND created_at >= ?`,
				item.SenderSessionID, store.DeliveryInterrupt, formatTime(now.Add(-rules.InterruptWindow))).Scan(&used); err != nil {
				return fmt.Errorf("count sender interrupts: %w", err)
			}
			if used >= rules.InterruptLimit {
				item.Delivery = store.DeliveryBoundary
				item.Reason = "interrupt_allowance_used"
			}
		}
		attachments, err := json.Marshal(store.NormalizeChatAttachments(item.Attachments))
		if err != nil {
			return fmt.Errorf("encode inbox attachments: %w", err)
		}
		item.State = store.InboxHeld
		item.CreatedAt, item.UpdatedAt = now, now
		if _, err := db.ExecContext(ctx, `INSERT INTO session_inbox (`+sessionInboxColumns+`)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '', '', ?, 0, ?, ?, NULL, NULL)`,
			item.SessionID, item.InputID, item.SenderSessionID, item.Prompt, string(attachments), item.RequestedDelivery,
			item.Delivery, item.State, item.Reason, item.TextHash, formatTime(now), formatTime(now)); err != nil {
			return fmt.Errorf("hold inbox message: %w", err)
		}
		admission = store.SessionInboxAdmission{Item: item}
		return nil
	})
	return admission, err
}

// ChangeSessionInboxItem moves a message to change.State when it is in one
// of change.From. changed is false when it was not.
func (s *Store) ChangeSessionInboxItem(ctx context.Context, sessionID, inputID string, change store.SessionInboxChange) (store.SessionInboxItem, bool, error) {
	at := change.At.UTC()
	if at.IsZero() {
		at = time.Now().UTC()
	}
	var item store.SessionInboxItem
	changed := false
	err := s.withTx(ctx, func(tx *Store) error {
		db := tx.conn()
		current, ok, err := tx.sessionInboxItem(ctx, db, sessionID, inputID)
		if err != nil || !ok {
			return err
		}
		item = current
		if len(change.From) > 0 && !slices.Contains(change.From, current.State) {
			return nil
		}
		next := current
		next.State = change.State
		if change.Reason != "" || change.State != current.State {
			next.Reason = change.Reason
		}
		if change.DeliveredAs != "" {
			next.DeliveredAs = change.DeliveredAs
		}
		if change.DeliveredInputID != "" {
			next.DeliveredInputID = change.DeliveredInputID
		}
		if change.CountAttempt {
			next.Attempts++
		}
		if (change.State == store.InboxDelivered || change.State == store.InboxConsumed) && next.DeliveredAt == nil {
			next.DeliveredAt = &at
		}
		if change.State == store.InboxConsumed && next.ConsumedAt == nil {
			next.ConsumedAt = &at
		}
		next.UpdatedAt = at
		if _, err := db.ExecContext(ctx, `UPDATE session_inbox SET state = ?, reason = ?, delivered_as = ?, delivered_input_id = ?,
			attempts = ?, updated_at = ?, delivered_at = ?, consumed_at = ? WHERE session_id = ? AND input_id = ?`,
			next.State, next.Reason, next.DeliveredAs, next.DeliveredInputID, next.Attempts, formatTime(at),
			optionalTime(next.DeliveredAt), optionalTime(next.ConsumedAt), sessionID, inputID); err != nil {
			return fmt.Errorf("update inbox message: %w", err)
		}
		item, changed = next, true
		return nil
	})
	return item, changed, err
}

func optionalTime(value *time.Time) any {
	if value == nil {
		return nil
	}
	return formatTime(*value)
}

// PendingSessionInboxItems lists the messages Foundry still has to place,
// oldest first.
func (s *Store) PendingSessionInboxItems(ctx context.Context) ([]store.SessionInboxItem, error) {
	return s.querySessionInbox(ctx, `SELECT `+sessionInboxColumns+` FROM session_inbox
		WHERE state IN (?, ?, ?) ORDER BY created_at, input_id`, store.InboxHeld, store.InboxUnknown, store.InboxAccepted)
}

// SessionInboxItems lists a session's messages since since, newest first.
func (s *Store) SessionInboxItems(ctx context.Context, sessionID string, since time.Time, limit int) ([]store.SessionInboxItem, error) {
	if limit <= 0 {
		limit = 50
	}
	return s.querySessionInbox(ctx, `SELECT `+sessionInboxColumns+` FROM session_inbox
		WHERE session_id = ? AND created_at >= ? ORDER BY created_at DESC LIMIT ?`, sessionID, formatTime(since), limit)
}

func (s *Store) querySessionInbox(ctx context.Context, query string, args ...any) ([]store.SessionInboxItem, error) {
	rows, err := s.reader().QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("list inbox messages: %w", err)
	}
	defer rows.Close()
	var items []store.SessionInboxItem
	for rows.Next() {
		item, err := scanSessionInboxItem(rows)
		if err != nil {
			return nil, fmt.Errorf("read inbox message: %w", err)
		}
		items = append(items, item)
	}
	return items, rows.Err()
}
