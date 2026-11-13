package httpapi

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

// The device page's proxy warning (DEV-217): its owner stops using the
// Worker's proxy or sets another one, through the Worker, which validates it.
func TestSetDeviceWorkerProxyGoesThroughTheWorker(t *testing.T) {
	fixture := setupProjectedSessionFixture(t)
	path := "/api/devices/" + fixture.deviceID + "/worker/proxy"
	connection := newDaemonConnection(fixture.server.hub, nil)
	fixture.server.hub.connections[fixture.deviceID] = connection
	defer close(connection.done)

	requestForTest(t, fixture.server, http.MethodPut, path, `{"url":"http://proxy:3128","clear":true}`, http.StatusBadRequest)
	requestForTest(t, fixture.server, http.MethodPut, path, `{"url":"  "}`, http.StatusBadRequest)
	// A worker that cannot do it is told to update, not left to time out.
	requestForTest(t, fixture.server, http.MethodPut, path, `{"clear":true}`, http.StatusConflict)

	connection.registrationMu.Lock()
	connection.registration.Capabilities = []string{workerProxySettingsCapability}
	connection.registrationMu.Unlock()
	asked := make(chan string, 3)
	answers := []wsWorkerProxySet{{}, {Proxy: "http://proxy:3128"}, {Error: "Invalid worker proxy: use http://…"}}
	go func() {
		for envelope := range connection.send {
			if envelope.Type != wsSetWorkerProxyType {
				continue
			}
			asked <- string(envelope.Payload)
			payload, _ := json.Marshal(answers[0])
			answers = answers[1:]
			_ = deliverDaemonResponse[wsWorkerProxySet](connection, wsEnvelope{ID: envelope.ID, Type: wsWorkerProxySetType, Payload: payload}, nil)
			if len(answers) == 0 {
				return
			}
		}
	}()
	requestForTest(t, fixture.server, http.MethodPut, path, `{"clear":true}`, http.StatusOK)
	if sent := <-asked; sent != `{"clear":true}` {
		t.Fatalf("clear sent %s", sent)
	}
	saved := requestForTest(t, fixture.server, http.MethodPut, path, `{"url":" http://user:pw@proxy:3128 "}`, http.StatusOK).Body.String()
	if sent := <-asked; sent != `{"url":"http://user:pw@proxy:3128"}` {
		t.Fatalf("set sent %s", sent)
	}
	if !strings.Contains(saved, `"proxy":"http://proxy:3128"`) || strings.Contains(saved, "pw@") {
		t.Fatalf("answer %s", saved)
	}
	refused := requestForTest(t, fixture.server, http.MethodPut, path, `{"url":"ftp://proxy"}`, http.StatusBadRequest).Body.String()
	<-asked
	if !strings.Contains(refused, "Invalid worker proxy") {
		t.Fatalf("the worker's refusal must reach the owner: %s", refused)
	}
}
