package httpapi

import (
	"context"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/feishu"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// A workspace's Feishu Bot runs on a Connectors app its maintainer may
// connect through; pairing codes, chats and removal go through the routes;
// Connectors shows what uses each app, and an app bots run on stays.
func TestWorkspaceFeishuBotRunsOnAConnectorsApp(t *testing.T) {
	f := newExternalAccountsFixture(t)
	ctx := context.Background()
	trap, reached := egressTrap(t)
	f.server.feishuEvents.Domain = trap.URL
	t.Cleanup(f.server.feishuEvents.Stop)
	const path = "/api/workspaces/ws_alice/feishu"

	var bot store.WorkspaceFeishuBot
	f.call(f.alice, http.MethodGet, path, "", http.StatusOK, "read the bot", &bot)
	if bot.Status != store.FeishuBotStatusUnconfigured || bot.App != nil || len(bot.Choices) != 0 {
		t.Fatalf("a workspace without a bot: %+v", bot)
	}
	f.call(f.alice, http.MethodPost, path+"/pair-code", "", http.StatusConflict, "a code before an app", nil)

	app := f.createApp(f.alice, "")
	bobsApp := f.createApp(f.bob, "")
	f.call(f.alice, http.MethodGet, path, "", http.StatusOK, "read the choices", &bot)
	if len(bot.Choices) != 1 || bot.Choices[0].ID != app.ID {
		t.Fatalf("alice may run the bot on %+v, want her app only", bot.Choices)
	}
	f.call(f.alice, http.MethodPost, path, `{"appId":"`+bobsApp.ID+`"}`, http.StatusNotFound, "bob's personal app", nil)
	f.call(f.alice, http.MethodPost, path, `{"appId":"`+app.ID+`"}`, http.StatusOK, "run the bot on alice's app", &bot)
	if bot.App == nil || bot.App.ID != app.ID || !bot.App.HasSecret || bot.Status == store.FeishuBotStatusUnconfigured {
		t.Fatalf("after picking the app: %+v", bot)
	}
	for deadline := time.Now().Add(5 * time.Second); reached() == 0 && time.Now().Before(deadline); time.Sleep(10 * time.Millisecond) {
	}
	if reached() == 0 {
		t.Fatal("the bot did not open its app's connection (through the trap)")
	}

	var code store.FeishuPairingCodeResult
	f.call(f.alice, http.MethodPost, path+"/pair-code", "", http.StatusOK, "generate a code", &code)
	if !strings.HasPrefix(code.PairingCode, "FND-") {
		t.Fatalf("pairing code = %q", code.PairingCode)
	}
	pairing, err := f.db.FindFeishuPairingRoute(ctx, "cli_fake", feishu.HashPairingCode(code.PairingCode))
	if err != nil || pairing.WorkspaceID != "ws_alice" || pairing.PairingCodeCreatedBy != f.aliceID {
		t.Fatalf("the code's route = %+v %v, want ws_alice made by alice", pairing, err)
	}
	recorder := doAuthCall(t, f.handler, f.as(f.alice, http.MethodGet, path, ""))
	if strings.Contains(recorder.Body.String(), code.PairingCode) || strings.Contains(recorder.Body.String(), pairing.PairingCode) || !strings.Contains(recorder.Body.String(), "pairingCodeExpiresAt") {
		t.Fatalf("the bot shows its code, or not when it lapses: %s", recorder.Body.String())
	}

	chat, err := f.db.BindFeishuChat(ctx, pairing, store.FeishuBotRoute{Kind: store.FeishuRouteChat, ChatID: "oc_team", ChatName: "Team", BoundUserID: f.aliceID})
	if err != nil {
		t.Fatal(err)
	}
	var uses []store.FeishuAppUse
	f.call(f.alice, http.MethodGet, "/api/feishu/app-uses", "", http.StatusOK, "app uses", &uses)
	if len(uses) != 1 || uses[0].AppID != app.ID || len(uses[0].Workspaces) != 1 || uses[0].Workspaces[0].WorkspaceID != "ws_alice" || uses[0].Workspaces[0].Chats != 1 {
		t.Fatalf("app uses = %+v", uses)
	}
	f.call(f.alice, http.MethodDelete, "/api/external-apps/"+app.ID, "", http.StatusConflict, "remove an app a bot runs on", nil)

	f.call(f.bob, http.MethodDelete, path+"/chats/"+chat.ID, "", http.StatusNotFound, "bob unbinds alice's chat", nil)
	f.call(f.alice, http.MethodDelete, path+"/chats/"+chat.ID, "", http.StatusOK, "unbind the chat", &bot)
	if len(bot.Chats) != 0 || bot.App == nil {
		t.Fatalf("after unbinding: %+v", bot)
	}
	f.call(f.alice, http.MethodDelete, path, "", http.StatusOK, "remove the bot", nil)
	f.call(f.alice, http.MethodGet, path, "", http.StatusOK, "read the removed bot", &bot)
	if bot.App != nil || bot.Status != store.FeishuBotStatusUnconfigured {
		t.Fatalf("after removing: %+v", bot)
	}
	f.call(f.alice, http.MethodDelete, "/api/external-apps/"+app.ID, "", http.StatusOK, "remove the app no bot runs on", nil)
}
