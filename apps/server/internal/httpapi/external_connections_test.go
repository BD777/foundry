package httpapi

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// answerExternalConnection attaches dev_1's worker, declaring capabilities,
// and answers its next request with reply. It returns what was asked.
func answerExternalConnection(t *testing.T, server *Server, capabilities []string, reply string) chan wsEnvelope {
	t.Helper()
	connection := newDaemonConnection(server.hub, nil)
	connection.registration = store.DaemonRegistration{Capabilities: capabilities}
	server.hub.mu.Lock()
	server.hub.connections["dev_1"] = connection
	server.hub.mu.Unlock()
	t.Cleanup(func() {
		server.hub.mu.Lock()
		delete(server.hub.connections, "dev_1")
		server.hub.mu.Unlock()
		close(connection.done)
	})
	asked := make(chan wsEnvelope, 1)
	go func() {
		for envelope := range connection.send {
			asked <- envelope
			_ = deliverDaemonResponse[wsExternalConnectionReply](connection, wsEnvelope{ID: envelope.ID, Payload: json.RawMessage(reply)}, nil)
			return
		}
	}()
	return asked
}

func externalConnectionServer(t *testing.T) *Server {
	t.Helper()
	backing := newEmptyTestStore(t)
	registerPromotionDaemon(t, backing, store.AgentProfileProjection{ID: "company", Runtime: "claude", ConnectionType: "external", Label: "Company"})
	return NewServer(backing)
}

func TestExternalConnectionManagementNeedsAConnectedCapableWorker(t *testing.T) {
	server := externalConnectionServer(t)
	check := "/api/devices/dev_1/external-connections/company/check"
	requestForTest(t, server, http.MethodPost, "/api/devices/dev_1/external-connections/claude_local/check", "", http.StatusNotFound)
	requestForTest(t, server, http.MethodPost, check, "", http.StatusConflict)

	// An older worker is told to update rather than sent a request it
	// cannot answer.
	asked := answerExternalConnection(t, server, nil, `{}`)
	response := requestForTest(t, server, http.MethodPost, check, "", http.StatusConflict)
	if !json.Valid(response.Body.Bytes()) || len(asked) != 0 {
		t.Fatalf("an old worker was asked: %s", response.Body.String())
	}
	var body map[string]string
	_ = json.Unmarshal(response.Body.Bytes(), &body)
	if body["error"] != errExternalConnectionUnsupported.Error() {
		t.Fatalf("refusal = %q", body["error"])
	}
	requestForTest(t, server, http.MethodDelete, "/api/devices/dev_1/external-connections/company", "", http.StatusConflict)
}

func TestExternalConnectionCheckRunsOnTheDeviceAndReturnsItsResult(t *testing.T) {
	server := externalConnectionServer(t)
	asked := answerExternalConnection(t, server, []string{externalConnectionManageCapability},
		`{"result":{"status":"failed","checkedAt":"2026-10-26T08:00:00Z","message":"gateway refused"}}`)
	response := requestForTest(t, server, http.MethodPost, "/api/devices/dev_1/external-connections/company/check", "", http.StatusOK)
	envelope := <-asked
	var input wsExternalConnectionRequestPayload
	_ = json.Unmarshal(envelope.Payload, &input)
	if envelope.Type != wsCheckExternalConnectionType || input.ProfileID != "company" {
		t.Fatalf("asked %s %+v", envelope.Type, input)
	}
	var result externalConnectionCheck
	if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if result.Status != "failed" || result.Message != "gateway refused" {
		t.Fatalf("result = %+v", result)
	}
}

func TestExternalConnectionDeviceErrorsKeepTheirMeaning(t *testing.T) {
	for _, tc := range []struct {
		code   string
		status int
	}{{"busy", http.StatusConflict}, {"not_found", http.StatusNotFound}, {"id_conflict", http.StatusConflict}, {"", http.StatusBadGateway}} {
		server := externalConnectionServer(t)
		asked := answerExternalConnection(t, server, []string{externalConnectionManageCapability},
			`{"error":"device says no","errorCode":"`+tc.code+`"}`)
		response := requestForTest(t, server, http.MethodDelete, "/api/devices/dev_1/external-connections/company", "", tc.status)
		if envelope := <-asked; envelope.Type != wsRemoveExternalConnectionType {
			t.Fatalf("asked %s", envelope.Type)
		}
		var body map[string]string
		_ = json.Unmarshal(response.Body.Bytes(), &body)
		if body["error"] != "device says no" {
			t.Fatalf("%s: error = %q", tc.code, body["error"])
		}
	}
}

func TestExternalConnectionRemovalAnswersAndOnlyForExternalRows(t *testing.T) {
	backing := newEmptyTestStore(t)
	registerPromotionDaemon(t, backing, store.AgentProfileProjection{ID: "gateway", Runtime: "claude", ConnectionType: "anthropic_compatible"})
	server := NewServer(backing)
	requestForTest(t, server, http.MethodDelete, "/api/devices/dev_1/external-connections/gateway", "", http.StatusBadRequest)

	server = externalConnectionServer(t)
	answerExternalConnection(t, server, []string{externalConnectionManageCapability}, `{}`)
	requestForTest(t, server, http.MethodDelete, "/api/devices/dev_1/external-connections/company", "", http.StatusOK)
}

// Only the device's owner manages its connections.
func TestExternalConnectionManagementIsTheDeviceOwners(t *testing.T) {
	f := newIsolationFixture(t)
	for _, call := range []struct{ method, path string }{
		{http.MethodPost, "/api/devices/dev_alice/external-connections/company/check"},
		{http.MethodDelete, "/api/devices/dev_alice/external-connections/company"},
	} {
		if code := doAuthCall(t, f.handler, f.as(f.bob, call.method, call.path, "")).Code; code != http.StatusNotFound {
			t.Fatalf("bob %s %s: %d", call.method, call.path, code)
		}
	}
}
