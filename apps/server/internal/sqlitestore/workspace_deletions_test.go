package sqlitestore

import (
	"context"
	"errors"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func homeRegistration(deviceID, deviceLabel string) store.DaemonRegistration {
	return store.DaemonRegistration{
		Device:    store.DeviceProjection{ID: deviceID, Label: deviceLabel, Status: "connected", LastSeenLabel: "online"},
		Workspace: store.WorkspaceProjection{ID: "ws_home", Name: "Foundry", LocalPath: "/home/me/Foundry", Baseline: "main"},
		Agents: []store.AgentProjection{{
			ID: "agent_home", WorkspaceID: "ws_home", DeviceID: deviceID, Provider: "claude", Status: "healthy",
			AuthMode: "local_config", SecretStored: "local", ConfigScope: "workspace", ConfigLabel: "local", LastSeenLabel: "online",
		}},
		Assets: []store.AssetProjection{{ID: "asset_home", WorkspaceID: "ws_home", Name: "AGENTS.md", Kind: "rule"}},
		Chats:  []store.ChatThread{{ID: "native_claude_home", Title: "a chat", Provider: "claude"}},
	}
}

// A device that still reports a workspace the person deleted from it (an
// older worker reports the folder its service was installed with on every
// start) keeps its own news; the workspace and everything under it stay
// gone until the person adds the folder again.
func TestDeletedWorkspaceStaysDeletedOnItsDevice(t *testing.T) {
	db := newTestStore(t)
	ctx := context.Background()
	if err := db.RegisterDaemon(ctx, homeRegistration("dev_home", "linux-dev")); err != nil {
		t.Fatal(err)
	}
	if _, err := db.DeleteWorkspace(ctx, "ws_home"); err != nil {
		t.Fatal(err)
	}

	changes, err := db.RegisterDaemonChanges(ctx, homeRegistration("dev_home", "linux-dev renamed"))
	if err != nil {
		t.Fatal(err)
	}
	if changes.DeletedWorkspace != "ws_home" || len(changes.Workspaces) != 0 || changes.Parts.NewWorkspace {
		t.Fatalf("changes = %+v, want the deleted workspace named and nothing of it changed", changes)
	}
	if _, err := db.GetWorkspace(ctx, "ws_home"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("deleted workspace came back: %v", err)
	}
	if agents, _ := db.ListAgents(ctx, "ws_home", ""); len(agents) != 0 {
		t.Fatalf("agents of the deleted workspace stored: %+v", agents)
	}
	if assets, _ := db.ListAssets(ctx, "ws_home"); len(assets) != 0 {
		t.Fatalf("assets of the deleted workspace stored: %+v", assets)
	}
	if chats, _ := db.ListChats(ctx, "ws_home"); len(chats) != 0 {
		t.Fatalf("chats of the deleted workspace stored: %+v", chats)
	}
	devices, err := db.ListDevices(ctx)
	if err != nil || len(devices) != 1 || devices[0].Label != "linux-dev renamed" {
		t.Fatalf("the device's own news must still count: %+v %v", devices, err)
	}

	// The deletion is the device's: another device's folder with the same
	// identity is that device's to report.
	other := homeRegistration("dev_other", "other")
	other.Agents, other.Assets, other.Chats = nil, nil, nil
	if changes, err := db.RegisterDaemonChanges(ctx, other); err != nil || changes.DeletedWorkspace != "" {
		t.Fatalf("another device's report = %+v %v", changes, err)
	}
	if _, err := db.DeleteWorkspace(ctx, "ws_home"); err != nil {
		t.Fatal(err)
	}

	// Adding the folder again takes the deletion back, however the path is
	// spelled; the device's reports count again.
	if err := db.ClearWorkspaceDeletion(ctx, "dev_home", "/home/me/Foundry/"); err != nil {
		t.Fatal(err)
	}
	if deleted, err := db.WorkspaceDeletedFromDevice(ctx, "ws_home", "dev_home"); err != nil || deleted {
		t.Fatalf("deletion after adding the folder again = %v %v", deleted, err)
	}
	changes, err = db.RegisterDaemonChanges(ctx, homeRegistration("dev_home", "linux-dev"))
	if err != nil || changes.DeletedWorkspace != "" || !changes.Parts.NewWorkspace {
		t.Fatalf("registration after adding again = %+v %v", changes, err)
	}
	if workspace, err := db.GetWorkspace(ctx, "ws_home"); err != nil || workspace.DeviceID != "dev_home" {
		t.Fatalf("workspace added again = %+v %v", workspace, err)
	}
	if deleted, _ := db.WorkspaceDeletedFromDevice(ctx, "ws_home", "dev_other"); !deleted {
		t.Fatal("the other device's own deletion must stand")
	}
}

// A database from before deletions were remembered gains the table on start.
func TestOlderDatabaseRemembersWorkspaceDeletions(t *testing.T) {
	path := t.TempDir() + "/foundry.db"
	ctx := context.Background()
	older := openTestStore(t, path)
	if err := older.RegisterDaemon(ctx, homeRegistration("dev_home", "linux-dev")); err != nil {
		t.Fatal(err)
	}
	if _, err := older.conn().ExecContext(ctx, `DROP TABLE deleted_workspaces`); err != nil {
		t.Fatal(err)
	}
	if err := older.Close(); err != nil {
		t.Fatal(err)
	}
	db := newTestStoreAtPath(t, path)
	if _, err := db.DeleteWorkspace(ctx, "ws_home"); err != nil {
		t.Fatal(err)
	}
	if deleted, err := db.WorkspaceDeletedFromDevice(ctx, "ws_home", "dev_home"); err != nil || !deleted {
		t.Fatalf("deletion on a migrated database = %v %v", deleted, err)
	}
}
