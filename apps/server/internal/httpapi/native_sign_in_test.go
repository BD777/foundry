package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"github.com/gorilla/websocket"
)

// fakeSignInDevice is alice's device answering native_sign_in the way the
// worker does: Claude's page, then the pasted code; sign-out reports the
// device again.
type fakeSignInDevice struct {
	t        *testing.T
	conn     *websocket.Conn
	done     chan struct{}
	mu       sync.Mutex
	requests []store.NativeSignInRequestPayload
}

func (d *fakeSignInDevice) serve() {
	defer close(d.done)
	code := ""
	for {
		var envelope wsEnvelope
		if err := d.conn.ReadJSON(&envelope); err != nil {
			return
		}
		if envelope.Type != wsNativeSignInType {
			continue
		}
		var request store.NativeSignInRequestPayload
		_ = json.Unmarshal(envelope.Payload, &request)
		d.mu.Lock()
		d.requests = append(d.requests, request)
		d.mu.Unlock()
		reply := store.NativeSignInReplyPayload{}
		step := &store.NativeSignInStep{Status: "pending", OperationID: request.OperationID, VerificationURL: "https://claude.com/cai/oauth/authorize?state=s", CodeEntry: true}
		switch request.Action {
		case store.NativeSignInActionBegin:
			reply.SignIn = step
		case store.NativeSignInActionInput:
			code = request.Input
			reply.SignIn = step
		case store.NativeSignInActionPoll:
			reply.SignIn = step
			if code == "good#s" {
				reply.SignIn = &store.NativeSignInStep{Status: "complete", OperationID: request.OperationID}
				reply.Registration = &store.DaemonRegistration{Device: store.DeviceProjection{ID: "dev_alice", Label: "alice-mac", Status: "connected", LastSeenLabel: "online"}, Capabilities: []string{store.DaemonCapabilityNativeSignIn}}
			}
		case store.NativeSignInActionDismiss:
			reply.SignIn = &store.NativeSignInStep{Status: "expired", OperationID: request.OperationID}
		case store.NativeSignInActionSignOut:
			reply.Registration = &store.DaemonRegistration{Device: store.DeviceProjection{ID: "dev_alice", Label: "alice-mac", Status: "connected", LastSeenLabel: "online"}, Capabilities: []string{store.DaemonCapabilityNativeSignIn}}
		}
		_ = d.conn.WriteJSON(map[string]any{"id": envelope.ID, "type": wsNativeSignInReplyType, "payload": reply})
	}
}

func TestNativeSignInThroughTheDevice(t *testing.T) {
	f := newIsolationFixture(t)
	httpServer := httptest.NewServer(f.handler)
	defer httpServer.Close()
	call := func(session, path, body string, want int) []byte {
		t.Helper()
		recorder := doAuthCall(t, f.handler, f.as(session, http.MethodPost, path, body))
		expectStatus(t, recorder, want, path)
		return recorder.Body.Bytes()
	}
	const base = "/api/devices/dev_alice/accounts/claude"

	// Before the device connects there is nothing to sign in through.
	call(f.alice, base+"/sign-in", `{"requestId":"browser-1"}`, http.StatusConflict)

	headers := http.Header{}
	headers.Set(deviceCredentialHeader, f.aliceDevice)
	conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(httpServer.URL, "http")+"/api/daemon/ws", headers)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	device := &fakeSignInDevice{t: t, conn: conn, done: make(chan struct{})}
	writeWSForTest(t, conn, "hello", map[string]any{
		"device":       map[string]any{"id": "dev_alice", "label": "alice-mac", "status": "connected", "lastSeenLabel": "online"},
		"workspace":    map[string]any{"id": "ws_alice", "name": "W", "localPath": "/tmp/w", "baseline": "main"},
		"capabilities": []string{store.DaemonCapabilityNativeSignIn},
	})
	go device.serve()
	defer func() { _ = conn.Close(); <-device.done }()
	waitFor(t, "the device to connect", func() bool { return f.server.hub.HasConnection("dev_alice") })

	// Only the device's owner signs it in; a runtime must be one Foundry signs in.
	call(f.bob, base+"/sign-in", `{"requestId":"browser-1"}`, http.StatusNotFound)
	call(f.alice, "/api/devices/dev_alice/accounts/mock/sign-in", `{"requestId":"browser-1"}`, http.StatusBadRequest)
	call(f.alice, base+"/sign-in", `{}`, http.StatusBadRequest)

	var begin store.NativeSignInStep
	_ = json.Unmarshal(call(f.alice, base+"/sign-in", `{"requestId":"browser-1"}`, http.StatusOK), &begin)
	if begin.Status != "pending" || !begin.CodeEntry || begin.OperationID == "" || !strings.HasPrefix(begin.VerificationURL, "https://claude.com/") {
		t.Fatalf("begin = %+v", begin)
	}
	// The same request names the same running sign-in: the device is polled, not restarted.
	var again store.NativeSignInStep
	_ = json.Unmarshal(call(f.alice, base+"/sign-in", `{"requestId":"browser-1"}`, http.StatusOK), &again)
	if again.OperationID != begin.OperationID {
		t.Fatalf("a repeated begin started another sign-in: %+v", again)
	}
	call(f.alice, base+"/sign-in/code", `{"operationId":"`+begin.OperationID+`"}`, http.StatusBadRequest)
	call(f.alice, base+"/sign-in/code", `{"operationId":"`+begin.OperationID+`","code":"good#s"}`, http.StatusOK)
	var done store.NativeSignInStep
	_ = json.Unmarshal(call(f.alice, base+"/sign-in/poll", `{"operationId":"`+begin.OperationID+`"}`, http.StatusOK), &done)
	if done.Status != "complete" {
		t.Fatalf("poll = %+v", done)
	}
	call(f.alice, base+"/sign-in/dismiss", `{"operationId":"`+begin.OperationID+`"}`, http.StatusOK)
	call(f.alice, base+"/sign-out", `{}`, http.StatusOK)

	device.mu.Lock()
	var actions []string
	for _, request := range device.requests {
		if request.Runtime != "claude" {
			t.Errorf("request for %s", request.Runtime)
		}
		actions = append(actions, string(request.Action))
	}
	device.mu.Unlock()
	if strings.Join(actions, ",") != "begin,poll,input,poll,dismiss,sign_out" {
		t.Fatalf("device saw %v", actions)
	}
}
