package sqlitestore

import (
	"context"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
	_ "modernc.org/sqlite"
)

func registerForOwnershipTest(t *testing.T, db *Store, deviceID, workspaceID string) {
	t.Helper()
	if err := db.RegisterDaemon(context.Background(), store.DaemonRegistration{
		Device:    store.DeviceProjection{ID: deviceID, Label: "D", Status: "connected"},
		Workspace: store.WorkspaceProjection{ID: workspaceID, Name: "W", LocalPath: "/tmp/" + workspaceID},
	}); err != nil {
		t.Fatal(err)
	}
}

func workspaceOwners(t *testing.T, db *Store, workspaceID string) []string {
	t.Helper()
	members, err := db.ListWorkspaceMembers(context.Background(), workspaceID)
	if err != nil {
		t.Fatal(err)
	}
	var owners []string
	for _, member := range members {
		if member.Role == store.WorkspaceRoleOwner {
			owners = append(owners, member.UserID)
		}
	}
	return owners
}

func TestFirstAdminClaimsResourcesRegisteredBeforeAccounts(t *testing.T) {
	ctx := context.Background()
	db := openAccountsTestStore(t)
	registerForOwnershipTest(t, db, "dev_legacy", "ws_legacy")
	profile, err := db.SaveProfile(ctx, store.SaveProfileInput{Runtime: "claude", Label: "Legacy", AuthMode: "custom", ConnectionType: "custom_endpoint"})
	if err != nil {
		t.Fatal(err)
	}
	if owners := workspaceOwners(t, db, "ws_legacy"); len(owners) != 0 {
		t.Fatalf("no account exists yet, owners = %v", owners)
	}

	admin, err := db.CreateFirstOwner(ctx, store.NewUser{Username: "admin", PasswordHash: "h"})
	if err != nil {
		t.Fatal(err)
	}
	if owners := workspaceOwners(t, db, "ws_legacy"); len(owners) != 1 || owners[0] != admin.ID {
		t.Fatalf("legacy workspace owners = %v, want the first admin", owners)
	}
	if claimed, _ := db.GetProfile(ctx, profile.ID); claimed.OwnerUserID != admin.ID {
		t.Fatalf("legacy connection owner = %q", claimed.OwnerUserID)
	}
	var deviceColumn string
	if err := db.conn().QueryRowContext(ctx, `SELECT device_id FROM workspaces WHERE id = 'ws_legacy'`).Scan(&deviceColumn); err != nil || deviceColumn != "dev_legacy" {
		t.Fatalf("workspace device column = %q %v", deviceColumn, err)
	}
}

func TestDeviceOwnerOwnsWorkspacesOnTheDevice(t *testing.T) {
	ctx := context.Background()
	db := openAccountsTestStore(t)
	admin, _ := db.CreateFirstOwner(ctx, store.NewUser{Username: "admin", PasswordHash: "h"})
	member, _ := db.CreateUser(ctx, store.NewUser{Username: "member", PasswordHash: "h", Role: store.RoleMember})
	now := time.Now().UTC()
	if _, err := pairForTest(t, db, member.ID, "t1", "machine-member", "dev_member", "c1", now); err != nil {
		t.Fatal(err)
	}
	registerForOwnershipTest(t, db, "dev_member", "ws_member")
	owners := workspaceOwners(t, db, "ws_member")
	if len(owners) != 1 || owners[0] != member.ID {
		t.Fatalf("workspace on the member's device must be owned by the member, got %v (admin %s)", owners, admin.ID)
	}
	// Re-registration keeps a single owner row.
	registerForOwnershipTest(t, db, "dev_member", "ws_member")
	if owners := workspaceOwners(t, db, "ws_member"); len(owners) != 1 {
		t.Fatalf("owners after re-registration = %v", owners)
	}
}
