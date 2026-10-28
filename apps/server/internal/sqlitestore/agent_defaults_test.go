package sqlitestore

import (
	"context"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// A workspace keeps one default per level; one that sets nothing is
// removed, and a chat's override stops applying once the chat is paired
// elsewhere.
func TestAgentDefaults(t *testing.T) {
	ctx := context.Background()
	s, err := Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	for _, id := range []string{"ws_a", "ws_b"} {
		insertTestWorkspace(t, s, id)
	}
	app := createFeishuApp(t, s, "cli_shared", "u_1")
	for _, workspace := range []string{"ws_a", "ws_b"} {
		if err := s.SetWorkspaceFeishuBotApp(ctx, workspace, app.ID); err != nil {
			t.Fatal(err)
		}
	}
	chat, err := pairChat(t, s, "ws_a", "oc_1", "code_a", store.FeishuRouteChat)
	if err != nil {
		t.Fatal(err)
	}
	for _, value := range []store.AgentDefault{
		{WorkspaceID: "ws_a", Scope: store.AgentDefaultWorkspace, ProfileID: "codex_local", Runtime: "codex", Model: "gpt-6", Effort: "high"},
		{WorkspaceID: "ws_a", Scope: store.AgentDefaultFeishuBot, RouteID: "ignored", Effort: "low", Runtime: "codex"},
		{WorkspaceID: "ws_a", Scope: store.AgentDefaultFeishuChat, RouteID: chat.ID, ProfileID: "claude_local", Runtime: "claude"},
	} {
		if err := s.SetAgentDefault(ctx, value); err != nil {
			t.Fatal(err)
		}
	}
	if err := s.SetAgentDefault(ctx, store.AgentDefault{WorkspaceID: "ws_a", Scope: store.AgentDefaultFeishuChat, ProfileID: "x"}); err == nil {
		t.Fatal("a chat's default without its route was kept")
	}
	if err := s.SetAgentDefault(ctx, store.AgentDefault{WorkspaceID: "ws_a", Scope: "channel"}); err == nil {
		t.Fatal("an unknown scope was kept")
	}
	defaults, err := s.ListAgentDefaults(ctx, "ws_a")
	if err != nil || len(defaults) != 3 {
		t.Fatalf("defaults = %+v %v", defaults, err)
	}
	for _, value := range defaults {
		if value.Scope == store.AgentDefaultFeishuBot && value.RouteID != "" {
			t.Fatalf("the bot's default kept route %q", value.RouteID)
		}
		if value.Scope == store.AgentDefaultWorkspace && (value.Model != "gpt-6" || value.Effort != "high" || value.UpdatedAt == "") {
			t.Fatalf("workspace default = %+v", value)
		}
	}
	// Replacing a level keeps one row; clearing every field removes it.
	if err := s.SetAgentDefault(ctx, store.AgentDefault{WorkspaceID: "ws_a", Scope: store.AgentDefaultWorkspace, Model: "gpt-6-mini", Runtime: "codex"}); err != nil {
		t.Fatal(err)
	}
	if err := s.SetAgentDefault(ctx, store.AgentDefault{WorkspaceID: "ws_a", Scope: store.AgentDefaultFeishuBot}); err != nil {
		t.Fatal(err)
	}
	defaults, _ = s.ListAgentDefaults(ctx, "ws_a")
	if len(defaults) != 2 || defaults[1].Scope != store.AgentDefaultWorkspace || defaults[1].ProfileID != "" || defaults[1].Model != "gpt-6-mini" {
		t.Fatalf("after replacing and clearing: %+v", defaults)
	}
	// oc_1 paired with ws_b: its override no longer applies in either.
	pairing, err := s.SetFeishuPairingCode(ctx, "ws_b", "code_b", "u_b", time.Now().Add(time.Minute).UTC().Format(time.RFC3339))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.BindFeishuChat(ctx, pairing, store.FeishuBotRoute{Kind: store.FeishuRouteChat, ChatID: "oc_1", BoundUserID: "u_b"}); err != nil {
		t.Fatal(err)
	}
	if defaults, _ = s.ListAgentDefaults(ctx, "ws_a"); len(defaults) != 1 {
		t.Fatalf("ws_a after its chat moved: %+v", defaults)
	}
	if defaults, _ = s.ListAgentDefaults(ctx, "ws_b"); len(defaults) != 0 {
		t.Fatalf("ws_b inherited another workspace's override: %+v", defaults)
	}
}
