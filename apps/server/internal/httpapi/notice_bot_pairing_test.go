package httpapi

import (
	"context"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/feishu"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// The Foundry bot is offered for notices only while the person has a direct
// chat with it that their assistant takes. The assistant sets no feishuAppId,
// so it takes direct chats on every app, and its home is not the workspace the
// chat is paired in: the person's own setup. A group the person pairs is not a
// direct chat, and without one the bot is listed with its reason.
func TestNoticeBotIsOfferedOnlyWithAPairedDirectChat(t *testing.T) {
	f := newExternalAccountsFixture(t)
	ctx := context.Background()
	assistant, err := f.db.CreatePersonalAgent(ctx, store.PersonalAgent{
		UserID: f.aliceID, WorkspaceID: "ws_pa", HomeDeviceID: "dev_alice",
		Settings: store.PersonalAgentSettings{FeishuDirectChat: true},
	})
	if err != nil || !assistant.IsDefault {
		t.Fatalf("assistant = %+v (%v), want the default assistant", assistant, err)
	}
	app, err := f.db.CreateExternalProviderApp(ctx, store.ExternalProviderApp{
		Provider: "feishu", OwnerUserID: f.aliceID, Label: "Foundry", ClientID: "cli_foundry",
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := f.db.SetWorkspaceFeishuBotApp(ctx, "ws_alice", app.ID); err != nil {
		t.Fatal(err)
	}
	pairChat := func(chatID string, kind store.FeishuRouteKind) {
		t.Helper()
		pairing, err := f.db.SetFeishuPairingCode(ctx, "ws_alice", feishu.HashPairingCode("FND-"+chatID), f.aliceID, time.Now().Add(time.Minute).UTC().Format(time.RFC3339))
		if err != nil {
			t.Fatal(err)
		}
		if _, err := f.db.BindFeishuChat(ctx, pairing, store.FeishuBotRoute{Kind: kind, ChatID: chatID, BoundUserID: f.aliceID}); err != nil {
			t.Fatal(err)
		}
	}
	foundryBot := func() PersonalAgentNotifyInstance {
		t.Helper()
		instances, err := f.server.listPersonalAgentNotifyInstances(ctx, assistant)
		if err != nil {
			t.Fatal(err)
		}
		for _, instance := range instances {
			if instance.ConnectorInstanceID == feishu.NoticeSinkID {
				return instance
			}
		}
		t.Fatalf("the Foundry bot is not listed: %+v", instances)
		return PersonalAgentNotifyInstance{}
	}

	pairChat("oc_team", store.FeishuRouteChat)
	if bot := foundryBot(); bot.Recommended || bot.Reason != notifyReasonFeishuNotPaired {
		t.Fatalf("with only a group paired, the bot = %+v, want reason %q", bot, notifyReasonFeishuNotPaired)
	}
	if f.server.feishu.HasNoticeChat(ctx, f.aliceID, assistant.ID) {
		t.Fatal("a paired group counts as the assistant's notice chat")
	}

	pairChat("oc_dm", store.FeishuRouteP2P)
	if bot := foundryBot(); !bot.Recommended || bot.Reason != "" {
		t.Fatalf("with a direct chat paired, the bot = %+v, want recommended without a reason", bot)
	}
	if !f.server.feishu.HasNoticeChat(ctx, f.aliceID, assistant.ID) {
		t.Fatal("a paired direct chat taken by the default assistant is not a notice chat")
	}
}
