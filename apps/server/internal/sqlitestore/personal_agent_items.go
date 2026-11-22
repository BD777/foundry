package sqlitestore

import (
	"context"
	"encoding/json"
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// 「事项」 beyond the list's basics (personal_agent_list.go): the timeline
// (pa_item_events), archive, the items page, the review of a range, and the
// time rule that archives closed items. Times are compared as instants
// (julianday): stored times carry varying fractional seconds, which their
// text order does not follow.

// recordItemEvent appends one fact to an item's timeline, in the transaction
// of the change it records.
func (s *Store) recordItemEvent(ctx context.Context, item store.PersonalAgentListItem, at, actor, kind string, detail store.PersonalAgentItemEventDetail) error {
	_, err := s.recordItemEventID(ctx, item, at, actor, kind, detail)
	return err
}

// recordItemEventID is recordItemEvent answering the new event's id.
func (s *Store) recordItemEventID(ctx context.Context, item store.PersonalAgentListItem, at, actor, kind string, detail store.PersonalAgentItemEventDetail) (string, error) {
	if err := checkActor(actor); err != nil {
		return "", err
	}
	raw, err := json.Marshal(detail)
	if err != nil {
		return "", fmt.Errorf("encode personal agent item event: %w", err)
	}
	id := paID("pie")
	if _, err := s.conn().ExecContext(ctx, `INSERT INTO pa_item_events (id, user_id, assistant_id, item_id, at, actor, kind, detail_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		id, item.UserID, item.AssistantID, item.ID, at, actor, kind, string(raw)); err != nil {
		return "", fmt.Errorf("record personal agent item event: %w", err)
	}
	homes := []string{item.HomeWorkspaceID}
	if kind == store.PersonalAgentItemEventRehomed {
		homes = append(homes, detail.From, detail.To)
	}
	s.itemChanged(item, homes...)
	return id, nil
}

// ObservePersonalAgentItemChanges sets the one observer of item changes.
func (s *Store) ObservePersonalAgentItemChanges(observer func(store.PersonalAgentItemChange)) {
	s.itemChanges = observer
}

// itemChanged tells the observer that the item changed in the given homes.
func (s *Store) itemChanged(item store.PersonalAgentListItem, homes ...string) {
	if s.itemChanges == nil {
		return
	}
	change := store.PersonalAgentItemChange{AssistantID: item.AssistantID, ItemID: item.ID}
	for _, home := range homes {
		if home != "" && !slices.Contains(change.Workspaces, home) {
			change.Workspaces = append(change.Workspaces, home)
		}
	}
	if len(change.Workspaces) > 0 {
		s.itemChanges(change)
	}
}

// ListPersonalAgentItemsAtHome lists the person's live items whose home is
// the workspace, with their helpers.
func (s *Store) ListPersonalAgentItemsAtHome(ctx context.Context, userID, workspaceID string) ([]store.PersonalAgentListItem, map[string][]store.PersonalAgentTask, error) {
	if userID == "" || workspaceID == "" {
		return []store.PersonalAgentListItem{}, map[string][]store.PersonalAgentTask{}, nil
	}
	items, err := s.queryItems(ctx, `user_id = ? AND home_workspace_id = ? AND archived_at = '' AND text != '' ORDER BY id`, userID, workspaceID)
	if err != nil {
		return nil, nil, err
	}
	helpers, err := s.itemHelpers(ctx, "", items)
	if err != nil {
		return nil, nil, err
	}
	return items, helpers, nil
}

func (s *Store) PersonalAgentItemsWereHomedIn(ctx context.Context, workspaceID string) (bool, error) {
	if workspaceID == "" {
		return false, nil
	}
	var homed bool
	if err := s.reader().QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM pa_items WHERE home_workspace_id = ?)
		OR EXISTS(SELECT 1 FROM pa_item_events WHERE kind = ? AND json_extract(detail_json, '$.from') = ?)`,
		workspaceID, store.PersonalAgentItemEventRehomed, workspaceID).Scan(&homed); err != nil {
		return false, fmt.Errorf("check items homed in workspace: %w", err)
	}
	return homed, nil
}

// ListPersonalAgentItemEvents lists an item's timeline, oldest first.
func (s *Store) ListPersonalAgentItemEvents(ctx context.Context, assistantID, itemID string) ([]store.PersonalAgentItemEvent, error) {
	rows, err := s.reader().QueryContext(ctx, `SELECT id, item_id, at, actor, kind, detail_json FROM pa_item_events
		WHERE assistant_id = ? AND item_id = ? ORDER BY julianday(at), rowid`, assistantID, itemID)
	if err != nil {
		return nil, fmt.Errorf("list personal agent item events: %w", err)
	}
	defer rows.Close()
	events := []store.PersonalAgentItemEvent{}
	for rows.Next() {
		var event store.PersonalAgentItemEvent
		var detailJSON string
		if err := rows.Scan(&event.ID, &event.ItemID, &event.At, &event.Actor, &event.Kind, &detailJSON); err != nil {
			return nil, fmt.Errorf("read personal agent item event: %w", err)
		}
		var detail store.PersonalAgentItemEventDetail
		if err := json.Unmarshal([]byte(detailJSON), &detail); err != nil {
			return nil, fmt.Errorf("read personal agent item event detail: %w", err)
		}
		if detail != (store.PersonalAgentItemEventDetail{}) {
			event.Detail = &detail
		}
		events = append(events, event)
	}
	return events, rows.Err()
}

// SetPersonalAgentItemArchived archives a closed item no helper of which
// runs, or restores it. Archiving or restoring an item already in that state
// changes nothing. It returns the sessions of the item's helpers, which go
// with the item.
func (s *Store) SetPersonalAgentItemArchived(ctx context.Context, actor, assistantID, id string, archived bool) ([]string, error) {
	if err := checkActor(actor); err != nil {
		return nil, err
	}
	var sessions []string
	err := s.withTx(ctx, func(tx *Store) error {
		item, err := tx.GetPersonalAgentItem(ctx, assistantID, id)
		if err != nil {
			return err
		}
		if item.Text == "" {
			return store.ErrNotFound
		}
		if (item.ArchivedAt != "") != archived {
			if err := tx.setItemArchived(ctx, actor, item, archived, paNow()); err != nil {
				return err
			}
		}
		sessions, err = tx.helperSessionIDs(ctx, assistantID, id)
		return err
	})
	return sessions, err
}

// SavePersonalAgentItemArchive saves an item as SavePersonalAgentItem does
// and archives or restores it as SetPersonalAgentItemArchived does, in one
// transaction. An archive the item cannot take is refused before the save
// writes anything; a save the store refuses (a stale revision, an invalid
// field, a dependency cycle) rolls the archive back with it. It returns the
// saved item and the sessions of its helpers.
func (s *Store) SavePersonalAgentItemArchive(ctx context.Context, actor string, item store.PersonalAgentListItem, archived bool) (store.PersonalAgentListItem, []string, error) {
	if err := checkActor(actor); err != nil {
		return store.PersonalAgentListItem{}, nil, err
	}
	var saved store.PersonalAgentListItem
	var sessions []string
	err := s.withTx(ctx, func(tx *Store) error {
		if archived {
			if err := tx.checkItemArchivable(ctx, item); err != nil {
				return err
			}
		}
		var err error
		if saved, err = tx.SavePersonalAgentItem(ctx, actor, item); err != nil {
			return err
		}
		if sessions, err = tx.SetPersonalAgentItemArchived(ctx, actor, item.AssistantID, item.ID, archived); err != nil {
			return err
		}
		saved, err = tx.GetPersonalAgentItem(ctx, item.AssistantID, item.ID)
		return err
	})
	return saved, sessions, err
}

// RecordPersonalAgentItemSessionEvent records that the archive or restore of
// an item took one of its helper sessions, once the session archive has taken
// it. kind is archived or restored.
func (s *Store) RecordPersonalAgentItemSessionEvent(ctx context.Context, actor, assistantID, itemID, kind, sessionID string) error {
	if kind != store.PersonalAgentItemEventArchived && kind != store.PersonalAgentItemEventRestored {
		return fmt.Errorf("%w: session event kind %q is neither archived nor restored", store.ErrPersonalAgentItemInvalid, kind)
	}
	item, err := s.GetPersonalAgentItem(ctx, assistantID, itemID)
	if err != nil {
		return err
	}
	return s.recordItemEvent(ctx, item, paNow(), actor, kind, store.PersonalAgentItemEventDetail{SessionID: sessionID})
}

// setItemArchived archives a closed item that no helper of it runs for, or
// restores it, and records the change for actor.
func (s *Store) setItemArchived(ctx context.Context, actor string, item store.PersonalAgentListItem, archived bool, now string) error {
	kind, archivedAt := store.PersonalAgentItemEventRestored, ""
	if archived {
		if err := s.checkItemArchivable(ctx, item); err != nil {
			return err
		}
		kind, archivedAt = store.PersonalAgentItemEventArchived, now
	}
	if _, err := s.conn().ExecContext(ctx, `UPDATE pa_items SET archived_at = ?, updated_at = ? WHERE assistant_id = ? AND id = ?`,
		archivedAt, now, item.AssistantID, item.ID); err != nil {
		return fmt.Errorf("set personal agent item archived: %w", err)
	}
	return s.recordItemEvent(ctx, item, now, actor, kind, store.PersonalAgentItemEventDetail{})
}

// checkItemArchivable refuses an archive of an item that is open or has a helper running.
func (s *Store) checkItemArchivable(ctx context.Context, item store.PersonalAgentListItem) error {
	if item.Status == store.PersonalAgentItemOpen {
		return store.ErrPersonalAgentItemNotArchivable
	}
	running, err := s.hasRunningHelper(ctx, item.AssistantID, item.ID)
	if err != nil {
		return err
	}
	if running {
		return store.ErrPersonalAgentItemNotArchivable
	}
	return nil
}

// hasRunningHelper reports whether a helper of the item is queued, running or asking.
func (s *Store) hasRunningHelper(ctx context.Context, assistantID, itemID string) (bool, error) {
	var running bool
	if err := s.conn().QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM pa_tasks WHERE assistant_id = ? AND item_id = ? AND status IN (?, ?, ?))`,
		assistantID, itemID, store.PersonalAgentTaskQueued, store.PersonalAgentTaskRunning, store.PersonalAgentTaskAsking).Scan(&running); err != nil {
		return false, fmt.Errorf("check personal agent item helpers: %w", err)
	}
	return running, nil
}

// helperSessionIDs lists the sessions of the item's helpers, oldest first.
func (s *Store) helperSessionIDs(ctx context.Context, assistantID, itemID string) ([]string, error) {
	rows, err := s.reader().QueryContext(ctx, `SELECT session_id FROM pa_tasks WHERE assistant_id = ? AND item_id = ? AND session_id <> '' ORDER BY created_at, rowid`,
		assistantID, itemID)
	if err != nil {
		return nil, fmt.Errorf("list personal agent item sessions: %w", err)
	}
	defer rows.Close()
	sessions := []string{}
	for rows.Next() {
		var sessionID string
		if err := rows.Scan(&sessionID); err != nil {
			return nil, fmt.Errorf("read personal agent item session: %w", err)
		}
		sessions = append(sessions, sessionID)
	}
	return sessions, rows.Err()
}

// SweepArchiveFinishedItems is the time rule: an item closed at least after
// ago, with no helper running, is archived as Foundry. It returns the items
// and the sessions of their helpers.
func (s *Store) SweepArchiveFinishedItems(ctx context.Context, now time.Time, after time.Duration) ([]store.PersonalAgentArchivedItem, error) {
	at, cutoff := formatTime(now), formatTime(now.Add(-after))
	archived := []store.PersonalAgentArchivedItem{}
	err := s.withTx(ctx, func(tx *Store) error {
		items, err := tx.queryItems(ctx, `text <> '' AND archived_at = '' AND status IN (?, ?) AND closed_at <> '' AND julianday(closed_at) <= julianday(?)
			AND NOT EXISTS (SELECT 1 FROM pa_tasks WHERE pa_tasks.assistant_id = pa_items.assistant_id AND pa_tasks.item_id = pa_items.id AND pa_tasks.status IN (?, ?, ?))
			ORDER BY julianday(closed_at), rowid`,
			store.PersonalAgentItemDone, store.PersonalAgentItemDropped, cutoff,
			store.PersonalAgentTaskQueued, store.PersonalAgentTaskRunning, store.PersonalAgentTaskAsking)
		if err != nil {
			return fmt.Errorf("find finished personal agent items: %w", err)
		}
		for _, item := range items {
			if err := tx.setItemArchived(ctx, store.PersonalAgentActorFoundry, item, true, at); err != nil {
				return err
			}
			sessions, err := tx.helperSessionIDs(ctx, item.AssistantID, item.ID)
			if err != nil {
				return err
			}
			archived = append(archived, store.PersonalAgentArchivedItem{AssistantID: item.AssistantID, ItemID: item.ID, SessionIDs: sessions})
		}
		return nil
	})
	return archived, err
}

func (s *Store) ClaimPersonalAgentItem(ctx context.Context, actor, assistantID, id, sessionID string) (store.PersonalAgentListItem, string, error) {
	if sessionID == "" {
		return store.PersonalAgentListItem{}, "", fmt.Errorf("%w: a claim names the session that holds the item", store.ErrPersonalAgentItemInvalid)
	}
	var saved store.PersonalAgentListItem
	var replaced string
	err := s.withTx(ctx, func(tx *Store) error {
		item, err := tx.GetPersonalAgentItem(ctx, assistantID, id)
		if err != nil {
			return err
		}
		if item.Text == "" {
			return store.ErrNotFound
		}
		if item.HolderSessionID == sessionID {
			saved = item
			return nil
		}
		replaced = item.HolderSessionID
		if err := tx.setItemHolder(ctx, actor, item, sessionID, store.PersonalAgentItemEventClaimed,
			store.PersonalAgentItemEventDetail{SessionID: sessionID, From: replaced}); err != nil {
			return err
		}
		saved, err = tx.GetPersonalAgentItem(ctx, assistantID, id)
		return err
	})
	return saved, replaced, err
}

func (s *Store) DecidePersonalAgentItem(ctx context.Context, actor, assistantID, id string, decision store.PersonalAgentItemEventDetail) (store.PersonalAgentListItem, string, error) {
	if strings.TrimSpace(decision.Decision) == "" || strings.TrimSpace(decision.Quote) == "" {
		return store.PersonalAgentListItem{}, "", fmt.Errorf("%w: a decision names what was decided and the person's words it rests on", store.ErrPersonalAgentItemInvalid)
	}
	detail := store.PersonalAgentItemEventDetail{Decision: decision.Decision, Quote: decision.Quote, Supersedes: decision.Supersedes}
	var saved store.PersonalAgentListItem
	var eventID string
	err := s.withTx(ctx, func(tx *Store) error {
		item, err := tx.GetPersonalAgentItem(ctx, assistantID, id)
		if err != nil {
			return err
		}
		if item.Text == "" {
			return store.ErrNotFound
		}
		if detail.Supersedes != "" {
			var found int
			if err := tx.conn().QueryRowContext(ctx, `SELECT COUNT(*) FROM pa_item_events WHERE assistant_id = ? AND item_id = ? AND id = ? AND kind = ?`,
				assistantID, id, detail.Supersedes, store.PersonalAgentItemEventDecided).Scan(&found); err != nil {
				return fmt.Errorf("find superseded decision: %w", err)
			}
			if found == 0 {
				return fmt.Errorf("%w: supersedes %q is not a decision of this item", store.ErrPersonalAgentItemInvalid, detail.Supersedes)
			}
		}
		now := paNow()
		if _, err := tx.conn().ExecContext(ctx, `UPDATE pa_items SET revision = revision + 1, intent_revision = intent_revision + 1, updated_at = ? WHERE assistant_id = ? AND id = ?`,
			now, assistantID, id); err != nil {
			return fmt.Errorf("record personal agent item decision: %w", err)
		}
		if eventID, err = tx.recordItemEventID(ctx, item, now, actor, store.PersonalAgentItemEventDecided, detail); err != nil {
			return err
		}
		saved, err = tx.GetPersonalAgentItem(ctx, assistantID, id)
		return err
	})
	return saved, eventID, err
}

func (s *Store) ReleasePersonalAgentItem(ctx context.Context, actor, assistantID, id, sessionID string) (store.PersonalAgentListItem, bool, error) {
	var saved store.PersonalAgentListItem
	released := false
	err := s.withTx(ctx, func(tx *Store) error {
		item, err := tx.GetPersonalAgentItem(ctx, assistantID, id)
		if err != nil {
			return err
		}
		if item.Text == "" {
			return store.ErrNotFound
		}
		saved = item
		if sessionID == "" || item.HolderSessionID != sessionID {
			return nil
		}
		if err := tx.setItemHolder(ctx, actor, item, "", store.PersonalAgentItemEventReleased,
			store.PersonalAgentItemEventDetail{SessionID: sessionID}); err != nil {
			return err
		}
		released = true
		saved, err = tx.GetPersonalAgentItem(ctx, assistantID, id)
		return err
	})
	return saved, released, err
}

// setItemHolder stores the item's holder and records the claim or release. A
// holder change is not an edit of the item: it bumps updated_at, not revision.
func (s *Store) setItemHolder(ctx context.Context, actor string, item store.PersonalAgentListItem, holder, kind string, detail store.PersonalAgentItemEventDetail) error {
	if err := checkActor(actor); err != nil {
		return err
	}
	now := paNow()
	if _, err := s.conn().ExecContext(ctx, `UPDATE pa_items SET holder_session_id = ?, updated_at = ? WHERE assistant_id = ? AND id = ?`,
		holder, now, item.AssistantID, item.ID); err != nil {
		return fmt.Errorf("set personal agent item holder: %w", err)
	}
	return s.recordItemEvent(ctx, item, now, actor, kind, detail)
}

// detachItemsFromDeleted returns the items homed in workspaces being deleted
// to the assistant's inbox, each recorded as rehomed by Foundry, and releases
// the items held by sessions being deleted. workspaces and sessions are SQL
// sets binding the deleted owner's id to ?1: one workspace when it is
// deleted, a device's workspaces and sessions when the device is purged. The
// home is a field a save writes back, so the revision moves: a save read
// before the deletion cannot restore the deleted home. It answers how many
// items it changed.
func (s *Store) detachItemsFromDeleted(ctx context.Context, owner, workspaces, sessions string) (int64, error) {
	items, err := s.queryItems(ctx, `home_workspace_id IN (`+workspaces+`) ORDER BY rowid`, owner)
	if err != nil {
		return 0, fmt.Errorf("find items homed in deleted workspaces: %w", err)
	}
	now := paNow()
	for _, item := range items {
		if _, err := s.conn().ExecContext(ctx, `UPDATE pa_items SET home_workspace_id = '', revision = revision + 1, intent_revision = intent_revision + 1, updated_at = ? WHERE assistant_id = ? AND id = ?`,
			now, item.AssistantID, item.ID); err != nil {
			return 0, fmt.Errorf("rehome personal agent item: %w", err)
		}
		from := item.HomeWorkspaceID
		item.HomeWorkspaceID = ""
		if err := s.recordItemEvent(ctx, item, now, store.PersonalAgentActorFoundry, store.PersonalAgentItemEventRehomed,
			store.PersonalAgentItemEventDetail{From: from}); err != nil {
			return 0, err
		}
	}
	held, err := s.queryItems(ctx, `holder_session_id IN (`+sessions+`) ORDER BY rowid`, owner)
	if err != nil {
		return 0, fmt.Errorf("find items held by deleted sessions: %w", err)
	}
	for _, item := range held {
		if err := s.setItemHolder(ctx, store.PersonalAgentActorFoundry, item, "", store.PersonalAgentItemEventReleased,
			store.PersonalAgentItemEventDetail{SessionID: item.HolderSessionID}); err != nil {
			return 0, err
		}
	}
	return int64(len(items) + len(held)), nil
}

// recordHelperEvents writes the helper events of a task change on its item:
// started when the task joins one, ended when it reaches a final status. A
// helper event bumps the item's updated_at, not its revision. Any other
// status change (queued, running, asking) records nothing: its item is only
// told, so the item's files show it.
func (s *Store) recordHelperEvents(ctx context.Context, actor, now string, previous, next store.PersonalAgentTask) error {
	if next.ItemID == "" {
		return nil
	}
	started := next.ItemID != previous.ItemID
	ended := helperFinished(next.Status) && (started || !helperFinished(previous.Status))
	if !started && !ended && next.Status == previous.Status {
		return nil
	}
	item, err := s.GetPersonalAgentItem(ctx, next.AssistantID, next.ItemID)
	if err != nil {
		return fmt.Errorf("record helper event on item %s: %w", next.ItemID, err)
	}
	if !started && !ended {
		s.itemChanged(item, item.HomeWorkspaceID)
		return nil
	}
	detail := store.PersonalAgentItemEventDetail{SessionID: next.SessionID, WorkspaceID: next.WorkspaceID, Title: next.Title}
	if started {
		if err := s.recordItemEvent(ctx, item, now, actor, store.PersonalAgentItemEventHelperStarted, detail); err != nil {
			return err
		}
	}
	if ended {
		detail.To = next.Status
		if err := s.recordItemEvent(ctx, item, now, actor, store.PersonalAgentItemEventHelperEnded, detail); err != nil {
			return err
		}
	}
	if _, err := s.conn().ExecContext(ctx, `UPDATE pa_items SET updated_at = ? WHERE assistant_id = ? AND id = ?`, now, next.AssistantID, next.ItemID); err != nil {
		return fmt.Errorf("touch personal agent item: %w", err)
	}
	return nil
}

// helperFinished reports whether a helper's status is final.
func helperFinished(status string) bool {
	switch status {
	case store.PersonalAgentTaskDone, store.PersonalAgentTaskFailed, store.PersonalAgentTaskCancelled:
		return true
	}
	return false
}

// itemSearchEscaper escapes a LIKE pattern's wildcards.
var itemSearchEscaper = strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`)

// ListPersonalAgentItemPage lists one page of the items of the filter, newest
// updated first, with the helpers of the items on it.
func (s *Store) ListPersonalAgentItemPage(ctx context.Context, assistantID string, filter store.PersonalAgentItemFilter) (store.PersonalAgentItemPage, error) {
	where := []string{"assistant_id = ?", "text <> ''"}
	args := []any{assistantID}
	if assistantID == "" {
		if filter.UserID == "" {
			return store.PersonalAgentItemPage{}, fmt.Errorf("%w: a page of items needs an assistant or a person", store.ErrPersonalAgentItemInvalid)
		}
		where[0], args[0] = "user_id = ?", filter.UserID
	}
	if filter.WorkspaceID != "" {
		// Home, or touched: a helper of either kind runs there.
		where = append(where, `(home_workspace_id = ? OR EXISTS (SELECT 1 FROM pa_tasks WHERE pa_tasks.assistant_id = pa_items.assistant_id
			AND pa_tasks.item_id = pa_items.id AND pa_tasks.workspace_id = ?) OR EXISTS (SELECT 1 FROM pa_item_helpers h
			JOIN agent_sessions a ON a.id = h.session_id WHERE h.assistant_id = pa_items.assistant_id AND h.item_id = pa_items.id AND a.workspace_id = ?))`)
		args = append(args, filter.WorkspaceID, filter.WorkspaceID, filter.WorkspaceID)
	}
	if filter.Inbox {
		if filter.WorkspaceID != "" {
			return store.PersonalAgentItemPage{}, fmt.Errorf("%w: a page of items is of a workspace or of the inbox, not both", store.ErrPersonalAgentItemInvalid)
		}
		where = append(where, "home_workspace_id = ''")
	}
	archivedView := false
	if filter.ClosedSince != "" {
		if _, err := parseInstant("closedSince", filter.ClosedSince); err != nil {
			return store.PersonalAgentItemPage{}, err
		}
		where = append(where, "(status = ? OR (closed_at <> '' AND julianday(closed_at) >= julianday(?)))")
		args = append(args, store.PersonalAgentItemOpen, filter.ClosedSince)
	} else {
		switch filter.View {
		case "", store.PersonalAgentItemViewOpen:
			where = append(where, "status = ?")
			args = append(args, store.PersonalAgentItemOpen)
		case store.PersonalAgentItemViewFinished:
			where = append(where, "status IN (?, ?)")
			args = append(args, store.PersonalAgentItemDone, store.PersonalAgentItemDropped)
		case store.PersonalAgentItemViewArchived:
			archivedView = true
			where = append(where, "archived_at <> ''")
		case store.PersonalAgentItemViewAll:
		default:
			return store.PersonalAgentItemPage{}, fmt.Errorf("%w: view %q is not open, finished, archived or all", store.ErrPersonalAgentItemInvalid, filter.View)
		}
	}
	if !archivedView && !filter.IncludeArchived {
		where = append(where, "archived_at = ''")
	}
	switch filter.Status {
	case "":
	case store.PersonalAgentItemOpen, store.PersonalAgentItemDone, store.PersonalAgentItemDropped:
		where = append(where, "status = ?")
		args = append(args, filter.Status)
	default:
		return store.PersonalAgentItemPage{}, fmt.Errorf("%w: status %q is not open, done or dropped", store.ErrPersonalAgentItemInvalid, filter.Status)
	}
	switch filter.Owner {
	case "":
	case store.PersonalAgentItemOwnerPerson, store.PersonalAgentItemOwnerAssistant:
		where = append(where, "owner = ?")
		args = append(args, filter.Owner)
	default:
		return store.PersonalAgentItemPage{}, fmt.Errorf("%w: owner %q is neither person nor assistant", store.ErrPersonalAgentItemInvalid, filter.Owner)
	}
	if filter.From != "" {
		if _, err := parseInstant("from", filter.From); err != nil {
			return store.PersonalAgentItemPage{}, err
		}
		where = append(where, "julianday(updated_at) >= julianday(?)")
		args = append(args, filter.From)
	}
	if filter.To != "" {
		if _, err := parseInstant("to", filter.To); err != nil {
			return store.PersonalAgentItemPage{}, err
		}
		where = append(where, "julianday(updated_at) < julianday(?)")
		args = append(args, filter.To)
	}
	if query := strings.TrimSpace(filter.Query); query != "" {
		pattern := "%" + itemSearchEscaper.Replace(query) + "%"
		where = append(where, `(LOWER(text) LIKE LOWER(?) ESCAPE '\' OR LOWER(summary) LIKE LOWER(?) ESCAPE '\')`)
		args = append(args, pattern, pattern)
	}
	condition := strings.Join(where, " AND ")

	var total int
	if err := s.reader().QueryRowContext(ctx, `SELECT COUNT(*) FROM pa_items WHERE `+condition, args...).Scan(&total); err != nil {
		return store.PersonalAgentItemPage{}, fmt.Errorf("count personal agent items: %w", err)
	}
	limit, offset := filter.Limit, max(filter.Offset, 0)
	switch {
	case limit <= 0:
		limit = store.PersonalAgentItemPageDefault
	case limit > store.PersonalAgentItemPageMax:
		limit = store.PersonalAgentItemPageMax
	}
	items, err := s.queryItems(ctx, condition+` ORDER BY julianday(updated_at) DESC, rowid DESC LIMIT ? OFFSET ?`, append(args, limit, offset)...)
	if err != nil {
		return store.PersonalAgentItemPage{}, err
	}
	helpers, err := s.itemHelpers(ctx, assistantID, items)
	if err != nil {
		return store.PersonalAgentItemPage{}, err
	}
	page := store.PersonalAgentItemPage{Items: items, Helpers: helpers, Total: total, Offset: offset}
	if offset+len(items) < total {
		page.NextOffset = offset + len(items)
	}
	return page, nil
}

// itemHelpers loads the helpers of the given items in one query.
func (s *Store) itemHelpers(ctx context.Context, assistantID string, items []store.PersonalAgentListItem) (map[string][]store.PersonalAgentTask, error) {
	helpers := map[string][]store.PersonalAgentTask{}
	if len(items) == 0 {
		return helpers, nil
	}
	condition, args := "assistant_id = ? AND ", []any{assistantID}
	if assistantID == "" {
		// The person's ledger: item ids are unique across their assistants.
		condition, args = "", nil
	}
	for _, item := range items {
		args = append(args, item.ID)
	}
	rows, err := s.reader().QueryContext(ctx, `SELECT `+taskColumns+` FROM pa_tasks WHERE `+condition+`item_id IN (`+sqlPlaceholders(len(items))+`)
		ORDER BY created_at, rowid`, args...)
	if err != nil {
		return nil, fmt.Errorf("list personal agent item helpers: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		task, err := scanTask(rows)
		if err != nil {
			return nil, err
		}
		helpers[task.ItemID] = append(helpers[task.ItemID], task)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := s.addLinkedHelpers(ctx, assistantID, items, helpers); err != nil {
		return nil, err
	}
	return helpers, nil
}

// addLinkedHelpers adds the helpers linked to the items (pa_item_helpers) to
// their tasks: a session already there as a task is not listed again. Each
// item's helpers stay oldest first. An empty assistantID reads the person's
// ledger, as itemHelpers does.
func (s *Store) addLinkedHelpers(ctx context.Context, assistantID string, items []store.PersonalAgentListItem, helpers map[string][]store.PersonalAgentTask) error {
	condition, args := "h.assistant_id = ? AND ", []any{assistantID}
	if assistantID == "" {
		condition, args = "", nil
	}
	for _, item := range items {
		args = append(args, item.ID)
	}
	rows, err := s.reader().QueryContext(ctx, `SELECT `+linkedHelperColumns+` FROM `+linkedHelperFrom+` WHERE `+condition+
		`h.item_id IN (`+sqlPlaceholders(len(items))+`) ORDER BY h.created_at, h.rowid`, args...)
	if err != nil {
		return fmt.Errorf("list personal agent linked item helpers: %w", err)
	}
	defer rows.Close()
	linked := map[string]bool{}
	for rows.Next() {
		helper, err := scanLinkedHelper(rows)
		if err != nil {
			return err
		}
		if slices.ContainsFunc(helpers[helper.ItemID], func(task store.PersonalAgentTask) bool { return task.SessionID == helper.SessionID }) {
			continue
		}
		helpers[helper.ItemID] = append(helpers[helper.ItemID], helper)
		linked[helper.ItemID] = true
	}
	if err := rows.Err(); err != nil {
		return err
	}
	for itemID := range linked {
		slices.SortStableFunc(helpers[itemID], func(a, b store.PersonalAgentTask) int {
			return parseStoredTime(a.CreatedAt).Compare(parseStoredTime(b.CreatedAt))
		})
	}
	return nil
}

// ReportPersonalAgentItems reviews [from, to), two RFC 3339 instants. Archived
// items count. Created counts items created in the range; done and dropped
// count items closed in the range with that status; open counts items open
// at to. Groups hold the items created, updated or closed in the range, by status.
func (s *Store) ReportPersonalAgentItems(ctx context.Context, assistantID, from, to string) (store.PersonalAgentItemRangeReport, error) {
	start, err := parseInstant("from", from)
	if err != nil {
		return store.PersonalAgentItemRangeReport{}, err
	}
	end, err := parseInstant("to", to)
	if err != nil {
		return store.PersonalAgentItemRangeReport{}, err
	}
	if !start.Before(end) {
		return store.PersonalAgentItemRangeReport{}, fmt.Errorf("%w: from must be before to", store.ErrPersonalAgentItemInvalid)
	}
	inRange := func(column string) string {
		return `(julianday(` + column + `) >= julianday(?) AND julianday(` + column + `) < julianday(?))`
	}
	count := func(condition string, args ...any) (int, error) {
		var n int
		err := s.reader().QueryRowContext(ctx, `SELECT COUNT(*) FROM pa_items WHERE assistant_id = ? AND text <> '' AND `+condition,
			append([]any{assistantID}, args...)...).Scan(&n)
		if err != nil {
			return 0, fmt.Errorf("count personal agent items for report: %w", err)
		}
		return n, nil
	}
	var report store.PersonalAgentItemRangeReport
	report.From, report.To = from, to
	if report.Counts.Created, err = count(inRange("created_at"), from, to); err != nil {
		return report, err
	}
	if report.Counts.Done, err = count("status = ? AND "+inRange("closed_at"), store.PersonalAgentItemDone, from, to); err != nil {
		return report, err
	}
	if report.Counts.Dropped, err = count("status = ? AND "+inRange("closed_at"), store.PersonalAgentItemDropped, from, to); err != nil {
		return report, err
	}
	if report.Counts.Open, err = count(`julianday(created_at) < julianday(?) AND (closed_at = '' OR julianday(closed_at) >= julianday(?))`, to, to); err != nil {
		return report, err
	}
	items, err := s.queryItems(ctx, `assistant_id = ? AND text <> '' AND (`+inRange("created_at")+` OR `+inRange("updated_at")+` OR `+inRange("closed_at")+`)
		ORDER BY julianday(updated_at) DESC, rowid DESC`, assistantID, from, to, from, to, from, to)
	if err != nil {
		return report, err
	}
	report.Groups = []store.PersonalAgentItemStatusGroup{
		{Status: store.PersonalAgentItemOpen, Items: []store.PersonalAgentListItem{}},
		{Status: store.PersonalAgentItemDone, Items: []store.PersonalAgentListItem{}},
		{Status: store.PersonalAgentItemDropped, Items: []store.PersonalAgentListItem{}},
	}
	for _, item := range items {
		for index := range report.Groups {
			if report.Groups[index].Status == item.Status {
				report.Groups[index].Items = append(report.Groups[index].Items, item)
			}
		}
	}
	if report.Helpers, err = s.itemHelpers(ctx, assistantID, items); err != nil {
		return report, err
	}
	return report, nil
}

// parseInstant reads an RFC 3339 instant a query names.
func parseInstant(name, value string) (time.Time, error) {
	instant, err := time.Parse(time.RFC3339, value)
	if err != nil {
		return time.Time{}, fmt.Errorf("%w: %s is not an RFC 3339 instant", store.ErrPersonalAgentItemInvalid, name)
	}
	return instant, nil
}
