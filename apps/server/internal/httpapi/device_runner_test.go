package httpapi

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func TestDeviceRunnerIsProjectedForItsConnectionOnly(t *testing.T) {
	fixture := setupProjectedSessionFixture(t)
	connection := newDaemonConnection(fixture.server.hub, nil)
	fixture.server.hub.connections[fixture.deviceID] = connection
	defer close(connection.done)
	runner := store.DeviceRunner{Version: "0.5.7-dev.53", TargetVersion: "0.5.7-dev.110", State: "pending", RunningTurns: 2, HeldTurns: 1}
	fixture.server.recordDeviceRunner(connection, fixture.deviceID, runner)
	devices := fixture.server.withDeviceRunners([]store.DeviceProjection{{ID: fixture.deviceID}})
	if devices[0].Runner == nil || *devices[0].Runner != runner {
		t.Fatalf("runner = %+v, want %+v", devices[0].Runner, runner)
	}
	// A report belongs to the connection that sent it: after the device
	// reconnects, an old one is not shown.
	fixture.server.hub.connections[fixture.deviceID] = newDaemonConnection(fixture.server.hub, nil)
	devices = fixture.server.withDeviceRunners([]store.DeviceProjection{{ID: fixture.deviceID}})
	if devices[0].Runner != nil {
		t.Fatalf("runner of a replaced connection = %+v", devices[0].Runner)
	}
}

func TestSwitchRunnerNowSendsTheReviewedTurnsAndReportsAChangedList(t *testing.T) {
	fixture := setupProjectedSessionFixture(t)
	path := "/api/devices/" + fixture.deviceID + "/worker/runner/switch"
	connection := newDaemonConnection(fixture.server.hub, nil)
	fixture.server.hub.connections[fixture.deviceID] = connection
	defer close(connection.done)
	// A worker that does not report its runner cannot switch it from here.
	requestForTest(t, fixture.server, http.MethodPost, path, `{"turns":[]}`, http.StatusConflict)
	connection.registration = store.DaemonRegistration{Capabilities: []string{runnerReportsFeature}}

	// The first read finds a turn started since the owner looked; the second
	// finds exactly the reviewed one.
	reads := [][]store.DeviceRunnerTurn{
		{{SessionID: "sess_a", InputID: "in_a"}, {SessionID: "sess_new", InputID: "in_new"}},
		{{SessionID: "sess_a", InputID: "in_a"}, {SessionID: "sess_bg", Background: true}},
	}
	asked := make(chan json.RawMessage, 2)
	go func() {
		for envelope := range connection.send {
			switch envelope.Type {
			case wsReadExecutionRunnerType:
				payload, _ := json.Marshal(wsExecutionRunnerRead{DeviceRunnerDetail: store.DeviceRunnerDetail{Turns: reads[0]}})
				reads = reads[1:]
				_ = deliverDaemonResponse[wsExecutionRunnerRead](connection, wsEnvelope{ID: envelope.ID, Type: wsExecutionRunnerReadType, Payload: payload}, nil)
			case wsSwitchExecutionRunnerType:
				asked <- envelope.Payload
				payload, _ := json.Marshal(wsExecutionRunnerSwitched{Switched: true})
				_ = deliverDaemonResponse[wsExecutionRunnerSwitched](connection, wsEnvelope{ID: envelope.ID, Type: wsExecutionRunnerSwitchedType, Payload: payload}, nil)
				return
			}
		}
	}()
	body := `{"turns":[{"sessionId":"sess_a","inputId":"in_a"},{"sessionId":"sess_bg","background":true}]}`
	requestForTest(t, fixture.server, http.MethodPost, path, body, http.StatusConflict)
	select {
	case <-asked:
		t.Fatal("a changed list must not reach the worker's switch")
	default:
	}
	requestForTest(t, fixture.server, http.MethodPost, path, body, http.StatusOK)
	if sent := string(<-asked); !strings.Contains(sent, `"sess_a"`) || strings.Contains(sent, "sess_bg") {
		t.Fatalf("asked the worker to stop %s; want only the reviewed turn", sent)
	}
}
