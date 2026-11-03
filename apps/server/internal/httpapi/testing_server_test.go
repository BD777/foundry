package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"

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

// registerDeviceForTest stores a device's registration as its connection's
// hello does (daemonConnection.syncRegistration), without a connection.
func registerDeviceForTest(t testing.TB, server *Server, registration string) {
	t.Helper()
	var input store.DaemonRegistration
	if err := json.Unmarshal([]byte(registration), &input); err != nil {
		t.Fatalf("registration %s: %v", registration, err)
	}
	if _, err := server.hub.registerDaemon(context.Background(), input); err != nil {
		t.Fatalf("register %s: %v", input.Device.ID, err)
	}
}

// helloForTest connects to live as the device credential belongs to and
// says hello with registration. It answers "registered", the server's
// "error: ...", "close <code>" or "dial <status>"; a registered connection
// stays open until the test ends.
func helloForTest(t testing.TB, live *httptest.Server, credential, registration string) string {
	t.Helper()
	headers := http.Header{}
	if credential != "" {
		headers.Set(deviceCredentialHeader, credential)
	}
	conn, response, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(live.URL, "http")+"/api/daemon/ws", headers)
	if err != nil {
		if response != nil {
			return fmt.Sprintf("dial %d", response.StatusCode)
		}
		t.Fatalf("dial: %v", err)
	}
	t.Cleanup(func() { conn.Close() })
	if err := conn.WriteJSON(map[string]any{"id": "hello_test", "type": "hello", "payload": json.RawMessage(registration)}); err != nil {
		t.Fatalf("hello: %v", err)
	}
	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	for {
		var reply wsEnvelope
		if err := conn.ReadJSON(&reply); err != nil {
			var closed *websocket.CloseError
			if errors.As(err, &closed) {
				return fmt.Sprintf("close %d", closed.Code)
			}
			t.Fatalf("read the hello's answer: %v", err)
		}
		switch reply.Type {
		case wsRegisteredType:
			return "registered"
		case wsErrorType:
			return "error: " + reply.Error
		}
	}
}
