package sqlitestore

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strings"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func (s *Store) GetChatLayout(ctx context.Context, workspaceID string) (store.ChatLayout, error) {
	result := store.ChatLayout{Groups: []store.ChatLayoutGroup{}, Positions: []store.ChatPlacement{}}
	if _, err := s.GetWorkspace(ctx, workspaceID); err != nil {
		return result, err
	}
	var payload string
	err := s.conn().QueryRowContext(ctx, `SELECT payload_json FROM chat_layouts WHERE workspace_id = ?`, workspaceID).Scan(&payload)
	if errors.Is(err, sql.ErrNoRows) {
		return result, nil
	}
	if err != nil {
		return result, err
	}
	err = json.Unmarshal([]byte(payload), &result)
	return result, err
}

// Layout is user-owned metadata, separate from daemon projections. Saving one
// revision atomically changes both membership and order. CAS prevents a stale
// browser snapshot from overwriting another browser's edits.
func (s *Store) SaveChatLayout(ctx context.Context, input store.SaveChatLayoutInput) (store.ChatLayout, error) {
	var result store.ChatLayout
	if err := store.ValidateChatLayout(input); err != nil {
		return result, err
	}
	err := s.withTx(ctx, func(tx *Store) error {
		current, err := tx.GetChatLayout(ctx, input.WorkspaceID)
		if err != nil {
			return err
		}
		if current.Revision != *input.ExpectedRevision {
			return store.ErrChatLayoutConflict
		}
		// Reject known foreign-workspace chats. Unknown IDs remain valid so
		// temporary native-import gaps and old browser migrations retain positions.
		for _, position := range input.Layout.Positions {
			var foreign bool
			err := tx.conn().QueryRowContext(ctx, `SELECT EXISTS (
				SELECT 1 FROM agent_sessions WHERE id = ? AND workspace_id <> ?
				UNION ALL SELECT 1 FROM chats WHERE id = ? AND COALESCE(json_extract(payload_json, '$.workspaceId'), '') NOT IN ('', ?)
			)`, position.ChatID, input.WorkspaceID, position.ChatID, input.WorkspaceID).Scan(&foreign)
			if err != nil {
				return err
			}
			if foreign {
				return store.ErrInvalidChatLayout
			}
		}
		result = input.Layout
		result.Revision = current.Revision + 1
		for i := range result.Groups {
			result.Groups[i].Name = strings.TrimSpace(result.Groups[i].Name)
		}
		payload, err := json.Marshal(result)
		if err != nil {
			return err
		}
		_, err = tx.conn().ExecContext(ctx, `INSERT INTO chat_layouts(workspace_id, revision, payload_json) VALUES (?, ?, ?)
			ON CONFLICT(workspace_id) DO UPDATE SET revision=excluded.revision, payload_json=excluded.payload_json`, input.WorkspaceID, result.Revision, string(payload))
		return err
	})
	return result, err
}
