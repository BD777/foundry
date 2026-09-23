package sqlitestore

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func pairForTest(t *testing.T, db *Store, userID, token, fingerprint, requested, credential string, now time.Time) (store.DeviceIdentity, error) {
	t.Helper()
	if err := db.CreateDevicePairingToken(context.Background(), token, userID, now.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	return db.PairDevice(context.Background(), store.PairDeviceInput{
		TokenHash: token, MachineFingerprint: fingerprint, RequestedDeviceID: requested, CredentialHash: credential, Now: now,
	})
}

func TestPairDeviceRejectsExpiredTokensAndDisabledOwners(t *testing.T) {
	ctx := context.Background()
	db := openAccountsTestStore(t)
	owner, _ := db.CreateFirstOwner(ctx, store.NewUser{Username: "owner", PasswordHash: "h"})
	member, _ := db.CreateUser(ctx, store.NewUser{Username: "member", PasswordHash: "h", Role: store.RoleMember})
	now := time.Now().UTC()

	if err := db.CreateDevicePairingToken(ctx, "expired", owner.ID, now.Add(-time.Second)); err != nil {
		t.Fatal(err)
	}
	if _, err := db.PairDevice(ctx, store.PairDeviceInput{TokenHash: "expired", MachineFingerprint: "m", CredentialHash: "c0", Now: now}); !errors.Is(err, store.ErrDevicePairingInvalid) {
		t.Fatalf("expired token err = %v", err)
	}

	identity, err := pairForTest(t, db, member.ID, "t1", "m-member", "", "c1", now)
	if err != nil || identity.OwnerUserID != member.ID {
		t.Fatalf("pair member device: %+v %v", identity, err)
	}
	disabled := true
	if _, err := db.UpdateUser(ctx, member.ID, store.UserUpdate{Disabled: &disabled}); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ResolveDeviceCredential(ctx, "c1"); !errors.Is(err, store.ErrDeviceCredentialInvalid) {
		t.Fatalf("disabled owner's device err = %v", err)
	}
	if _, err := pairForTest(t, db, member.ID, "t2", "m-member-2", "", "c2", now); !errors.Is(err, store.ErrDevicePairingInvalid) {
		t.Fatalf("disabled owner pairing err = %v", err)
	}
}

func TestPairDeviceAfterRemovalIssuesANewDevice(t *testing.T) {
	ctx := context.Background()
	db := openAccountsTestStore(t)
	owner, _ := db.CreateFirstOwner(ctx, store.NewUser{Username: "owner", PasswordHash: "h"})
	now := time.Now().UTC()
	first, err := pairForTest(t, db, owner.ID, "t1", "machine", "dev_local", "c1", now)
	if err != nil || first.DeviceID != "dev_local" {
		t.Fatalf("first pairing: %+v %v", first, err)
	}
	if err := db.RegisterDaemon(ctx, store.DaemonRegistration{
		Device:    store.DeviceProjection{ID: "dev_local", Label: "L", Status: "connected"},
		Workspace: store.WorkspaceProjection{ID: "ws_local", Name: "W", LocalPath: "/tmp/w"},
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := db.SoftRemoveDevice(ctx, "dev_local"); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ResolveDeviceCredential(ctx, "c1"); !errors.Is(err, store.ErrDeviceCredentialInvalid) {
		t.Fatalf("removed device credential err = %v", err)
	}
	second, err := pairForTest(t, db, owner.ID, "t2", "machine", "dev_local", "c2", now)
	if err != nil {
		t.Fatal(err)
	}
	if second.DeviceID == "dev_local" {
		t.Fatal("a removed device id must never be reissued")
	}
	if resolved, err := db.ResolveDeviceCredential(ctx, "c2"); err != nil || resolved.DeviceID != second.DeviceID {
		t.Fatalf("new credential: %+v %v", resolved, err)
	}
}
