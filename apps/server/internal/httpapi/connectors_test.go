package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"github.com/gorilla/websocket"
)

// fakeConnectorWorker is alice's device answering connector_request the way
// the worker's device-held runtime does, with a login it controls.
type fakeConnectorWorker struct {
	t        *testing.T
	conn     *websocket.Conn
	mu       sync.Mutex
	actions  []string
	signedIn bool
	approved bool
	expires  time.Time
	done     chan struct{}
}

func (w *fakeConnectorWorker) connect(serverURL, credential string, capabilities ...string) {
	w.t.Helper()
	headers := http.Header{}
	headers.Set(deviceCredentialHeader, credential)
	conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(serverURL, "http")+"/api/daemon/ws", headers)
	if err != nil {
		w.t.Fatalf("dial: %v", err)
	}
	w.conn = conn
	w.done = make(chan struct{})
	writeWSForTest(w.t, conn, "hello", map[string]any{
		"capabilities": capabilities,
		"device":       map[string]any{"id": "dev_alice", "label": "alice-mac", "status": "connected", "lastSeenLabel": "online"},
		"workspace":    map[string]any{"id": "ws_alice", "name": "W", "localPath": "/tmp/w", "baseline": "main"},
	})
	go w.serve()
}

func (w *fakeConnectorWorker) disconnect() {
	_ = w.conn.Close()
	<-w.done
}

func (w *fakeConnectorWorker) state() *store.DeviceConnectorState {
	state := &store.DeviceConnectorState{Kind: "bytedcli", Installed: true, InstallSource: "device", Version: "0.170.0", Status: store.DeviceConnectorSignedOut}
	if w.signedIn {
		// The device sends what the tool shows; an email must not survive.
		state.Status, state.SignedIn, state.Identity, state.Sites = store.DeviceConnectorReady, true, "someone@example.com", []string{"cn", "cn"}
		state.ExpiresAt = w.expires.Format(time.RFC3339)
	}
	return state
}

func (w *fakeConnectorWorker) serve() {
	defer close(w.done)
	for {
		var envelope wsEnvelope
		if err := w.conn.ReadJSON(&envelope); err != nil {
			return
		}
		if envelope.Type != wsConnectorRequestType {
			continue
		}
		var request store.ConnectorRequestPayload
		_ = json.Unmarshal(envelope.Payload, &request)
		w.mu.Lock()
		w.actions = append(w.actions, request.Action)
		reply := store.ConnectorReplyPayload{}
		switch {
		case request.Connector.Kind == "aws" && request.Action == "status":
			reply.State = &store.DeviceConnectorState{Kind: "aws", Status: store.DeviceConnectorNotInstalled}
		case request.Connector.Kind != "bytedcli" || request.Connector.Holding != store.ConnectorDeviceHeld:
			reply.Error = "unexpected connector"
		case request.Action == "status":
			reply.State = w.state()
		case request.Action == "sign_in_begin":
			reply.SignIn = &store.DeviceConnectorSignIn{Status: "pending", VerificationURL: "https://cloud.bytedance.net/open/ai/service_account/create_and_bind?code=x"}
		case request.Action == "sign_in_poll" && !w.approved:
			reply.SignIn = &store.DeviceConnectorSignIn{Status: "pending"}
		case request.Action == "sign_in_poll":
			w.signedIn = true
			reply.SignIn = &store.DeviceConnectorSignIn{Status: "complete"}
			reply.State = w.state()
		case request.Action == "sign_out":
			w.signedIn = false
			reply.State = w.state()
		default:
			reply.Error = "unknown action"
		}
		w.mu.Unlock()
		_ = w.conn.WriteJSON(map[string]any{"id": envelope.ID, "type": wsConnectorReplyType, "payload": reply})
	}
}

func (w *fakeConnectorWorker) count(action string) int {
	w.mu.Lock()
	defer w.mu.Unlock()
	count := 0
	for _, done := range w.actions {
		if done == action {
			count++
		}
	}
	return count
}

func TestDeviceHeldConnectorThroughTheDevice(t *testing.T) {
	f := newIsolationFixture(t)
	now := time.Now().UTC()
	var clock atomic.Int64
	clock.Store(now.UnixNano())
	f.server.connectors.Devices.Now = func() time.Time { return time.Unix(0, clock.Load()) }
	httpServer := httptest.NewServer(f.handler)
	defer httpServer.Close()
	worker := &fakeConnectorWorker{t: t, signedIn: true, expires: now.Add(48 * time.Hour)}
	worker.connect(httpServer.URL, f.aliceDevice, store.DaemonCapabilityDeviceConnectors)
	defer worker.disconnect()
	waitFor(t, "the device to connect", func() bool { return f.server.hub.HasConnection("dev_alice") })

	call := func(session, method, path, body string, want int) []byte {
		t.Helper()
		recorder := doAuthCall(t, f.handler, f.as(session, method, path, body))
		expectStatus(t, recorder, want, method+" "+path)
		return recorder.Body.Bytes()
	}

	// The page reads the device, keeps the metadata (no email) and the
	// reminder, and lists only the person's own devices.
	var view store.DeviceConnectorsView
	_ = json.Unmarshal(call(f.alice, http.MethodGet, "/api/connectors/devices?refresh=1", "", http.StatusOK), &view)
	if len(view.Connectors) != 2 || view.Connectors[0].Kind != "aws" || view.Connectors[1].Kind != "bytedcli" || view.Connectors[0].Holding != store.ConnectorDeviceHeld {
		t.Fatalf("connectors = %+v", view.Connectors)
	}
	if len(view.Devices) != 1 || view.Devices[0].DeviceID != "dev_alice" || !view.Devices[0].Online || !view.Devices[0].Supported || len(view.Devices[0].States) != 2 {
		t.Fatalf("devices = %+v", view.Devices)
	}
	state := view.Devices[0].States[0]
	if state.Kind != "bytedcli" {
		state = view.Devices[0].States[1]
	}
	if state.Status != store.DeviceConnectorExpiring || state.Identity != "someone" || strings.Join(state.Sites, ",") != "cn" || state.ExpiringSince == "" {
		t.Fatalf("state = %+v", state)
	}
	if body := string(call(f.alice, http.MethodGet, "/api/connectors/devices", "", http.StatusOK)); strings.Contains(body, "example.com") {
		t.Fatalf("an email was kept: %s", body)
	}
	// A second view within the stale window does not ask the device again.
	call(f.alice, http.MethodGet, "/api/connectors/devices?refresh=1", "", http.StatusOK)
	if got := worker.count("status"); got != 2 {
		t.Fatalf("status reads = %d, want 2", got)
	}
	var bobView store.DeviceConnectorsView
	_ = json.Unmarshal(call(f.bob, http.MethodGet, "/api/connectors/devices", "", http.StatusOK), &bobView)
	for _, device := range bobView.Devices {
		if device.DeviceID == "dev_alice" {
			t.Fatalf("bob sees alice's device: %+v", bobView)
		}
	}

	// Only the device's owner acts on it; only device-held kinds exist here.
	for _, path := range []string{"check", "install", "sign-in", "sign-in/poll", "sign-out"} {
		call(f.bob, http.MethodPost, "/api/devices/dev_alice/connectors/bytedcli/"+path, "", http.StatusNotFound)
	}
	call(f.alice, http.MethodPost, "/api/devices/dev_alice/connectors/feishu/check", "", http.StatusNotFound)

	// Sign-in: the page to approve on, then polls until the device completes.
	worker.mu.Lock()
	worker.signedIn = false
	worker.mu.Unlock()
	var signIn store.DeviceConnectorSignIn
	_ = json.Unmarshal(call(f.alice, http.MethodPost, "/api/devices/dev_alice/connectors/bytedcli/sign-in", `{"requestId":"test-start"}`, http.StatusAccepted), &signIn)
	waitFor(t, "authorization challenge", func() bool {
		_ = json.Unmarshal(call(f.alice, http.MethodPost, "/api/devices/dev_alice/connectors/bytedcli/sign-in", `{"requestId":"test-start"}`, http.StatusAccepted), &signIn)
		return signIn.VerificationURL != ""
	})
	if signIn.Status != "pending" || !strings.HasPrefix(signIn.VerificationURL, "https://cloud.bytedance.net/") {
		t.Fatalf("sign-in = %+v", signIn)
	}
	_ = json.Unmarshal(call(f.alice, http.MethodPost, "/api/devices/dev_alice/connectors/bytedcli/sign-in/poll", `{"operationId":"`+signIn.OperationID+`"}`, http.StatusOK), &signIn)
	now = now.Add(3 * time.Second)
	clock.Store(now.UnixNano())
	_ = json.Unmarshal(call(f.alice, http.MethodPost, "/api/devices/dev_alice/connectors/bytedcli/sign-in/poll", `{"operationId":"`+signIn.OperationID+`"}`, http.StatusOK), &signIn)
	waitFor(t, "native pending poll", func() bool { return worker.count("sign_in_poll") == 1 })
	worker.mu.Lock()
	worker.approved = true
	worker.expires = now.Add(30 * 24 * time.Hour)
	worker.mu.Unlock()
	_ = json.Unmarshal(call(f.alice, http.MethodPost, "/api/devices/dev_alice/connectors/bytedcli/sign-in/poll", `{"operationId":"`+signIn.OperationID+`"}`, http.StatusOK), &signIn)
	if signIn.Status != "pending" || worker.count("sign_in_poll") != 1 {
		t.Fatalf("a poll right after another asked the device again: %+v, %d polls", signIn, worker.count("sign_in_poll"))
	}
	now = now.Add(3 * time.Second)
	clock.Store(now.UnixNano())
	_ = json.Unmarshal(call(f.alice, http.MethodPost, "/api/devices/dev_alice/connectors/bytedcli/sign-in/poll", `{"operationId":"`+signIn.OperationID+`"}`, http.StatusOK), &signIn)
	waitFor(t, "authorization complete", func() bool {
		_ = json.Unmarshal(call(f.alice, http.MethodPost, "/api/devices/dev_alice/connectors/bytedcli/sign-in/poll", `{"operationId":"`+signIn.OperationID+`"}`, http.StatusOK), &signIn)
		return signIn.Status == "complete"
	})
	if signIn.Status != "complete" || signIn.State == nil || signIn.State.Status != store.DeviceConnectorReady || signIn.State.ExpiringSince != "" {
		t.Fatalf("completed sign-in = %+v", signIn)
	}

	// A fresh native login is reused without beginning another challenge.
	before := worker.count("sign_in_begin")
	var reused store.DeviceConnectorSignIn
	_ = json.Unmarshal(call(f.alice, http.MethodPost, "/api/devices/dev_alice/connectors/bytedcli/sign-in", `{"requestId":"reuse-native"}`, http.StatusAccepted), &reused)
	waitFor(t, "reuse existing login", func() bool {
		_ = json.Unmarshal(call(f.alice, http.MethodPost, "/api/devices/dev_alice/connectors/bytedcli/sign-in", `{"requestId":"reuse-native"}`, http.StatusAccepted), &reused)
		return reused.Status == "complete"
	})
	if reused.Status != "complete" || reused.State == nil || worker.count("sign_in_begin") != before {
		t.Fatalf("native reuse: %+v", reused)
	}
	call(f.alice, http.MethodPost, "/api/devices/dev_alice/connectors/bytedcli/sign-in/poll", `{"operationId":"stale-id"}`, http.StatusConflict)
	// Sign-out only on request, and the record follows.
	var signedOut store.DeviceConnectorState
	_ = json.Unmarshal(call(f.alice, http.MethodPost, "/api/devices/dev_alice/connectors/bytedcli/sign-out", "", http.StatusOK), &signedOut)
	if signedOut.Status != store.DeviceConnectorSignedOut || signedOut.Identity != "" || signedOut.ExpiresAt != "" {
		t.Fatalf("signed out = %+v", signedOut)
	}

	// A completed adapter reply without a usable fresh login is not success.
	descriptor, _ := f.server.connectors.Devices.Connector("bytedcli")
	unverified := f.server.signInAnswer(context.Background(), "dev_alice", descriptor, store.ConnectorReplyPayload{SignIn: &store.DeviceConnectorSignIn{Status: "complete"}})
	if unverified.Status != "failed" || unverified.State != nil {
		t.Fatalf("unverified completion: %+v", unverified)
	}
	// Bindings: a maintainer binds their own device's login, not another's.
	call(f.alice, http.MethodPut, "/api/workspaces/ws_alice/device-connectors", `{"bindings":[{"kind":"bytedcli","deviceId":"dev_bob"}]}`, http.StatusNotFound)
	call(f.alice, http.MethodPut, "/api/workspaces/ws_alice/device-connectors", `{"bindings":[{"kind":"feishu","deviceId":"dev_alice"}]}`, http.StatusBadRequest)
	call(f.bob, http.MethodPut, "/api/workspaces/ws_alice/device-connectors", `{"bindings":[]}`, http.StatusNotFound)
	var bound store.WorkspaceDeviceConnectors
	_ = json.Unmarshal(call(f.alice, http.MethodPut, "/api/workspaces/ws_alice/device-connectors", `{"bindings":[{"kind":"bytedcli","deviceId":"dev_alice"}]}`, http.StatusOK), &bound)
	if len(bound.Bindings) != 1 || bound.Bindings[0].DeviceName != "alice-mac" || bound.Bindings[0].State == nil || bound.Bindings[0].Members {
		t.Fatalf("bindings = %+v", bound.Bindings)
	}

	// The session's run carries the connector for alice's own session there.
	ctx := context.Background()
	session := store.AgentSession{ID: "sess_bytedcli", WorkspaceID: "ws_alice", DeviceID: "dev_alice", CreatedByUserID: f.aliceID, Source: "chat"}
	alice, _ := f.server.store.GetUser(ctx, f.aliceID)
	aliceDevice := Actor{Kind: ActorDaemon, DeviceID: "dev_alice", Account: &alice}
	uses := f.server.hub.sessionConnectors(ctx, session, aliceDevice, declares(store.DaemonCapabilityDeviceConnectors)).DeviceConnectors
	if len(uses) != 0 {
		t.Fatalf("signed-out owner got a login: %+v", uses)
	}
	_, err := f.server.connectors.Devices.Record(ctx, "dev_alice", store.DeviceConnectorState{Kind: "bytedcli", Status: store.DeviceConnectorReady, SignedIn: true, Identity: "someone"})
	if err != nil {
		t.Fatal(err)
	}
	// Removing the legacy owner-only binding leaves the owner's login available.
	call(f.alice, http.MethodPut, "/api/workspaces/ws_alice/device-connectors", `{"bindings":[]}`, http.StatusOK)
	uses = f.server.hub.sessionConnectors(ctx, session, aliceDevice, declares(store.DaemonCapabilityDeviceConnectors)).DeviceConnectors
	if len(uses) != 1 || uses[0].Access != "device_login" || uses[0].Command != "bytedcli" || len(uses[0].IsolationEnv) != 0 {
		t.Fatalf("uses = %+v", uses)
	}
	verifier := session
	verifier.Source = "verification"
	if got := f.server.hub.sessionConnectors(ctx, verifier, aliceDevice, declares(store.DaemonCapabilityDeviceConnectors)); len(got.DeviceConnectors) != 0 {
		t.Fatalf("verifier got connectors: %+v", got)
	}
	if uses := f.server.hub.sessionConnectors(ctx, session, aliceDevice, declares()).DeviceConnectors; len(uses) != 0 {
		t.Fatalf("an old worker got device connectors: %+v", uses)
	}
	// Someone else's session on alice's device is kept from her login.
	bobs := session
	bobs.CreatedByUserID = f.bobID
	uses = f.server.hub.sessionConnectors(ctx, bobs, aliceDevice, declares(store.DaemonCapabilityDeviceConnectors)).DeviceConnectors
	if len(uses) != 2 || uses[0].Kind != "aws" || uses[0].Access != "none" || uses[0].IsolationEnv["AWS_PROFILE"] == "" || uses[1].Access != "none" || uses[1].IsolationEnv["BYTEDCLI_PROFILE"] == "" {
		t.Fatalf("bob's session on alice's device = %+v", uses)
	}

	// An offline device is said to be offline.
	worker.disconnect()
	waitFor(t, "the device to go", func() bool { return !f.server.hub.HasConnection("dev_alice") })
	call(f.alice, http.MethodPost, "/api/devices/dev_alice/connectors/bytedcli/check", "", http.StatusConflict)
}

// A device whose worker predates device-held connectors is told to update.
func TestDeviceHeldConnectorNeedsANewWorker(t *testing.T) {
	f := newIsolationFixture(t)
	httpServer := httptest.NewServer(f.handler)
	defer httpServer.Close()
	worker := &fakeConnectorWorker{t: t}
	worker.connect(httpServer.URL, f.aliceDevice)
	defer worker.disconnect()
	waitFor(t, "the device to connect", func() bool { return f.server.hub.HasConnection("dev_alice") })
	recorder := doAuthCall(t, f.handler, f.as(f.alice, http.MethodPost, "/api/devices/dev_alice/connectors/bytedcli/check", ""))
	expectStatus(t, recorder, http.StatusConflict, "check on an old worker")
	if !strings.Contains(recorder.Body.String(), "update its worker") {
		t.Fatalf("answer = %s", recorder.Body.String())
	}
	var view store.DeviceConnectorsView
	_ = json.Unmarshal(doAuthCall(t, f.handler, f.as(f.alice, http.MethodGet, "/api/connectors/devices?refresh=1", "")).Body.Bytes(), &view)
	if len(view.Devices) != 1 || !view.Devices[0].Online || view.Devices[0].Supported {
		t.Fatalf("devices = %+v", view.Devices)
	}
	if worker.count("status") != 0 {
		t.Fatal("an old worker was asked")
	}
}

func TestWorkspaceConnectorsExcludeUnrelatedOwnedDevices(t *testing.T) {
	f := newIsolationFixture(t)
	_, credential := pairOverHTTP(t, f.handler, f.alice, "alice-other-machine", "dev_alice_other")
	expectStatus(t, doAuthCall(t, f.handler, deviceCall(http.MethodPost, "/api/daemon/register", registrationBody("dev_alice_other", "ws_alice_other"), credential)), http.StatusOK, "register unrelated owned device")
	response := doAuthCall(t, f.handler, f.as(f.alice, http.MethodGet, "/api/workspaces/ws_alice/device-connectors", ""))
	expectStatus(t, response, http.StatusOK, "workspace scope")
	var view store.WorkspaceDeviceConnectors
	_ = json.Unmarshal(response.Body.Bytes(), &view)
	if view.DefaultDeviceID != "dev_alice" || len(view.ExecutionDevices) != 1 || len(view.Devices) != 1 || view.Devices[0].DeviceID != "dev_alice" {
		t.Fatalf("workspace offered unrelated login: %+v", view)
	}
	expectStatus(t, doAuthCall(t, f.handler, f.as(f.alice, http.MethodPut, "/api/workspaces/ws_alice/device-connectors", `{"bindings":[{"kind":"bytedcli","deviceId":"dev_alice_other"}]}`)), http.StatusConflict, "cross-device binding")
	// A pre-existing legacy binding may survive unchanged, but cannot be broadened.
	err := f.server.connectors.Devices.SetBindings(context.Background(), "ws_alice", f.aliceID, []store.DeviceConnectorBindingInput{{Kind: "bytedcli", DeviceID: "dev_alice_other"}}, func(string) bool { return true })
	if err != nil {
		t.Fatal(err)
	}
	expectStatus(t, doAuthCall(t, f.handler, f.as(f.alice, http.MethodPut, "/api/workspaces/ws_alice/device-connectors", `{"bindings":[{"kind":"bytedcli","deviceId":"dev_alice_other","members":false},{"kind":"bytedcli","deviceId":"dev_alice"}]}`)), http.StatusOK, "retain legacy grant")
	expectStatus(t, doAuthCall(t, f.handler, f.as(f.alice, http.MethodPut, "/api/workspaces/ws_alice/device-connectors", `{"bindings":[{"kind":"bytedcli","deviceId":"dev_alice_other","members":true}]}`)), http.StatusConflict, "cannot widen legacy grant")
}

func TestDeviceAuthorizationImageIsOwnerOperationAndGroupScoped(t *testing.T) {
	f := newIsolationFixture(t)
	descriptor, _ := f.server.connectors.Devices.Connector("bytedcli")
	input := connectorAuthorizationInput{AuthorizationID: "feishu_web_session", AuthorizationRevision: 1}
	scope, err := authorizationScope(descriptor, input)
	if err != nil {
		t.Fatal(err)
	}
	begin, err := f.server.connectors.Devices.Authorize(f.aliceID, "dev_alice", scope, "image-request", "", true, func(_, _ string, _ func(string)) (store.DeviceConnectorSignIn, error) {
		return store.DeviceConnectorSignIn{Status: "pending", Image: []byte{137, 80, 78, 71, 13, 10, 26, 10}, Challenge: &store.ConnectorAuthorizationChallenge{Kind: "qr_image"}}, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	waitFor(t, "image prepared", func() bool {
		_, e := f.server.connectors.Devices.AuthorizationImage(f.aliceID, "dev_alice", scope, begin.OperationID)
		return e == nil
	})
	path := "/api/devices/dev_alice/connectors/bytedcli/sign-in/image?authorizationId=feishu_web_session&authorizationRevision=1&operationId=" + begin.OperationID
	response := doAuthCall(t, f.handler, f.as(f.alice, http.MethodGet, path, ""))
	expectStatus(t, response, http.StatusOK, "owner's active image")
	if response.Header().Get("Cache-Control") != "no-store, private" || response.Header().Get("Content-Type") != "image/png" {
		t.Fatal(response.Header())
	}
	expectStatus(t, doAuthCall(t, f.handler, f.as(f.bob, http.MethodGet, path, "")), http.StatusNotFound, "another user's image")
	expectStatus(t, doAuthCall(t, f.handler, f.as(f.alice, http.MethodGet, strings.Replace(path, "Revision=1", "Revision=2", 1), "")), http.StatusNotFound, "wrong revision")
	expectStatus(t, doAuthCall(t, f.handler, f.as(f.alice, http.MethodGet, path+"-stale", "")), http.StatusNotFound, "wrong operation")
	expectStatus(t, doAuthCall(t, f.handler, f.as(f.alice, http.MethodPost, "/api/devices/dev_alice/connectors/bytedcli/sign-in/dismiss", `{"operationId":"`+begin.OperationID+`","authorizationId":"feishu_web_session","authorizationRevision":1}`)), http.StatusNoContent, "dismiss image")
	expectStatus(t, doAuthCall(t, f.handler, f.as(f.alice, http.MethodGet, path, "")), http.StatusNotFound, "dismissed image")
	// A ready base login does not satisfy the additional credential group.
	if authorizationReady(store.DeviceConnectorState{SignedIn: true, Status: store.DeviceConnectorReady}, input) {
		t.Fatal("base login granted additional capability")
	}
	if !authorizationReady(store.DeviceConnectorState{Authorizations: []store.ConnectorAuthorizationState{{ID: input.AuthorizationID, Revision: 1, Status: "ready"}}}, input) {
		t.Fatal("capability incorrectly depends on base login")
	}
}
