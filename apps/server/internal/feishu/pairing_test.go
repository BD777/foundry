package feishu

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

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

func bindGroup(t *testing.T, db *sqlitestore.Store, userID string) {
	t.Helper()
	if _, err := db.SaveWorkspaceFeishuBot(context.Background(), store.WorkspaceFeishuBot{
		WorkspaceID: "ws_1", AppID: "cli_x", ChatID: "oc_1", BoundUserID: userID, Status: store.FeishuBotStatusConnected,
	}); err != nil {
		t.Fatal(err)
	}
}

func TestPairingCodeIsStoredOnlyAsHash(t *testing.T) {
	ctx := context.Background()
	db := openPairingTestStore(t)
	alice := addUser(t, db, "alice", store.WorkspaceRoleMember)
	if _, err := db.SaveWorkspaceFeishuBot(ctx, store.WorkspaceFeishuBot{
		WorkspaceID: "ws_1", AppID: "cli_x", PairingCode: HashPairingCode("FND-ABCD"),
		PairingCodeCreatedBy: alice.ID, Status: store.FeishuBotStatusConnected,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := db.FindWorkspaceByPairingCode(ctx, "FND-ABCD"); err == nil {
		t.Fatal("the plaintext code must not match a stored code")
	}
	bot, err := db.FindWorkspaceByPairingCode(ctx, HashPairingCode(" fnd-abcd "))
	if err != nil || bot.WorkspaceID != "ws_1" {
		t.Fatalf("hashed lookup = %+v %v", bot, err)
	}
	if bot.PairingCodeCreatedBy != alice.ID {
		t.Fatalf("code creator = %q, want %q", bot.PairingCodeCreatedBy, alice.ID)
	}
}

func TestBoundUserFollowsTheAccountsCurrentPermissions(t *testing.T) {
	ctx := context.Background()
	db := openPairingTestStore(t)
	manager := NewWSManager(db, nil, nil)

	if userID, refusal := manager.boundUser(ctx, "ws_1"); userID != "" || refusal == "" {
		t.Fatalf("a workspace without a bot must refuse, got %q %q", userID, refusal)
	}

	alice := addUser(t, db, "alice", store.WorkspaceRoleMember)
	bindGroup(t, db, alice.ID)
	if userID, refusal := manager.boundUser(ctx, "ws_1"); userID != alice.ID || refusal != "" {
		t.Fatalf("member binding = %q %q, want alice", userID, refusal)
	}

	bindGroup(t, db, "")
	if userID, refusal := manager.boundUser(ctx, "ws_1"); userID != "" || refusal == "" {
		t.Fatalf("an unbound group must refuse, got %q %q", userID, refusal)
	}

	viewer := addUser(t, db, "vic", store.WorkspaceRoleViewer)
	bindGroup(t, db, viewer.ID)
	if userID, refusal := manager.boundUser(ctx, "ws_1"); userID != "" || refusal == "" {
		t.Fatalf("a viewer binding must refuse, got %q %q", userID, refusal)
	}

	outsider := addUser(t, db, "otto", "")
	bindGroup(t, db, outsider.ID)
	if userID, refusal := manager.boundUser(ctx, "ws_1"); userID != "" || refusal == "" {
		t.Fatalf("a non-member binding must refuse, got %q %q", userID, refusal)
	}

	bindGroup(t, db, alice.ID)
	disabled := true
	if _, err := db.UpdateUser(ctx, alice.ID, store.UserUpdate{Disabled: &disabled}); err != nil {
		t.Fatal(err)
	}
	if userID, refusal := manager.boundUser(ctx, "ws_1"); userID != "" || refusal == "" {
		t.Fatalf("a disabled account must refuse, got %q %q", userID, refusal)
	}
}

func TestBotJSONNeverCarriesThePairingCodeHash(t *testing.T) {
	encoded, err := json.Marshal(store.WorkspaceFeishuBot{WorkspaceID: "ws_1", PairingCode: "hash", PairingCodeCreatedBy: "user_1"})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encoded), "hash") || strings.Contains(string(encoded), "user_1") {
		t.Fatalf("bot JSON leaks pairing state: %s", encoded)
	}
}
