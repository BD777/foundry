package sqlitestore

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// pairWorker pairs a worker that reports its own fingerprint and system
// account, as workers since the account check do.
func pairWorker(db *Store, userID, token, worker, account, requested, credential string, accept bool) (store.DeviceIdentity, error) {
	return db.PairDevice(context.Background(), store.PairDeviceInput{
		TokenHash: token, MachineFingerprint: "machine", WorkerFingerprint: worker,
		Identity:          store.DeviceAccountIdentity{OSAccountFingerprint: account, HostFingerprint: "host"},
		RequestedDeviceID: requested, CredentialHash: credential, Now: time.Now().UTC(), AcceptSharedAccount: accept,
	})
}

func newToken(t *testing.T, db *Store, userID, token string) {
	t.Helper()
	if err := db.CreateDevicePairingToken(context.Background(), token, userID, time.Now().UTC().Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
}

func sharingUsers(t *testing.T, db *Store) (store.User, store.User) {
	t.Helper()
	ctx := context.Background()
	alice, err := db.CreateFirstOwner(ctx, store.NewUser{Username: "alice", DisplayName: "Alice", PasswordHash: "h"})
	if err != nil {
		t.Fatal(err)
	}
	bob, err := db.CreateUser(ctx, store.NewUser{Username: "bob", DisplayName: "Bob", PasswordHash: "h", Role: store.RoleMember})
	if err != nil {
		t.Fatal(err)
	}
	return alice, bob
}

func TestPairingUnderAnotherPersonsSystemAccountWaitsForConsent(t *testing.T) {
	ctx := context.Background()
	db := openAccountsTestStore(t)
	alice, bob := sharingUsers(t, db)

	newToken(t, db, alice.ID, "ta")
	first, err := pairWorker(db, alice.ID, "ta", "worker-a", "account-1", "dev_a", "ca", false)
	if err != nil || first.DeviceID != "dev_a" {
		t.Fatalf("alice pairs: %+v %v", first, err)
	}

	// Bob's worker runs under the same system account (its own state root).
	newToken(t, db, bob.ID, "tb")
	_, err = pairWorker(db, bob.ID, "tb", "worker-b", "account-1", "dev_b", "cb", false)
	var shared *store.DeviceAccountSharedError
	if !errors.As(err, &shared) || !reflect.DeepEqual(shared.SharedWith, []string{"Alice"}) {
		t.Fatalf("bob pairs under alice's account: %v", err)
	}
	if _, err := db.ResolveDeviceCredential(ctx, "cb"); !errors.Is(err, store.ErrDeviceCredentialInvalid) {
		t.Fatalf("nothing may be paired before bob chooses: %v", err)
	}
	status, err := db.DevicePairingStatus(ctx, "tb", bob.ID)
	if err != nil || status.State != store.DevicePairingNeedsConsent || !reflect.DeepEqual(status.SharedWith, []string{"Alice"}) {
		t.Fatalf("token waits for bob: %+v %v", status, err)
	}
	if _, err := db.DevicePairingStatus(ctx, "tb", alice.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("only the token's creator reads it: %v", err)
	}

	// Bob continues in the web; the worker's next try pairs.
	if status, err := db.SetDevicePairingConsent(ctx, "tb", bob.ID, true); err != nil || status.State != store.DevicePairingWaiting {
		t.Fatalf("bob continues: %+v %v", status, err)
	}
	second, err := pairWorker(db, bob.ID, "tb", "worker-b", "account-1", "dev_b", "cb", false)
	if err != nil || second.DeviceID != "dev_b" {
		t.Fatalf("bob pairs after continuing: %+v %v", second, err)
	}
	if status, _ := db.DevicePairingStatus(ctx, "tb", bob.ID); status.State != store.DevicePairingPaired || status.DeviceID != "dev_b" {
		t.Fatalf("token paired: %+v", status)
	}

	shares, err := db.ListDeviceAccountShares(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(shares["dev_a"]) != 1 || shares["dev_a"][0].DeviceID != "dev_b" || shares["dev_a"][0].OwnerName != "Bob" ||
		shares["dev_a"][0].AcceptedBy != "Bob" || shares["dev_a"][0].AcceptedAt == "" || !shares["dev_a"][0].NoticePending {
		t.Fatalf("alice's device: %+v", shares["dev_a"])
	}
	if len(shares["dev_b"]) != 1 || shares["dev_b"][0].DeviceID != "dev_a" || shares["dev_b"][0].OwnerName != "Alice" || shares["dev_b"][0].NoticePending {
		t.Fatalf("bob's device: %+v", shares["dev_b"])
	}
	if err := db.DismissDeviceAccountShareNotice(ctx, "dev_a"); err != nil {
		t.Fatal(err)
	}
	if shares, _ := db.ListDeviceAccountShares(ctx); shares["dev_a"][0].NoticePending || len(shares["dev_a"]) != 1 {
		t.Fatalf("one notice, the label stays: %+v", shares["dev_a"])
	}

	// Re-pairing a device whose sharing someone chose asks nothing again.
	newToken(t, db, bob.ID, "tb2")
	if again, err := pairWorker(db, bob.ID, "tb2", "worker-b", "account-1", "dev_b", "cb2", false); err != nil || again.DeviceID != "dev_b" {
		t.Fatalf("bob pairs again: %+v %v", again, err)
	}
}

func TestPairingConsentFromTheTerminalAndCancelFromTheWeb(t *testing.T) {
	ctx := context.Background()
	db := openAccountsTestStore(t)
	alice, bob := sharingUsers(t, db)
	newToken(t, db, alice.ID, "ta")
	if _, err := pairWorker(db, alice.ID, "ta", "worker-a", "account-1", "dev_a", "ca", false); err != nil {
		t.Fatal(err)
	}

	newToken(t, db, bob.ID, "tb")
	if _, err := pairWorker(db, bob.ID, "tb", "worker-b", "account-1", "", "cb", false); err == nil {
		t.Fatal("bob must be asked first")
	}
	if status, err := db.SetDevicePairingConsent(ctx, "tb", bob.ID, false); err != nil || status.State != store.DevicePairingCancelled {
		t.Fatalf("bob cancels: %+v %v", status, err)
	}
	if _, err := pairWorker(db, bob.ID, "tb", "worker-b", "account-1", "", "cb", true); !errors.Is(err, store.ErrDevicePairingCancelled) {
		t.Fatalf("a cancelled pairing stays cancelled: %v", err)
	}

	newToken(t, db, bob.ID, "tb2")
	paired, err := pairWorker(db, bob.ID, "tb2", "worker-b", "account-1", "", "cb2", true)
	if err != nil {
		t.Fatalf("continuing in the terminal pairs: %v", err)
	}
	if shares, _ := db.ListDeviceAccountShares(ctx); len(shares[paired.DeviceID]) != 1 || !shares["dev_a"][0].NoticePending {
		t.Fatalf("shares after the terminal's choice: %+v", shares)
	}
}

func TestSeparateSystemAccountsAreSeparateDevicesWithoutAsking(t *testing.T) {
	ctx := context.Background()
	db := openAccountsTestStore(t)
	alice, bob := sharingUsers(t, db)
	newToken(t, db, alice.ID, "ta")
	a, err := pairWorker(db, alice.ID, "ta", "worker-a", "account-a", "", "ca", false)
	if err != nil {
		t.Fatal(err)
	}
	newToken(t, db, bob.ID, "tb")
	b, err := pairWorker(db, bob.ID, "tb", "worker-b", "account-b", "", "cb", false)
	if err != nil || b.DeviceID == a.DeviceID {
		t.Fatalf("bob on his own account: %+v %v", b, err)
	}
	// One person, two system accounts (or state roots) of one computer: two
	// devices, nothing to ask.
	newToken(t, db, alice.ID, "ta2")
	a2, err := pairWorker(db, alice.ID, "ta2", "worker-a2", "account-c", "", "ca2", false)
	if err != nil || a2.DeviceID == a.DeviceID {
		t.Fatalf("alice's second account: %+v %v", a2, err)
	}
	if shares, _ := db.ListDeviceAccountShares(ctx); len(shares) != 0 {
		t.Fatalf("nobody shares: %+v", shares)
	}
}

func TestDevicesPairedBeforeTheAccountCheckKeepTheirIDs(t *testing.T) {
	ctx := context.Background()
	db := openAccountsTestStore(t)
	alice, bob := sharingUsers(t, db)
	now := time.Now().UTC()
	// An older worker: the machine's fingerprint only.
	legacy, err := pairForTest(t, db, alice.ID, "t1", "machine", "dev_old", "c1", now)
	if err != nil || legacy.DeviceID != "dev_old" {
		t.Fatalf("legacy pairing: %+v %v", legacy, err)
	}
	// Updated, it reports its account when it connects.
	if changed, err := db.RecordDeviceAccountIdentity(ctx, "dev_old", store.DeviceAccountIdentity{OSAccountFingerprint: "account-1", HostFingerprint: "host"}); err != nil || !changed {
		t.Fatalf("record identity: %v %v", changed, err)
	}
	if changed, _ := db.RecordDeviceAccountIdentity(ctx, "dev_old", store.DeviceAccountIdentity{OSAccountFingerprint: "account-1"}); changed {
		t.Fatal("an unchanged report writes nothing")
	}
	// Another system account of that machine is a new device, not this one.
	newToken(t, db, alice.ID, "t2")
	other, err := pairWorker(db, alice.ID, "t2", "worker-2", "account-2", "dev_other", "c2", false)
	if err != nil || other.DeviceID == "dev_old" {
		t.Fatalf("another account: %+v %v", other, err)
	}
	// The same account pairing again keeps its device and id.
	newToken(t, db, alice.ID, "t3")
	again, err := pairWorker(db, alice.ID, "t3", "worker-1", "account-1", "dev_somewhere", "c3", false)
	if err != nil || again.DeviceID != "dev_old" {
		t.Fatalf("same account re-pairs: %+v %v", again, err)
	}
	if resolved, err := db.ResolveDeviceCredential(ctx, "c3"); err != nil || resolved.DeviceID != "dev_old" {
		t.Fatalf("rotated credential: %+v %v", resolved, err)
	}
	// Found later, a shared account is labelled though nobody chose it.
	if _, err := pairForTest(t, db, bob.ID, "tb-legacy", "machine", "dev_bob", "cb", now); err != nil {
		t.Fatal(err)
	}
	if _, err := db.RecordDeviceAccountIdentity(ctx, "dev_bob", store.DeviceAccountIdentity{OSAccountFingerprint: "account-1"}); err != nil {
		t.Fatal(err)
	}
	shares, _ := db.ListDeviceAccountShares(ctx)
	if len(shares["dev_old"]) != 1 || shares["dev_old"][0].AcceptedAt != "" || shares["dev_old"][0].NoticePending {
		t.Fatalf("found later: %+v", shares["dev_old"])
	}
	// A removed device shares nothing.
	if err := db.RegisterDaemon(ctx, store.DaemonRegistration{Device: store.DeviceProjection{ID: "dev_bob", Label: "B", Status: "connected"}}); err != nil {
		t.Fatal(err)
	}
	if _, err := db.SoftRemoveDevice(ctx, "dev_bob"); err != nil {
		t.Fatal(err)
	}
	if shares, _ := db.ListDeviceAccountShares(ctx); len(shares) != 0 {
		t.Fatalf("after removal: %+v", shares)
	}
}
