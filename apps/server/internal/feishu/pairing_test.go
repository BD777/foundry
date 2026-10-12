package feishu

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/browserevent"
	"github.com/foundry-dev/foundry/apps/server/internal/sqlitestore"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func openPairingTestStore(t *testing.T) *sqlitestore.Store {
	t.Helper()
	db, err := sqlitestore.Open(t.TempDir() + "/foundry.db")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	if err := db.RegisterDaemon(context.Background(), store.DaemonRegistration{
		Device:    store.DeviceProjection{ID: "dev_1", Label: "D", Status: "connected"},
		Workspace: store.WorkspaceProjection{ID: "ws_1", Name: "W", LocalPath: "/tmp/ws_1"},
	}); err != nil {
		t.Fatal(err)
	}
	return db
}

func addUser(t *testing.T, db *sqlitestore.Store, username, workspaceRole string) store.User {
	t.Helper()
	ctx := context.Background()
	user, err := db.CreateUser(ctx, store.NewUser{Username: username, Role: store.RoleMember, PasswordHash: "h"})
	if err != nil {
		t.Fatal(err)
	}
	if workspaceRole != "" {
		if err := db.SetWorkspaceMember(ctx, "ws_1", user.ID, workspaceRole, user.ID); err != nil {
			t.Fatal(err)
		}
	}
	return user
}

// botApp registers Feishu app clientID in Connectors, once, and runs the
// workspace's bot on it.
func runBotOn(t *testing.T, db *sqlitestore.Store, workspaceID, clientID string) string {
	t.Helper()
	ctx := context.Background()
	apps, err := db.FeishuProviderAppsByClientID(ctx, clientID)
	if err != nil {
		t.Fatal(err)
	}
	var appID string
	if len(apps) > 0 {
		appID = apps[0].ID
	} else {
		app, err := db.CreateExternalProviderApp(ctx, store.ExternalProviderApp{Provider: "feishu", OwnerUserID: "u_owner", Label: "Bot", ClientID: clientID})
		if err != nil {
			t.Fatal(err)
		}
		appID = app.ID
	}
	if err := db.SetWorkspaceFeishuBotApp(ctx, workspaceID, appID); err != nil {
		t.Fatal(err)
	}
	return appID
}

// issueCode gives the workspace's bot a pairing code made by userID.
func issueCode(t *testing.T, db *sqlitestore.Store, workspaceID, code, userID string) store.FeishuBotRoute {
	t.Helper()
	route, err := db.SetFeishuPairingCode(context.Background(), workspaceID, HashPairingCode(code), userID, time.Now().Add(time.Minute).UTC().Format(time.RFC3339))
	if err != nil {
		t.Fatal(err)
	}
	return route
}

// bindChat routes chatID on Feishu app clientID to the workspace, acting
// as userID.
func bindChat(t *testing.T, db *sqlitestore.Store, workspaceID, clientID, chatID string, kind store.FeishuRouteKind, userID string) store.FeishuBotRoute {
	t.Helper()
	runBotOn(t, db, workspaceID, clientID)
	pairing := issueCode(t, db, workspaceID, "FND-"+chatID, userID)
	route, err := db.BindFeishuChat(context.Background(), pairing, store.FeishuBotRoute{Kind: kind, ChatID: chatID, BoundUserID: userID})
	if err != nil {
		t.Fatal(err)
	}
	return route
}

func bindGroup(t *testing.T, db *sqlitestore.Store, userID string) store.FeishuBotRoute {
	t.Helper()
	return bindChat(t, db, "ws_1", "cli_x", "oc_1", store.FeishuRouteChat, userID)
}

func TestPairingCodeIsStoredOnlyAsHash(t *testing.T) {
	ctx := context.Background()
	db := openPairingTestStore(t)
	alice := addUser(t, db, "alice", store.WorkspaceRoleMember)
	runBotOn(t, db, "ws_1", "cli_x")
	issueCode(t, db, "ws_1", "FND-ABCD", alice.ID)
	if _, err := db.FindFeishuPairingRoute(ctx, "cli_x", "FND-ABCD"); err == nil {
		t.Fatal("the plaintext code must not match a stored code")
	}
	route, err := db.FindFeishuPairingRoute(ctx, "cli_x", HashPairingCode(" fnd-abcd "))
	if err != nil || route.WorkspaceID != "ws_1" {
		t.Fatalf("hashed lookup = %+v %v", route, err)
	}
	if route.PairingCodeCreatedBy != alice.ID {
		t.Fatalf("code creator = %q, want %q", route.PairingCodeCreatedBy, alice.ID)
	}
}

func TestBoundUserFollowsTheAccountsCurrentPermissions(t *testing.T) {
	ctx := context.Background()
	db := openPairingTestStore(t)
	manager := NewWSManager(db, nil, nil, eventsForTest())

	if userID, refusal := manager.boundUser(ctx, store.FeishuBotRoute{WorkspaceID: "ws_1"}); userID != "" || refusal == "" {
		t.Fatalf("a chat bound to no account must refuse, got %q %q", userID, refusal)
	}

	alice := addUser(t, db, "alice", store.WorkspaceRoleMember)
	route := bindGroup(t, db, alice.ID)
	if userID, refusal := manager.boundUser(ctx, route); userID != alice.ID || refusal != "" {
		t.Fatalf("member binding = %q %q, want alice", userID, refusal)
	}

	route = bindGroup(t, db, "")
	if userID, refusal := manager.boundUser(ctx, route); userID != "" || refusal == "" {
		t.Fatalf("an unbound group must refuse, got %q %q", userID, refusal)
	}

	viewer := addUser(t, db, "vic", store.WorkspaceRoleViewer)
	route = bindGroup(t, db, viewer.ID)
	if userID, refusal := manager.boundUser(ctx, route); userID != "" || refusal == "" {
		t.Fatalf("a viewer binding must refuse, got %q %q", userID, refusal)
	}

	outsider := addUser(t, db, "otto", "")
	route = bindGroup(t, db, outsider.ID)
	if userID, refusal := manager.boundUser(ctx, route); userID != "" || refusal == "" {
		t.Fatalf("a non-member binding must refuse, got %q %q", userID, refusal)
	}

	route = bindGroup(t, db, alice.ID)
	disabled := true
	if _, err := db.UpdateUser(ctx, alice.ID, store.UserUpdate{Disabled: &disabled}); err != nil {
		t.Fatal(err)
	}
	if userID, refusal := manager.boundUser(ctx, route); userID != "" || refusal == "" {
		t.Fatalf("a disabled account must refuse, got %q %q", userID, refusal)
	}
}

func TestBotJSONNeverCarriesThePairingCodeHash(t *testing.T) {
	encoded, err := json.Marshal(store.WorkspaceFeishuBot{WorkspaceID: "ws_1", Chats: []store.FeishuBotRoute{{ID: "fbr_1", PairingCode: "hash", PairingCodeCreatedBy: "user_1"}}})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encoded), "hash") || strings.Contains(string(encoded), "user_1") {
		t.Fatalf("bot JSON leaks pairing state: %s", encoded)
	}
}

// Pairing binds the chat to the account that made the code and tells the
// bot's workspace what the bot is now, without the code. A chat paired
// again moves to the new code's workspace, which both workspaces are told.
func TestPairingTellsTheWorkspaceItsBot(t *testing.T) {
	ctx := context.Background()
	db := openPairingTestStore(t)
	addWorkspace(t, db, "ws_2")
	alice := addUser(t, db, "alice", store.WorkspaceRoleMember)
	runBotOn(t, db, "ws_1", "cli_x")
	runBotOn(t, db, "ws_2", "cli_x")
	issueCode(t, db, "ws_1", "FND-ABCD", alice.ID)
	events := eventsForTest()
	workspace, _ := events.Subscribe(workspaceReachForTest("ws_1"), "")
	other, _ := events.Subscribe(workspaceReachForTest("ws_2"), "")
	manager := NewWSManager(db, allSecrets{}, nil, events)
	app := &botApp{clientID: "cli_x", client: &fakeBot{}}
	if err := manager.handlePairCommand(ctx, app, "om_1", "oc_9", "group", "/pair FND-ABCD"); err != nil {
		t.Fatal(err)
	}
	if len(workspace.C) != 1 || len(other.C) != 0 {
		t.Fatalf("delivered to the workspace %d, to another %d; want the bot to its workspace only", len(workspace.C), len(other.C))
	}
	frame := string(<-workspace.C)
	bot := publishedBot(t, frame)
	if len(bot.Chats) != 1 || bot.Chats[0].ChatID != "oc_9" || bot.Chats[0].BoundUserID != alice.ID || bot.Chats[0].ChatName != "Group" ||
		bot.App == nil || bot.App.ClientID != "cli_x" || strings.Contains(frame, "FND-ABCD") || strings.Contains(frame, HashPairingCode("FND-ABCD")) {
		t.Fatalf("published %s, want the bot bound to the group as alice, without its code", frame)
	}
	// The spent code binds nothing more.
	if err := manager.handlePairCommand(ctx, app, "om_2", "oc_10", "group", "/pair FND-ABCD"); err != nil {
		t.Fatal(err)
	}
	if route, err := db.FindFeishuChatRoute(ctx, "cli_x", "oc_10"); err == nil {
		t.Fatalf("a spent code bound %+v", route)
	}

	issueCode(t, db, "ws_2", "FND-WS22", alice.ID)
	if err := manager.handlePairCommand(ctx, app, "om_3", "oc_9", "group", "/pair FND-WS22"); err != nil {
		t.Fatal(err)
	}
	if moved := publishedBot(t, string(<-other.C)); len(moved.Chats) != 1 || moved.Chats[0].ChatID != "oc_9" {
		t.Fatalf("ws_2 was told %+v, want oc_9", moved)
	}
	if left := publishedBot(t, string(<-workspace.C)); len(left.Chats) != 0 {
		t.Fatalf("ws_1 was told %+v, want no chat", left)
	}
}

func publishedBot(t *testing.T, frame string) store.WorkspaceFeishuBot {
	t.Helper()
	_, data, _ := strings.Cut(frame, "data: ")
	var published struct {
		Type    browserevent.Type        `json:"type"`
		Payload store.WorkspaceFeishuBot `json:"payload"`
	}
	if err := json.Unmarshal([]byte(strings.TrimSpace(data)), &published); err != nil {
		t.Fatalf("decode %q: %v", frame, err)
	}
	if published.Type != browserevent.FeishuBotUpdated {
		t.Fatalf("published %s", frame)
	}
	return published.Payload
}

// allSecrets holds a secret for every app.
type allSecrets struct{}

func (allSecrets) HasSecret(context.Context, string) (bool, error) { return true, nil }

func addWorkspace(t *testing.T, db *sqlitestore.Store, id string) {
	t.Helper()
	if err := db.RegisterDaemon(context.Background(), store.DaemonRegistration{
		Device:    store.DeviceProjection{ID: "dev_1", Label: "D", Status: "connected"},
		Workspace: store.WorkspaceProjection{ID: id, Name: "W " + id, LocalPath: "/tmp/" + id},
	}); err != nil {
		t.Fatal(err)
	}
}
