package sqlitestore

import (
	"context"
	"database/sql"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
	_ "modernc.org/sqlite"
)

func TestLegacyOwnerRoleMigratesToAdminKeepingSessions(t *testing.T) {
	path := t.TempDir() + "/foundry.db"
	legacy, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	for _, statement := range []string{
		`CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT NOT NULL, username_key TEXT NOT NULL UNIQUE,
			display_name TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
			password_hash TEXT NOT NULL, disabled_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
		`CREATE TABLE user_sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			created_at TEXT NOT NULL, last_used_at TEXT NOT NULL, expires_at TEXT NOT NULL)`,
		`CREATE TABLE user_invites (id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE,
			role TEXT NOT NULL CHECK (role IN ('owner', 'member')), created_by TEXT NOT NULL, created_at TEXT NOT NULL,
			expires_at TEXT NOT NULL, used_by TEXT, used_at TEXT, revoked_at TEXT)`,
		`INSERT INTO users VALUES ('user_a', 'alice', 'alice', 'Alice', 'owner', 'h', NULL, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
		`INSERT INTO users VALUES ('user_b', 'bob', 'bob', 'Bob', 'member', 'h', NULL, '2026-01-02T00:00:00Z', '2026-01-02T00:00:00Z')`,
		`INSERT INTO user_sessions VALUES ('session', 'user_a', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '2999-01-01T00:00:00Z')`,
		`INSERT INTO user_invites VALUES ('inv', 'invite-hash', 'owner', 'user_a', '2026-01-01T00:00:00Z', '2999-01-01T00:00:00Z', NULL, NULL, NULL)`,
	} {
		if _, err := legacy.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	_ = legacy.Close()

	db, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	ctx := context.Background()
	alice, err := db.GetUser(ctx, "user_a")
	if err != nil || alice.Role != store.RoleAdmin {
		t.Fatalf("migrated owner = %+v %v, want admin", alice, err)
	}
	if bob, _ := db.GetUser(ctx, "user_b"); bob.Role != store.RoleMember {
		t.Fatalf("member role changed: %+v", bob)
	}
	if user, _, err := db.ResolveUserSession(ctx, "session", time.Now(), time.Now(), time.Now()); err != nil || user.ID != "user_a" {
		t.Fatalf("login session must survive the rebuild: %+v %v", user, err)
	}
	invite, err := db.GetPendingInvite(ctx, "invite-hash", time.Now())
	if err != nil || invite.Role != store.RoleAdmin {
		t.Fatalf("migrated invite = %+v %v", invite, err)
	}
	var violations int
	rows, err := db.conn().QueryContext(ctx, `PRAGMA foreign_key_check`)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		violations++
	}
	_ = rows.Close()
	if violations != 0 {
		t.Fatalf("foreign key violations after migration: %d", violations)
	}
}

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
