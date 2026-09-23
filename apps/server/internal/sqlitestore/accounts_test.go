package sqlitestore

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func openAccountsTestStore(t *testing.T) *Store {
	t.Helper()
	db, err := Open(t.TempDir() + "/foundry.db")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return db
}

func TestCreateFirstOwnerOnlyWhileEmpty(t *testing.T) {
	ctx := context.Background()
	db := openAccountsTestStore(t)
	owner, err := db.CreateFirstOwner(ctx, store.NewUser{Username: "Alice", PasswordHash: "h", Role: store.RoleMember})
	if err != nil {
		t.Fatal(err)
	}
	if owner.Role != store.RoleAdmin || owner.DisplayName != "Alice" {
		t.Fatalf("first owner = %+v, want owner role and username as display name", owner)
	}
	if _, err := db.CreateFirstOwner(ctx, store.NewUser{Username: "bob", PasswordHash: "h"}); !errors.Is(err, store.ErrAccountsInitialized) {
		t.Fatalf("second CreateFirstOwner err = %v, want ErrAccountsInitialized", err)
	}
	if _, err := db.CreateUser(ctx, store.NewUser{Username: "ALICE", PasswordHash: "h", Role: store.RoleMember}); !errors.Is(err, store.ErrUsernameTaken) {
		t.Fatalf("case-insensitive duplicate err = %v, want ErrUsernameTaken", err)
	}
	user, hash, err := db.GetUserCredentials(ctx, "alice")
	if err != nil || user.ID != owner.ID || hash != "h" {
		t.Fatalf("GetUserCredentials = %+v %q %v", user, hash, err)
	}
}

func TestUserSessionLifecycle(t *testing.T) {
	ctx := context.Background()
	db := openAccountsTestStore(t)
	user, err := db.CreateFirstOwner(ctx, store.NewUser{Username: "alice", PasswordHash: "h"})
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	if err := db.CreateUserSession(ctx, user.ID, "session-hash", now.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}

	resolved, extended, err := db.ResolveUserSession(ctx, "session-hash", now, now, now.Add(2*time.Hour))
	if err != nil || resolved.ID != user.ID || extended {
		t.Fatalf("fresh session = %+v extended=%v err=%v", resolved, extended, err)
	}
	_, extended, err = db.ResolveUserSession(ctx, "session-hash", now, now.Add(90*time.Minute), now.Add(2*time.Hour))
	if err != nil || !extended {
		t.Fatalf("session near expiry should slide: extended=%v err=%v", extended, err)
	}
	if _, _, err := db.ResolveUserSession(ctx, "session-hash", now.Add(3*time.Hour), now, now); !errors.Is(err, store.ErrUserSessionInvalid) {
		t.Fatalf("expired session err = %v, want ErrUserSessionInvalid", err)
	}
	if _, _, err := db.ResolveUserSession(ctx, "session-hash", now, now, now); !errors.Is(err, store.ErrUserSessionInvalid) {
		t.Fatalf("expired session must be deleted, got err = %v", err)
	}
}

func TestPasswordChangeAndDisableRevokeSessions(t *testing.T) {
	ctx := context.Background()
	db := openAccountsTestStore(t)
	owner, _ := db.CreateFirstOwner(ctx, store.NewUser{Username: "owner", PasswordHash: "h"})
	member, err := db.CreateUser(ctx, store.NewUser{Username: "member", PasswordHash: "h", Role: store.RoleMember})
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	_ = db.CreateUserSession(ctx, owner.ID, "owner-session", now.Add(time.Hour))
	_ = db.CreateUserSession(ctx, member.ID, "member-session", now.Add(time.Hour))

	if err := db.SetUserPassword(ctx, owner.ID, "h2"); err != nil {
		t.Fatal(err)
	}
	if _, _, err := db.ResolveUserSession(ctx, "owner-session", now, now, now); !errors.Is(err, store.ErrUserSessionInvalid) {
		t.Fatalf("password change must revoke sessions, err = %v", err)
	}

	disabled := true
	if _, err := db.UpdateUser(ctx, member.ID, store.UserUpdate{Disabled: &disabled}); err != nil {
		t.Fatal(err)
	}
	if _, _, err := db.ResolveUserSession(ctx, "member-session", now, now, now); !errors.Is(err, store.ErrUserSessionInvalid) {
		t.Fatalf("disabling must revoke sessions, err = %v", err)
	}
}

func TestLastActiveOwnerIsProtected(t *testing.T) {
	ctx := context.Background()
	db := openAccountsTestStore(t)
	owner, _ := db.CreateFirstOwner(ctx, store.NewUser{Username: "owner", PasswordHash: "h"})
	member := store.RoleMember
	disabled := true
	if _, err := db.UpdateUser(ctx, owner.ID, store.UserUpdate{Role: &member}); !errors.Is(err, store.ErrLastAdmin) {
		t.Fatalf("demote last owner err = %v, want ErrLastAdmin", err)
	}
	if _, err := db.UpdateUser(ctx, owner.ID, store.UserUpdate{Disabled: &disabled}); !errors.Is(err, store.ErrLastAdmin) {
		t.Fatalf("disable last owner err = %v, want ErrLastAdmin", err)
	}

	second, _ := db.CreateUser(ctx, store.NewUser{Username: "second", PasswordHash: "h", Role: store.RoleAdmin})
	if _, err := db.UpdateUser(ctx, owner.ID, store.UserUpdate{Role: &member}); err != nil {
		t.Fatalf("demote with another owner present: %v", err)
	}
	if _, err := db.UpdateUser(ctx, second.ID, store.UserUpdate{Disabled: &disabled}); !errors.Is(err, store.ErrLastAdmin) {
		t.Fatalf("disable remaining owner err = %v, want ErrLastAdmin", err)
	}
}

func TestInviteRedeemsOnce(t *testing.T) {
	ctx := context.Background()
	db := openAccountsTestStore(t)
	owner, _ := db.CreateFirstOwner(ctx, store.NewUser{Username: "owner", PasswordHash: "h"})
	now := time.Now().UTC()
	invite, err := db.CreateInvite(ctx, "invite-hash", store.RoleMember, owner.ID, now.Add(time.Hour), store.WorkspaceGrant{})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.GetPendingInvite(ctx, "invite-hash", now); err != nil {
		t.Fatalf("pending invite: %v", err)
	}
	// input.Role is ignored in favour of the invite's role.
	user, err := db.RedeemInvite(ctx, "invite-hash", now, store.NewUser{Username: "newbie", PasswordHash: "h", Role: store.RoleAdmin})
	if err != nil {
		t.Fatal(err)
	}
	if user.Role != store.RoleMember {
		t.Fatalf("redeemed role = %q, want member", user.Role)
	}
	if _, err := db.RedeemInvite(ctx, "invite-hash", now, store.NewUser{Username: "again", PasswordHash: "h"}); !errors.Is(err, store.ErrInviteInvalid) {
		t.Fatalf("reuse err = %v, want ErrInviteInvalid", err)
	}
	if err := db.RevokeInvite(ctx, invite.ID); !errors.Is(err, store.ErrInviteNotFound) {
		t.Fatalf("revoking a used invite err = %v, want ErrInviteNotFound", err)
	}

	if _, err := db.CreateInvite(ctx, "expired-hash", store.RoleMember, owner.ID, now.Add(-time.Minute), store.WorkspaceGrant{}); err != nil {
		t.Fatal(err)
	}
	if _, err := db.GetPendingInvite(ctx, "expired-hash", now); !errors.Is(err, store.ErrInviteInvalid) {
		t.Fatalf("expired invite err = %v, want ErrInviteInvalid", err)
	}
	revoked, _ := db.CreateInvite(ctx, "revoked-hash", store.RoleMember, owner.ID, now.Add(time.Hour), store.WorkspaceGrant{})
	if err := db.RevokeInvite(ctx, revoked.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.RedeemInvite(ctx, "revoked-hash", now, store.NewUser{Username: "late", PasswordHash: "h"}); !errors.Is(err, store.ErrInviteInvalid) {
		t.Fatalf("revoked invite err = %v, want ErrInviteInvalid", err)
	}
	// A failed redemption (duplicate username) must not consume the invite.
	fresh, _ := db.CreateInvite(ctx, "fresh-hash", store.RoleMember, owner.ID, now.Add(time.Hour), store.WorkspaceGrant{})
	if _, err := db.RedeemInvite(ctx, "fresh-hash", now, store.NewUser{Username: "newbie", PasswordHash: "h"}); !errors.Is(err, store.ErrUsernameTaken) {
		t.Fatalf("duplicate username err = %v", err)
	}
	if _, err := db.GetPendingInvite(ctx, "fresh-hash", now); err != nil {
		t.Fatalf("invite %s should still be pending: %v", fresh.ID, err)
	}
}
