package sqlitestore

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/foundry-dev/foundry/apps/server/internal/chattitle"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func (s *Store) ListChatTitles(ctx context.Context, workspaceID string) ([]store.ChatTitle, error) {
	rows, err := s.conn().QueryContext(ctx, `SELECT t.chat_id, t.title, t.version, t.generation_session_id, COALESCE(json_extract(s.payload_json, '$.status'), ''), COALESCE(json_extract(s.payload_json, '$.error'), '') FROM chat_titles t LEFT JOIN agent_sessions s ON s.id=t.generation_session_id WHERE t.workspace_id = ?`, workspaceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []store.ChatTitle{}
	for rows.Next() {
		var item store.ChatTitle
		if err := rows.Scan(&item.ChatID, &item.Title, &item.Version, &item.GenerationSessionID, &item.GenerationStatus, &item.GenerationError); err != nil {
			return nil, err
		}
		result = append(result, item)
	}
	return result, rows.Err()
}

func (s *Store) completeChatTitleJob(ctx context.Context, session store.AgentSession) error {
	title, err := chattitle.Parse(session.Response)
	if err != nil {
		return err
	}
	_, err = s.conn().ExecContext(ctx, `UPDATE chat_titles SET title=?, version=?, generation_session_id='' WHERE workspace_id=? AND generation_session_id=?`, title, time.Now().UTC().Format(time.RFC3339Nano), session.WorkspaceID, session.ID)
	return err
}

func (s *Store) RenameChat(ctx context.Context, id string, input store.RenameChatInput) (store.ChatTitle, error) {
	var result store.ChatTitle
	title := strings.TrimSpace(input.Title)
	if title == "" || utf8.RuneCountInString(title) > 120 {
		return result, errors.New("title must contain 1–120 characters")
	}
	err := s.withTx(ctx, func(tx *Store) error {
		canonicalID := id
		sessions, err := tx.ListAgentSessionThread(ctx, input.WorkspaceID, id)
		if err == nil && len(sessions) > 0 {
			if sessions[0].WorkspaceID != input.WorkspaceID {
				return store.ErrNotFound
			}
			canonicalID = sessions[0].ThreadID
			if canonicalID == "" {
				canonicalID = sessions[0].ID
			}
		} else {
			if err != nil && !errors.Is(err, store.ErrNotFound) && !errors.Is(err, sql.ErrNoRows) {
				return err
			}
			chat, err := tx.GetChat(ctx, id)
			if err != nil {
				return err
			}
			if chat.WorkspaceID != input.WorkspaceID {
				return store.ErrNotFound
			}
		}
		var version string
		err = tx.conn().QueryRowContext(ctx, `SELECT version FROM chat_titles WHERE workspace_id = ? AND chat_id = ?`, input.WorkspaceID, canonicalID).Scan(&version)
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		if input.ExpectedVersion != nil && version != *input.ExpectedVersion {
			return store.ErrTitleConflict
		}
		result = store.ChatTitle{ChatID: canonicalID, Title: title, Version: time.Now().UTC().Format(time.RFC3339Nano)}
		_, err = tx.conn().ExecContext(ctx, `INSERT INTO chat_titles (workspace_id, chat_id, title, version) VALUES (?, ?, ?, ?) ON CONFLICT(workspace_id, chat_id) DO UPDATE SET title=excluded.title, version=excluded.version, generation_session_id=''`, input.WorkspaceID, canonicalID, title, result.Version)
		return err
	})
	return result, err
}

// Registration and session creation are atomic; completed jobs may only update
// the title while they still own this generation slot. Manual naming revokes it.
func (s *Store) CreateChatTitleJob(ctx context.Context, chatID string, input store.CreateAgentSessionInput, automatic bool) (store.AgentSession, error) {
	var job store.AgentSession
	err := s.withTx(ctx, func(tx *Store) error {
		var existing string
		err := tx.conn().QueryRowContext(ctx, `SELECT generation_session_id FROM chat_titles WHERE workspace_id=? AND chat_id=?`, input.WorkspaceID, chatID).Scan(&existing)
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		if automatic && err == nil {
			return nil
		}
		if existing != "" {
			prior, err := tx.GetAgentSession(ctx, existing)
			if err != nil {
				return err
			}
			if !isTerminalAgentSession(prior.Status) {
				job = prior
				return nil
			}
		}
		input.Source = "naming"
		input.ThreadID, input.NativeSessionID, input.ImportedContext, input.ProfileTransitionNote = "", "", "", ""
		input.Attachments = nil
		job, err = tx.CreateAgentSession(ctx, input)
		if err != nil {
			return err
		}
		_, err = tx.conn().ExecContext(ctx, `INSERT INTO chat_titles(workspace_id,chat_id,title,version,generation_session_id) VALUES (?,?,'','',?) ON CONFLICT(workspace_id,chat_id) DO UPDATE SET generation_session_id=excluded.generation_session_id`, input.WorkspaceID, chatID, job.ID)
		return err
	})
	return job, err
}
