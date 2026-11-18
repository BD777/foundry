package feishu

import (
	"context"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// membersBot is the fixture's bot client with a group whose user members are users.
type membersBot struct {
	*fakeBot
	users []string
}

func (b *membersBot) ChatUserOpenIDs(context.Context, string) ([]string, error) {
	return b.users, nil
}

// legacyGroup pairs a group for userID the way groups paired before the sender's
// open_id was kept: no person recorded on the route.
func legacyGroup(t *testing.T, f assistantFixture, userID, chatID string) {
	t.Helper()
	pairing := issueCode(t, f.db, "ws_1", "FND-"+chatID, userID)
	if _, err := f.db.BindFeishuChat(context.Background(), pairing, store.FeishuBotRoute{Kind: store.FeishuRouteChat, ChatID: chatID, BoundUserID: userID}); err != nil {
		t.Fatal(err)
	}
}

// A group whose only user member is the one person is that person's: the backfill
// records it, and the person can take notices by open_id.
func TestBackfillDerivesThePersonOfASingleUserGroup(t *testing.T) {
	f := newAssistantFixture(t)
	ctx := context.Background()
	other := addUser(t, f.db, "legacy_single", store.WorkspaceRoleMember)
	legacyGroup(t, f, other.ID, "oc_legacy_single")
	if reason := f.manager.NoticeChatReason(ctx, other.ID, "asst_person"); reason != NoticeReasonNotPaired {
		t.Fatalf("before the backfill reason = %q, want %q", reason, NoticeReasonNotPaired)
	}
	f.app.client = &membersBot{fakeBot: f.bot, users: []string{"ou_legacy_single"}}
	f.manager.backfillGroupPeers(ctx, f.app)
	if reason := f.manager.NoticeChatReason(ctx, other.ID, "asst_person"); reason != "" {
		t.Fatalf("after the backfill reason = %q, want the person reachable by their open_id", reason)
	}
}

// A group with several user members has no person derivable from it: the route keeps
// none, and the person stays without a notice chat.
func TestBackfillLeavesAGroupWithSeveralUsersUnderived(t *testing.T) {
	f := newAssistantFixture(t)
	ctx := context.Background()
	other := addUser(t, f.db, "legacy_team", store.WorkspaceRoleMember)
	legacyGroup(t, f, other.ID, "oc_legacy_team")
	f.app.client = &membersBot{fakeBot: f.bot, users: []string{"ou_team_a", "ou_team_b"}}
	f.manager.backfillGroupPeers(ctx, f.app)
	if reason := f.manager.NoticeChatReason(ctx, other.ID, "asst_person"); reason != NoticeReasonNotPaired {
		t.Fatalf("reason = %q for a group of several users, want %q", reason, NoticeReasonNotPaired)
	}
}
