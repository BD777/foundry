package sqlitestore

import (
	"cmp"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"unicode/utf8"

	"github.com/foundry-dev/foundry/apps/server/internal/personalagent/flow"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// The person's list (store.PersonalAgentListItem, table pa_items) and the
// day the assistant's daily digest last went out (assistants
// digest_sent_on).

var (
	_ store.PersonalAgentListStore        = (*Store)(nil)
	_ store.PersonalAgentItemChangeSource = (*Store)(nil)
)

func (s *Store) setupPersonalAgentList(ctx context.Context) error {
	statements := []string{
		`CREATE TABLE IF NOT EXISTS pa_items (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL,
			assistant_id TEXT NOT NULL DEFAULT '',
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
			reminded_at TEXT NOT NULL DEFAULT '',
			intent_revision INTEGER NOT NULL DEFAULT 1,
			revision INTEGER NOT NULL DEFAULT 1,
			source_input_id TEXT NOT NULL DEFAULT '',
			source_inbox_id TEXT NOT NULL DEFAULT '',
			capture_key TEXT NOT NULL DEFAULT '',
			capture_hash TEXT NOT NULL DEFAULT '',
			plan_json TEXT NOT NULL DEFAULT 'null'
		)`,
		`CREATE INDEX IF NOT EXISTS idx_pa_items_user ON pa_items (user_id, status, created_at)`,
		`CREATE INDEX IF NOT EXISTS idx_pa_items_reminders ON pa_items (status, remind, at)`,
		// The capture key is unique per assistant (setupAssistantRecords).
		`CREATE TABLE IF NOT EXISTS pa_item_events (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL DEFAULT '',
			assistant_id TEXT NOT NULL DEFAULT '',
			item_id TEXT NOT NULL,
			at TEXT NOT NULL,
			actor TEXT NOT NULL,
			kind TEXT NOT NULL,
			detail_json TEXT NOT NULL DEFAULT '{}'
		)`,
		`CREATE INDEX IF NOT EXISTS idx_pa_item_events_item ON pa_item_events (assistant_id, item_id, at)`,
	}
	statements = append(statements, itemSignalSchema...)
	for _, statement := range statements {
		if _, err := s.conn().ExecContext(ctx, statement); err != nil {
			return fmt.Errorf("migrate sqlite personal agent list: %w", err)
		}
	}
	return s.migratePersonalAgentItems(ctx)
}

// migratePersonalAgentItems adds the 「事项」 columns to pa_items and item_id to
// pa_tasks, and backfills them from the old single task link. A column is
// backfilled only by the start that adds it, so a later start never undoes
// what the person or the assistant changed since. The steps share one
// transaction: a column is never left added without its backfill.
func (s *Store) migratePersonalAgentItems(ctx context.Context) error {
	return s.withTx(ctx, func(tx *Store) error {
		added, err := tx.addColumnIfMissing(ctx, "pa_items", "owner", `TEXT NOT NULL DEFAULT 'person'`)
		if err != nil {
			return err
		}
		if added {
			if _, err := tx.conn().ExecContext(ctx, `UPDATE pa_items SET owner = 'assistant' WHERE task_id <> ''`); err != nil {
				return fmt.Errorf("migrate sqlite personal agent items: backfill owner: %w", err)
			}
		}
		for _, column := range []struct{ name, definition string }{
			{"summary", `TEXT NOT NULL DEFAULT ''`},
			{"origin_json", `TEXT NOT NULL DEFAULT ''`},
			{"archived_at", `TEXT NOT NULL DEFAULT ''`},
		} {
			if _, err := tx.addColumnIfMissing(ctx, "pa_items", column.name, column.definition); err != nil {
				return err
			}
		}
		// A linked helper's status came with its events (DEV-324).
		for _, column := range []struct{ name, definition string }{
			{"status", `TEXT NOT NULL DEFAULT 'running'`},
			{"ended_at", `TEXT NOT NULL DEFAULT ''`},
		} {
			if _, err := tx.addColumnIfMissing(ctx, "pa_item_helpers", column.name, column.definition); err != nil {
				return err
			}
		}
		added, err = tx.addColumnIfMissing(ctx, "pa_tasks", "item_id", `TEXT NOT NULL DEFAULT ''`)
		if err != nil {
			return err
		}
		if added {
			if _, err := tx.conn().ExecContext(ctx, `UPDATE pa_tasks SET item_id = (SELECT pa_items.id FROM pa_items WHERE pa_items.task_id = pa_tasks.id ORDER BY pa_items.rowid LIMIT 1)
				WHERE EXISTS (SELECT 1 FROM pa_items WHERE pa_items.task_id = pa_tasks.id)`); err != nil {
				return fmt.Errorf("migrate sqlite personal agent items: backfill task items: %w", err)
			}
		}
		if _, err := tx.conn().ExecContext(ctx, `CREATE INDEX IF NOT EXISTS idx_pa_tasks_item ON pa_tasks (assistant_id, item_id)`); err != nil {
			return fmt.Errorf("migrate sqlite personal agent items: %w", err)
		}
		// An item's home was the plan's workspaceId; from here on it is this
		// column alone, and the plans no longer carry it.
		added, err = tx.addColumnIfMissing(ctx, "pa_items", "home_workspace_id", `TEXT NOT NULL DEFAULT ''`)
		if err != nil {
			return err
		}
		if added {
			if _, err := tx.conn().ExecContext(ctx, `UPDATE pa_items SET home_workspace_id = COALESCE(json_extract(plan_json, '$.workspaceId'), ''),
				plan_json = json_remove(plan_json, '$.workspaceId')
				WHERE json_type(plan_json) = 'object' AND json_type(plan_json, '$.workspaceId') IS NOT NULL`); err != nil {
				return fmt.Errorf("migrate sqlite personal agent items: backfill home: %w", err)
			}
		}
		if _, err := tx.addColumnIfMissing(ctx, "pa_items", "holder_session_id", `TEXT NOT NULL DEFAULT ''`); err != nil {
			return err
		}
		if _, err := tx.conn().ExecContext(ctx, `CREATE INDEX IF NOT EXISTS idx_pa_items_home ON pa_items (user_id, home_workspace_id)`); err != nil {
			return fmt.Errorf("migrate sqlite personal agent items: %w", err)
		}
		return nil
	})
}

// addColumnIfMissing adds a column the table lacks and reports whether it did.
func (s *Store) addColumnIfMissing(ctx context.Context, table, column, definition string) (bool, error) {
	var present int
	if err := s.conn().QueryRowContext(ctx, `SELECT count(*) FROM pragma_table_info(?) WHERE name = ?`, table, column).Scan(&present); err != nil {
		return false, fmt.Errorf("migrate sqlite personal agent items: check %s.%s: %w", table, column, err)
	}
	if present > 0 {
		return false, nil
	}
	if _, err := s.conn().ExecContext(ctx, fmt.Sprintf(`ALTER TABLE %s ADD COLUMN %s %s`, table, column, definition)); err != nil {
		return false, fmt.Errorf("migrate sqlite personal agent items: add %s.%s: %w", table, column, err)
	}
	return true, nil
}

const itemColumns = `id, user_id, assistant_id, text, when_text, at, remind, status, quote, source_session_id, created_at, updated_at, closed_at, reminded_at, revision, source_input_id, capture_key, capture_hash, plan_json, source_inbox_id, intent_revision, owner, summary, origin_json, archived_at, home_workspace_id, holder_session_id`

func scanItem(row interface{ Scan(...any) error }) (store.PersonalAgentListItem, error) {
	var item store.PersonalAgentListItem
	var plan, origin string
	err := row.Scan(&item.ID, &item.UserID, &item.AssistantID, &item.Text, &item.When, &item.At, &item.Remind, &item.Status, &item.Quote,
		&item.SourceSessionID, &item.CreatedAt, &item.UpdatedAt, &item.ClosedAt, &item.RemindedAt,
		&item.Revision, &item.SourceInputID, &item.CaptureKey, &item.CaptureHash, &plan, &item.SourceInboxID, &item.IntentRevision,
		&item.Owner, &item.Summary, &origin, &item.ArchivedAt, &item.HomeWorkspaceID, &item.HolderSessionID)
	if errors.Is(err, sql.ErrNoRows) {
		return item, store.ErrNotFound
	}
	if err != nil {
		return item, err
	}
	if err := json.Unmarshal([]byte(plan), &item.Plan); err != nil {
		return item, fmt.Errorf("read personal agent item plan: %w", err)
	}
	if item.Plan != nil {
		item.Plan.WorkspaceID = item.HomeWorkspaceID
	}
	if origin != "" {
		item.Origin = &store.PersonalAgentItemOrigin{}
		if err := json.Unmarshal([]byte(origin), item.Origin); err != nil {
			return item, fmt.Errorf("read personal agent item origin: %w", err)
		}
	}
	return item, nil
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

func (s *Store) ListPersonalAgentItems(ctx context.Context, assistantID, closedSince string) ([]store.PersonalAgentListItem, error) {
	if closedSince == "" {
		return s.queryItems(ctx, `assistant_id = ? AND text<>'' AND status = ? ORDER BY created_at, rowid`, assistantID, store.PersonalAgentItemOpen)
	}
	return s.queryItems(ctx, `assistant_id = ? AND text<>'' AND (status = ? OR closed_at >= ?) ORDER BY created_at, rowid`,
		assistantID, store.PersonalAgentItemOpen, closedSince)
}

func (s *Store) GetPersonalAgentItem(ctx context.Context, assistantID, id string) (store.PersonalAgentListItem, error) {
	return scanItem(s.conn().QueryRowContext(ctx, `SELECT `+itemColumns+` FROM pa_items WHERE assistant_id = ? AND id = ?`, assistantID, id))
}

func (s *Store) GetPersonalAgentItemOfUser(ctx context.Context, userID, id string) (store.PersonalAgentListItem, error) {
	item, err := scanItem(s.conn().QueryRowContext(ctx, `SELECT `+itemColumns+` FROM pa_items WHERE user_id = ? AND id = ?`, userID, id))
	if err == nil && item.Text == "" {
		return item, store.ErrNotFound
	}
	return item, err
}

func (s *Store) AddPersonalAgentItem(ctx context.Context, actor string, item store.PersonalAgentListItem) (store.PersonalAgentListItem, error) {
	if item.UserID == "" || item.AssistantID == "" || item.Text == "" {
		return item, errors.New("a list item needs a person and a text")
	}
	var saved store.PersonalAgentListItem
	err := s.withTx(ctx, func(tx *Store) error {
		if item.CaptureKey != "" {
			existing, err := scanItem(tx.conn().QueryRowContext(ctx, `SELECT `+itemColumns+` FROM pa_items WHERE assistant_id=? AND capture_key=?`, item.AssistantID, item.CaptureKey))
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
		saved, err = tx.addPersonalAgentItem(ctx, actor, item)
		return err
	})
	return saved, err
}

func (s *Store) addPersonalAgentItem(ctx context.Context, actor string, item store.PersonalAgentListItem) (store.PersonalAgentListItem, error) {
	if err := checkItemFields(actor, item); err != nil {
		return item, err
	}
	now := paNow()
	item.Revision = 1
	item.IntentRevision = 1
	item.ID, item.CreatedAt, item.UpdatedAt, item.RemindedAt, item.ArchivedAt = paID("pai"), now, now, "", ""
	if item.Status == "" {
		item.Status = store.PersonalAgentItemOpen
	}
	if item.Status != store.PersonalAgentItemOpen && item.ClosedAt == "" {
		item.ClosedAt = now
	}
	if item.Owner == "" {
		item.Owner = store.PersonalAgentItemOwnerPerson
	}
	item.HolderSessionID = ""
	home, err := s.itemHome(ctx, item.AssistantID, item.HomeWorkspaceID)
	if err != nil {
		return item, err
	}
	item.HomeWorkspaceID = home
	plan, err := encodeItemPlan(item.Plan)
	if err != nil {
		return item, err
	}
	origin, err := encodeItemOrigin(item.Origin)
	if err != nil {
		return item, err
	}
	_, err = s.conn().ExecContext(ctx, `INSERT INTO pa_items (`+itemColumns+`) VALUES (`+sqlPlaceholders(27)+`)`,
		item.ID, item.UserID, item.AssistantID, item.Text, item.When, item.At, item.Remind, item.Status, item.Quote,
		item.SourceSessionID, item.CreatedAt, item.UpdatedAt, item.ClosedAt, item.RemindedAt,
		item.Revision, item.SourceInputID, item.CaptureKey, item.CaptureHash, plan, item.SourceInboxID, item.IntentRevision,
		item.Owner, item.Summary, origin, item.ArchivedAt, item.HomeWorkspaceID, item.HolderSessionID)
	if err != nil {
		return item, fmt.Errorf("add personal agent item: %w", err)
	}
	if err := s.checkItemDependencies(ctx, item); err != nil {
		return item, err
	}
	if err := s.recordItemEvent(ctx, item, now, actor, store.PersonalAgentItemEventCreated, store.PersonalAgentItemEventDetail{}); err != nil {
		return item, err
	}
	if item.Plan != nil {
		item.Plan.WorkspaceID = item.HomeWorkspaceID
	}
	return item, nil
}

// SavePersonalAgentItem stores the item's fields. Closing stamps ClosedAt
// unless given, reopening clears it and restores an archived item; a new At
// clears RemindedAt. Owner and origin that are left empty stay as they are,
// and so does the archive unless reopening clears it.
func (s *Store) SavePersonalAgentItem(ctx context.Context, actor string, item store.PersonalAgentListItem) (store.PersonalAgentListItem, error) {
	if err := checkActor(actor); err != nil {
		return store.PersonalAgentListItem{}, err
	}
	var saved store.PersonalAgentListItem
	err := s.withTx(ctx, func(tx *Store) error {
		previous, err := tx.GetPersonalAgentItem(ctx, item.AssistantID, item.ID)
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
		item.Owner = cmp.Or(item.Owner, previous.Owner)
		item.Origin, item.ArchivedAt = previous.Origin, previous.ArchivedAt
		item.HolderSessionID = previous.HolderSessionID
		if item.HomeWorkspaceID, err = tx.itemHome(ctx, item.AssistantID, item.HomeWorkspaceID); err != nil {
			return err
		}
		if err := checkItemFields(actor, item); err != nil {
			return err
		}
		plan, err := encodeItemPlan(item.Plan)
		if err != nil {
			return err
		}
		now := paNow()
		switch {
		case item.Status == store.PersonalAgentItemOpen:
			item.ClosedAt = ""
			item.ArchivedAt = ""
		case item.Status != previous.Status || item.ClosedAt == "":
			item.ClosedAt = now
		}
		if item.At != previous.At {
			item.RemindedAt = ""
		} else {
			item.RemindedAt = previous.RemindedAt
		}
		item.CreatedAt, item.UpdatedAt = previous.CreatedAt, now
		item.SourceSessionID = previous.SourceSessionID
		if err := tx.checkItemDependencies(ctx, item); err != nil {
			return err
		}
		if _, err := tx.conn().ExecContext(ctx, `UPDATE pa_items SET text = ?, when_text = ?, at = ?, remind = ?, status = ?, quote = ?,
			updated_at = ?, closed_at = ?, reminded_at = ?, revision = ?, plan_json = ?, intent_revision = ?, owner = ?, summary = ?, archived_at = ?,
			home_workspace_id = ?
			WHERE assistant_id = ? AND id = ?`,
			item.Text, item.When, item.At, item.Remind, item.Status, item.Quote, item.UpdatedAt, item.ClosedAt,
			item.RemindedAt, item.Revision, plan, item.IntentRevision, item.Owner, item.Summary, item.ArchivedAt,
			item.HomeWorkspaceID, item.AssistantID, item.ID); err != nil {
			return fmt.Errorf("save personal agent item: %w", err)
		}
		if err := tx.recordItemChanges(ctx, actor, now, previous, item); err != nil {
			return err
		}
		// A plan change (progress, next action, evidence) records no event.
		tx.itemChanged(item, previous.HomeWorkspaceID, item.HomeWorkspaceID)
		if item.Plan != nil {
			item.Plan.WorkspaceID = item.HomeWorkspaceID
		}
		saved = item
		return nil
	})
	return saved, err
}

// recordItemChanges writes the timeline events of what a save changed: the
// words or time, owner, status, summary, and an archive cleared by reopening.
func (s *Store) recordItemChanges(ctx context.Context, actor, now string, previous, item store.PersonalAgentListItem) error {
	record := func(kind string, detail store.PersonalAgentItemEventDetail) error {
		return s.recordItemEvent(ctx, previous, now, actor, kind, detail)
	}
	if previous.Text != item.Text || previous.When != item.When || previous.At != item.At {
		if err := record(store.PersonalAgentItemEventEdited, store.PersonalAgentItemEventDetail{}); err != nil {
			return err
		}
	}
	if previous.Owner != item.Owner {
		if err := record(store.PersonalAgentItemEventOwnerChanged, store.PersonalAgentItemEventDetail{From: previous.Owner, To: item.Owner}); err != nil {
			return err
		}
	}
	if previous.Status != item.Status {
		if err := record(store.PersonalAgentItemEventStatusChanged, store.PersonalAgentItemEventDetail{From: previous.Status, To: item.Status}); err != nil {
			return err
		}
	}
	if previous.Summary != item.Summary {
		if err := record(store.PersonalAgentItemEventSummaryUpdated, store.PersonalAgentItemEventDetail{}); err != nil {
			return err
		}
	}
	if previous.HomeWorkspaceID != item.HomeWorkspaceID {
		if err := record(store.PersonalAgentItemEventRehomed, store.PersonalAgentItemEventDetail{From: previous.HomeWorkspaceID, To: item.HomeWorkspaceID}); err != nil {
			return err
		}
	}
	if previous.ArchivedAt != "" && item.ArchivedAt == "" {
		return record(store.PersonalAgentItemEventRestored, store.PersonalAgentItemEventDetail{})
	}
	return nil
}

// Runs inside the same write transaction as an item change. Two concurrent
// edge edits therefore cannot each validate a stale graph and create a cycle.
func (s *Store) checkItemDependencies(ctx context.Context, changed store.PersonalAgentListItem) error {
	if changed.Plan == nil || len(changed.Plan.Dependencies) == 0 {
		return nil
	}
	items, err := s.ListPersonalAgentItems(ctx, changed.AssistantID, "0001-01-01")
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
	graph[changed.ID] = changed.Plan.Dependencies
	if err := flow.CheckItemDependencies(changed.ID, graph); err != nil {
		return fmt.Errorf("%w: %v", store.ErrPersonalAgentItemInvalid, err)
	}
	return nil
}

// DeletePersonalAgentItem is the person's delete. The item's timeline and its
// helpers' link go with it; a helper still running keeps its session.
func (s *Store) DeletePersonalAgentItem(ctx context.Context, assistantID, id string) error {
	return s.withTx(ctx, func(tx *Store) error {
		item, err := tx.GetPersonalAgentItem(ctx, assistantID, id)
		if err != nil {
			return err
		}
		if item.Text == "" {
			return store.ErrNotFound
		}
		var used bool
		if err := tx.conn().QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM pa_items,json_each(pa_items.plan_json,'$.dependencies') AS dep WHERE assistant_id=? AND dep.value=?)`, assistantID, id).Scan(&used); err != nil {
			return err
		}
		if used {
			return fmt.Errorf("this item is a dependency; remove its links or mark it dropped instead")
		}
		if _, err := tx.conn().ExecContext(ctx, `DELETE FROM pa_item_events WHERE assistant_id=? AND item_id=?`, assistantID, id); err != nil {
			return fmt.Errorf("delete personal agent item events: %w", err)
		}
		if _, err := tx.conn().ExecContext(ctx, `UPDATE pa_tasks SET item_id='' WHERE assistant_id=? AND item_id=?`, assistantID, id); err != nil {
			return fmt.Errorf("unlink personal agent item helpers: %w", err)
		}
		for _, table := range []string{"pa_item_helpers", "pa_item_signals"} {
			if _, err := tx.conn().ExecContext(ctx, `DELETE FROM `+table+` WHERE assistant_id=? AND item_id=?`, assistantID, id); err != nil {
				return fmt.Errorf("delete personal agent item %s: %w", table, err)
			}
		}
		if item.CaptureKey != "" {
			// Keep only the identity fence. A replay after a person's delete
			// must not resurrect the original words or launch the work again.
			_, err = tx.conn().ExecContext(ctx, `UPDATE pa_items SET text='',quote='',when_text='',at='',remind=0,summary='',origin_json='',plan_json='null',home_workspace_id='',holder_session_id='',status='dropped',revision=revision+1,closed_at=?,updated_at=? WHERE assistant_id=? AND id=?`, paNow(), paNow(), assistantID, id)
		} else {
			_, err = tx.conn().ExecContext(ctx, `DELETE FROM pa_items WHERE assistant_id=? AND id=?`, assistantID, id)
		}
		if err == nil {
			tx.itemChanged(item, item.HomeWorkspaceID)
		}
		return err
	})
}

// DuePersonalAgentReminders compares times as stored: RFC 3339 in UTC.
func (s *Store) DuePersonalAgentReminders(ctx context.Context, now string) ([]store.PersonalAgentListItem, error) {
	return s.queryItems(ctx, `status = ? AND remind = 1 AND at != '' AND at <= ? AND reminded_at = '' ORDER BY at, rowid`,
		store.PersonalAgentItemOpen, now)
}

func (s *Store) ClaimPersonalAgentReminder(ctx context.Context, assistantID, id, at string) (bool, error) {
	result, err := s.conn().ExecContext(ctx, `UPDATE pa_items SET reminded_at = ? WHERE assistant_id = ? AND id = ? AND at = ? AND reminded_at = ''`,
		paNow(), assistantID, id, at)
	if err != nil {
		return false, fmt.Errorf("claim personal agent reminder: %w", err)
	}
	count, _ := result.RowsAffected()
	return count == 1, nil
}

func (s *Store) ListPersonalAgents(ctx context.Context) ([]store.PersonalAgent, error) {
	return s.queryAssistants(ctx, `1 ORDER BY owner_user_id, is_default DESC, created_at, id`)
}

func (s *Store) ClaimPersonalAgentDigest(ctx context.Context, assistantID, day string) (bool, error) {
	result, err := s.conn().ExecContext(ctx, `UPDATE assistants SET digest_sent_on = ? WHERE id = ? AND digest_sent_on != ?`,
		day, assistantID, day)
	if err != nil {
		return false, fmt.Errorf("claim personal agent digest: %w", err)
	}
	count, _ := result.RowsAffected()
	return count == 1, nil
}

// checkItemFields refuses what a write would store that the contract does not allow:
// an unknown owner or origin kind, a summary over its limit, and an unknown actor.
func checkItemFields(actor string, item store.PersonalAgentListItem) error {
	if err := checkActor(actor); err != nil {
		return err
	}
	switch item.Owner {
	case "", store.PersonalAgentItemOwnerPerson, store.PersonalAgentItemOwnerAssistant:
	default:
		return fmt.Errorf("%w: owner %q is neither person nor assistant", store.ErrPersonalAgentItemInvalid, item.Owner)
	}
	if utf8.RuneCountInString(item.Summary) > store.PersonalAgentItemSummaryMaxLength {
		return fmt.Errorf("%w: summary is longer than %d characters", store.ErrPersonalAgentItemInvalid, store.PersonalAgentItemSummaryMaxLength)
	}
	if item.Origin != nil {
		switch item.Origin.Kind {
		case store.PersonalAgentItemOriginWeb, store.PersonalAgentItemOriginChannel, store.PersonalAgentItemOriginSelfChat:
		default:
			return fmt.Errorf("%w: origin kind %q is not web, channel or self_chat", store.ErrPersonalAgentItemInvalid, item.Origin.Kind)
		}
	}
	return nil
}

// checkActor refuses an actor outside the three that may cause a change.
func checkActor(actor string) error {
	switch actor {
	case store.PersonalAgentActorPerson, store.PersonalAgentActorAssistant, store.PersonalAgentActorFoundry, store.PersonalAgentActorSession:
		return nil
	}
	return fmt.Errorf("unknown personal agent actor %q", actor)
}

// encodeItemPlan is plan_json: the plan without its workspaceId, which is
// the item's home (home_workspace_id).
func encodeItemPlan(plan *store.PersonalAgentItemPlan) (string, error) {
	if plan != nil {
		stored := *plan
		stored.WorkspaceID = ""
		plan = &stored
	}
	raw, err := json.Marshal(plan)
	if err != nil {
		return "", fmt.Errorf("encode personal agent item plan: %w", err)
	}
	return string(raw), nil
}

func encodeItemOrigin(origin *store.PersonalAgentItemOrigin) (string, error) {
	if origin == nil {
		return "", nil
	}
	raw, err := json.Marshal(origin)
	if err != nil {
		return "", fmt.Errorf("encode personal agent item origin: %w", err)
	}
	return string(raw), nil
}

// sqlPlaceholders is "?, ?, …" for n values.
func sqlPlaceholders(n int) string {
	return strings.TrimSuffix(strings.Repeat("?, ", n), ", ")
}

// Operational progress and references do not mint a new authorization identity.
func sameItemIntent(a, b store.PersonalAgentListItem) bool {
	normalize := func(i store.PersonalAgentListItem) any {
		var mode, workspace, action string
		var dependencies []string
		clarify := false
		workspace = i.HomeWorkspaceID
		if i.Plan != nil {
			mode = i.Plan.Mode
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
