package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
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
	f.server.connectors.Devices.Now = func() time.Time { return now }
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
	if len(view.Connectors) != 1 || view.Connectors[0].Kind != "bytedcli" || view.Connectors[0].Holding != store.ConnectorDeviceHeld {
		t.Fatalf("connectors = %+v", view.Connectors)
	}
	if len(view.Devices) != 1 || view.Devices[0].DeviceID != "dev_alice" || !view.Devices[0].Online || !view.Devices[0].Supported || len(view.Devices[0].States) != 1 {
		t.Fatalf("devices = %+v", view.Devices)
	}
	state := view.Devices[0].States[0]
	if state.Status != store.DeviceConnectorExpiring || state.Identity != "someone" || strings.Join(state.Sites, ",") != "cn" || state.ExpiringSince == "" {
		t.Fatalf("state = %+v", state)
	}
	if body := string(call(f.alice, http.MethodGet, "/api/connectors/devices", "", http.StatusOK)); strings.Contains(body, "example.com") {
		t.Fatalf("an email was kept: %s", body)
	}
	// A second view within the stale window does not ask the device again.
	call(f.alice, http.MethodGet, "/api/connectors/devices?refresh=1", "", http.StatusOK)
	if got := worker.count("status"); got != 1 {
		t.Fatalf("status reads = %d, want 1", got)
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
	_ = json.Unmarshal(call(f.alice, http.MethodPost, "/api/devices/dev_alice/connectors/bytedcli/sign-in", "", http.StatusAccepted), &signIn)
	if signIn.Status != "pending" || !strings.HasPrefix(signIn.VerificationURL, "https://cloud.bytedance.net/") {
		t.Fatalf("sign-in = %+v", signIn)
	}
	_ = json.Unmarshal(call(f.alice, http.MethodPost, "/api/devices/dev_alice/connectors/bytedcli/sign-in/poll", "", http.StatusOK), &signIn)
	worker.mu.Lock()
	worker.approved = true
	worker.expires = now.Add(30 * 24 * time.Hour)
	worker.mu.Unlock()
	_ = json.Unmarshal(call(f.alice, http.MethodPost, "/api/devices/dev_alice/connectors/bytedcli/sign-in/poll", "", http.StatusOK), &signIn)
	if signIn.Status != "pending" || worker.count("sign_in_poll") != 1 {
		t.Fatalf("a poll right after another asked the device again: %+v, %d polls", signIn, worker.count("sign_in_poll"))
	}
	now = now.Add(3 * time.Second)
	_ = json.Unmarshal(call(f.alice, http.MethodPost, "/api/devices/dev_alice/connectors/bytedcli/sign-in/poll", "", http.StatusOK), &signIn)
	if signIn.Status != "complete" || signIn.State == nil || signIn.State.Status != store.DeviceConnectorReady || signIn.State.ExpiringSince != "" {
		t.Fatalf("completed sign-in = %+v", signIn)
	}

	// Sign-out only on request, and the record follows.
	var signedOut store.DeviceConnectorState
	_ = json.Unmarshal(call(f.alice, http.MethodPost, "/api/devices/dev_alice/connectors/bytedcli/sign-out", "", http.StatusOK), &signedOut)
	if signedOut.Status != store.DeviceConnectorSignedOut || signedOut.Identity != "" || signedOut.ExpiresAt != "" {
		t.Fatalf("signed out = %+v", signedOut)
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
	if len(uses) != 1 || uses[0].Access != "device_login" || uses[0].Command != "bytedcli" || len(uses[0].IsolationEnv) != 0 {
		t.Fatalf("uses = %+v", uses)
	}
	if uses := f.server.hub.sessionConnectors(ctx, session, aliceDevice, declares()).DeviceConnectors; len(uses) != 0 {
		t.Fatalf("an old worker got device connectors: %+v", uses)
	}
	// Someone else's session on alice's device is kept from her login.
	bobs := session
	bobs.CreatedByUserID = f.bobID
	uses = f.server.hub.sessionConnectors(ctx, bobs, aliceDevice, declares(store.DaemonCapabilityDeviceConnectors)).DeviceConnectors
	if len(uses) != 1 || uses[0].Access != "none" || uses[0].IsolationEnv["BYTEDCLI_PROFILE"] == "" {
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
