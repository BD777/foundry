package sqlitestore

import (
	"context"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func TestFeishuStore(t *testing.T) {
	ctx := context.Background()
	s, err := Open(":memory:")
	if err != nil {
		t.Fatalf("open in-memory db: %v", err)
	}
	defer s.Close()

	workspaceID := "ws_test_feishu"

	// Insert test workspace so foreign key passes
	_, err = s.conn().ExecContext(ctx, `INSERT INTO workspaces (id, name, local_path, baseline, context_summary, accepted_count, resolved_count, payload_json, updated_at) VALUES (?, 'Test', '/path', 'main', '', 0, 0, '{}', '2026-01-01T00:00:00Z')`, workspaceID)
	if err != nil {
		t.Fatalf("insert workspace: %v", err)
	}

	// 1. Initial get should return unconfigured
	bot, err := s.GetWorkspaceFeishuBot(ctx, workspaceID)
	if err != nil {
		t.Fatalf("get unconfigured bot: %v", err)
	}
	if bot.Status != store.FeishuBotStatusUnconfigured {
		t.Errorf("expected status unconfigured, got %s", bot.Status)
	}

	// 2. Save bot config
	bot.AppID = "cli_a1b2c3d4"
	bot.Status = store.FeishuBotStatusConnecting
	bot.PairingCode = "FND-1234"
	bot.PairingCodeExpiresAt = time.Now().Add(10 * time.Minute).Format(time.RFC3339)

	saved, err := s.SaveWorkspaceFeishuBot(ctx, bot)
	if err != nil {
		t.Fatalf("save bot: %v", err)
	}
	if saved.AppID != "cli_a1b2c3d4" {
		t.Errorf("expected appId cli_a1b2c3d4, got %s", saved.AppID)
	}

	// 3. Find by pairing code
	found, err := s.FindWorkspaceByPairingCode(ctx, "FND-1234")
	if err != nil {
		t.Fatalf("find by pairing code: %v", err)
	}
	if found.WorkspaceID != workspaceID {
		t.Errorf("expected workspaceID %s, got %s", workspaceID, found.WorkspaceID)
	}

	// 4. Update with chat binding
	found.ChatID = "oc_chat123"
	found.ChatName = "AI Engineering Group"
	found.Status = store.FeishuBotStatusConnected
	found.PairingCode = ""
	_, err = s.SaveWorkspaceFeishuBot(ctx, found)
	if err != nil {
		t.Fatalf("update with chat: %v", err)
	}

	// 5. Find by chat id
	byChat, err := s.FindWorkspaceByChatID(ctx, "oc_chat123")
	if err != nil {
		t.Fatalf("find by chat id: %v", err)
	}
	if byChat.WorkspaceID != workspaceID {
		t.Errorf("expected workspaceID %s, got %s", workspaceID, byChat.WorkspaceID)
	}

	// 6. Test Chat Threads
	thread := store.FeishuChatThread{
		RootMessageID:   "om_root123",
		WorkspaceID:     workspaceID,
		ChatID:          "oc_chat123",
		LatestSessionID: "sess_456",
		CardMessageID:   "om_card789",
	}
	if err := s.SaveFeishuChatThread(ctx, thread); err != nil {
		t.Fatalf("save chat thread: %v", err)
	}

	savedThread, err := s.GetFeishuChatThread(ctx, "om_root123")
	if err != nil {
		t.Fatalf("get chat thread: %v", err)
	}
	if savedThread.LatestSessionID != "sess_456" {
		t.Errorf("expected latest session sess_456, got %s", savedThread.LatestSessionID)
	}

	// 7. Delete bot
	if err := s.DeleteWorkspaceFeishuBot(ctx, workspaceID); err != nil {
		t.Fatalf("delete bot: %v", err)
	}
	afterDelete, err := s.GetWorkspaceFeishuBot(ctx, workspaceID)
	if err != nil {
		t.Fatalf("get after delete: %v", err)
	}
	if afterDelete.AppID != "" {
		t.Errorf("expected empty appId after delete, got %s", afterDelete.AppID)
	}
}
