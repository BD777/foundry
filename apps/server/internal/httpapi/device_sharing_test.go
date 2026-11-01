package httpapi

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func issuePairingToken(t *testing.T, handler http.Handler, session string) string {
	t.Helper()
	issued := doAuthCall(t, handler, authCall{method: http.MethodPost, path: "/api/devices/pairing-tokens", body: `{}`, cookie: session, origin: accountsTestOrigin})
	expectStatus(t, issued, http.StatusCreated, "issue pairing token")
	var token struct {
		Token string `json:"token"`
	}
	if err := json.Unmarshal(issued.Body.Bytes(), &token); err != nil {
		t.Fatal(err)
	}
	return token.Token
}

func pairBody(token, worker, account, deviceID string) string {
	return `{"token":"` + token + `","deviceId":"` + deviceID + `","workerFingerprint":"` + worker +
		`","osAccountFingerprint":"` + account + `","hostFingerprint":"host"}`
}

func pairingStatus(t *testing.T, handler http.Handler, session, path, body string) store.DevicePairingStatus {
	t.Helper()
	recorder := doAuthCall(t, handler, authCall{method: http.MethodPost, path: path, body: body, cookie: session, origin: accountsTestOrigin})
	expectStatus(t, recorder, http.StatusOK, path)
	var status store.DevicePairingStatus
	if err := json.Unmarshal(recorder.Body.Bytes(), &status); err != nil {
		t.Fatal(err)
	}
	return status
}

func listedDevices(t *testing.T, handler http.Handler, session string) map[string]store.DeviceProjection {
	t.Helper()
	recorder := doAuthCall(t, handler, authCall{method: http.MethodGet, path: "/api/devices", cookie: session})
	expectStatus(t, recorder, http.StatusOK, "list devices")
	var devices []store.DeviceProjection
	if err := json.Unmarshal(recorder.Body.Bytes(), &devices); err != nil {
		t.Fatal(err)
	}
	byID := map[string]store.DeviceProjection{}
	for _, device := range devices {
		byID[device.ID] = device
	}
	return byID
}

func TestPairingUnderAnotherPersonsSystemAccountAsksAndLabelsBothDevices(t *testing.T) {
	server, handler := newAccountsTestServer(t)
	owner := setupOwner(t, server, handler)
	member := inviteAndJoin(t, handler, owner, store.RoleMember, "member")

	ownerToken := issuePairingToken(t, handler, owner)
	paired := doAuthCall(t, handler, authCall{method: http.MethodPost, path: "/api/daemon/pair", body: pairBody(ownerToken, "worker-a", "account-1", "dev_a")})
	expectStatus(t, paired, http.StatusCreated, "owner pairs")
	var ownerDevice struct{ Credential string }
	_ = json.Unmarshal(paired.Body.Bytes(), &ownerDevice)

	memberToken := issuePairingToken(t, handler, member)
	refused := doAuthCall(t, handler, authCall{method: http.MethodPost, path: "/api/daemon/pair", body: pairBody(memberToken, "worker-b", "account-1", "dev_b")})
	expectStatus(t, refused, http.StatusConflict, "member pairs under the owner's account")
	var needed store.DevicePairingConsentNeeded
	if err := json.Unmarshal(refused.Body.Bytes(), &needed); err != nil {
		t.Fatal(err)
	}
	if needed.Code != store.SystemAccountSharedCode || len(needed.SharedWith) != 1 || needed.SharedWith[0] != "Owner" ||
		!strings.Contains(needed.Error, "already used by Owner") || !strings.Contains(needed.Error, "nothing here keeps your work apart") {
		t.Fatalf("consent answer: %+v", needed)
	}

	tokenBody := `{"token":"` + memberToken + `"}`
	if status := pairingStatus(t, handler, member, "/api/devices/pairing-tokens/status", tokenBody); status.State != store.DevicePairingNeedsConsent {
		t.Fatalf("status: %+v", status)
	}
	expectStatus(t, doAuthCall(t, handler, authCall{method: http.MethodPost, path: "/api/devices/pairing-tokens/status", body: tokenBody, cookie: owner, origin: accountsTestOrigin}),
		http.StatusNotFound, "another person's token")
	if status := pairingStatus(t, handler, member, "/api/devices/pairing-tokens/consent", `{"token":"`+memberToken+`","accept":true}`); status.State != store.DevicePairingWaiting {
		t.Fatalf("continue: %+v", status)
	}
	again := doAuthCall(t, handler, authCall{method: http.MethodPost, path: "/api/daemon/pair", body: pairBody(memberToken, "worker-b", "account-1", "dev_b")})
	expectStatus(t, again, http.StatusCreated, "member pairs after continuing")
	var memberDevice struct{ Credential string }
	_ = json.Unmarshal(again.Body.Bytes(), &memberDevice)

	expectStatus(t, doAuthCall(t, handler, deviceCall(http.MethodPost, "/api/daemon/register", registrationBody("dev_a", "ws_a"), ownerDevice.Credential)), http.StatusOK, "register a")
	expectStatus(t, doAuthCall(t, handler, deviceCall(http.MethodPost, "/api/daemon/register", registrationBody("dev_b", "ws_b"), memberDevice.Credential)), http.StatusOK, "register b")

	ownerView := listedDevices(t, handler, owner)
	shares := ownerView["dev_a"].SharesSystemAccountWith
	if len(shares) != 1 || shares[0].DeviceID != "dev_b" || shares[0].OwnerName != "member" || !shares[0].NoticePending || shares[0].AcceptedBy != "member" {
		t.Fatalf("owner's device: %+v", shares)
	}
	if _, seen := ownerView["dev_b"]; seen {
		t.Fatal("the owner must not see the member's device")
	}
	memberShares := listedDevices(t, handler, member)["dev_b"].SharesSystemAccountWith
	if len(memberShares) != 1 || memberShares[0].OwnerName != "Owner" || memberShares[0].NoticePending {
		t.Fatalf("member's device: %+v", memberShares)
	}

	expectStatus(t, doAuthCall(t, handler, authCall{method: http.MethodPost, path: "/api/devices/dev_a/system-account-notice/dismiss", body: `{}`, cookie: member, origin: accountsTestOrigin}),
		http.StatusNotFound, "only the device's owner dismisses its notice")
	expectStatus(t, doAuthCall(t, handler, authCall{method: http.MethodPost, path: "/api/devices/dev_a/system-account-notice/dismiss", body: `{}`, cookie: owner, origin: accountsTestOrigin}),
		http.StatusNoContent, "dismiss")
	if shares := listedDevices(t, handler, owner)["dev_a"].SharesSystemAccountWith; len(shares) != 1 || shares[0].NoticePending {
		t.Fatalf("after dismissing, the label stays: %+v", shares)
	}
}

func TestPairingUnderSeparateSystemAccountsAsksNothing(t *testing.T) {
	server, handler := newAccountsTestServer(t)
	owner := setupOwner(t, server, handler)
	member := inviteAndJoin(t, handler, owner, store.RoleMember, "member")
	expectStatus(t, doAuthCall(t, handler, authCall{method: http.MethodPost, path: "/api/daemon/pair", body: pairBody(issuePairingToken(t, handler, owner), "worker-a", "account-a", "")}),
		http.StatusCreated, "owner pairs")
	expectStatus(t, doAuthCall(t, handler, authCall{method: http.MethodPost, path: "/api/daemon/pair", body: pairBody(issuePairingToken(t, handler, member), "worker-b", "account-b", "")}),
		http.StatusCreated, "member pairs on another account")
}

func TestSharedAccountMessageNamesEveryone(t *testing.T) {
	if got := sharedAccountMessage([]string{"Alice"}); !strings.HasPrefix(got, "This computer account is already used by Alice in Foundry. If you continue, you share it: you'll both work") {
		t.Fatalf("one: %s", got)
	}
	if got := sharedAccountMessage([]string{"Alice", "Bob", "Carol"}); !strings.Contains(got, "used by Alice, Bob and Carol") || !strings.Contains(got, "you'll all work") {
		t.Fatalf("several: %s", got)
	}
}

func TestAssistantHomeIsNeverSuggestedOnASharedSystemAccount(t *testing.T) {
	server, handler := newAccountsTestServer(t)
	owner := setupOwner(t, server, handler)
	member := inviteAndJoin(t, handler, owner, store.RoleMember, "member")
	pair := func(session, worker, account, deviceID string, accept bool) {
		body := pairBody(issuePairingToken(t, handler, session), worker, account, deviceID)
		if accept {
			body = strings.TrimSuffix(body, "}") + `,"acceptSharedAccount":true}`
		}
		expectStatus(t, doAuthCall(t, handler, authCall{method: http.MethodPost, path: "/api/daemon/pair", body: body}), http.StatusCreated, "pair "+deviceID)
	}
	pair(owner, "worker-a", "account-1", "dev_a", false)
	pair(owner, "worker-c", "account-2", "dev_c", false)
	pair(member, "worker-b", "account-1", "dev_b", true)

	users, err := server.store.ListUsers(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	ids := map[string]string{}
	for _, user := range users {
		ids[user.Username] = user.ID
	}
	if suggested, err := server.suggestedHomeDevice(t.Context(), ids["owner"]); err != nil || suggested != "dev_c" {
		t.Fatalf("suggested home = %q, %v; want the unshared dev_c", suggested, err)
	}
	if suggested, err := server.suggestedHomeDevice(t.Context(), ids["member"]); err != nil || suggested != "" {
		t.Fatalf("a person whose only device is shared gets no suggestion: %q, %v", suggested, err)
	}
}
