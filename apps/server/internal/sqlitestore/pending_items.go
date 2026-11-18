package sqlitestore

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"slices"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// setupPendingItems keeps what waits for the person in their sessions
// (DEV-079). Source events are never replayed; only storage metadata on
// existing rows is backfilled during migration.
func (s *Store) setupPendingItems(ctx context.Context) error {
	statements := []string{
		`CREATE TABLE IF NOT EXISTS pending_items (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL,
			assistant_id TEXT NOT NULL DEFAULT '',
			workspace_id TEXT NOT NULL,
			session_id TEXT NOT NULL DEFAULT '',
			issue_id TEXT NOT NULL DEFAULT '',
			source TEXT NOT NULL,
			item_key TEXT NOT NULL,
			state TEXT NOT NULL,
			payload_json TEXT NOT NULL,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			resolved_at TEXT NOT NULL DEFAULT '',
			handler TEXT NOT NULL DEFAULT 'person',
			deadline_at TEXT NOT NULL DEFAULT '',
			acknowledged_at TEXT NOT NULL DEFAULT '',
			notified_at TEXT NOT NULL DEFAULT '',
			outcome TEXT NOT NULL DEFAULT ''
		)`,
		`CREATE INDEX IF NOT EXISTS pending_items_user ON pending_items (user_id, state, updated_at)`,
		`CREATE INDEX IF NOT EXISTS pending_items_session ON pending_items (session_id, state)`,
		`CREATE INDEX IF NOT EXISTS pending_items_issue ON pending_items (issue_id, state)`,
		`CREATE INDEX IF NOT EXISTS pending_items_key ON pending_items (item_key, state)`,
		`ALTER TABLE pending_items ADD COLUMN handler TEXT NOT NULL DEFAULT 'person'`,
		`ALTER TABLE pending_items ADD COLUMN deadline_at TEXT NOT NULL DEFAULT ''`,
		`ALTER TABLE pending_items ADD COLUMN acknowledged_at TEXT NOT NULL DEFAULT ''`,
		`ALTER TABLE pending_items ADD COLUMN notified_at TEXT NOT NULL DEFAULT ''`,
		`ALTER TABLE pending_items ADD COLUMN outcome TEXT NOT NULL DEFAULT ''`,
		`CREATE INDEX IF NOT EXISTS pending_items_assistant_deadline ON pending_items (handler, state, deadline_at)`,
		`UPDATE pending_items SET deadline_at = COALESCE(NULLIF(strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+10 minutes'), ''), created_at)
			WHERE state = 'open' AND handler = 'assistant' AND deadline_at = ''`,
		`UPDATE pending_items SET outcome = CASE
				WHEN state = 'dismissed' THEN 'person_dismissed_not_needed'
				WHEN state = 'replied' THEN 'person_answered'
				ELSE 'auto_resolved'
			END
			WHERE state <> 'open' AND outcome = ''`,
		// Reading answers with a model (DEV-125 P2) was removed (DEV-152):
		// its settings, its items and any of its sessions go.
		`DROP TABLE IF EXISTS pending_triage_settings`,
		`DELETE FROM pending_items WHERE source = 'answer'`,
		`DELETE FROM agent_session_events WHERE session_id IN (SELECT id FROM agent_sessions WHERE json_extract(payload_json, '$.source') = 'triage')`,
		`DELETE FROM agent_sessions WHERE json_extract(payload_json, '$.source') = 'triage'`,
	}
	for _, statement := range statements {
		if _, err := s.conn().ExecContext(ctx, statement); err != nil && !strings.Contains(err.Error(), "duplicate column name") {
			return fmt.Errorf("migrate pending items: %w", err)
		}
	}
	return nil
}

// pendingStates are the states an item may be in.
var pendingStates = []string{store.PendingOpen, store.PendingReplied, store.PendingSuperseded, store.PendingDone, store.PendingDismissed}

const pendingItemColumns = `id, user_id, assistant_id, state, payload_json, created_at, updated_at, resolved_at, handler, deadline_at, acknowledged_at, notified_at, outcome`

func scanPendingItem(row interface{ Scan(...any) error }) (store.PendingItem, error) {
	var id, userID, assistantID, state, payload, createdAt, updatedAt, resolvedAt string
	var handler, deadlineAt, acknowledgedAt, notifiedAt, outcome string
	if err := row.Scan(&id, &userID, &assistantID, &state, &payload, &createdAt, &updatedAt, &resolvedAt,
		&handler, &deadlineAt, &acknowledgedAt, &notifiedAt, &outcome); err != nil {
		return store.PendingItem{}, err
	}
	var stored pendingPayload
	if err := json.Unmarshal([]byte(payload), &stored); err != nil {
		return store.PendingItem{}, fmt.Errorf("decode pending item: %w", err)
	}
	item := stored.PendingItem
	item.Key = stored.Key
	item.ID, item.UserID, item.AssistantID, item.State = id, userID, assistantID, state
	item.Handler, item.DeadlineAt, item.AcknowledgedAt = handler, deadlineAt, acknowledgedAt
	item.NotifiedAt, item.Outcome = notifiedAt, outcome
	item.CreatedAt, item.UpdatedAt, item.ResolvedAt = createdAt, updatedAt, resolvedAt
	return item, nil
}

// pendingPayload is what the row keeps beyond its columns.
type pendingPayload struct {
	store.PendingItem
	Key string `json:"key"`
}

func (s *Store) savePendingItem(ctx context.Context, item store.PendingItem) error {
	payload, err := encode(pendingPayload{PendingItem: item, Key: item.Key})
	if err != nil {
		return err
	}
	_, err = s.conn().ExecContext(ctx, `INSERT INTO pending_items
		(id, user_id, workspace_id, session_id, issue_id, source, item_key, state, payload_json, created_at, updated_at, resolved_at,
		 handler, assistant_id, deadline_at, acknowledged_at, notified_at, outcome)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
			workspace_id = excluded.workspace_id,
			session_id = excluded.session_id,
			issue_id = excluded.issue_id,
			source = excluded.source,
			item_key = excluded.item_key,
			state = excluded.state,
			handler = excluded.handler,
			assistant_id = CASE WHEN excluded.assistant_id <> '' THEN excluded.assistant_id ELSE pending_items.assistant_id END,
			deadline_at = excluded.deadline_at,
			acknowledged_at = excluded.acknowledged_at,
			notified_at = excluded.notified_at,
			outcome = excluded.outcome,
			payload_json = excluded.payload_json,
			updated_at = excluded.updated_at,
			resolved_at = excluded.resolved_at`,
		item.ID, item.UserID, item.WorkspaceID, item.SessionID, item.IssueID, item.Source, item.Key, item.State,
		payload, item.CreatedAt, item.UpdatedAt, item.ResolvedAt, store.PendingHandledBy(item), item.AssistantID,
		item.DeadlineAt, item.AcknowledgedAt, item.NotifiedAt, item.Outcome)
	if err != nil {
		return fmt.Errorf("save pending item: %w", err)
	}
	if item.State != store.PendingOpen {
		// However the item closed, a notice the person has not answered yet
		// no longer asks: queued ones are never sent, sent ones are answered
		// on the web (DEV-294). A notice being sent is left to its send.
		_, err := s.conn().ExecContext(ctx, `UPDATE person_notices SET state = ?, updated_at = ?, card_stale = 1
			WHERE item_id = ? AND state IN (?, ?)`,
			store.NoticeSuperseded, personNoticeTimeText(time.Now()), item.ID, store.NoticeQueued, store.NoticeSent)
		if err != nil {
			return fmt.Errorf("supersede the notices of a closed item: %w", err)
		}
	}
	return nil
}

func (s *Store) RecordPendingItem(ctx context.Context, item store.PendingItem) (store.PendingItem, bool, error) {
	if item.UserID == "" || (item.WorkspaceID == "") != store.PendingPersonal(item.Source) || item.Key == "" || item.Source == "" {
		return store.PendingItem{}, false, fmt.Errorf("a pending item needs a person, a source, a key and a workspace unless it is the person's own")
	}
	var result store.PendingItem
	changed := false
	err := s.withTx(ctx, func(tx *Store) error {
		nowTime := time.Now().UTC()
		now := formatTime(nowTime)
		existing, err := latestPendingItem(ctx, tx.conn(), item.Key)
		if err == nil && existing.State != store.PendingOpen && existing.EventID == item.EventID {
			// An event reported again after its item was resolved stays resolved.
			result = existing
			return nil
		}
		if errors.Is(err, sql.ErrNoRows) || (err == nil && existing.State != store.PendingOpen) {
			item.ID = evidenceID("pnd")
			item.State = store.PendingOpen
			item.Occurrences = 1
			item.CreatedAt, item.UpdatedAt, item.ResolvedAt = now, now, ""
			item.Handler = store.PendingHandledBy(item)
			item.Outcome = ""
			result, changed = item, true
			return tx.savePendingItem(ctx, item)
		}
		if err != nil {
			return fmt.Errorf("read pending item: %w", err)
		}
		// The same event reported again (a growing answer keeps its id)
		// takes its newest words without counting twice.
		next := existing
		next.Title, next.Excerpt, next.Context = item.Title, item.Excerpt, item.Context
		next.Options, next.Recommendation, next.Rule = item.Options, item.Recommendation, item.Rule
		next.Count = item.Count
		if item.Source == store.PendingSourceTurnFailed {
			next.SessionID, next.WorkspaceID = item.SessionID, item.WorkspaceID
			next.Handler = item.Handler
			if item.AssistantID != "" {
				next.AssistantID = item.AssistantID
			}
			next.FailureCategory = item.FailureCategory
			next.FailureProvider, next.FailureAccountID = item.FailureProvider, item.FailureAccountID
			if item.FailureResetAt != "" || next.FailureResetAt == "" {
				next.FailureResetAt = item.FailureResetAt
			}
			next.FailureSessions = mergeStrings(next.FailureSessions, item.FailureSessions...)
			next.FailureSessions = mergeStrings(next.FailureSessions, item.SessionID)
		}
		if item.EventID != existing.EventID {
			next.Occurrences++
			next.EventID, next.MessageID = item.EventID, item.MessageID
		}
		if pendingSame(existing, next) {
			result = existing
			return nil
		}
		next.UpdatedAt = now
		result, changed = next, true
		return tx.savePendingItem(ctx, next)
	})
	return result, changed, err
}

func pendingSame(a, b store.PendingItem) bool {
	return a.Title == b.Title && a.Excerpt == b.Excerpt && a.Context == b.Context &&
		slices.Equal(a.Options, b.Options) && a.Recommendation == b.Recommendation && a.Rule == b.Rule &&
		a.Occurrences == b.Occurrences && a.Count == b.Count && a.EventID == b.EventID && a.MessageID == b.MessageID &&
		a.SessionID == b.SessionID && a.WorkspaceID == b.WorkspaceID && a.Handler == b.Handler &&
		a.DeadlineAt == b.DeadlineAt && a.AcknowledgedAt == b.AcknowledgedAt &&
		a.NotifiedAt == b.NotifiedAt && a.Outcome == b.Outcome &&
		a.FailureCategory == b.FailureCategory && a.FailureProvider == b.FailureProvider &&
		a.FailureAccountID == b.FailureAccountID && a.FailureResetAt == b.FailureResetAt &&
		slices.Equal(a.FailureSessions, b.FailureSessions)
}

// mergeStrings appends values not already present, preserving their order.
func mergeStrings(current []string, values ...string) []string {
	result := append([]string(nil), current...)
	for _, value := range values {
		if value == "" || slices.Contains(result, value) {
			continue
		}
		result = append(result, value)
	}
	return result
}

func (s *Store) ListOpenPendingItemsBySource(ctx context.Context, source string) ([]store.PendingItem, error) {
	rows, err := s.reader().QueryContext(ctx, `SELECT `+pendingItemColumns+`
		FROM pending_items WHERE source = ? AND state = ? ORDER BY updated_at, created_at, id`,
		source, store.PendingOpen)
	if err != nil {
		return nil, fmt.Errorf("list open pending items: %w", err)
	}
	defer rows.Close()
	var items []store.PendingItem
	for rows.Next() {
		item, err := scanPendingItem(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (s *Store) MergePendingItems(ctx context.Context, target store.PendingItem, sourceIDs []string) (store.PendingItem, bool, error) {
	if target.UserID == "" || target.WorkspaceID == "" || target.Key == "" ||
		target.Source != store.PendingSourceTurnFailed {
		return store.PendingItem{}, false, fmt.Errorf("merging turn failures needs a person, workspace, key and turn_failed source")
	}
	var result store.PendingItem
	changed := false
	err := s.withTx(ctx, func(tx *Store) error {
		existing, err := pendingItemAt(ctx, tx.conn(), "item_key = ? AND state = ?", []any{target.Key, store.PendingOpen}, false)
		targetExists := err == nil
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return fmt.Errorf("read merged pending item: %w", err)
		}
		var sources []store.PendingItem
		for _, id := range sourceIDs {
			if targetExists && id == existing.ID {
				continue
			}
			item, err := scanPendingItem(tx.conn().QueryRowContext(ctx, `SELECT `+pendingItemColumns+`
				FROM pending_items WHERE id = ? AND state = ?`, id, store.PendingOpen))
			if errors.Is(err, sql.ErrNoRows) {
				continue
			}
			if err != nil {
				return fmt.Errorf("read pending item %s: %w", id, err)
			}
			sources = append(sources, item)
		}
		if len(sources) == 0 {
			if targetExists {
				next := target
				next.ID, next.Occurrences, next.CreatedAt = existing.ID, existing.Occurrences, existing.CreatedAt
				next.UpdatedAt = laterPendingTime(existing.UpdatedAt, target.UpdatedAt)
				next.FailureSessions = mergeStrings(existing.FailureSessions, target.FailureSessions...)
				next.State, next.ResolvedAt, next.ResolutionReason, next.ResolutionDetail =
					store.PendingOpen, "", "", ""
				changed = !pendingSame(existing, next)
				result = next
				if changed {
					return tx.savePendingItem(ctx, next)
				}
			}
			return nil
		}
		now := time.Now().UTC()
		if targetExists {
			result = target
			result.ID, result.Occurrences, result.CreatedAt = existing.ID, existing.Occurrences, existing.CreatedAt
			result.UpdatedAt = laterPendingTime(existing.UpdatedAt, target.UpdatedAt)
			result.FailureSessions = mergeStrings(existing.FailureSessions, target.FailureSessions...)
		} else {
			target.ID = evidenceID("pnd")
			target.State = store.PendingOpen
			target.Occurrences = 0
			target.CreatedAt = sources[0].CreatedAt
			target.ResolvedAt = ""
			result = target
		}
		latest := result.UpdatedAt
		for _, source := range sources {
			result.Occurrences += max(source.Occurrences, 1)
			result.FailureSessions = mergeStrings(result.FailureSessions, source.FailureSessions...)
			result.FailureSessions = mergeStrings(result.FailureSessions, source.SessionID)
			if parseStoredTime(source.CreatedAt).Before(parseStoredTime(result.CreatedAt)) || result.CreatedAt == "" {
				result.CreatedAt = source.CreatedAt
			}
			if result.UpdatedAt == "" || parseStoredTime(source.UpdatedAt).After(parseStoredTime(result.UpdatedAt)) {
				result.Title, result.Excerpt, result.Context = source.Title, source.Excerpt, source.Context
				result.SessionID, result.WorkspaceID = source.SessionID, source.WorkspaceID
				result.EventID, result.MessageID = source.EventID, source.MessageID
				if source.FailureCategory != "" {
					result.FailureCategory = source.FailureCategory
					result.FailureProvider, result.FailureAccountID = source.FailureProvider, source.FailureAccountID
					result.FailureResetAt = source.FailureResetAt
				}
				result.Rule = source.Rule
				result.Handler, result.AssistantID = source.Handler, source.AssistantID
				result.DeadlineAt, result.AcknowledgedAt = source.DeadlineAt, source.AcknowledgedAt
				result.UpdatedAt = source.UpdatedAt
			}
			latest = laterPendingTime(latest, source.UpdatedAt)
			source.State, source.UpdatedAt, source.ResolvedAt = store.PendingDone, formatTime(now), formatTime(now)
			source.ResolutionReason, source.ResolutionDetail = store.PendingResolutionMerged, "same root cause"
			source.Outcome = store.PendingOutcomeAutoResolved
			if err := tx.savePendingItem(ctx, source); err != nil {
				return err
			}
			changed = true
		}
		result.State = store.PendingOpen
		result.UpdatedAt = laterPendingTime(result.UpdatedAt, latest)
		result.ResolvedAt, result.Outcome = "", ""
		result.ResolutionReason, result.ResolutionDetail = "", ""
		result.Handler = store.PendingHandledBy(result)
		if err := tx.savePendingItem(ctx, result); err != nil {
			return err
		}
		return nil
	})
	return result, changed, err
}

func laterPendingTime(left, right string) string {
	if left == "" || parseStoredTime(right).After(parseStoredTime(left)) {
		return right
	}
	return left
}

func (s *Store) ResolvePendingItems(ctx context.Context, resolution store.PendingResolution) (int, error) {
	if resolution.SessionID == "" && resolution.IssueID == "" && resolution.Key == "" {
		return 0, fmt.Errorf("resolving pending items needs a session, an Issue or a key")
	}
	if !slices.Contains(pendingStates, resolution.State) || resolution.State == store.PendingOpen {
		return 0, fmt.Errorf("unknown resolution %q", resolution.State)
	}
	query := `SELECT ` + pendingItemColumns + ` FROM pending_items WHERE state = ?`
	args := []any{store.PendingOpen}
	if resolution.SessionID != "" {
		query += ` AND session_id = ?`
		args = append(args, resolution.SessionID)
	}
	if resolution.IssueID != "" {
		query += ` AND issue_id = ?`
		args = append(args, resolution.IssueID)
	}
	if resolution.Key != "" {
		query += ` AND item_key = ?`
		args = append(args, resolution.Key)
	}
	if len(resolution.Sources) > 0 {
		query += ` AND source IN (` + strings.TrimSuffix(strings.Repeat("?,", len(resolution.Sources)), ",") + `)`
		for _, source := range resolution.Sources {
			args = append(args, source)
		}
	}
	if resolution.ExceptKey != "" {
		query += ` AND item_key != ?`
		args = append(args, resolution.ExceptKey)
	}
	resolved := 0
	var changed []store.PendingItem
	err := s.withTx(ctx, func(tx *Store) error {
		rows, err := tx.conn().QueryContext(ctx, query, args...)
		if err != nil {
			return fmt.Errorf("read pending items: %w", err)
		}
		var items []store.PendingItem
		for rows.Next() {
			item, err := scanPendingItem(rows)
			if err != nil {
				rows.Close()
				return err
			}
			items = append(items, item)
		}
		if err := rows.Close(); err != nil {
			return err
		}
		before := time.Time{}
		if resolution.Before != "" {
			before = parseStoredTime(resolution.Before)
		}
		now := formatTime(time.Now().UTC())
		for _, item := range items {
			// Compared as times: stored and given times differ in precision.
			if !before.IsZero() && !parseStoredTime(item.CreatedAt).Before(before) {
				continue
			}
			if resolution.MessageID != "" && nativeMessageID(item.MessageID) != nativeMessageID(resolution.MessageID) {
				continue
			}
			if resolution.Rule != "" && item.Rule != resolution.Rule {
				continue
			}
			item.State, item.UpdatedAt, item.ResolvedAt = resolution.State, now, now
			item.ResolutionReason, item.ResolutionDetail = resolution.ResolutionReason, resolution.ResolutionDetail
			item.Outcome = pendingResolutionOutcome(resolution, item)
			setPendingAnswer(&item, resolution.Answer)
			if resolution.AcknowledgedAt != "" && item.AcknowledgedAt == "" {
				item.AcknowledgedAt = resolution.AcknowledgedAt
			}
			if err := tx.savePendingItem(ctx, item); err != nil {
				return err
			}
			changed = append(changed, item)
			resolved++
		}
		return nil
	})
	if err == nil {
		for _, item := range changed {
			logPendingOutcome(item)
		}
	}
	return resolved, err
}

func pendingResolutionOutcome(resolution store.PendingResolution, item store.PendingItem) string {
	if resolution.Outcome != "" {
		return resolution.Outcome
	}
	if resolution.State == store.PendingDismissed {
		return store.PendingOutcomePersonDismissedNotNeeded
	}
	if resolution.State == store.PendingReplied {
		return store.PendingOutcomePersonAnswered
	}
	return store.PendingOutcomeAutoResolved
}

func logPendingOutcome(item store.PendingItem) {
	if item.Outcome == "" {
		return
	}
	ended := item.ResolvedAt
	if ended == "" {
		ended = item.HandedAt
	}
	elapsed := ""
	if created := parseStoredTime(item.CreatedAt); !created.IsZero() {
		if at := parseStoredTime(ended); !at.IsZero() {
			elapsed = at.Sub(created).Round(time.Millisecond).String()
		}
	}
	log.Printf("pending item outcome: id=%s source=%s outcome=%s elapsed=%s", item.ID, item.Source, item.Outcome, elapsed)
}

// nativeMessageID is a transcript message id without its turn prefix
// ("<input>/").
func nativeMessageID(id string) string {
	return id[strings.LastIndex(id, "/")+1:]
}

func (s *Store) ListPendingItems(ctx context.Context, userID string, states []string, resolvedSince string, limit int) ([]store.PendingItem, error) {
	return s.listPendingItems(ctx, userID, states, resolvedSince, limit, false)
}

// ListVisiblePendingItems is ListPendingItems for the items the person may
// still see: one whose session was archived or deleted is left out, as the
// conversation it came from is. An item without a session (an account, a
// connector) stays. Every list of what "needs the person" reads this, so the
// assistant's card and the Needs-you page never disagree.
func (s *Store) ListVisiblePendingItems(ctx context.Context, userID string, states []string, resolvedSince string, limit int) ([]store.PendingItem, error) {
	return s.listPendingItems(ctx, userID, states, resolvedSince, limit, true)
}

func (s *Store) listPendingItems(ctx context.Context, userID string, states []string, resolvedSince string, limit int, visible bool) ([]store.PendingItem, error) {
	if limit <= 0 || limit > 500 {
		limit = 500
	}
	var wanted []string
	for _, state := range states {
		if slices.Contains(pendingStates, state) && !slices.Contains(wanted, state) {
			wanted = append(wanted, state)
		}
	}
	if len(wanted) == 0 {
		return nil, nil
	}
	query := `SELECT ` + pendingItemColumns + ` FROM pending_items WHERE user_id = ? AND state IN (` +
		strings.TrimSuffix(strings.Repeat("?,", len(wanted)), ",") + `)`
	args := []any{userID}
	for _, state := range wanted {
		args = append(args, state)
	}
	if resolvedSince != "" {
		query += ` AND (state = ? OR resolved_at >= ?)`
		args = append(args, store.PendingOpen, resolvedSince)
	}
	if visible {
		query += ` AND (session_id = '' OR EXISTS (SELECT 1 FROM agent_sessions
			WHERE agent_sessions.id = pending_items.session_id AND ` + visibleAgentSessionSQL + ` AND NOT ` + archivedSessionSQL + `))`
	}
	query += ` ORDER BY updated_at DESC LIMIT ?`
	args = append(args, limit)
	rows, err := s.reader().QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("list pending items: %w", err)
	}
	defer rows.Close()
	var items []store.PendingItem
	for rows.Next() {
		item, err := scanPendingItem(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (s *Store) SetPendingItemState(ctx context.Context, userID, id, state string) (store.PendingItem, error) {
	if state != store.PendingOpen && state != store.PendingDone && state != store.PendingDismissed {
		return store.PendingItem{}, fmt.Errorf("an item can be marked done, dismissed or open")
	}
	outcome := store.PendingOutcomePersonAnswered
	if state == store.PendingDismissed {
		outcome = store.PendingOutcomePersonDismissedNotNeeded
	}
	return s.ResolvePendingItem(ctx, userID, id, state, outcome, store.PendingAnswer{})
}

// ResolvePendingItem changes one item by its handler's decision. Reopening
// clears the outcome and gives an assistant-handled item a fresh deadline.
func (s *Store) ResolvePendingItem(ctx context.Context, userID, id, state, outcome string, answer store.PendingAnswer) (store.PendingItem, error) {
	return s.resolvePendingItem(ctx, userID, id, state, outcome, answer, "")
}

// ClosePendingItem marks an item done by the assistant without an answer,
// with the reason it closed it.
func (s *Store) ClosePendingItem(ctx context.Context, userID, id, reason string) (store.PendingItem, error) {
	return s.resolvePendingItem(ctx, userID, id, store.PendingDone, store.PendingOutcomeAssistantClosed, store.PendingAnswer{}, reason)
}

func (s *Store) resolvePendingItem(ctx context.Context, userID, id, state, outcome string, answer store.PendingAnswer, closeReason string) (store.PendingItem, error) {
	if state != store.PendingOpen && state != store.PendingDone && state != store.PendingDismissed {
		return store.PendingItem{}, fmt.Errorf("an item can be marked done, dismissed or open")
	}
	if state != store.PendingOpen && outcome == "" {
		return store.PendingItem{}, fmt.Errorf("closing an item needs an outcome")
	}
	var result store.PendingItem
	var logged store.PendingItem
	err := s.withTx(ctx, func(tx *Store) error {
		item, err := scanPendingItem(tx.conn().QueryRowContext(ctx, `SELECT `+pendingItemColumns+` FROM pending_items WHERE id = ? AND user_id = ?`, id, userID))
		if errors.Is(err, sql.ErrNoRows) {
			return store.ErrNotFound
		}
		if err != nil {
			return fmt.Errorf("read pending item: %w", err)
		}
		if item.State == state {
			result = item
			return nil
		}
		now := formatTime(time.Now().UTC())
		item.State, item.UpdatedAt = state, now
		item.ResolvedAt = now
		if state == store.PendingOpen {
			item.ResolvedAt = ""
			item.ResolutionReason, item.ResolutionDetail = "", ""
			item.Outcome, item.AcknowledgedAt, item.NotifiedAt = "", "", ""
			item.DeadlineAt, item.CloseReason = "", ""
		} else {
			item.Outcome = outcome
			setPendingAnswer(&item, answer)
			item.CloseReason = cutPendingText(closeReason)
			logged = item
		}
		result = item
		return tx.savePendingItem(ctx, item)
	})
	if err == nil && logged.Outcome != "" {
		logPendingOutcome(logged)
	}
	return result, err
}

// setPendingAnswer records the answer an item was closed with, cut to
// PendingAnswerLimit characters; an empty answer changes nothing.
func setPendingAnswer(item *store.PendingItem, answer store.PendingAnswer) {
	if text := cutPendingText(answer.Text); text != "" {
		item.Answer, item.AnsweredBy = text, answer.By
	}
}

// cutPendingText trims text and keeps at most PendingAnswerLimit characters.
func cutPendingText(text string) string {
	text = strings.TrimSpace(text)
	if runes := []rune(text); len(runes) > store.PendingAnswerLimit {
		text = string(runes[:store.PendingAnswerLimit])
	}
	return text
}

func (s *Store) GetPendingItem(ctx context.Context, userID, id string) (store.PendingItem, error) {
	item, err := scanPendingItem(s.reader().QueryRowContext(ctx, `SELECT `+pendingItemColumns+` FROM pending_items WHERE id = ? AND user_id = ?`, id, userID))
	if errors.Is(err, sql.ErrNoRows) {
		return store.PendingItem{}, store.ErrNotFound
	}
	return item, err
}

func (s *Store) HandPendingItem(ctx context.Context, userID, id, handler, note, reason, outcome, inputID string) (store.PendingItem, error) {
	if handler != store.PendingHandlerPerson && handler != store.PendingHandlerAssistant {
		return store.PendingItem{}, fmt.Errorf("an item is handled by the person or the assistant")
	}
	var result store.PendingItem
	var logged store.PendingItem
	err := s.withTx(ctx, func(tx *Store) error {
		item, err := scanPendingItem(tx.conn().QueryRowContext(ctx, `SELECT `+pendingItemColumns+` FROM pending_items WHERE id = ? AND user_id = ?`, id, userID))
		if errors.Is(err, sql.ErrNoRows) {
			return store.ErrNotFound
		}
		if err != nil {
			return fmt.Errorf("read pending item: %w", err)
		}
		if item.State != store.PendingOpen {
			return fmt.Errorf("pending item %s is %s, no longer open", id, item.State)
		}
		now := formatTime(time.Now().UTC())
		item.Handler, item.UpdatedAt = handler, now
		if item.AcknowledgedAt == "" {
			item.AcknowledgedAt = now
		}
		if note = strings.TrimSpace(note); note != "" {
			item.Note = note
		}
		if handler == store.PendingHandlerPerson {
			item.HandedReason, item.HandedAt = reason, now
			item.HandedInputID = inputID
			item.Outcome = outcome
			logged = item
		}
		result = item
		return tx.savePendingItem(ctx, item)
	})
	if err == nil && logged.Outcome != "" {
		logPendingOutcome(logged)
	}
	return result, err
}

// OpenHandOverForInput reports whether an item handed to the person by the
// assistant turn inputID is still open. Rows handed over before the turn was
// recorded never match: their turn is unknown (DEV-279).
func (s *Store) OpenHandOverForInput(ctx context.Context, inputID string) (bool, error) {
	if inputID == "" {
		return false, nil
	}
	var count int
	err := s.reader().QueryRowContext(ctx, `SELECT COUNT(*) FROM pending_items
		WHERE state = ? AND handler = ? AND outcome = ? AND json_extract(payload_json, '$.handedInputId') = ?`,
		store.PendingOpen, store.PendingHandlerPerson, store.PendingOutcomeHandedOver, inputID).Scan(&count)
	if err != nil {
		return false, fmt.Errorf("read open hand-overs: %w", err)
	}
	return count > 0, nil
}

func (s *Store) MarkPendingItemNotified(ctx context.Context, userID, id, at string) error {
	return s.withTx(ctx, func(tx *Store) error {
		item, err := scanPendingItem(tx.conn().QueryRowContext(ctx, `SELECT `+pendingItemColumns+` FROM pending_items WHERE id = ? AND user_id = ?`, id, userID))
		if err != nil {
			return err
		}
		if item.State != store.PendingOpen || item.NotifiedAt != "" {
			return nil
		}
		item.NotifiedAt, item.UpdatedAt = at, at
		return tx.savePendingItem(ctx, item)
	})
}

func (s *Store) ListOpenAssistantPendingItems(ctx context.Context) ([]store.PendingItem, error) {
	rows, err := s.reader().QueryContext(ctx, `SELECT `+pendingItemColumns+`
		FROM pending_items WHERE state = ? AND handler = ? ORDER BY created_at, id`,
		store.PendingOpen, store.PendingHandlerAssistant)
	if err != nil {
		return nil, fmt.Errorf("list assistant pending items: %w", err)
	}
	defer rows.Close()
	var items []store.PendingItem
	for rows.Next() {
		item, err := scanPendingItem(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

// latestPendingItem is the newest open item of key, or else its newest item.
func latestPendingItem(ctx context.Context, db dbExecutor, key string) (store.PendingItem, error) {
	item, err := pendingItemAt(ctx, db, "item_key = ? AND state = ?", []any{key, store.PendingOpen}, true)
	if errors.Is(err, sql.ErrNoRows) {
		return pendingItemAt(ctx, db, "item_key = ?", []any{key}, true)
	}
	return item, err
}

// pendingItemAt is the item matching where whose created_at is the newest (or
// the oldest), sql.ErrNoRows when none matches.
func pendingItemAt(ctx context.Context, db dbExecutor, where string, args []any, newest bool) (store.PendingItem, error) {
	rowID, found, err := timeEdgeRowID(ctx, db, "pending_items", "created_at", where, args, newest)
	if err != nil {
		return store.PendingItem{}, err
	}
	if !found {
		return store.PendingItem{}, sql.ErrNoRows
	}
	return scanPendingItem(db.QueryRowContext(ctx, `SELECT `+pendingItemColumns+` FROM pending_items WHERE rowid = ?`, rowID))
}
