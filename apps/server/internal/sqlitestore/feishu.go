package sqlitestore

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func (s *Store) setupFeishu(ctx context.Context) error {
	statements := []string{
		`CREATE TABLE IF NOT EXISTS workspace_feishu_bots (
			workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
			app_id TEXT NOT NULL,
			chat_id TEXT NOT NULL DEFAULT '',
			chat_name TEXT NOT NULL DEFAULT '',
			pairing_code TEXT NOT NULL DEFAULT '',
			pairing_code_expires_at TEXT NOT NULL DEFAULT '',
			status TEXT NOT NULL DEFAULT 'unconfigured',
			status_detail TEXT NOT NULL DEFAULT '',
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)`,
		`CREATE INDEX IF NOT EXISTS idx_workspace_feishu_bots_pairing ON workspace_feishu_bots (pairing_code)`,
		`CREATE INDEX IF NOT EXISTS idx_workspace_feishu_bots_chat ON workspace_feishu_bots (chat_id)`,
		`CREATE TABLE IF NOT EXISTS feishu_chat_threads (
			root_message_id TEXT PRIMARY KEY,
			workspace_id TEXT NOT NULL,
			chat_id TEXT NOT NULL,
			latest_session_id TEXT NOT NULL,
			card_message_id TEXT NOT NULL DEFAULT '',
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)`,
		`CREATE INDEX IF NOT EXISTS idx_feishu_chat_threads_session ON feishu_chat_threads (latest_session_id)`,
	}
	for _, statement := range statements {
		if _, err := s.conn().ExecContext(ctx, statement); err != nil {
			return fmt.Errorf("migrate sqlite feishu: %w", err)
		}
	}
	// The bot acts in its group as the account that generated its pairing
	// code; pairing_code holds only the code's hash.
	for column, statement := range map[string]string{
		"pairing_code_created_by": `ALTER TABLE workspace_feishu_bots ADD COLUMN pairing_code_created_by TEXT NOT NULL DEFAULT ''`,
		"bound_user_id":           `ALTER TABLE workspace_feishu_bots ADD COLUMN bound_user_id TEXT NOT NULL DEFAULT ''`,
	} {
		if err := s.ensureColumn(ctx, "workspace_feishu_bots", column, statement); err != nil {
			return err
		}
	}
	return nil
}

// feishuBotColumns lists the projected columns in feishuBotFields order.
const feishuBotColumns = `workspace_id, app_id, chat_id, chat_name, pairing_code, pairing_code_expires_at,
	status, status_detail, updated_at, pairing_code_created_by, bound_user_id`

func feishuBotFields(bot *store.WorkspaceFeishuBot) []any {
	return []any{&bot.WorkspaceID, &bot.AppID, &bot.ChatID, &bot.ChatName, &bot.PairingCode, &bot.PairingCodeExpiresAt,
		&bot.Status, &bot.StatusDetail, &bot.UpdatedAt, &bot.PairingCodeCreatedBy, &bot.BoundUserID}
}

func (s *Store) GetWorkspaceFeishuBot(ctx context.Context, workspaceID string) (store.WorkspaceFeishuBot, error) {
	row := s.conn().QueryRowContext(ctx, `
		SELECT `+feishuBotColumns+`
		FROM workspace_feishu_bots WHERE workspace_id = ?`, workspaceID)
	var bot store.WorkspaceFeishuBot
	err := row.Scan(feishuBotFields(&bot)...)
	if errors.Is(err, sql.ErrNoRows) {
		return store.WorkspaceFeishuBot{
			WorkspaceID:  workspaceID,
			Status:       store.FeishuBotStatusUnconfigured,
			HasAppSecret: false,
		}, nil
	}
	if err != nil {
		return store.WorkspaceFeishuBot{}, fmt.Errorf("load feishu bot for %s: %w", workspaceID, err)
	}
	hasSecret, err := s.HasSecret(ctx, "feishu:app_secret:"+workspaceID)
	if err == nil {
		bot.HasAppSecret = hasSecret
	}
	return bot, nil
}

func (s *Store) SaveWorkspaceFeishuBot(ctx context.Context, bot store.WorkspaceFeishuBot) (store.WorkspaceFeishuBot, error) {
	now := formatTime(time.Now())
	bot.WorkspaceID = strings.TrimSpace(bot.WorkspaceID)
	bot.AppID = strings.TrimSpace(bot.AppID)
	bot.ChatID = strings.TrimSpace(bot.ChatID)
	bot.ChatName = strings.TrimSpace(bot.ChatName)
	bot.PairingCode = strings.TrimSpace(bot.PairingCode)
	if bot.Status == "" {
		bot.Status = store.FeishuBotStatusUnconfigured
	}
	bot.UpdatedAt = now

	_, err := s.conn().ExecContext(ctx, `
		INSERT INTO workspace_feishu_bots (
			workspace_id, app_id, chat_id, chat_name, pairing_code, pairing_code_expires_at, status, status_detail, created_at, updated_at,
			pairing_code_created_by, bound_user_id
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(workspace_id) DO UPDATE SET
			pairing_code_created_by = excluded.pairing_code_created_by,
			bound_user_id = excluded.bound_user_id,
			app_id = excluded.app_id,
			chat_id = excluded.chat_id,
			chat_name = excluded.chat_name,
			pairing_code = excluded.pairing_code,
			pairing_code_expires_at = excluded.pairing_code_expires_at,
			status = excluded.status,
			status_detail = excluded.status_detail,
			updated_at = excluded.updated_at`,
		bot.WorkspaceID, bot.AppID, bot.ChatID, bot.ChatName, bot.PairingCode, bot.PairingCodeExpiresAt, bot.Status, bot.StatusDetail, now, now,
		bot.PairingCodeCreatedBy, bot.BoundUserID)
	if err != nil {
		return store.WorkspaceFeishuBot{}, fmt.Errorf("save feishu bot for %s: %w", bot.WorkspaceID, err)
	}

	hasSecret, err := s.HasSecret(ctx, "feishu:app_secret:"+bot.WorkspaceID)
	if err == nil {
		bot.HasAppSecret = hasSecret
	}
	return bot, nil
}

func (s *Store) DeleteWorkspaceFeishuBot(ctx context.Context, workspaceID string) error {
	_, err := s.conn().ExecContext(ctx, `DELETE FROM workspace_feishu_bots WHERE workspace_id = ?`, workspaceID)
	if err != nil {
		return fmt.Errorf("delete feishu bot %s: %w", workspaceID, err)
	}
	_ = s.DeleteSecret(ctx, "feishu:app_secret:"+workspaceID)
	return nil
}

func (s *Store) ListAllConfiguredFeishuBots(ctx context.Context) ([]store.WorkspaceFeishuBot, error) {
	rows, err := s.conn().QueryContext(ctx, `
		SELECT `+feishuBotColumns+`
		FROM workspace_feishu_bots WHERE app_id <> ''`)
	if err != nil {
		return nil, fmt.Errorf("list feishu bots: %w", err)
	}

	var bots []store.WorkspaceFeishuBot
	for rows.Next() {
		var bot store.WorkspaceFeishuBot
		if err := rows.Scan(feishuBotFields(&bot)...); err != nil {
			rows.Close()
			return nil, err
		}
		bots = append(bots, bot)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()

	for i := range bots {
		hasSecret, _ := s.HasSecret(ctx, "feishu:app_secret:"+bots[i].WorkspaceID)
		bots[i].HasAppSecret = hasSecret
	}
	return bots, nil
}

func (s *Store) FindWorkspaceByPairingCode(ctx context.Context, code string) (store.WorkspaceFeishuBot, error) {
	code = strings.TrimSpace(code)
	if code == "" {
		return store.WorkspaceFeishuBot{}, store.ErrNotFound
	}
	row := s.conn().QueryRowContext(ctx, `
		SELECT `+feishuBotColumns+`
		FROM workspace_feishu_bots WHERE pairing_code = ?`, code)
	var bot store.WorkspaceFeishuBot
	err := row.Scan(feishuBotFields(&bot)...)
	if errors.Is(err, sql.ErrNoRows) {
		return store.WorkspaceFeishuBot{}, store.ErrNotFound
	}
	if err != nil {
		return store.WorkspaceFeishuBot{}, err
	}
	hasSecret, _ := s.HasSecret(ctx, "feishu:app_secret:"+bot.WorkspaceID)
	bot.HasAppSecret = hasSecret
	return bot, nil
}

func (s *Store) FindWorkspaceByChatID(ctx context.Context, chatID string) (store.WorkspaceFeishuBot, error) {
	chatID = strings.TrimSpace(chatID)
	if chatID == "" {
		return store.WorkspaceFeishuBot{}, store.ErrNotFound
	}
	row := s.conn().QueryRowContext(ctx, `
		SELECT `+feishuBotColumns+`
		FROM workspace_feishu_bots WHERE chat_id = ?`, chatID)
	var bot store.WorkspaceFeishuBot
	err := row.Scan(feishuBotFields(&bot)...)
	if errors.Is(err, sql.ErrNoRows) {
		return store.WorkspaceFeishuBot{}, store.ErrNotFound
	}
	if err != nil {
		return store.WorkspaceFeishuBot{}, err
	}
	hasSecret, _ := s.HasSecret(ctx, "feishu:app_secret:"+bot.WorkspaceID)
	bot.HasAppSecret = hasSecret
	return bot, nil
}

func (s *Store) GetFeishuChatThread(ctx context.Context, rootMessageID string) (store.FeishuChatThread, error) {
	row := s.conn().QueryRowContext(ctx, `
		SELECT root_message_id, workspace_id, chat_id, latest_session_id, card_message_id, created_at, updated_at
		FROM feishu_chat_threads WHERE root_message_id = ?`, rootMessageID)
	var thread store.FeishuChatThread
	err := row.Scan(&thread.RootMessageID, &thread.WorkspaceID, &thread.ChatID, &thread.LatestSessionID, &thread.CardMessageID, &thread.CreatedAt, &thread.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return store.FeishuChatThread{}, store.ErrNotFound
	}
	if err != nil {
		return store.FeishuChatThread{}, err
	}
	return thread, nil
}

func (s *Store) SaveFeishuChatThread(ctx context.Context, thread store.FeishuChatThread) error {
	now := formatTime(time.Now())
	if thread.CreatedAt == "" {
		thread.CreatedAt = now
	}
	thread.UpdatedAt = now
	_, err := s.conn().ExecContext(ctx, `
		INSERT INTO feishu_chat_threads (
			root_message_id, workspace_id, chat_id, latest_session_id, card_message_id, created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(root_message_id) DO UPDATE SET
			workspace_id = excluded.workspace_id,
			chat_id = excluded.chat_id,
			latest_session_id = excluded.latest_session_id,
			card_message_id = excluded.card_message_id,
			updated_at = excluded.updated_at`,
		thread.RootMessageID, thread.WorkspaceID, thread.ChatID, thread.LatestSessionID, thread.CardMessageID, thread.CreatedAt, thread.UpdatedAt)
	if err != nil {
		return fmt.Errorf("save feishu chat thread %s: %w", thread.RootMessageID, err)
	}
	return nil
}
