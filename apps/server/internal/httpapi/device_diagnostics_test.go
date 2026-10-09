package httpapi

import (
	"bytes"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// A worker's account of its previous connection is logged, and joins the
// server's own reason as the device's last disconnect.
func TestWorkerConnectionReportsAreLoggedAndKept(t *testing.T) {
	payload := json.RawMessage(`{
		"device": {"id": "dev_1", "label": "byte-dev"},
		"workspace": {"id": "ws_1"},
		"activeSessionIds": [],
		"providerHealth": [], "assets": [], "agents": [], "skills": [], "workspaceFiles": [],
		"connections": [{"openedAt": "2026-10-09T06:09:00Z", "closedAt": "2026-10-09T06:10:14Z",
			"durationMs": 74000, "closedBy": "worker", "closeCode": 1006,
			"sinceServerDataMs": 75000, "proxy": "proxy.corp:3128"}]
	}`)
	var registration store.DaemonRegistration
	if err := decodeWebSocketPayload(payload, &registration); err != nil {
		t.Fatalf("registration with connection reports refused: %v", err)
	}
	hub := NewDaemonHub(nil, nil, "")
	hub.disconnects.serverSide("dev_1", errors.New("read tcp: i/o timeout"), time.Date(2026, 10, 9, 6, 10, 18, 0, time.UTC))
	var output bytes.Buffer
	log.SetOutput(&output)
	defer log.SetOutput(os.Stderr)
	hub.logWorkerConnections(registration)
	want := "device byte-dev reconnected: previous connection lasted 74s, closed by worker, code=1006, last data from server 75s before, proxy=proxy.corp:3128"
	if !strings.Contains(output.String(), want) {
		t.Fatalf("log = %q, want %q", output.String(), want)
	}
	devices := hub.withDisconnects([]store.DeviceProjection{{ID: "dev_1"}, {ID: "dev_2"}})
	last := devices[0].LastDisconnect
	if last == nil || last.ServerReason != "read tcp: i/o timeout" || last.Worker == nil || last.Worker.ClosedBy != "worker" {
		t.Fatalf("last disconnect = %+v", last)
	}
	if devices[1].LastDisconnect != nil {
		t.Fatal("a device that never dropped has no last disconnect")
	}
}

func TestDeviceDiagnosticsAskACapableConnectedWorker(t *testing.T) {
	fixture := setupProjectedSessionFixture(t)
	path := "/api/devices/" + fixture.deviceID + "/diagnostics"
	requestForTest(t, fixture.server, http.MethodPost, path, `{}`, http.StatusConflict)

	connection := newDaemonConnection(fixture.server.hub, nil)
	fixture.server.hub.connections[fixture.deviceID] = connection
	defer close(connection.done)
	// An older worker is told to update first.
	requestForTest(t, fixture.server, http.MethodPost, path, `{}`, http.StatusConflict)

	connection.registration = store.DaemonRegistration{Capabilities: []string{diagnosticsCapability}}
	go func() {
		for envelope := range connection.send {
			var payload []byte
			switch envelope.Type {
			case wsRunDiagnosticsType:
				payload, _ = json.Marshal(wsDiagnosticsReady{Report: &store.DeviceDiagnostics{
					GeneratedAt: "now", WorkerVersion: "0.5.7",
					Checks:  []store.DiagnosticCheck{{ID: "connection.socket", Status: "ok", Values: map[string]any{"ms": 42}}},
					LogTail: []string{"[err] fine"},
				}})
				_ = deliverDaemonResponse[wsDiagnosticsReady](connection, wsEnvelope{ID: envelope.ID, Type: wsDiagnosticsReadyType, Payload: payload}, nil)
			case wsRunRepairType:
				var request wsRunRepair
				_ = json.Unmarshal(envelope.Payload, &request)
				payload, _ = json.Marshal(wsRepairDone{Result: &store.DeviceRepairResult{Action: request.Action, Values: map[string]any{"count": 2}}})
				_ = deliverDaemonResponse[wsRepairDone](connection, wsEnvelope{ID: envelope.ID, Type: wsRepairDoneType, Payload: payload}, nil)
			}
		}
	}()
	response := requestForTest(t, fixture.server, http.MethodPost, path, `{}`, http.StatusOK)
	var report store.DeviceDiagnostics
	if err := json.Unmarshal(response.Body.Bytes(), &report); err != nil || len(report.Checks) != 1 || report.Checks[0].ID != "connection.socket" {
		t.Fatalf("report = %s, %v", response.Body.String(), err)
	}
	repairs := "/api/devices/" + fixture.deviceID + "/repairs"
	requestForTest(t, fixture.server, http.MethodPost, repairs, `{"action":"rm -rf"}`, http.StatusBadRequest)
	repaired := requestForTest(t, fixture.server, http.MethodPost, repairs, `{"action":"forget-missing-workspaces"}`, http.StatusOK)
	if !strings.Contains(repaired.Body.String(), `"count":2`) {
		t.Fatalf("repair = %s", repaired.Body.String())
	}
}
