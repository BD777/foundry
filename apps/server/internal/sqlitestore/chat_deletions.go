package sqlitestore

import (
	"context"
	"strings"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// Filter before LIMIT so deleted turns do not crowd out visible conversations.
const visibleAgentSessionSQL = `NOT EXISTS (SELECT 1 FROM chat_deletions d
	WHERE d.workspace_id = agent_sessions.workspace_id AND d.deletion_key IN (
		'id:' || agent_sessions.id, 'id:' || agent_sessions.thread_id,
		'native:' || agent_sessions.provider || ':' || json_extract(agent_sessions.payload_json, '$.nativeSessionId')))`

const visibleChatSQL = `NOT EXISTS (SELECT 1 FROM chat_deletions d
	WHERE d.workspace_id = COALESCE(json_extract(chats.payload_json, '$.workspaceId'), '') AND d.deletion_key IN (
		'id:' || chats.id,
		'native:' || json_extract(chats.payload_json, '$.provider') || ':' || json_extract(chats.payload_json, '$.nativeSessionId')))`

func (s *Store) chatDeleted(ctx context.Context, workspaceID, id, provider, nativeID string) (bool, error) {
	var deleted bool
	nativeKey := ""
	if provider != "" && nativeID != "" {
		nativeKey = "native:" + provider + ":" + nativeID
	}
	err := s.conn().QueryRowContext(ctx, `SELECT EXISTS (SELECT 1 FROM chat_deletions WHERE workspace_id = ? AND deletion_key IN (?, ?))`, workspaceID, "id:"+id, nativeKey).Scan(&deleted)
	return deleted, err
}

// Membership, deletion markers and layout revision commit together. The client
// sends a group ID and revision, never its filtered or paginated list of chats.
func (s *Store) DeleteChatGroup(ctx context.Context, input store.DeleteChatGroupInput) (store.ChatLayout, error) {
	var result store.ChatLayout
	if strings.TrimSpace(input.WorkspaceID) == "" || strings.TrimSpace(input.GroupID) == "" || input.ExpectedRevision == nil || *input.ExpectedRevision < 0 {
		return result, store.ErrInvalidChatLayout
	}
	err := s.withTx(ctx, func(tx *Store) error {
		layout, err := tx.GetChatLayout(ctx, input.WorkspaceID)
		if err != nil {
			return err
		}
		if layout.Revision != *input.ExpectedRevision {
			return store.ErrChatLayoutConflict
		}
		found := false
		groups := []store.ChatLayoutGroup{}
		for _, group := range layout.Groups {
			if group.ID == input.GroupID {
				found = true
			} else {
				groups = append(groups, group)
			}
		}
		if !found {
			return store.ErrNotFound
		}
		positions := []store.ChatPlacement{}
		for _, position := range layout.Positions {
			if position.GroupID != input.GroupID {
				positions = append(positions, position)
				continue
			}
			if err := tx.softDeleteChat(ctx, input.WorkspaceID, position.ChatID); err != nil {
				return err
			}
		}
		layout.Groups, layout.Positions = groups, positions
		result, err = tx.SaveChatLayout(ctx, store.SaveChatLayoutInput{WorkspaceID: input.WorkspaceID, ExpectedRevision: input.ExpectedRevision, Layout: layout})
		return err
	})
	return result, err
}

func (s *Store) softDeleteChat(ctx context.Context, workspaceID, chatID string) error {
	sessions, err := listJSON[store.AgentSession](ctx, s.conn(), `SELECT payload_json FROM agent_sessions WHERE workspace_id = ? AND (id = ? OR thread_id = ? OR thread_id IN (SELECT thread_id FROM agent_sessions WHERE workspace_id = ? AND id = ?))`, workspaceID, chatID, chatID, workspaceID, chatID)
	if err != nil {
		return err
	}
	chats, err := listJSON[store.ChatThread](ctx, s.conn(), `SELECT payload_json FROM chats WHERE id = ? AND COALESCE(json_extract(payload_json, '$.workspaceId'), '') = ?`, chatID, workspaceID)
	if err != nil {
		return err
	}
	keys := map[string]bool{"id:" + chatID: true}
	add := func(id, provider, nativeID string) {
		if id != "" {
			keys["id:"+id] = true
		}
		if provider != "" && nativeID != "" {
			keys["native:"+provider+":"+nativeID] = true
		}
	}
	for _, session := range sessions {
		if session.Status == "queued" || session.Status == "running" {
			return store.ErrChatDeletionBusy
		}
		add(session.ID, session.Provider, session.NativeSessionID)
		add(session.ThreadID, "", "")
	}
	for _, chat := range chats {
		if chat.Status == "queued" || chat.Status == "running" {
			return store.ErrChatDeletionBusy
		}
		add(chat.ID, chat.Provider, chat.NativeSessionID)
	}
	for key := range keys {
		if _, err := s.conn().ExecContext(ctx, `INSERT OR IGNORE INTO chat_deletions(workspace_id, deletion_key) VALUES (?, ?)`, workspaceID, key); err != nil {
			return err
		}
	}
	// A native identity may also be referenced by a different local thread.
	// Never hide an active execution through one of those aliases.
	var busy bool
	if err := s.conn().QueryRowContext(ctx, `SELECT EXISTS (SELECT 1 FROM agent_sessions WHERE workspace_id = ? AND status IN ('queued', 'running') AND NOT `+visibleAgentSessionSQL+`)`, workspaceID).Scan(&busy); err != nil {
		return err
	}
	if busy {
		return store.ErrChatDeletionBusy
	}
	return nil
}
