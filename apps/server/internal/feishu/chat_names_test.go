package feishu

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/feishuevents"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

type renamedBot struct {
	fakeBot
	name string
	err  error
}

func (b *renamedBot) ChatName(context.Context, string) (string, error) { return b.name, b.err }

// A paired group's name follows Feishu: the change event renames it, a
// refresh reads it again, and a failed refresh keeps the name and says why.
func TestChatNameFollowsFeishu(t *testing.T) {
	ctx := context.Background()
	db := openPairingTestStore(t)
	alice := addUser(t, db, "alice", store.WorkspaceRoleMember)
	runBotOn(t, db, "ws_1", "cli_x")
	issueCode(t, db, "ws_1", "FND-ABCD", alice.ID)
	manager := NewWSManager(db, allSecrets{}, nil, eventsForTest())
	bot := &renamedBot{name: "Old"}
	app := &botApp{clientID: "cli_x", client: bot}
	manager.apps["cli_x"] = app
	if err := manager.handlePairCommand(ctx, app, "om_1", "oc_9", "group", "", "/pair FND-ABCD"); err != nil {
		t.Fatal(err)
	}
	chat := func() store.FeishuBotRoute {
		route, err := db.FindFeishuChatRoute(ctx, "cli_x", "oc_9")
		if err != nil {
			t.Fatal(err)
		}
		return route
	}
	if got := chat(); got.ChatName != "Old" || chatNameStale(got, time.Now()) || !chatNameStale(got, time.Now().Add(2*time.Hour)) {
		t.Fatalf("paired %+v, want Old, fresh for an hour", got)
	}

	manager.HandleEvent(ctx, feishuevents.Event{AppID: "cli_x", ID: "ev_1", Type: chatUpdated,
		Payload: []byte(`{"schema":"2.0","header":{"event_type":"im.chat.updated_v1"},"event":{"chat_id":"oc_9","after_change":{"name":"Renamed"}}}`)})
	if got := chat().ChatName; got != "Renamed" {
		t.Fatalf("after the change event the name is %q, want Renamed", got)
	}

	bot.err = errors.New("feishu get chat failed [99991672]: no permission")
	if err := manager.RefreshChatName(ctx, "ws_1", chat().ID); err == nil {
		t.Fatal("a failed refresh reported no error")
	}
	if got := chat(); got.ChatName != "Renamed" || got.ChatNameError == "" {
		t.Fatalf("after a failed refresh %+v, want the name kept and the reason", got)
	}

	bot.name, bot.err = "Newest", nil
	if err := manager.RefreshChatName(ctx, "ws_1", chat().ID); err != nil {
		t.Fatal(err)
	}
	if got := chat(); got.ChatName != "Newest" || got.ChatNameError != "" {
		t.Fatalf("after a refresh %+v, want Newest without an error", got)
	}
}
