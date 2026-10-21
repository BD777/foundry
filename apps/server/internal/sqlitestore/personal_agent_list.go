package sqlitestore

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"

	"github.com/foundry-dev/foundry/apps/server/internal/personalagent/flow"
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
	for _, column := range []struct{ name, definition string }{
		{"intent_revision", "INTEGER NOT NULL DEFAULT 1"},
		{"revision", "INTEGER NOT NULL DEFAULT 1"},
		{"source_input_id", "TEXT NOT NULL DEFAULT ''"},
		{"source_inbox_id", "TEXT NOT NULL DEFAULT ''"},
		{"capture_key", "TEXT NOT NULL DEFAULT ''"},
		{"capture_hash", "TEXT NOT NULL DEFAULT ''"},
		{"plan_json", "TEXT NOT NULL DEFAULT 'null'"},
	} {
		if err := s.ensureColumn(ctx, "pa_items", column.name, "ALTER TABLE pa_items ADD COLUMN "+column.name+" "+column.definition); err != nil {
			return err
		}
	}
	if _, err := s.conn().ExecContext(ctx, `CREATE UNIQUE INDEX IF NOT EXISTS idx_pa_items_capture ON pa_items(user_id,capture_key) WHERE capture_key<>''`); err != nil {
		return err
	}
	return s.ensureColumn(ctx, "personal_agents", "digest_sent_on",
		`ALTER TABLE personal_agents ADD COLUMN digest_sent_on TEXT NOT NULL DEFAULT ''`)
}

const itemColumns = `id, user_id, text, when_text, at, remind, status, quote, task_id, source_session_id, created_at, updated_at, closed_at, reminded_at, revision,source_input_id,capture_key,capture_hash,plan_json,source_inbox_id,intent_revision`

func scanItem(row interface{ Scan(...any) error }) (store.PersonalAgentListItem, error) {
	var item store.PersonalAgentListItem
	var plan string
	err := row.Scan(&item.ID, &item.UserID, &item.Text, &item.When, &item.At, &item.Remind, &item.Status, &item.Quote,
		&item.TaskID, &item.SourceSessionID, &item.CreatedAt, &item.UpdatedAt, &item.ClosedAt, &item.RemindedAt,
		&item.Revision, &item.SourceInputID, &item.CaptureKey, &item.CaptureHash, &plan, &item.SourceInboxID, &item.IntentRevision)
	if errors.Is(err, sql.ErrNoRows) {
		return item, store.ErrNotFound
	}
	if err == nil {
		err = json.Unmarshal([]byte(plan), &item.Plan)
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
		return s.queryItems(ctx, `user_id = ? AND text<>'' AND status = ? ORDER BY created_at, rowid`, userID, store.PersonalAgentItemOpen)
	}
	return s.queryItems(ctx, `user_id = ? AND text<>'' AND (status = ? OR closed_at >= ?) ORDER BY created_at, rowid`,
		userID, store.PersonalAgentItemOpen, closedSince)
}

func (s *Store) GetPersonalAgentItem(ctx context.Context, userID, id string) (store.PersonalAgentListItem, error) {
	return scanItem(s.conn().QueryRowContext(ctx, `SELECT `+itemColumns+` FROM pa_items WHERE user_id = ? AND id = ?`, userID, id))
}

func (s *Store) AddPersonalAgentItem(ctx context.Context, item store.PersonalAgentListItem) (store.PersonalAgentListItem, error) {
	if item.UserID == "" || item.Text == "" {
		return item, errors.New("a list item needs a person and a text")
	}
	var saved store.PersonalAgentListItem
	err := s.withTx(ctx, func(tx *Store) error {
		if item.CaptureKey != "" {
			existing, err := scanItem(tx.conn().QueryRowContext(ctx, `SELECT `+itemColumns+` FROM pa_items WHERE user_id=? AND capture_key=?`, item.UserID, item.CaptureKey))
			if err == nil {
				if existing.CaptureHash != item.CaptureHash {
					return store.ErrIdempotencyConflict
				}
				saved = existing
				return nil
			}
			if !errors.Is(err, store.ErrNotFound) {
				return err
			}
		}
		var err error
		saved, err = tx.addPersonalAgentItem(ctx, item)
		return err
	})
	return saved, err
}

func (s *Store) addPersonalAgentItem(ctx context.Context, item store.PersonalAgentListItem) (store.PersonalAgentListItem, error) {
	now := paNow()
	item.Revision = 1
	item.IntentRevision = 1
	item.ID, item.CreatedAt, item.UpdatedAt, item.RemindedAt = paID("pai"), now, now, ""
	if item.Status == "" {
		item.Status = store.PersonalAgentItemOpen
	}
	if item.Status != store.PersonalAgentItemOpen && item.ClosedAt == "" {
		item.ClosedAt = now
	}
	plan, err := json.Marshal(item.Plan)
	if err != nil {
		return item, err
	}
	_, err = s.conn().ExecContext(ctx, `INSERT INTO pa_items (`+itemColumns+`) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,?,?,?,?,?,?,?)`,
		item.ID, item.UserID, item.Text, item.When, item.At, item.Remind, item.Status, item.Quote, item.TaskID,
		item.SourceSessionID, item.CreatedAt, item.UpdatedAt, item.ClosedAt, item.RemindedAt,
		item.Revision, item.SourceInputID, item.CaptureKey, item.CaptureHash, string(plan), item.SourceInboxID, item.IntentRevision)
	if err != nil {
		return item, fmt.Errorf("add personal agent item: %w", err)
	}
	if err := s.checkItemDependencies(ctx, item); err != nil {
		return item, err
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
		if previous.Text == "" {
			return store.ErrNotFound
		}
		if item.Revision != 0 && item.Revision != previous.Revision {
			return store.ErrPersonalAgentRevision
		}
		item.Revision = previous.Revision + 1
		item.IntentRevision = previous.IntentRevision
		if !sameItemIntent(previous, item) {
			item.IntentRevision++
		}
		item.SourceInputID, item.CaptureKey, item.CaptureHash = previous.SourceInputID, previous.CaptureKey, previous.CaptureHash
		item.SourceInboxID = previous.SourceInboxID
		plan, err := json.Marshal(item.Plan)
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
			task_id = ?, updated_at = ?, closed_at = ?, reminded_at = ?,revision=?,plan_json=?,intent_revision=? WHERE user_id = ? AND id = ?`,
			item.Text, item.When, item.At, item.Remind, item.Status, item.Quote, item.TaskID, item.UpdatedAt, item.ClosedAt,
			item.RemindedAt, item.Revision, string(plan), item.IntentRevision, item.UserID, item.ID); err != nil {
			return fmt.Errorf("save personal agent item: %w", err)
		}
		item.SourceSessionID = previous.SourceSessionID
		if err := tx.checkItemDependencies(ctx, item); err != nil {
			return err
		}
		saved = item
		return nil
	})
	return saved, err
}

// Runs inside the same write transaction as an item change. Two concurrent
// edge edits therefore cannot each validate a stale graph and create a cycle.
func (s *Store) checkItemDependencies(ctx context.Context, changed store.PersonalAgentListItem) error {
	if changed.Plan == nil || len(changed.Plan.Dependencies) == 0 {
		return nil
	}
	items, err := s.ListPersonalAgentItems(ctx, changed.UserID, "0001-01-01")
	if err != nil {
		return err
	}
	graph := map[string][]string{}
	for _, item := range items {
		graph[item.ID] = nil
		if item.Plan != nil {
			graph[item.ID] = item.Plan.Dependencies
		}
	}
	return flow.CheckItemDependencies(changed.ID, graph)
}

func (s *Store) DeletePersonalAgentItem(ctx context.Context, userID, id string) error {
	return s.withTx(ctx, func(tx *Store) error {
		item, err := tx.GetPersonalAgentItem(ctx, userID, id)
		if err != nil {
			return err
		}
		if item.Text == "" {
			return store.ErrNotFound
		}
		var used bool
		if err := tx.conn().QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM pa_items,json_each(pa_items.plan_json,'$.dependencies') AS dep WHERE user_id=? AND dep.value=?)`, userID, id).Scan(&used); err != nil {
			return err
		}
		if used {
			return fmt.Errorf("this item is a dependency; remove its links or mark it dropped instead")
		}
		if item.CaptureKey != "" {
			// Keep only the identity fence. A replay after a person's delete
			// must not resurrect the original words or launch the work again.
			_, err = tx.conn().ExecContext(ctx, `UPDATE pa_items SET text='',quote='',when_text='',at='',remind=0,task_id='',plan_json='null',status='dropped',revision=revision+1,closed_at=?,updated_at=? WHERE user_id=? AND id=?`, paNow(), paNow(), userID, id)
		} else {
			_, err = tx.conn().ExecContext(ctx, `DELETE FROM pa_items WHERE user_id=? AND id=?`, userID, id)
		}
		return err
	})
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

// Operational progress and references do not mint a new authorization identity.
func sameItemIntent(a, b store.PersonalAgentListItem) bool {
	normalize := func(i store.PersonalAgentListItem) any {
		var mode, workspace, action string
		var dependencies []string
		clarify := false
		if i.Plan != nil {
			mode = i.Plan.Mode
			workspace = i.Plan.WorkspaceID
			action = i.Plan.NextAction
			dependencies = i.Plan.Dependencies
			if i.Plan.Route != nil {
				clarify = i.Plan.Route.NeedsClarification || i.Plan.Route.Kind == "clarify"
			}
		}
		return struct {
			Text, When, Status, Mode, Workspace, Action string
			Dependencies                                []string
			Clarify                                     bool
		}{i.Text, i.When, i.Status, mode, workspace, action, dependencies, clarify}
	}
	return reflect.DeepEqual(normalize(a), normalize(b))
}
