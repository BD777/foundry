package sqlitestore

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// The messages people queue in chats, in sending order (position). Sent
// rows stay as the record of which session took them; deleted ones go.
// chat_queue_revisions counts every change to a chat's queue.
func chatQueueSchema() []string {
	return []string{
		`CREATE TABLE IF NOT EXISTS chat_queue_items (
			id TEXT PRIMARY KEY,
			workspace_id TEXT NOT NULL,
			chat_id TEXT NOT NULL,
			position INTEGER NOT NULL,
			text TEXT NOT NULL,
			attachments_json TEXT NOT NULL DEFAULT '[]',
			run_settings_json TEXT NOT NULL DEFAULT '{}',
			created_by TEXT NOT NULL DEFAULT '',
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			revision INTEGER NOT NULL DEFAULT 1,
			state TEXT NOT NULL DEFAULT 'queued',
			error TEXT NOT NULL DEFAULT '',
			sent_session_id TEXT NOT NULL DEFAULT ''
		)`,
		`CREATE INDEX IF NOT EXISTS idx_chat_queue_items_chat ON chat_queue_items (chat_id, position)`,
		`CREATE INDEX IF NOT EXISTS idx_chat_queue_items_state ON chat_queue_items (state)`,
		`CREATE TABLE IF NOT EXISTS chat_queue_revisions (
			workspace_id TEXT NOT NULL,
			chat_id TEXT NOT NULL,
			revision INTEGER NOT NULL,
			PRIMARY KEY (workspace_id, chat_id)
		)`,
	}
}

const chatQueueItemColumns = `id, workspace_id, chat_id, position, text, attachments_json, run_settings_json,
	created_by, created_at, updated_at, revision, state, error, sent_session_id`

// unsentChatQueueStates are the states a queue lists.
const unsentChatQueueStates = `('queued', 'dispatching', 'failed')`

type chatQueueRow struct {
	item        store.ChatQueueItem
	workspaceID string
}

func scanChatQueueRow(scan func(...any) error) (chatQueueRow, error) {
	var row chatQueueRow
	var attachments, settings string
	item := &row.item
	if err := scan(&item.ID, &row.workspaceID, &item.ChatID, &item.Position, &item.Text, &attachments, &settings,
		&item.CreatedBy, &item.CreatedAt, &item.UpdatedAt, &item.Revision, &item.State, &item.Error, &item.SentSessionID); err != nil {
		return row, err
	}
	if err := json.Unmarshal([]byte(attachments), &item.Attachments); err != nil {
		return row, fmt.Errorf("decode queued message attachments: %w", err)
	}
	if len(item.Attachments) == 0 {
		item.Attachments = nil
	}
	if err := json.Unmarshal([]byte(settings), &item.RunSettings); err != nil {
		return row, fmt.Errorf("decode queued message settings: %w", err)
	}
	return row, nil
}

func (s *Store) chatQueueRow(ctx context.Context, itemID string) (chatQueueRow, error) {
	row, err := scanChatQueueRow(s.conn().QueryRowContext(ctx, `SELECT `+chatQueueItemColumns+` FROM chat_queue_items WHERE id = ?`, itemID).Scan)
	if errors.Is(err, sql.ErrNoRows) {
		return row, store.ErrNotFound
	}
	return row, err
}

// chatQueueItem loads one message of a chat; another chat's is not found.
func (s *Store) chatQueueItem(ctx context.Context, workspaceID, chatID, itemID string) (store.ChatQueueItem, error) {
	row, err := s.chatQueueRow(ctx, itemID)
	if err != nil {
		return store.ChatQueueItem{}, err
	}
	if row.workspaceID != workspaceID || row.item.ChatID != chatID {
		return store.ChatQueueItem{}, store.ErrNotFound
	}
	return row.item, nil
}

func (s *Store) ChatQueue(ctx context.Context, workspaceID, chatID string) (store.ChatQueue, error) {
	queue := store.ChatQueue{WorkspaceID: workspaceID, ChatID: chatID, Items: []store.ChatQueueItem{}}
	err := s.conn().QueryRowContext(ctx, `SELECT revision FROM chat_queue_revisions WHERE workspace_id = ? AND chat_id = ?`, workspaceID, chatID).Scan(&queue.Revision)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return queue, err
	}
	rows, err := s.conn().QueryContext(ctx, `SELECT `+chatQueueItemColumns+` FROM chat_queue_items
		WHERE workspace_id = ? AND chat_id = ? AND state IN `+unsentChatQueueStates+`
		ORDER BY position ASC, created_at ASC, id ASC`, workspaceID, chatID)
	if err != nil {
		return queue, err
	}
	defer rows.Close()
	for rows.Next() {
		row, err := scanChatQueueRow(rows.Scan)
		if err != nil {
			return queue, err
		}
		queue.Items = append(queue.Items, row.item)
	}
	return queue, rows.Err()
}

func (s *Store) bumpChatQueueRevision(ctx context.Context, workspaceID, chatID string) error {
	_, err := s.conn().ExecContext(ctx, `INSERT INTO chat_queue_revisions (workspace_id, chat_id, revision) VALUES (?, ?, 1)
		ON CONFLICT (workspace_id, chat_id) DO UPDATE SET revision = revision + 1`, workspaceID, chatID)
	return err
}

// changeChatQueue runs change in a transaction, counts it as a new queue
// revision and returns the queue after it.
func (s *Store) changeChatQueue(ctx context.Context, workspaceID, chatID string, change func(tx *Store, now string) error) (store.ChatQueue, error) {
	var queue store.ChatQueue
	err := s.withTx(ctx, func(tx *Store) error {
		if err := change(tx, formatTime(time.Now().UTC())); err != nil {
			return err
		}
		if err := tx.bumpChatQueueRevision(ctx, workspaceID, chatID); err != nil {
			return err
		}
		var err error
		queue, err = tx.ChatQueue(ctx, workspaceID, chatID)
		return err
	})
	return queue, err
}

func encodeChatQueueMessage(text string, attachments []store.ChatAttachment, settings store.ChatQueueRunSettings) (string, string, string, error) {
	text = strings.TrimSpace(text)
	attachments = store.NormalizeChatAttachments(attachments)
	if text == "" && len(attachments) == 0 {
		return "", "", "", store.ErrInvalidChatQueueMessage
	}
	if attachments == nil {
		attachments = []store.ChatAttachment{}
	}
	encodedAttachments, err := json.Marshal(attachments)
	if err != nil {
		return "", "", "", err
	}
	encodedSettings, err := json.Marshal(settings)
	if err != nil {
		return "", "", "", err
	}
	return text, string(encodedAttachments), string(encodedSettings), nil
}

func (s *Store) EnqueueChatMessage(ctx context.Context, workspaceID, chatID, createdBy string, input store.EnqueueChatMessageInput) (store.ChatQueue, error) {
	text, attachments, settings, err := encodeChatQueueMessage(input.Text, input.Attachments, input.RunSettings)
	if err != nil {
		return store.ChatQueue{}, err
	}
	return s.changeChatQueue(ctx, workspaceID, chatID, func(tx *Store, now string) error {
		var last int64
		if err := tx.conn().QueryRowContext(ctx, `SELECT COALESCE(MAX(position), 0) FROM chat_queue_items WHERE workspace_id = ? AND chat_id = ?`, workspaceID, chatID).Scan(&last); err != nil {
			return err
		}
		// The id becomes the input's id when the message is sent: a UUIDv7,
		// like every input id.
		_, err := tx.conn().ExecContext(ctx, `INSERT INTO chat_queue_items (`+chatQueueItemColumns+`)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'queued', '', '')`,
			newSessionInputID(time.Now().UTC()), workspaceID, chatID, last+1, text, attachments, settings, createdBy, now, now)
		return err
	})
}

// changeableChatQueueItem refuses a message that went out or is going out.
func changeableChatQueueItem(item store.ChatQueueItem) error {
	switch item.State {
	case store.ChatQueueStateDispatching:
		return store.ErrChatQueueItemSending
	case store.ChatQueueStateSent:
		return store.ErrChatQueueItemSent
	}
	return nil
}

func (s *Store) EditChatQueueItem(ctx context.Context, workspaceID, chatID, itemID string, input store.EditChatQueueItemInput) (store.ChatQueue, error) {
	if input.ExpectedRevision == nil {
		return store.ChatQueue{}, store.ErrChatQueueConflict
	}
	return s.changeChatQueue(ctx, workspaceID, chatID, func(tx *Store, now string) error {
		item, err := tx.chatQueueItem(ctx, workspaceID, chatID, itemID)
		if err != nil {
			return err
		}
		if err := changeableChatQueueItem(item); err != nil {
			return err
		}
		if item.Revision != *input.ExpectedRevision {
			return store.ErrChatQueueConflict
		}
		if input.Text != nil {
			item.Text = *input.Text
		}
		if input.Attachments != nil {
			item.Attachments = *input.Attachments
		}
		if input.RunSettings != nil {
			item.RunSettings = *input.RunSettings
		}
		text, attachments, settings, err := encodeChatQueueMessage(item.Text, item.Attachments, item.RunSettings)
		if err != nil {
			return err
		}
		_, err = tx.conn().ExecContext(ctx, `UPDATE chat_queue_items SET text = ?, attachments_json = ?, run_settings_json = ?,
			revision = revision + 1, updated_at = ? WHERE id = ?`, text, attachments, settings, now, itemID)
		return err
	})
}

func (s *Store) DeleteChatQueueItem(ctx context.Context, workspaceID, chatID, itemID string) (store.ChatQueue, error) {
	return s.changeChatQueue(ctx, workspaceID, chatID, func(tx *Store, _ string) error {
		item, err := tx.chatQueueItem(ctx, workspaceID, chatID, itemID)
		if err != nil {
			return err
		}
		if err := changeableChatQueueItem(item); err != nil {
			return err
		}
		_, err = tx.conn().ExecContext(ctx, `DELETE FROM chat_queue_items WHERE id = ?`, itemID)
		return err
	})
}

func (s *Store) ReorderChatQueue(ctx context.Context, workspaceID, chatID string, input store.ReorderChatQueueInput) (store.ChatQueue, error) {
	if input.ExpectedRevision == nil {
		return store.ChatQueue{}, store.ErrChatQueueConflict
	}
	return s.changeChatQueue(ctx, workspaceID, chatID, func(tx *Store, _ string) error {
		queue, err := tx.ChatQueue(ctx, workspaceID, chatID)
		if err != nil {
			return err
		}
		if queue.Revision != *input.ExpectedRevision {
			return store.ErrChatQueueConflict
		}
		// The order names exactly the messages that still wait; one being
		// sent keeps its place ahead of them.
		waiting := map[string]bool{}
		for _, item := range queue.Items {
			if item.State != store.ChatQueueStateDispatching {
				waiting[item.ID] = true
			}
		}
		if len(input.ItemIDs) != len(waiting) {
			return store.ErrChatQueueConflict
		}
		for index, id := range input.ItemIDs {
			if !waiting[id] {
				return store.ErrChatQueueConflict
			}
			delete(waiting, id)
			if _, err := tx.conn().ExecContext(ctx, `UPDATE chat_queue_items SET position = ? WHERE id = ?`, index+1, id); err != nil {
				return err
			}
		}
		_, err = tx.conn().ExecContext(ctx, `UPDATE chat_queue_items SET position = 0 WHERE workspace_id = ? AND chat_id = ? AND state = 'dispatching'`, workspaceID, chatID)
		return err
	})
}

func (s *Store) RetryChatQueueItem(ctx context.Context, workspaceID, chatID, itemID string) (store.ChatQueue, error) {
	return s.changeChatQueue(ctx, workspaceID, chatID, func(tx *Store, now string) error {
		item, err := tx.chatQueueItem(ctx, workspaceID, chatID, itemID)
		if err != nil {
			return err
		}
		if err := changeableChatQueueItem(item); err != nil {
			return err
		}
		var first int64
		if err := tx.conn().QueryRowContext(ctx, `SELECT COALESCE(MIN(position), 1) FROM chat_queue_items
			WHERE workspace_id = ? AND chat_id = ? AND state IN `+unsentChatQueueStates, workspaceID, chatID).Scan(&first); err != nil {
			return err
		}
		_, err = tx.conn().ExecContext(ctx, `UPDATE chat_queue_items SET state = 'queued', error = '', position = ?,
			revision = revision + 1, updated_at = ? WHERE id = ?`, first-1, now, itemID)
		return err
	})
}

func (s *Store) ClaimChatQueueItem(ctx context.Context, workspaceID, chatID, itemID string, head bool) (store.ChatQueueItem, store.ChatQueue, error) {
	var claimed store.ChatQueueItem
	queue, err := s.changeChatQueue(ctx, workspaceID, chatID, func(tx *Store, now string) error {
		queue, err := tx.ChatQueue(ctx, workspaceID, chatID)
		if err != nil {
			return err
		}
		found := false
		for index, item := range queue.Items {
			if item.State == store.ChatQueueStateDispatching {
				return store.ErrChatQueueBusy
			}
			if head && index == 0 {
				if item.ID != itemID {
					return store.ErrChatQueueConflict
				}
				if item.State == store.ChatQueueStateFailed {
					return store.ErrChatQueuePaused
				}
			}
			if item.ID == itemID {
				claimed, found = item, true
			}
		}
		if !found {
			if _, err := tx.chatQueueItem(ctx, workspaceID, chatID, itemID); err == nil {
				return store.ErrChatQueueItemSent
			}
			return store.ErrNotFound
		}
		claimed.State, claimed.Error, claimed.UpdatedAt = store.ChatQueueStateDispatching, "", now
		claimed.Revision++
		_, err = tx.conn().ExecContext(ctx, `UPDATE chat_queue_items SET state = 'dispatching', error = '',
			revision = revision + 1, updated_at = ? WHERE id = ?`, now, itemID)
		return err
	})
	if err != nil {
		return store.ChatQueueItem{}, store.ChatQueue{}, err
	}
	return claimed, queue, nil
}

func (s *Store) SettleChatQueueItem(ctx context.Context, itemID, state, sessionID, message string) (store.ChatQueue, error) {
	switch state {
	case store.ChatQueueStateSent, store.ChatQueueStateFailed, store.ChatQueueStateQueued:
	default:
		return store.ChatQueue{}, fmt.Errorf("settle a queued message as %q", state)
	}
	row, err := s.chatQueueRow(ctx, itemID)
	if err != nil {
		return store.ChatQueue{}, err
	}
	return s.changeChatQueue(ctx, row.workspaceID, row.item.ChatID, func(tx *Store, now string) error {
		_, err := tx.conn().ExecContext(ctx, `UPDATE chat_queue_items SET state = ?, sent_session_id = ?, error = ?,
			revision = revision + 1, updated_at = ? WHERE id = ? AND state = 'dispatching'`,
			state, sessionID, strings.TrimSpace(message), now, itemID)
		return err
	})
}

func (s *Store) ChatQueueInputSession(ctx context.Context, itemID string) (string, bool, error) {
	var sessionID string
	err := s.conn().QueryRowContext(ctx, `SELECT session_id FROM agent_session_events WHERE id = ?`, "evt_"+itemID).Scan(&sessionID)
	if errors.Is(err, sql.ErrNoRows) {
		return "", false, nil
	}
	return sessionID, err == nil, err
}

func (s *Store) RecoverChatQueueDispatches(ctx context.Context) ([]store.ChatQueue, error) {
	ids, err := listStrings(ctx, s.conn(), `SELECT id FROM chat_queue_items WHERE state = 'dispatching'`)
	if err != nil {
		return nil, err
	}
	queues := []store.ChatQueue{}
	for _, id := range ids {
		sessionID, sent, err := s.ChatQueueInputSession(ctx, id)
		if err != nil {
			return queues, err
		}
		state := store.ChatQueueStateQueued
		if sent {
			state = store.ChatQueueStateSent
		}
		queue, err := s.SettleChatQueueItem(ctx, id, state, sessionID, "")
		if err != nil {
			return queues, err
		}
		queues = append(queues, queue)
	}
	return queues, nil
}

func (s *Store) PendingChatQueues(ctx context.Context) ([]store.ChatQueueRef, error) {
	refs := []store.ChatQueueRef{}
	err := scanRows(ctx, s.conn(), `SELECT DISTINCT workspace_id, chat_id FROM chat_queue_items WHERE state = 'queued'`, func(rows *sql.Rows) error {
		var ref store.ChatQueueRef
		if err := rows.Scan(&ref.WorkspaceID, &ref.ChatID); err != nil {
			return err
		}
		refs = append(refs, ref)
		return nil
	})
	return refs, err
}

func (s *Store) DeleteChatQueueItemsBy(ctx context.Context, workspaceID, userID string) ([]store.ChatQueueRef, error) {
	refs := []store.ChatQueueRef{}
	if strings.TrimSpace(userID) == "" {
		return refs, nil
	}
	err := s.withTx(ctx, func(tx *Store) error {
		chats, err := listStrings(ctx, tx.conn(), `SELECT DISTINCT chat_id FROM chat_queue_items
			WHERE workspace_id = ? AND created_by = ? AND state IN ('queued', 'failed')`, workspaceID, userID)
		if err != nil {
			return err
		}
		if _, err := tx.conn().ExecContext(ctx, `DELETE FROM chat_queue_items
			WHERE workspace_id = ? AND created_by = ? AND state IN ('queued', 'failed')`, workspaceID, userID); err != nil {
			return err
		}
		for _, chatID := range chats {
			if err := tx.bumpChatQueueRevision(ctx, workspaceID, chatID); err != nil {
				return err
			}
			refs = append(refs, store.ChatQueueRef{WorkspaceID: workspaceID, ChatID: chatID})
		}
		return nil
	})
	return refs, err
}

func (s *Store) ChatQueueSession(ctx context.Context, workspaceID, chatID string) (store.AgentSession, bool, bool, error) {
	var latestID string
	var active bool
	err := s.conn().QueryRowContext(ctx, `SELECT id,
		EXISTS (SELECT 1 FROM agent_sessions WHERE workspace_id = ? AND (id = ? OR thread_id = ?) AND status IN ('queued', 'running', 'blocked'))
		FROM agent_sessions WHERE workspace_id = ? AND (id = ? OR thread_id = ?)
		ORDER BY created_at DESC, id DESC LIMIT 1`,
		workspaceID, chatID, chatID, workspaceID, chatID, chatID).Scan(&latestID, &active)
	if errors.Is(err, sql.ErrNoRows) {
		return store.AgentSession{}, false, false, nil
	}
	if err != nil {
		return store.AgentSession{}, false, false, err
	}
	session, err := s.GetAgentSessionSummary(ctx, latestID)
	if err != nil {
		return store.AgentSession{}, false, false, err
	}
	return session, true, active, nil
}

// moveChatQueue hands a chat's queue to the session that continues it, in
// the caller's transaction.
func (s *Store) moveChatQueue(ctx context.Context, workspaceID, fromID, toID string) error {
	if fromID == toID {
		return nil
	}
	result, err := s.conn().ExecContext(ctx, `UPDATE chat_queue_items SET chat_id = ? WHERE workspace_id = ? AND chat_id = ?`, toID, workspaceID, fromID)
	if err != nil {
		return fmt.Errorf("move chat queue: %w", err)
	}
	moved, _ := result.RowsAffected()
	var revision int64
	err = s.conn().QueryRowContext(ctx, `SELECT COALESCE(MAX(revision), 0) FROM chat_queue_revisions WHERE workspace_id = ? AND chat_id IN (?, ?)`, workspaceID, fromID, toID).Scan(&revision)
	if err != nil {
		return err
	}
	if moved == 0 && revision == 0 {
		return nil
	}
	if _, err := s.conn().ExecContext(ctx, `DELETE FROM chat_queue_revisions WHERE workspace_id = ? AND chat_id = ?`, workspaceID, fromID); err != nil {
		return err
	}
	_, err = s.conn().ExecContext(ctx, `INSERT INTO chat_queue_revisions (workspace_id, chat_id, revision) VALUES (?, ?, ?)
		ON CONFLICT (workspace_id, chat_id) DO UPDATE SET revision = excluded.revision`, workspaceID, toID, revision+1)
	return err
}

// deleteChatQueues drops the queues of deleted chats, in the caller's transaction.
func (s *Store) deleteChatQueues(ctx context.Context, workspaceID string, chatIDs []string) error {
	for _, chatID := range chatIDs {
		if _, err := s.conn().ExecContext(ctx, `DELETE FROM chat_queue_items WHERE workspace_id = ? AND chat_id = ? AND state <> 'sent'`, workspaceID, chatID); err != nil {
			return err
		}
		if err := s.bumpChatQueueRevision(ctx, workspaceID, chatID); err != nil {
			return err
		}
	}
	return nil
}
