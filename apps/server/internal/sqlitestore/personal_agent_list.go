package sqlitestore

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// The person's list (store.PersonalAgentListItem, table pa_items) and the
// day the person's daily digest last went out (personal_agents
// digest_sent_on).

var _ store.PersonalAgentListStore = (*Store)(nil)

func (s *Store) setupPersonalAgentList(ctx context.Context) error {
	statements := []string{
		`CREATE TABLE IF NOT EXISTS pa_items (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL,
			text TEXT NOT NULL,
			when_text TEXT NOT NULL DEFAULT '',
			at TEXT NOT NULL DEFAULT '',
			remind INTEGER NOT NULL DEFAULT 0,
			status TEXT NOT NULL,
			quote TEXT NOT NULL DEFAULT '',
			task_id TEXT NOT NULL DEFAULT '',
			source_session_id TEXT NOT NULL DEFAULT '',
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			closed_at TEXT NOT NULL DEFAULT '',
			reminded_at TEXT NOT NULL DEFAULT ''
		)`,
		`CREATE INDEX IF NOT EXISTS idx_pa_items_user ON pa_items (user_id, status, created_at)`,
		`CREATE INDEX IF NOT EXISTS idx_pa_items_reminders ON pa_items (status, remind, at)`,
	}
	for _, statement := range statements {
		if _, err := s.conn().ExecContext(ctx, statement); err != nil {
			return fmt.Errorf("migrate sqlite personal agent list: %w", err)
		}
	}
	return s.ensureColumn(ctx, "personal_agents", "digest_sent_on",
		`ALTER TABLE personal_agents ADD COLUMN digest_sent_on TEXT NOT NULL DEFAULT ''`)
}

const itemColumns = `id, user_id, text, when_text, at, remind, status, quote, task_id, source_session_id, created_at, updated_at, closed_at, reminded_at`

func scanItem(row interface{ Scan(...any) error }) (store.PersonalAgentListItem, error) {
	var item store.PersonalAgentListItem
	err := row.Scan(&item.ID, &item.UserID, &item.Text, &item.When, &item.At, &item.Remind, &item.Status, &item.Quote,
		&item.TaskID, &item.SourceSessionID, &item.CreatedAt, &item.UpdatedAt, &item.ClosedAt, &item.RemindedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return item, store.ErrNotFound
	}
	return item, err
}

func (s *Store) queryItems(ctx context.Context, query string, args ...any) ([]store.PersonalAgentListItem, error) {
	rows, err := s.reader().QueryContext(ctx, `SELECT `+itemColumns+` FROM pa_items WHERE `+query, args...)
	if err != nil {
		return nil, fmt.Errorf("list personal agent items: %w", err)
	}
	defer rows.Close()
	items := []store.PersonalAgentListItem{}
	for rows.Next() {
		item, err := scanItem(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (s *Store) ListPersonalAgentItems(ctx context.Context, userID, closedSince string) ([]store.PersonalAgentListItem, error) {
	if closedSince == "" {
		return s.queryItems(ctx, `user_id = ? AND status = ? ORDER BY created_at, rowid`, userID, store.PersonalAgentItemOpen)
	}
	return s.queryItems(ctx, `user_id = ? AND (status = ? OR closed_at >= ?) ORDER BY created_at, rowid`,
		userID, store.PersonalAgentItemOpen, closedSince)
}

func (s *Store) GetPersonalAgentItem(ctx context.Context, userID, id string) (store.PersonalAgentListItem, error) {
	return scanItem(s.conn().QueryRowContext(ctx, `SELECT `+itemColumns+` FROM pa_items WHERE user_id = ? AND id = ?`, userID, id))
}

func (s *Store) AddPersonalAgentItem(ctx context.Context, item store.PersonalAgentListItem) (store.PersonalAgentListItem, error) {
	if item.UserID == "" || item.Text == "" {
		return item, errors.New("a list item needs a person and a text")
	}
	now := paNow()
	item.ID, item.CreatedAt, item.UpdatedAt, item.RemindedAt = paID("pai"), now, now, ""
	if item.Status == "" {
		item.Status = store.PersonalAgentItemOpen
	}
	if item.Status != store.PersonalAgentItemOpen && item.ClosedAt == "" {
		item.ClosedAt = now
	}
	_, err := s.conn().ExecContext(ctx, `INSERT INTO pa_items (`+itemColumns+`) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		item.ID, item.UserID, item.Text, item.When, item.At, item.Remind, item.Status, item.Quote, item.TaskID,
		item.SourceSessionID, item.CreatedAt, item.UpdatedAt, item.ClosedAt, item.RemindedAt)
	if err != nil {
		return item, fmt.Errorf("add personal agent item: %w", err)
	}
	return item, nil
}

// SavePersonalAgentItem stores the item's fields. Closing stamps ClosedAt
// unless given, reopening clears it; a new At clears RemindedAt.
func (s *Store) SavePersonalAgentItem(ctx context.Context, item store.PersonalAgentListItem) (store.PersonalAgentListItem, error) {
	var saved store.PersonalAgentListItem
	err := s.withTx(ctx, func(tx *Store) error {
		previous, err := tx.GetPersonalAgentItem(ctx, item.UserID, item.ID)
		if err != nil {
			return err
		}
		now := paNow()
		switch {
		case item.Status == store.PersonalAgentItemOpen:
			item.ClosedAt = ""
		case item.Status != previous.Status || item.ClosedAt == "":
			item.ClosedAt = now
		}
		if item.At != previous.At {
			item.RemindedAt = ""
		} else {
			item.RemindedAt = previous.RemindedAt
		}
		item.CreatedAt, item.UpdatedAt = previous.CreatedAt, now
		if _, err := tx.conn().ExecContext(ctx, `UPDATE pa_items SET text = ?, when_text = ?, at = ?, remind = ?, status = ?, quote = ?,
			task_id = ?, updated_at = ?, closed_at = ?, reminded_at = ? WHERE user_id = ? AND id = ?`,
			item.Text, item.When, item.At, item.Remind, item.Status, item.Quote, item.TaskID, item.UpdatedAt, item.ClosedAt,
			item.RemindedAt, item.UserID, item.ID); err != nil {
			return fmt.Errorf("save personal agent item: %w", err)
		}
		item.SourceSessionID = previous.SourceSessionID
		saved = item
		return nil
	})
	return saved, err
}

func (s *Store) DeletePersonalAgentItem(ctx context.Context, userID, id string) error {
	result, err := s.conn().ExecContext(ctx, `DELETE FROM pa_items WHERE user_id = ? AND id = ?`, userID, id)
	if err != nil {
		return fmt.Errorf("delete personal agent item: %w", err)
	}
	if count, _ := result.RowsAffected(); count == 0 {
		return store.ErrNotFound
	}
	return nil
}

// DuePersonalAgentReminders compares times as stored: RFC 3339 in UTC.
func (s *Store) DuePersonalAgentReminders(ctx context.Context, now string) ([]store.PersonalAgentListItem, error) {
	return s.queryItems(ctx, `status = ? AND remind = 1 AND at != '' AND at <= ? AND reminded_at = '' ORDER BY at, rowid`,
		store.PersonalAgentItemOpen, now)
}

func (s *Store) ClaimPersonalAgentReminder(ctx context.Context, userID, id, at string) (bool, error) {
	result, err := s.conn().ExecContext(ctx, `UPDATE pa_items SET reminded_at = ? WHERE user_id = ? AND id = ? AND at = ? AND reminded_at = ''`,
		paNow(), userID, id, at)
	if err != nil {
		return false, fmt.Errorf("claim personal agent reminder: %w", err)
	}
	count, _ := result.RowsAffected()
	return count == 1, nil
}

func (s *Store) ListPersonalAgents(ctx context.Context) ([]store.PersonalAgent, error) {
	rows, err := s.reader().QueryContext(ctx, `SELECT `+personalAgentRead+` FROM personal_agents ORDER BY user_id`)
	if err != nil {
		return nil, fmt.Errorf("list personal agents: %w", err)
	}
	defer rows.Close()
	agents := []store.PersonalAgent{}
	for rows.Next() {
		agent, err := scanPersonalAgent(rows)
		if err != nil {
			return nil, err
		}
		agents = append(agents, agent)
	}
	return agents, rows.Err()
}

func (s *Store) ClaimPersonalAgentDigest(ctx context.Context, userID, day string) (bool, error) {
	result, err := s.conn().ExecContext(ctx, `UPDATE personal_agents SET digest_sent_on = ? WHERE user_id = ? AND digest_sent_on != ?`,
		day, userID, day)
	if err != nil {
		return false, fmt.Errorf("claim personal agent digest: %w", err)
	}
	count, _ := result.RowsAffected()
	return count == 1, nil
}
