package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func registrationBody(deviceID, workspaceID string) string {
	return `{"device":{"id":"` + deviceID + `","label":"Device","status":"connected","lastSeenLabel":"online"},` +
		`"workspace":{"id":"` + workspaceID + `","name":"W","localPath":"/tmp/w","baseline":"main","contextSummary":"","acceptedCount":0,"resolvedCount":0},` +
		`"providerHealth":[],"assets":[],"agents":[],"skills":[],"workspaceFiles":[]}`
}

// pairOverHTTP runs the user-facing flow: an account issues a one-time token
// and a worker redeems it.
func pairOverHTTP(t *testing.T, handler http.Handler, session, fingerprint, deviceID string) (string, string) {
	t.Helper()
	issued := doAuthCall(t, handler, authCall{method: http.MethodPost, path: "/api/devices/pairing-tokens", body: `{}`, cookie: session, origin: accountsTestOrigin})
	expectStatus(t, issued, http.StatusCreated, "issue pairing token")
	var token struct {
		Token string `json:"token"`
	}
	if err := json.Unmarshal(issued.Body.Bytes(), &token); err != nil || token.Token == "" {
		t.Fatalf("pairing token response %s", issued.Body.String())
	}
	body := `{"token":"` + token.Token + `","machineFingerprint":"` + fingerprint + `","deviceId":"` + deviceID + `"}`
	paired := doAuthCall(t, handler, authCall{method: http.MethodPost, path: "/api/daemon/pair", body: body})
	expectStatus(t, paired, http.StatusCreated, "pair device")
	var result struct {
		DeviceID   string `json:"deviceId"`
		Credential string `json:"credential"`
	}
	if err := json.Unmarshal(paired.Body.Bytes(), &result); err != nil || result.Credential == "" {
		t.Fatalf("pair response %s", paired.Body.String())
	}
	reused := doAuthCall(t, handler, authCall{method: http.MethodPost, path: "/api/daemon/pair", body: body})
	expectStatus(t, reused, http.StatusUnauthorized, "reuse pairing token")
	return result.DeviceID, result.Credential
}

func deviceCall(method, path, body, credential string) authCall {
	return authCall{method: method, path: path, body: body, headers: map[string]string{deviceCredentialHeader: credential}}
}

func TestDevicePairingIssuesPerDeviceCredentials(t *testing.T) {
	server, handler := newAccountsTestServer(t)
	owner := setupOwner(t, server, handler)

	expectStatus(t, doAuthCall(t, handler, authCall{method: http.MethodPost, path: "/api/devices/pairing-tokens", body: `{}`}),
		http.StatusUnauthorized, "pairing token without a session")
	expectStatus(t, doAuthCall(t, handler, authCall{method: http.MethodPost, path: "/api/daemon/pair",
		body: `{"token":"made-up","machineFingerprint":"m1"}`}), http.StatusUnauthorized, "unknown pairing token")

	deviceID, credential := pairOverHTTP(t, handler, owner, "machine-1", "dev_laptop")
	if deviceID != "dev_laptop" {
		t.Fatalf("a free local device id must be kept, got %q", deviceID)
	}
	expectStatus(t, doAuthCall(t, handler, deviceCall(http.MethodPost, "/api/daemon/register", registrationBody("dev_laptop", "ws_laptop"), credential)),
		http.StatusOK, "register own device")

	// The same account pairing the same machine again keeps the device and
	// rotates the credential.
	again, rotated := pairOverHTTP(t, handler, owner, "machine-1", "dev_other_local_id")
	if again != "dev_laptop" {
		t.Fatalf("re-pairing the same machine must keep its device, got %q", again)
	}
	expectStatus(t, doAuthCall(t, handler, deviceCall(http.MethodPost, "/api/daemon/register", registrationBody("dev_laptop", "ws_laptop"), credential)),
		http.StatusUnauthorized, "rotated-out credential")
	expectStatus(t, doAuthCall(t, handler, deviceCall(http.MethodPost, "/api/daemon/register", registrationBody("dev_laptop", "ws_laptop"), rotated)),
		http.StatusOK, "rotated credential")

	// Another account on the same machine gets its own device.
	member := inviteAndJoin(t, handler, owner, store.RoleMember, "member")
	memberDevice, _ := pairOverHTTP(t, handler, member, "machine-1", "dev_laptop")
	if memberDevice == "dev_laptop" {
		t.Fatal("another account must not take over an existing device id")
	}
}

func TestDeviceCredentialBindsDeviceAndWorkspace(t *testing.T) {
	server, handler := newAccountsTestServer(t)
	owner := setupOwner(t, server, handler)
	_, laptop := pairOverHTTP(t, handler, owner, "machine-laptop", "dev_laptop")
	_, desktop := pairOverHTTP(t, handler, owner, "machine-desktop", "dev_desktop")

	expectStatus(t, doAuthCall(t, handler, deviceCall(http.MethodPost, "/api/daemon/register", registrationBody("dev_laptop", "ws_shared"), laptop)),
		http.StatusOK, "laptop registers its workspace")
	expectStatus(t, doAuthCall(t, handler, deviceCall(http.MethodPost, "/api/daemon/register", registrationBody("dev_laptop", "ws_other"), desktop)),
		http.StatusForbidden, "desktop claims to be the laptop")
	expectStatus(t, doAuthCall(t, handler, deviceCall(http.MethodPost, "/api/daemon/register", registrationBody("dev_desktop", "ws_shared"), desktop)),
		http.StatusConflict, "desktop takes over the laptop's workspace")
	expectStatus(t, doAuthCall(t, handler, deviceCall(http.MethodPost, "/api/daemon/issues/claim", `{"deviceId":"dev_laptop"}`, desktop)),
		http.StatusForbidden, "desktop claims work as the laptop")
	expectStatus(t, doAuthCall(t, handler, authCall{method: http.MethodPost, path: "/api/daemon/register", body: registrationBody("dev_laptop", "ws_shared")}),
		http.StatusUnauthorized, "daemon route without a credential")

	// Removing the device revokes its credential; the workspace becomes free.
	expectStatus(t, doAuthCall(t, handler, authCall{method: http.MethodDelete, path: "/api/devices/dev_laptop", cookie: owner, origin: accountsTestOrigin}),
		http.StatusOK, "remove laptop")
	expectStatus(t, doAuthCall(t, handler, deviceCall(http.MethodPost, "/api/daemon/register", registrationBody("dev_laptop", "ws_shared"), laptop)),
		http.StatusUnauthorized, "removed device credential")
	expectStatus(t, doAuthCall(t, handler, deviceCall(http.MethodPost, "/api/daemon/register", registrationBody("dev_desktop", "ws_shared"), desktop)),
		http.StatusOK, "workspace of a removed device can move")
}

func TestDeviceCredentialActsWithItsOwnersRole(t *testing.T) {
	server, handler := newAccountsTestServer(t)
	owner := setupOwner(t, server, handler)
	member := inviteAndJoin(t, handler, owner, store.RoleMember, "member")
	_, ownerDevice := pairOverHTTP(t, handler, owner, "machine-owner", "dev_owner")
	_, memberDevice := pairOverHTTP(t, handler, member, "machine-member", "dev_member")

	// A device never carries instance admin rights, not even its admin's.
	expectStatus(t, doAuthCall(t, handler, deviceCall(http.MethodGet, "/api/users", "", ownerDevice)),
		http.StatusForbidden, "admin's device on an admin route")
	expectStatus(t, doAuthCall(t, handler, deviceCall(http.MethodGet, "/api/users", "", memberDevice)),
		http.StatusForbidden, "member's device on an owner route")
	expectStatus(t, doAuthCall(t, handler, deviceCall(http.MethodGet, "/api/workspaces", "", memberDevice)),
		http.StatusOK, "member's device on a member route")

	// Disabling the owner of a device disables the device.
	var users []store.User
	_ = json.Unmarshal(doAuthCall(t, handler, authCall{method: http.MethodGet, path: "/api/users", cookie: owner}).Body.Bytes(), &users)
	var memberID string
	for _, user := range users {
		if user.Username == "member" {
			memberID = user.ID
		}
	}
	expectStatus(t, doAuthCall(t, handler, authCall{method: http.MethodPatch, path: "/api/users/" + memberID, body: `{"disabled":true}`, cookie: owner, origin: accountsTestOrigin}),
		http.StatusOK, "disable member")
	expectStatus(t, doAuthCall(t, handler, deviceCall(http.MethodGet, "/api/workspaces", "", memberDevice)),
		http.StatusUnauthorized, "disabled owner's device")
}

func TestDaemonWebSocketHelloMustNameCredentialDevice(t *testing.T) {
	server := NewServerWithOptions(newTestStore(t), ServerOptions{})
	credential := pairTestDevice(t, server, "dev_ws_laptop", "machine-ws-laptop")
	testServer := httptest.NewServer(server.Routes())
	defer testServer.Close()
	headers := http.Header{}
	headers.Set(deviceCredentialHeader, credential)
	conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(testServer.URL, "http")+"/api/daemon/ws", headers)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.Close()
	_ = conn.SetReadDeadline(time.Now().Add(3 * time.Second))

	hello := func(deviceID string) {
		writeWSForTest(t, conn, "hello", map[string]any{
			"device":         map[string]any{"id": deviceID, "label": "D", "status": "connected", "lastSeenLabel": "online"},
			"workspace":      map[string]any{"id": "ws_ws_laptop", "name": "W", "localPath": "/tmp/w", "baseline": "main", "contextSummary": "", "acceptedCount": 0, "resolvedCount": 0},
			"providerHealth": []map[string]any{},
			"assets":         []map[string]any{},
		})
	}
	hello("dev_someone_else")
	var reply wsEnvelope
	if err := conn.ReadJSON(&reply); err != nil {
		t.Fatalf("read reply: %v", err)
	}
	if reply.Type != wsErrorType || !strings.Contains(reply.Error, "does not match its credential") {
		t.Fatalf("hello for another device must be refused, got %+v", reply)
	}
	hello("dev_ws_laptop")
	readWSTypeForTest(t, conn, "registered")
}
