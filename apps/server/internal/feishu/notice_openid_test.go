package feishu

import (
	"context"
	"errors"
	"fmt"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// openIDBot is the fixture's bot client with direct messages by open_id: it opens
// chatID, or refuses with err when err is set.
type openIDBot struct {
	*fakeBot
	chatID string
	err    error
	opened []string
}

func (b *openIDBot) SendCardToOpenID(_ context.Context, openID, _ string) (string, string, error) {
	b.opened = append(b.opened, openID)
	if b.err != nil {
		return "", "", b.err
	}
	return "om_by_open_id", b.chatID, nil
}

// The bot clients of the other fixtures take the open_id send too, opening a
// chat nobody asserts on.
func (b *fakeBot) SendCardToOpenID(context.Context, string, string) (string, string, error) {
	return "om_open_id", "oc_open_id", nil
}

func (b *renamedBot) SendCardToOpenID(context.Context, string, string) (string, string, error) {
	return "om_open_id", "oc_open_id", nil
}

func (b *fakeBot) ChatUserOpenIDs(context.Context, string) ([]string, error) { return nil, nil }

func (b *renamedBot) ChatUserOpenIDs(context.Context, string) ([]string, error) { return nil, nil }

// bindGroupWithOpenID pairs a group chat for userID on the fixture's app, the way
// the group's /pair command does: the sender's open_id is recorded.
func bindGroupWithOpenID(t *testing.T, f assistantFixture, userID, openID string) {
	t.Helper()
	pairing := issueCode(t, f.db, "ws_1", "FND-"+openID, userID)
	chat := store.FeishuBotRoute{Kind: store.FeishuRouteChat, ChatID: "oc_" + openID, BoundUserID: userID, PeerOpenID: openID}
	if _, err := f.db.BindFeishuChat(context.Background(), pairing, chat); err != nil {
		t.Fatal(err)
	}
}

// A person whose open_id a group pairing recorded can take notices: the bot writes
// to them by open_id, so no direct chat is needed first.
func TestNoticeChatReachesThePersonThroughAGroupOpenID(t *testing.T) {
	f := newAssistantFixture(t)
	other := addUser(t, f.db, "group_only", store.WorkspaceRoleMember)
	bindGroupWithOpenID(t, f, other.ID, "ou_group_only")
	ctx := context.Background()
	if reason := f.manager.NoticeChatReason(ctx, other.ID, "asst_person"); reason != "" {
		t.Fatalf("reason = %q, want the person reachable by their open_id", reason)
	}
	if !f.manager.HasNoticeChat(ctx, other.ID, "asst_person") {
		t.Fatal("a verified open_id cannot queue notices")
	}
}

// The first notice opens the direct chat by open_id, and the chat it opens is the
// person's p2p route for the app and assistant: later notices go to that chat.
func TestFirstNoticeByOpenIDRecordsTheDirectChat(t *testing.T) {
	f := newAssistantFixture(t)
	ctx := context.Background()
	other := addUser(t, f.db, "group_only", store.WorkspaceRoleMember)
	bindGroupWithOpenID(t, f, other.ID, "ou_group_only")
	bot := &openIDBot{fakeBot: f.bot, chatID: "oc_dm_new"}
	f.app.client = bot
	notice := openNotice("question", "收起来")
	notice.UserID = other.ID

	messageID, err := f.manager.SendNotice(ctx, notice)
	if err != nil || messageID != "om_by_open_id" {
		t.Fatalf("first notice = %q, %v; want the card sent by open_id", messageID, err)
	}
	if len(bot.opened) != 1 || bot.opened[0] != "ou_group_only" {
		t.Fatalf("opened by open_id = %v, want the person's open_id once", bot.opened)
	}
	chats := f.manager.pairedDirectChats(ctx, other.ID, "asst_person")
	if len(chats) != 1 || chats[0].chatID != "oc_dm_new" || chats[0].clientID != "cli_x" {
		t.Fatalf("paired direct chats = %+v, want the chat Feishu opened", chats)
	}
	var recorded store.FeishuBotRoute
	routes, err := f.db.ListFeishuBotRoutes(ctx, store.FeishuBotRouteFilter{})
	if err != nil {
		t.Fatal(err)
	}
	for _, route := range routes {
		if route.Kind == store.FeishuRouteP2P && route.BoundUserID == other.ID {
			recorded = route
		}
	}
	if recorded.ChatID != "oc_dm_new" || recorded.PeerOpenID != "ou_group_only" || recorded.WorkspaceID != "ws_pa" {
		t.Fatalf("recorded direct chat route = %+v, want chat oc_dm_new, the person's open_id, the assistant's home ws_pa", recorded)
	}

	if _, err := f.manager.SendNotice(ctx, notice); err != nil {
		t.Fatal(err)
	}
	if len(bot.opened) != 1 {
		t.Fatalf("a later notice opened the chat by open_id again: %v", bot.opened)
	}
	f.bot.mu.Lock()
	last := f.bot.sent[len(f.bot.sent)-1].to
	f.bot.mu.Unlock()
	if last != "oc_dm_new" {
		t.Fatalf("later notice sent to %q, want the recorded chat oc_dm_new", last)
	}
}

// A person outside the app's availability range ends the notice with the reason,
// and the settings show it instead of a pairing task.
func TestFirstNoticeReportsAPersonOutsideTheAppsScope(t *testing.T) {
	f := newAssistantFixture(t)
	ctx := context.Background()
	other := addUser(t, f.db, "group_only", store.WorkspaceRoleMember)
	bindGroupWithOpenID(t, f, other.ID, "ou_group_only")
	f.app.client = &openIDBot{fakeBot: f.bot, err: fmt.Errorf("%w: feishu [230013]: Bot has NO availability to this user", ErrUserNotReachable)}
	notice := openNotice("question", "收起来")
	notice.UserID = other.ID

	if _, err := f.manager.SendNotice(ctx, notice); !errors.Is(err, ErrUserNotReachable) {
		t.Fatalf("send error = %v, want ErrUserNotReachable", err)
	}
	if got := f.manager.NoticeChatReason(ctx, other.ID, "asst_person"); got != NoticeReasonNotReachable {
		t.Fatalf("reason = %q, want %q", got, NoticeReasonNotReachable)
	}
	if len(f.manager.pairedDirectChats(ctx, other.ID, "asst_person")) != 0 {
		t.Fatal("a refused person got a direct chat route")
	}
	if !f.manager.HasNoticeChat(ctx, other.ID, "asst_person") {
		t.Fatal("a refused person is not queued, so the notice would be dropped rather than failed with its reason")
	}
}

// The sender of a group's pairing code is recorded as the person's open_id on the
// group route: the identity the bot writes to.
func TestGroupPairingRecordsTheSendersOpenID(t *testing.T) {
	f := newAssistantFixture(t)
	ctx := context.Background()
	other := addUser(t, f.db, "group_pairer", store.WorkspaceRoleMember)
	issueCode(t, f.db, "ws_1", "FND-PAIR", other.ID)
	if err := f.manager.handlePairCommand(ctx, f.app, "om_pair", "oc_pair_group", "group", "ou_pairer", "/pair FND-PAIR"); err != nil {
		t.Fatal(err)
	}
	routes, err := f.db.ListFeishuBotRoutes(ctx, store.FeishuBotRouteFilter{})
	if err != nil {
		t.Fatal(err)
	}
	for _, route := range routes {
		if route.ChatID == "oc_pair_group" {
			if route.Kind != store.FeishuRouteChat || route.BoundUserID != other.ID || route.PeerOpenID != "ou_pairer" {
				t.Fatalf("group route = %+v, want a chat bound to the code's person with their open_id", route)
			}
			return
		}
	}
	t.Fatal("the group was not paired")
}
