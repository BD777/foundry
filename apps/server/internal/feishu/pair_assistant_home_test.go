package feishu

import (
	"context"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// A direct chat paired in a workspace that is not the assistant's home goes to
// the assistant: the route names the assistant's home, and the workspace it was
// paired in is the previous one.
func TestDirectChatPairedElsewhereGoesToTheAssistant(t *testing.T) {
	f := newAssistantFixture(t)
	chat, err := f.manager.chatRoute(context.Background(), f.app, "oc_dm")
	if err != nil {
		t.Fatal(err)
	}
	if chat.assistant == nil || chat.WorkspaceID != "ws_pa" || chat.assistant.previousWorkspaceID != "ws_1" {
		t.Fatalf("the direct chat paired in ws_1 = %+v, want the assistant of ws_pa with ws_1 as its previous workspace", chat)
	}
}

// The assistant's home pairs its own bot. The person's /pair, sent as a direct
// message, binds that chat to the home, and the chat goes to the assistant.
func TestPairingDirectChatOnTheAssistantHomeRoutesItToTheAssistant(t *testing.T) {
	ctx := context.Background()
	f := newAssistantFixture(t)
	runBotOn(t, f.db, "ws_pa", "cli_x")
	issueCode(t, f.db, "ws_pa", "FND-PADM", f.person.ID)

	f.send(t, personMessage("om_pair_dm", "", "/pair FND-PADM", "ou_person"))

	route, err := f.db.FindFeishuChatRoute(ctx, "cli_x", "oc_dm")
	if err != nil {
		t.Fatal(err)
	}
	if route.Kind != store.FeishuRouteP2P || route.WorkspaceID != "ws_pa" || route.BoundUserID != f.person.ID {
		t.Fatalf("the direct chat after /pair = %+v, want a direct route of ws_pa bound to the person", route)
	}
	chat, err := f.manager.chatRoute(ctx, f.app, "oc_dm")
	if err != nil {
		t.Fatal(err)
	}
	if chat.assistant == nil || chat.WorkspaceID != "ws_pa" || chat.assistant.previousWorkspaceID != "" {
		t.Fatalf("the paired direct chat = %+v, want the assistant of ws_pa with no previous workspace", chat)
	}
}

// The person's /pair in their direct chat is answered with the card of a chat
// the assistant takes: it says the messages here go to the assistant.
func TestDirectPairingReplyTellsThePersonTheAssistantAnswersHere(t *testing.T) {
	f := newAssistantFixture(t)
	runBotOn(t, f.db, "ws_pa", "cli_x")
	issueCode(t, f.db, "ws_pa", "FND-PADM", f.person.ID)

	f.send(t, personMessage("om_pair_dm", "", "/pair FND-PADM", "ou_person"))

	if !repliesContain(f.bot.take(), "om_pair_dm", "本单聊已关联至你的助理") {
		t.Fatal("the direct pairing was not answered with the assistant's copy")
	}
}

// A direct chat the assistant does not take is linked to its workspace, and
// its card says so instead of naming the assistant.
func TestDirectPairingReplyNamesTheWorkspaceWhenTheAssistantTakesNoChat(t *testing.T) {
	f := newAssistantFixture(t)
	f.desk.route.TakesDirectChats = false
	issueCode(t, f.db, "ws_1", "FND-PAW1", f.person.ID)

	f.send(t, personMessage("om_pair_ws1", "", "/pair FND-PAW1", "ou_person"))

	replies := f.bot.take()
	if !repliesContain(replies, "om_pair_ws1", "本单聊已关联至工作区") || repliesContain(replies, "om_pair_ws1", "你的助理") {
		t.Fatalf("the direct pairing copy = %+v, want the workspace copy", replies)
	}
}

// A group's /pair keeps the group copy.
func TestGroupPairingReplyKeepsTheGroupCopy(t *testing.T) {
	f := newAssistantFixture(t)
	issueCode(t, f.db, "ws_1", "FND-GRPW", f.person.ID)
	group := groupMessage("om_grp_pair", "", "@_user_1 /pair FND-GRPW", true)
	chat := "oc_new_group"
	group.Event.Message.ChatId = &chat
	f.send(t, group)

	if !repliesContain(f.bot.take(), "om_grp_pair", "本飞书群已成功绑定至工作区") {
		t.Fatal("the group pairing was not answered with the group copy")
	}
}
