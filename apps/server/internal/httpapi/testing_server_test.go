package httpapi

import (
	"context"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/accounts"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// testOwner is the account package tests act as unless a test logs in for
// real through the auth routes.
var testOwner = store.User{
	ID:          "user_test_owner",
	Username:    "test-owner",
	DisplayName: "Test Owner",
	Role:        store.RoleAdmin,
}

// NewServer builds a server whose browser requests are authenticated as
// testOwner, so handler tests need no login round trip.
func NewServer(st store.Store) *Server {
	return withTestOwner(NewServerWithOptions(st, DefaultServerOptions()))
}

func withTestOwner(server *Server) *Server {
	owner := testOwner
	server.testActor = &Actor{Kind: ActorAccount, Account: &owner}
	server.testFullAccess = true
	return server
}

// pairTestDevice runs the real pairing path for deviceID on a fresh owner
// account and returns the device credential.
func pairTestDevice(t *testing.T, server *Server, deviceID, fingerprint string) string {
	t.Helper()
	ctx := context.Background()
	owner, err := server.store.(store.AccountStore).CreateUser(ctx, store.NewUser{
		Username: "owner-" + deviceID, Role: store.RoleAdmin, PasswordHash: "unused",
	})
	if err != nil {
		t.Fatal(err)
	}
	credentials := server.store.(store.DeviceCredentialStore)
	token, _ := accounts.NewToken()
	if err := credentials.CreateDevicePairingToken(ctx, accounts.HashToken(token), owner.ID, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	credential, _ := accounts.NewToken()
	identity, err := credentials.PairDevice(ctx, store.PairDeviceInput{
		TokenHash: accounts.HashToken(token), MachineFingerprint: fingerprint,
		RequestedDeviceID: deviceID, CredentialHash: accounts.HashToken(credential), Now: time.Now(),
	})
	if err != nil || identity.DeviceID != deviceID {
		t.Fatalf("pair %s: %+v %v", deviceID, identity, err)
	}
	return credential
}
