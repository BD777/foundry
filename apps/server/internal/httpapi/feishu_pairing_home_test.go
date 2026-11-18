package httpapi

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/feishu"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// feishuAppForPairing registers one Feishu app of the person, for the pairing
// tests below.
func (f assistantFixture) feishuAppForPairing(t *testing.T, clientID string) store.ExternalProviderApp {
	t.Helper()
	app, err := f.server.store.CreateExternalProviderApp(context.Background(), store.ExternalProviderApp{
		Provider: "feishu", OwnerUserID: f.aliceID, Label: "Foundry " + clientID, ClientID: clientID,
	})
	if err != nil {
		t.Fatal(err)
	}
	return app
}

// assistantHomePairingRoute is the pairing route of the workspace, nil when it
// has none.
func (f assistantFixture) assistantHomePairingRoute(t *testing.T, workspaceID string) *store.FeishuBotRoute {
	t.Helper()
	routes, err := f.server.store.ListFeishuBotRoutes(context.Background(), store.FeishuBotRouteFilter{WorkspaceID: workspaceID})
	if err != nil {
		t.Fatal(err)
	}
	for _, route := range routes {
		if route.Kind == store.FeishuRoutePairing {
			return &route
		}
	}
	return nil
}

// setAliceAssistantFeishu sets the person's default assistant's Feishu direct
// chat and the app it names.
func (f assistantFixture) setAliceAssistantFeishu(t *testing.T, takesDirectChat bool, appID string) {
	t.Helper()
	ctx := context.Background()
	agent, err := f.server.store.DefaultAssistant(ctx, f.aliceID)
	if err != nil {
		t.Fatal(err)
	}
	settings := agent.Settings
	settings.FeishuDirectChat, settings.FeishuAppID = takesDirectChat, appID
	if _, err := f.server.store.SavePersonalAgentSettings(ctx, agent.ID, settings); err != nil {
		t.Fatal(err)
	}
}

// The assistant's home has no bot yet. With the one Feishu app the person has,
// pair_code runs the bot on it and issues the code, so the person's direct
// message reaches the assistant.
func TestPairCodeBindsTheAssistantHomeBotOnTheOnlyFeishuApp(t *testing.T) {
	f := newAssistantFixture(t)
	token := f.foundryChatToken(t)
	ctx := context.Background()
	app := f.feishuAppForPairing(t, "cli_home")
	if err := f.server.store.SetWorkspaceMember(ctx, "ws_pa", f.aliceID, store.WorkspaceRoleOwner, "test"); err != nil {
		t.Fatal(err)
	}

	answer, text, failed := f.foundryCall(t, token, map[string]any{"op": "pair_code", "area": "feishu", "workspaceId": "ws_pa"})
	if failed {
		t.Fatalf("the assistant's home was refused a pairing code: %s", text)
	}
	if answer["status"] != "issued" || !strings.HasPrefix(answer["pairingCode"].(string), "FND-") {
		t.Fatalf("pairing answer = %v, want an issued FND- code", answer)
	}
	route := f.assistantHomePairingRoute(t, "ws_pa")
	if route == nil || route.AppID != app.ID || route.PairingCodeCreatedBy != f.aliceID {
		t.Fatalf("the home's pairing route = %+v, want the bot on app %s with the code of %s", route, app.ID, f.aliceID)
	}
}

// With several Feishu apps and none named by the assistant, no app is guessed:
// the code is refused and the bot is not started.
func TestPairCodeRefusesTheAssistantHomeWithSeveralFeishuAppsAndNoneNamed(t *testing.T) {
	f := newAssistantFixture(t)
	token := f.foundryChatToken(t)
	ctx := context.Background()
	f.feishuAppForPairing(t, "cli_one")
	f.feishuAppForPairing(t, "cli_two")
	if err := f.server.store.SetWorkspaceMember(ctx, "ws_pa", f.aliceID, store.WorkspaceRoleOwner, "test"); err != nil {
		t.Fatal(err)
	}

	if _, text, failed := f.foundryCall(t, token, map[string]any{"op": "pair_code", "area": "feishu", "workspaceId": "ws_pa"}); !failed || !strings.Contains(text, "feishuAppId") {
		t.Fatalf("several apps, none named: %q (failed %v), want a refusal naming feishuAppId", text, failed)
	}
	if route := f.assistantHomePairingRoute(t, "ws_pa"); route != nil {
		t.Fatalf("a bot was started on an app nobody named: %+v", route)
	}
}

// The assistant's feishuAppId decides which of the person's apps runs the bot.
func TestPairCodeUsesTheFeishuAppTheAssistantNames(t *testing.T) {
	f := newAssistantFixture(t)
	token := f.foundryChatToken(t)
	ctx := context.Background()
	f.feishuAppForPairing(t, "cli_one")
	named := f.feishuAppForPairing(t, "cli_two")
	f.setAliceAssistantFeishu(t, true, named.ID)
	if err := f.server.store.SetWorkspaceMember(ctx, "ws_pa", f.aliceID, store.WorkspaceRoleOwner, "test"); err != nil {
		t.Fatal(err)
	}

	if _, text, failed := f.foundryCall(t, token, map[string]any{"op": "pair_code", "area": "feishu", "workspaceId": "ws_pa"}); failed {
		t.Fatalf("the named app was refused: %s", text)
	}
	if route := f.assistantHomePairingRoute(t, "ws_pa"); route == nil || route.AppID != named.ID {
		t.Fatalf("the home's pairing route = %+v, want the named app %s", route, named.ID)
	}
}

// An assistant that takes no Feishu direct messages gets no bot from pairing.
func TestPairCodeRefusesTheAssistantHomeWhenItTakesNoDirectChats(t *testing.T) {
	f := newAssistantFixture(t)
	token := f.foundryChatToken(t)
	ctx := context.Background()
	f.feishuAppForPairing(t, "cli_home")
	f.setAliceAssistantFeishu(t, false, "")
	if err := f.server.store.SetWorkspaceMember(ctx, "ws_pa", f.aliceID, store.WorkspaceRoleOwner, "test"); err != nil {
		t.Fatal(err)
	}

	if _, text, failed := f.foundryCall(t, token, map[string]any{"op": "pair_code", "area": "feishu", "workspaceId": "ws_pa"}); !failed || !strings.Contains(text, "direct") {
		t.Fatalf("no direct chats: %q (failed %v), want a refusal about direct messages", text, failed)
	}
	if route := f.assistantHomePairingRoute(t, "ws_pa"); route != nil {
		t.Fatalf("a bot was started for an assistant that takes no direct chats: %+v", route)
	}
}

// A workspace that is not the assistant's home is not bound by pairing: it
// keeps the answer to pick its bot first.
func TestPairCodeLeavesAWorkspaceWithoutABotAlone(t *testing.T) {
	f := newAssistantFixture(t)
	token := f.foundryChatToken(t)
	f.feishuAppForPairing(t, "cli_home")
	if err := f.server.store.SetWorkspaceMember(context.Background(), "ws_alice", f.aliceID, store.WorkspaceRoleOwner, "test"); err != nil {
		t.Fatal(err)
	}

	if _, text, failed := f.foundryCall(t, token, map[string]any{"op": "pair_code", "area": "feishu", "workspaceId": "ws_alice"}); !failed || !strings.Contains(text, "pick the Feishu app") {
		t.Fatalf("a workspace that is not the home: %q (failed %v), want the pick-the-app refusal", text, failed)
	}
	if route := f.assistantHomePairingRoute(t, "ws_alice"); route != nil {
		t.Fatalf("a bot was started on a workspace that is not the assistant's home: %+v", route)
	}
}

// pairDirectChat pairs the person's direct chat on workspaceID's bot, which runs
// on appID, the way /pair does.
func (f assistantFixture) pairDirectChat(t *testing.T, workspaceID, appID, chatID string) {
	t.Helper()
	ctx := context.Background()
	db := f.server.store
	if err := db.SetWorkspaceFeishuBotApp(ctx, workspaceID, appID); err != nil {
		t.Fatal(err)
	}
	pairing, err := db.SetFeishuPairingCode(ctx, workspaceID, feishu.HashPairingCode("FND-"+chatID), f.aliceID, time.Now().Add(time.Minute).UTC().Format(time.RFC3339))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.BindFeishuChat(ctx, pairing, store.FeishuBotRoute{Kind: store.FeishuRouteP2P, ChatID: chatID, BoundUserID: f.aliceID, PeerOpenID: "ou_alice"}); err != nil {
		t.Fatal(err)
	}
}

// The person has two Feishu apps and names none, but their assistant's direct
// chat is already paired on one of them: that app runs the bot, so the code is
// issued without naming it.
func TestPairCodeUsesTheAppOfTheAssistantsPairedDirectChat(t *testing.T) {
	f := newAssistantFixture(t)
	token := f.foundryChatToken(t)
	ctx := context.Background()
	paired := f.feishuAppForPairing(t, "cli_paired")
	f.feishuAppForPairing(t, "cli_other")
	f.pairDirectChat(t, "ws_alice", paired.ID, "oc_dm_paired")
	if err := f.server.store.SetWorkspaceMember(ctx, "ws_pa", f.aliceID, store.WorkspaceRoleOwner, "test"); err != nil {
		t.Fatal(err)
	}

	answer, text, failed := f.foundryCall(t, token, map[string]any{"op": "pair_code", "area": "feishu", "workspaceId": "ws_pa"})
	if failed {
		t.Fatalf("the assistant's home was refused with a paired direct chat on one app: %s", text)
	}
	if answer["status"] != "issued" {
		t.Fatalf("pairing answer = %v, want an issued code", answer)
	}
	if route := f.assistantHomePairingRoute(t, "ws_pa"); route == nil || route.AppID != paired.ID {
		t.Fatalf("the home's pairing route = %+v, want the paired direct chat's app %s", route, paired.ID)
	}
}

// Direct chats paired on two apps leave no app to choose: the code is refused
// until the assistant names one.
func TestPairCodeRefusesWhenTheAssistantsDirectChatsRunOnTwoApps(t *testing.T) {
	f := newAssistantFixture(t)
	token := f.foundryChatToken(t)
	ctx := context.Background()
	first := f.feishuAppForPairing(t, "cli_first")
	second := f.feishuAppForPairing(t, "cli_second")
	f.pairDirectChat(t, "ws_alice", first.ID, "oc_dm_first")
	f.pairDirectChat(t, "ws_bob", second.ID, "oc_dm_second")
	if err := f.server.store.SetWorkspaceMember(ctx, "ws_pa", f.aliceID, store.WorkspaceRoleOwner, "test"); err != nil {
		t.Fatal(err)
	}

	if _, text, failed := f.foundryCall(t, token, map[string]any{"op": "pair_code", "area": "feishu", "workspaceId": "ws_pa"}); !failed || !strings.Contains(text, "several Feishu apps") {
		t.Fatalf("direct chats on two apps: %q (failed %v), want a refusal naming several apps", text, failed)
	}
	if route := f.assistantHomePairingRoute(t, "ws_pa"); route != nil {
		t.Fatalf("a bot was started while the direct chats run on two apps: %+v", route)
	}
}
