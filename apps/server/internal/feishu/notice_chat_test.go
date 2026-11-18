package feishu

import (
	"context"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// A group the person pairs is not their notice chat: the bot's direct chats are
// the only place it carries an assistant's notices.
func TestHasNoticeChatIsNotAGroup(t *testing.T) {
	f := newAssistantFixture(t)
	other := addUser(t, f.db, "group_only", store.WorkspaceRoleMember)
	bindChat(t, f.db, "ws_1", "cli_x", "oc_group_only", store.FeishuRouteChat, other.ID)
	if f.manager.HasNoticeChat(context.Background(), other.ID, "asst_person") {
		t.Fatal("a group the person paired counts as their notice chat")
	}
}

// Eligibility does not wait on the bot running: a notice queued while the bot
// restarts is sent once it is back. Sending still needs the bot running.
func TestHasNoticeChatDoesNotNeedTheBotRunning(t *testing.T) {
	f := newAssistantFixture(t)
	delete(f.manager.apps, "cli_x")
	if !f.manager.HasNoticeChat(context.Background(), f.person.ID, "asst_person") {
		t.Fatal("a paired chat whose bot is restarting is not a notice chat")
	}
	if app, _ := f.manager.assistantDirectChat(context.Background(), f.person.ID, "asst_person"); app != nil {
		t.Fatal("a send found a bot that is not running")
	}
}
