package feishu

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"sort"
	"sync"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/feishuevents"
	"github.com/foundry-dev/foundry/apps/server/internal/feishuevents/feishueventstest"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// sharedAppSecret is the one app both workspaces' bots run on.
type sharedAppSecret struct{}

func (sharedAppSecret) AppCredentials(_ context.Context, appID string) (feishuevents.Credentials, error) {
	if appID != "cli_shared" {
		return feishuevents.Credentials{}, errors.New("unknown app")
	}
	return feishuevents.Credentials{AppID: appID, AppSecret: "secret_shared"}, nil
}

// recordingDispatcher records the sessions topics start.
type recordingDispatcher struct {
	mu      sync.Mutex
	started []store.CreateAgentSessionInput
}

func (d *recordingDispatcher) CreateSessionAndDispatch(_ context.Context, input store.CreateAgentSessionInput) (store.AgentSession, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.started = append(d.started, input)
	return store.AgentSession{ID: fmt.Sprintf("sess_%d", len(d.started)), WorkspaceID: input.WorkspaceID}, nil
}

func (d *recordingDispatcher) SendSessionMessage(context.Context, string, string) error { return nil }

func (d *recordingDispatcher) byWorkspace() map[string][]string {
	d.mu.Lock()
	defer d.mu.Unlock()
	prompts := map[string][]string{}
	for _, input := range d.started {
		prompts[input.WorkspaceID] = append(prompts[input.WorkspaceID], input.Prompt)
	}
	for _, list := range prompts {
		sort.Strings(list)
	}
	return prompts
}

func (d *recordingDispatcher) count() int {
	d.mu.Lock()
	defer d.mu.Unlock()
	return len(d.started)
}

// Two workspaces whose bots run on one Feishu app share the server's one
// connection to it, and each gets exactly its own group's messages: none
// lost to a connection the other workspace held, none twice.
func TestTwoWorkspacesShareOneAppConnection(t *testing.T) {
	ctx := context.Background()
	db := openPairingTestStore(t)
	addWorkspace(t, db, "ws_2")
	member := addUser(t, db, "member", store.WorkspaceRoleMember)
	if err := db.SetWorkspaceMember(ctx, "ws_2", member.ID, store.WorkspaceRoleMember, member.ID); err != nil {
		t.Fatal(err)
	}
	for workspace, chat := range map[string]string{"ws_1": "oc_1", "ws_2": "oc_2"} {
		bindChat(t, db, workspace, "cli_shared", chat, store.FeishuRouteChat, member.ID)
	}

	fake := feishueventstest.NewFakeSource("cli_shared", "secret_shared")
	t.Cleanup(fake.Close)
	hub := feishuevents.NewHub(sharedAppSecret{}, nil)
	hub.Domain = fake.URL()
	hub.Logf = t.Logf
	t.Cleanup(hub.Stop)
	dispatcher := &recordingDispatcher{}
	manager := NewWSManager(db, allSecrets{}, dispatcher, eventsForTest())
	bot := &fakeBot{}
	manager.newClient = func(string, string, string) botClient { return bot }
	manager.Events, manager.Credentials = hub, sharedAppSecret{}
	hub.Bots = manager
	manager.Sync(ctx)
	if !fake.WaitOpen(1, 5*time.Second) {
		t.Fatal("the app's connection did not open")
	}

	const each = 5
	want := map[string][]string{}
	for index := range each {
		for workspace, chat := range map[string]string{"ws_1": "oc_1", "ws_2": "oc_2"} {
			text := fmt.Sprintf("task %d for %s", index, workspace)
			want[workspace] = append(want[workspace], text)
			id := fmt.Sprintf("%s_%d", chat, index)
			payload := feishueventstest.MessagePayload("cli_shared", "ev_"+id, chat, "om_"+id, "", text, true)
			if _, err := fake.Push(payload, 1); err != nil {
				t.Fatal(err)
			}
			if index == 0 {
				// Feishu redelivers one of them.
				if _, err := fake.Push(payload, 1); err != nil {
					t.Fatal(err)
				}
			}
		}
	}
	// A group neither workspace is bound to.
	if _, err := fake.Push(feishueventstest.MessagePayload("cli_shared", "ev_stray", "oc_3", "om_stray", "", "anyone?", true), 1); err != nil {
		t.Fatal(err)
	}
	fake.WaitAcks(2*each+3, 5*time.Second)
	for deadline := time.Now().Add(5 * time.Second); dispatcher.count() < 2*each && time.Now().Before(deadline); {
		time.Sleep(10 * time.Millisecond)
	}
	time.Sleep(100 * time.Millisecond)
	got := dispatcher.byWorkspace()
	for workspace := range want {
		sort.Strings(want[workspace])
		if !slices.Equal(got[workspace], want[workspace]) {
			t.Fatalf("%s started %v, want %v", workspace, got[workspace], want[workspace])
		}
	}
	if dispatcher.count() != 2*each {
		t.Fatalf("%d sessions started, want %d (no duplicates, nothing for the stray group)", dispatcher.count(), 2*each)
	}
	if fake.Accepted() != 1 || fake.EndpointRequests() != 1 {
		t.Fatalf("%d connections to feishu, want one for both workspaces", fake.Accepted())
	}
	for _, workspace := range []string{"ws_1", "ws_2"} {
		if view, err := manager.WorkspaceBot(ctx, workspace); err != nil || view.Status != store.FeishuBotStatusConnected || view.LastEventAt == "" {
			t.Fatalf("%s bot = %+v %v, want connected with a last event", workspace, view, err)
		}
	}

	// A reply in a topic goes to the workspace that started the topic,
	// without a mention.
	if _, err := fake.Push(feishueventstest.MessagePayload("cli_shared", "ev_reply", "oc_2", "om_reply", "om_oc_2_1", "and also this", false), 1); err != nil {
		t.Fatal(err)
	}
	// A new group pairs with the workspace whose code it sends.
	issueCode(t, db, "ws_2", "FND-WS22", member.ID)
	if _, err := fake.Push(feishueventstest.MessagePayload("cli_shared", "ev_pair", "oc_new", "om_pair", "", "/pair FND-WS22", true), 1); err != nil {
		t.Fatal(err)
	}
	var paired store.FeishuBotRoute
	for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); time.Sleep(10 * time.Millisecond) {
		if route, err := db.FindFeishuChatRoute(ctx, "cli_shared", "oc_new"); err == nil {
			paired = route
			break
		}
	}
	if paired.WorkspaceID != "ws_2" || paired.BoundUserID != member.ID {
		t.Fatalf("after pairing oc_new routes to %+v, want ws_2 as the member", paired)
	}
	if route, _ := db.FindFeishuChatRoute(ctx, "cli_shared", "oc_1"); route.WorkspaceID != "ws_1" {
		t.Fatalf("pairing another group moved oc_1 to %q", route.WorkspaceID)
	}
	// The topic's session is not in the store, so the follow-up is answered
	// with why it cannot continue: it was routed to the topic, not dropped.
	answered := false
	for deadline := time.Now().Add(5 * time.Second); !answered && time.Now().Before(deadline); time.Sleep(10 * time.Millisecond) {
		for _, reply := range bot.take() {
			answered = answered || reply.to == "om_reply"
		}
	}
	if !answered {
		t.Fatal("the reply in ws_2's topic was not routed to the topic")
	}

	// The connection stays while either workspace's bot runs on the app.
	if err := db.DeleteWorkspaceFeishuBot(ctx, "ws_1"); err != nil {
		t.Fatal(err)
	}
	manager.Sync(ctx)
	time.Sleep(50 * time.Millisecond)
	if fake.Open() != 1 {
		t.Fatal("removing one bot closed the other's connection")
	}
	if err := db.DeleteWorkspaceFeishuBot(ctx, "ws_2"); err != nil {
		t.Fatal(err)
	}
	manager.Sync(ctx)
	if !fake.WaitOpen(0, 5*time.Second) {
		t.Fatal("the connection outlived both bots")
	}
}

// In a direct chat with the bot every message is for it: it starts a
// topic without a mention. In a group, a message without one is dropped.
func TestADirectChatNeedsNoMention(t *testing.T) {
	ctx := context.Background()
	db := openPairingTestStore(t)
	member := addUser(t, db, "member", store.WorkspaceRoleMember)
	bindChat(t, db, "ws_1", "cli_x", "oc_dm", store.FeishuRouteP2P, member.ID)
	bindChat(t, db, "ws_1", "cli_x", "oc_group", store.FeishuRouteChat, member.ID)
	dispatcher := &recordingDispatcher{}
	manager := NewWSManager(db, allSecrets{}, dispatcher, eventsForTest())
	app := &botApp{clientID: "cli_x", client: &fakeBot{}}
	direct := groupMessage("om_dm", "", "summarise the repo", false)
	chat, kind := "oc_dm", "p2p"
	direct.Event.Message.ChatId, direct.Event.Message.ChatType = &chat, &kind
	if err := manager.handleMessage(ctx, app, direct); err != nil {
		t.Fatal(err)
	}
	group := groupMessage("om_group", "", "chatter", false)
	groupChat := "oc_group"
	group.Event.Message.ChatId = &groupChat
	if err := manager.handleMessage(ctx, app, group); err != nil {
		t.Fatal(err)
	}
	if started := dispatcher.byWorkspace()["ws_1"]; len(started) != 1 || started[0] != "summarise the repo" {
		t.Fatalf("started %v, want the direct message only", started)
	}
	if dispatcher.started[0].CreatedByUserID != member.ID {
		t.Fatalf("the direct chat acted as %q, want the member who paired it", dispatcher.started[0].CreatedByUserID)
	}
}
