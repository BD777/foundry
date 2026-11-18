package sqlitestore

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// personNoticeTimeLayout is fixed-width, so the due check compares stored
// times as text.
const personNoticeTimeLayout = "2006-01-02T15:04:05.000Z"

// setupPersonNotices keeps the notices sent about items that wait for the
// person (DEV-294). A notice names its item; the item's workspace, session
// or Issue owns the rows (workspaceOwnedRows), and its assistant's records
// go with the assistant (assistantRecordTables).
func (s *Store) setupPersonNotices(ctx context.Context) error {
	statements := []string{
		`CREATE TABLE IF NOT EXISTS person_notices (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL,
			assistant_id TEXT NOT NULL DEFAULT '',
			item_id TEXT NOT NULL,
			kind TEXT NOT NULL,
			title TEXT NOT NULL DEFAULT '',
			text TEXT NOT NULL DEFAULT '',
			options_json TEXT NOT NULL DEFAULT '[]',
			allow_free_text INTEGER NOT NULL DEFAULT 0,
			link TEXT NOT NULL DEFAULT '',
			sink_id TEXT NOT NULL,
			target TEXT NOT NULL DEFAULT '',
			provider_message_id TEXT NOT NULL DEFAULT '',
			state TEXT NOT NULL,
			attempts INTEGER NOT NULL DEFAULT 0,
			next_attempt_at TEXT NOT NULL DEFAULT '',
			ambiguous_at TEXT NOT NULL DEFAULT '',
			error_reason TEXT NOT NULL DEFAULT '',
			answered_by TEXT NOT NULL DEFAULT '',
			answer_text TEXT NOT NULL DEFAULT '',
			card_stale INTEGER NOT NULL DEFAULT 0,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)`,
		// One live notice per item: a second one waits until this one ends.
		`CREATE UNIQUE INDEX IF NOT EXISTS person_notices_active_item ON person_notices (item_id)
			WHERE state IN ('queued', 'sending', 'sent')`,
		`CREATE INDEX IF NOT EXISTS person_notices_due ON person_notices (state, next_attempt_at)`,
		`CREATE INDEX IF NOT EXISTS person_notices_item ON person_notices (item_id, created_at)`,
		`CREATE INDEX IF NOT EXISTS person_notices_message ON person_notices (sink_id, provider_message_id)`,
	}
	for _, statement := range statements {
		if _, err := s.conn().ExecContext(ctx, statement); err != nil {
			return fmt.Errorf("migrate person notices: %w", err)
		}
	}
	return s.addPersonNoticeCardStaleColumn(ctx)
}

// addPersonNoticeCardStaleColumn adds card_stale to notice tables made before
// sent messages were refreshed; fresh databases get it from setupPersonNotices.
func (s *Store) addPersonNoticeCardStaleColumn(ctx context.Context) error {
	var present int
	if err := s.conn().QueryRowContext(ctx, `SELECT count(*) FROM pragma_table_info('person_notices') WHERE name = 'card_stale'`).Scan(&present); err != nil {
		return fmt.Errorf("check person notice card column: %w", err)
	}
	if present > 0 {
		return nil
	}
	if _, err := s.conn().ExecContext(ctx, `ALTER TABLE person_notices ADD COLUMN card_stale INTEGER NOT NULL DEFAULT 0`); err != nil {
		return fmt.Errorf("add person notice card column: %w", err)
	}
	return nil
}

const personNoticeColumns = `id, user_id, assistant_id, item_id, kind, title, text, options_json, allow_free_text, link, sink_id, target, provider_message_id, state, attempts, next_attempt_at, ambiguous_at, error_reason, answered_by, answer_text, created_at, updated_at`

// personNoticeActive is the SQL list of the active states, with its values.
func personNoticeActive() (string, []any) {
	marks := make([]string, len(store.NoticeActiveStates))
	args := make([]any, len(store.NoticeActiveStates))
	for index, state := range store.NoticeActiveStates {
		marks[index] = "?"
		args[index] = state
	}
	return strings.Join(marks, ", "), args
}

func personNoticeTimeText(value time.Time) string {
	if value.IsZero() {
		return ""
	}
	return value.UTC().Format(personNoticeTimeLayout)
}

func scanPersonNotice(row interface{ Scan(...any) error }) (store.PersonNotice, error) {
	var notice store.PersonNotice
	var optionsJSON, nextAttemptAt, ambiguousAt, createdAt, updatedAt string
	var allowFreeText int
	err := row.Scan(&notice.ID, &notice.UserID, &notice.AssistantID, &notice.ItemID, &notice.Kind, &notice.Title,
		&notice.Text, &optionsJSON, &allowFreeText, &notice.Link, &notice.SinkID, &notice.Target,
		&notice.ProviderMessageID, &notice.State, &notice.Attempts, &nextAttemptAt, &ambiguousAt,
		&notice.ErrorReason, &notice.AnsweredBy, &notice.AnswerText, &createdAt, &updatedAt)
	if err != nil {
		return store.PersonNotice{}, err
	}
	if err := json.Unmarshal([]byte(optionsJSON), &notice.Options); err != nil {
		return store.PersonNotice{}, fmt.Errorf("read person notice options: %w", err)
	}
	notice.AllowFreeText = allowFreeText != 0
	notice.NextAttemptAt = parseStoredTime(nextAttemptAt)
	notice.AmbiguousAt = parseStoredTime(ambiguousAt)
	notice.CreatedAt = parseStoredTime(createdAt)
	notice.UpdatedAt = parseStoredTime(updatedAt)
	return notice, nil
}

func queryPersonNotices(ctx context.Context, db dbExecutor, query string, args ...any) ([]store.PersonNotice, error) {
	var notices []store.PersonNotice
	err := scanRows(ctx, db, query, func(rows *sql.Rows) error {
		notice, err := scanPersonNotice(rows)
		if err != nil {
			return err
		}
		notices = append(notices, notice)
		return nil
	}, args...)
	if err != nil {
		return nil, fmt.Errorf("read person notices: %w", err)
	}
	return notices, nil
}

// CreatePersonNotice inserts the notice unless its item already has an
// active one, which it returns with false.
func (s *Store) CreatePersonNotice(ctx context.Context, notice store.PersonNotice) (store.PersonNotice, bool, error) {
	options := notice.Options
	if options == nil {
		options = []store.PersonNoticeOption{}
	}
	optionsJSON, err := json.Marshal(options)
	if err != nil {
		return store.PersonNotice{}, false, fmt.Errorf("encode person notice options: %w", err)
	}
	allowFreeText := 0
	if notice.AllowFreeText {
		allowFreeText = 1
	}
	created := false
	var existing []store.PersonNotice
	err = s.withTx(ctx, func(tx *Store) error {
		activeMarks, activeArgs := personNoticeActive()
		args := []any{
			notice.ID, notice.UserID, notice.AssistantID, notice.ItemID, notice.Kind, notice.Title, notice.Text,
			string(optionsJSON), allowFreeText, notice.Link, notice.SinkID, notice.Target, notice.ProviderMessageID,
			notice.State, notice.Attempts, personNoticeTimeText(notice.NextAttemptAt), personNoticeTimeText(notice.AmbiguousAt),
			notice.ErrorReason, notice.AnsweredBy, notice.AnswerText,
			personNoticeTimeText(notice.CreatedAt), personNoticeTimeText(notice.UpdatedAt),
			notice.ItemID,
		}
		args = append(args, activeArgs...)
		result, err := tx.conn().ExecContext(ctx, `INSERT INTO person_notices (`+personNoticeColumns+`)
			SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
			WHERE NOT EXISTS (SELECT 1 FROM person_notices WHERE item_id = ? AND state IN (`+activeMarks+`))`, args...)
		if err != nil {
			return fmt.Errorf("create person notice: %w", err)
		}
		if affected, _ := result.RowsAffected(); affected == 1 {
			created = true
			return nil
		}
		existing, err = queryPersonNotices(ctx, tx.conn(),
			`SELECT `+personNoticeColumns+` FROM person_notices WHERE item_id = ? AND state IN (`+activeMarks+`) LIMIT 1`,
			append([]any{notice.ItemID}, activeArgs...)...)
		return err
	})
	if err != nil {
		return store.PersonNotice{}, false, err
	}
	if created {
		return notice, true, nil
	}
	if len(existing) == 0 {
		return store.PersonNotice{}, false, fmt.Errorf("person notice for item %s was refused but none is active", notice.ItemID)
	}
	return existing[0], false, nil
}

func (s *Store) DuePersonNotices(ctx context.Context, now time.Time, limit int) ([]store.PersonNotice, error) {
	return queryPersonNotices(ctx, s.reader(),
		`SELECT `+personNoticeColumns+` FROM person_notices WHERE state = ? AND next_attempt_at <= ?
			ORDER BY next_attempt_at, created_at, id LIMIT ?`,
		store.NoticeQueued, personNoticeTimeText(now), limit)
}

func (s *Store) ClaimPersonNotice(ctx context.Context, id string, at time.Time) (store.PersonNotice, bool, error) {
	var claimed []store.PersonNotice
	err := s.withTx(ctx, func(tx *Store) error {
		result, err := tx.conn().ExecContext(ctx, `UPDATE person_notices SET state = ?, attempts = attempts + 1, updated_at = ?
			WHERE id = ? AND state = ?`, store.NoticeSending, personNoticeTimeText(at), id, store.NoticeQueued)
		if err != nil {
			return fmt.Errorf("claim person notice: %w", err)
		}
		if affected, _ := result.RowsAffected(); affected == 0 {
			return nil
		}
		claimed, err = queryPersonNotices(ctx, tx.conn(), `SELECT `+personNoticeColumns+` FROM person_notices WHERE id = ?`, id)
		return err
	})
	if err != nil {
		return store.PersonNotice{}, false, err
	}
	if len(claimed) == 0 {
		return store.PersonNotice{}, false, nil
	}
	return claimed[0], true, nil
}

func (s *Store) SettlePersonNotice(ctx context.Context, id string, settlement store.PersonNoticeSettlement) (bool, error) {
	result, err := s.conn().ExecContext(ctx, `UPDATE person_notices SET state = ?, provider_message_id = ?, next_attempt_at = ?,
		ambiguous_at = ?, error_reason = ?, updated_at = ? WHERE id = ? AND state = ?`,
		settlement.State, settlement.ProviderMessageID, personNoticeTimeText(settlement.NextAttemptAt),
		personNoticeTimeText(settlement.AmbiguousAt), settlement.ErrorReason, personNoticeTimeText(settlement.At),
		id, store.NoticeSending)
	if err != nil {
		return false, fmt.Errorf("settle person notice: %w", err)
	}
	affected, _ := result.RowsAffected()
	return affected == 1, nil
}

func (s *Store) FailPersonNotice(ctx context.Context, id, reason string, at time.Time) (bool, error) {
	result, err := s.conn().ExecContext(ctx, `UPDATE person_notices SET state = ?, error_reason = ?, updated_at = ?
		WHERE id = ? AND state IN (?, ?)`, store.NoticeFailed, reason, personNoticeTimeText(at), id, store.NoticeQueued, store.NoticeSending)
	if err != nil {
		return false, fmt.Errorf("fail person notice: %w", err)
	}
	affected, _ := result.RowsAffected()
	return affected == 1, nil
}

func (s *Store) SupersedePersonNotices(ctx context.Context, itemID string, at time.Time) (int, error) {
	activeMarks, activeArgs := personNoticeActive()
	result, err := s.conn().ExecContext(ctx, `UPDATE person_notices SET state = ?, updated_at = ?, card_stale = 1
		WHERE item_id = ? AND state IN (`+activeMarks+`)`,
		append([]any{store.NoticeSuperseded, personNoticeTimeText(at), itemID}, activeArgs...)...)
	if err != nil {
		return 0, fmt.Errorf("supersede person notices: %w", err)
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return 0, fmt.Errorf("count superseded person notices: %w", err)
	}
	return int(affected), nil
}

func (s *Store) RecoverStalePersonNotices(ctx context.Context, before, at time.Time) (int, error) {
	stamp := personNoticeTimeText(at)
	result, err := s.conn().ExecContext(ctx, `UPDATE person_notices SET state = ?, next_attempt_at = ?,
		ambiguous_at = CASE WHEN ambiguous_at = '' THEN ? ELSE ambiguous_at END, updated_at = ?
		WHERE state = ? AND updated_at < ?`,
		store.NoticeQueued, stamp, stamp, stamp, store.NoticeSending, personNoticeTimeText(before))
	if err != nil {
		return 0, fmt.Errorf("recover stale person notices: %w", err)
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return 0, fmt.Errorf("count recovered person notices: %w", err)
	}
	return int(affected), nil
}

// AnswerPersonNotice takes a sent notice's answer. The state check is the
// compare-and-set that lets only the first reply settle the notice.
func (s *Store) AnswerPersonNotice(ctx context.Context, id, by, text string, at time.Time) (bool, error) {
	result, err := s.conn().ExecContext(ctx, `UPDATE person_notices SET state = ?, answered_by = ?, answer_text = ?, updated_at = ?, card_stale = 1
		WHERE id = ? AND state = ?`, store.NoticeAnswered, by, text, personNoticeTimeText(at), id, store.NoticeSent)
	return singleRowChanged(result, err, "answer person notice")
}

func (s *Store) PersonNoticesNeedingRefresh(ctx context.Context, limit int) ([]store.PersonNotice, error) {
	return queryPersonNotices(ctx, s.conn(), `SELECT `+personNoticeColumns+` FROM person_notices
		WHERE card_stale = 1 ORDER BY updated_at, id LIMIT ?`, limit)
}

func (s *Store) ClearPersonNoticeRefresh(ctx context.Context, id, state string) (bool, error) {
	result, err := s.conn().ExecContext(ctx, `UPDATE person_notices SET card_stale = 0 WHERE id = ? AND state = ?`, id, state)
	return singleRowChanged(result, err, "clear person notice refresh")
}

func (s *Store) ReopenPersonNotice(ctx context.Context, id string, at time.Time) (bool, error) {
	result, err := s.conn().ExecContext(ctx, `UPDATE person_notices SET state = ?, answered_by = '', answer_text = '', updated_at = ?
		WHERE id = ? AND state = ?`, store.NoticeSent, personNoticeTimeText(at), id, store.NoticeAnswered)
	return singleRowChanged(result, err, "reopen person notice")
}

func (s *Store) PersonNoticeByMessage(ctx context.Context, sinkID, providerMessageID string) (store.PersonNotice, bool, error) {
	notices, err := queryPersonNotices(ctx, s.reader(),
		`SELECT `+personNoticeColumns+` FROM person_notices WHERE sink_id = ? AND provider_message_id = ? ORDER BY updated_at DESC LIMIT 1`,
		sinkID, providerMessageID)
	if err != nil || len(notices) == 0 {
		return store.PersonNotice{}, false, err
	}
	return notices[0], true, nil
}

func singleRowChanged(result sql.Result, err error, action string) (bool, error) {
	if err != nil {
		return false, fmt.Errorf("%s: %w", action, err)
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return false, fmt.Errorf("count rows to %s: %w", action, err)
	}
	return affected == 1, nil
}

func (s *Store) PersonNoticesOfItem(ctx context.Context, itemID string) ([]store.PersonNotice, error) {
	return queryPersonNotices(ctx, s.reader(),
		`SELECT `+personNoticeColumns+` FROM person_notices WHERE item_id = ? ORDER BY created_at, id`, itemID)
}

var _ store.PersonNoticeStore = (*Store)(nil)

// PersonNoticeSentIDs returns the provider message ids of the sink's notices
// updated since the time: a notice has one only once a send was accepted.
func (s *Store) PersonNoticeSentIDs(ctx context.Context, sinkID string, since time.Time) ([]string, error) {
	rows, err := s.conn().QueryContext(ctx, `SELECT provider_message_id FROM person_notices
		WHERE sink_id = ? AND provider_message_id != '' AND updated_at >= ? ORDER BY updated_at`,
		sinkID, personNoticeTimeText(since))
	if err != nil {
		return nil, fmt.Errorf("list sent person notices: %w", err)
	}
	defer rows.Close()
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, fmt.Errorf("read a sent person notice: %w", err)
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read sent person notices: %w", err)
	}
	return ids, nil
}
