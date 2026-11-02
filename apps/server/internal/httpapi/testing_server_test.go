package httpapi

import (
	"context"
	"net/http/httptest"
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
func NewServer(st Backend) *Server {
	return withTestOwner(NewServerWithOptions(st, DefaultServerOptions()))
}

// serveForTest serves server's routes for the rest of the test and shuts
// the server down when it ends (shutDownAtCleanup).
func serveForTest(t testing.TB, server *Server) *httptest.Server {
	t.Helper()
	live := httptest.NewServer(server.Routes())
	t.Cleanup(live.Close)
	shutDownAtCleanup(t, server)
	return live
}

// shutDownAtCleanup shuts server down when the test ends, as production
// does (Server.Shutdown: device connections and the work started beside
// them), before the cleanups registered earlier, the store's and its temp
// dir's, run. A test that serves server's routes itself calls it once it
// built the server.
func shutDownAtCleanup(t testing.TB, server *Server) {
	t.Helper()
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := server.Shutdown(ctx); err != nil {
			t.Errorf("shut the test server down: %v", err)
		}
	})
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
	owner, err := server.store.CreateUser(ctx, store.NewUser{
		Username: "owner-" + deviceID, Role: store.RoleAdmin, PasswordHash: "unused",
	})
	if err != nil {
		t.Fatal(err)
	}
	token, _ := accounts.NewToken()
	if err := server.store.CreateDevicePairingToken(ctx, accounts.HashToken(token), owner.ID, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	credential, _ := accounts.NewToken()
	identity, err := server.store.PairDevice(ctx, store.PairDeviceInput{
		TokenHash: accounts.HashToken(token), WorkerFingerprint: fingerprint,
		RequestedDeviceID: deviceID, CredentialHash: accounts.HashToken(credential), Now: time.Now(),
	})
	if err != nil || identity.DeviceID != deviceID {
		t.Fatalf("pair %s: %+v %v", deviceID, identity, err)
	}
	return credential
}
