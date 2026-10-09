package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func TestUpdateWorkerAsksACapableConnectedWorker(t *testing.T) {
	fixture := setupProjectedSessionFixture(t)
	path := "/api/devices/" + fixture.deviceID + "/worker/update"
	requestForTest(t, fixture.server, http.MethodPost, path, `{}`, http.StatusConflict)

	connection := newDaemonConnection(fixture.server.hub, nil)
	fixture.server.hub.connections[fixture.deviceID] = connection
	defer close(connection.done)
	// A worker that does not declare the capability is told to update by hand.
	requestForTest(t, fixture.server, http.MethodPost, path, `{}`, http.StatusConflict)

	connection.registration = store.DaemonRegistration{Capabilities: []string{workerUpdateCapability}}
	asked := make(chan string, 1)
	go func() {
		for envelope := range connection.send {
			asked <- envelope.Type
			payload, _ := json.Marshal(wsWorkerUpdateStarted{Log: "/state/logs/self-update.log"})
			_ = deliverDaemonResponse[wsWorkerUpdateStarted](connection, wsEnvelope{ID: envelope.ID, Type: wsWorkerUpdateStartedType, Payload: payload}, nil)
			return
		}
	}()
	response := requestForTest(t, fixture.server, http.MethodPost, path, `{}`, http.StatusAccepted)
	if kind := <-asked; kind != wsUpdateWorkerType {
		t.Fatalf("asked %q, want %q", kind, wsUpdateWorkerType)
	}
	if !json.Valid(response.Body.Bytes()) {
		t.Fatalf("body = %s", response.Body.String())
	}
	// The update is in progress until the device reports the new version:
	// a second request is refused, and devices carry it for every page.
	requestForTest(t, fixture.server, http.MethodPost, path, `{}`, http.StatusConflict)
	devices := fixture.server.withWorkerUpdates([]store.DeviceProjection{{ID: fixture.deviceID}})
	if devices[0].WorkerUpdate == nil || devices[0].WorkerUpdate.StartedAt == "" {
		t.Fatalf("device projection = %+v, want the update in progress", devices[0])
	}
}

func TestWorkerUpdateEndsWhenTheDeviceReportsItsVersion(t *testing.T) {
	var updates workerUpdates
	now := time.Now().UTC()
	updates.start("dev", store.DeviceWorkerUpdate{StartedAt: now.Format(time.RFC3339), Version: "0.5.8", FromVersion: "0.5.7"})
	if update, ok := updates.active("dev", "0.5.7", now); !ok || update.Stalled {
		t.Fatal("the old version still runs: the update is in progress")
	}
	if _, ok := updates.active("dev", "0.5.8", now); ok {
		t.Fatal("the device runs the new version: the update is over")
	}
	// An update that never finishes stays visible as stalled, and may be
	// started again.
	updates.start("dev", store.DeviceWorkerUpdate{StartedAt: now.Format(time.RFC3339), Version: "0.5.9", FromVersion: "0.5.8"})
	update, ok := updates.active("dev", "0.5.8", now.Add(workerUpdateWindow))
	if !ok || !update.Stalled {
		t.Fatalf("past its window the update = %+v, %v; want it shown as stalled", update, ok)
	}
	// The device came back on some other version: the update is over.
	if _, ok := updates.active("dev", "0.5.8-local", now.Add(workerUpdateWindow)); ok {
		t.Fatal("a device on another version still shows the update")
	}
}

// fakeUpdatingWorker answers the update request and then each status probe
// with the next of statuses (the last one repeats); it reports what it was
// asked on asked.
func fakeUpdatingWorker(connection *daemonConnection, statuses []wsWorkerUpdateStatus, asked chan<- string) {
	probes := 0
	for envelope := range connection.send {
		asked <- envelope.Type
		switch envelope.Type {
		case wsUpdateWorkerType:
			payload, _ := json.Marshal(wsWorkerUpdateStarted{Log: "/state/logs/self-update.log"})
			_ = deliverDaemonResponse[wsWorkerUpdateStarted](connection, wsEnvelope{ID: envelope.ID, Type: wsWorkerUpdateStartedType, Payload: payload}, nil)
		case wsReadWorkerUpdateStatusType:
			status := statuses[min(probes, len(statuses)-1)]
			probes++
			payload, _ := json.Marshal(status)
			_ = deliverDaemonResponse[wsWorkerUpdateStatus](connection, wsEnvelope{ID: envelope.ID, Type: wsWorkerUpdateStatusType, Payload: payload}, nil)
		}
	}
}

func connectProbingWorker(t *testing.T, fixture projectedSessionFixture, capabilities ...string) *daemonConnection {
	t.Helper()
	connection := newDaemonConnection(fixture.server.hub, nil)
	connection.deviceID = fixture.deviceID
	connection.registration = store.DaemonRegistration{
		Capabilities: capabilities,
		Device:       store.DeviceProjection{ID: fixture.deviceID, Worker: &store.DeviceWorker{Version: "0.5.7"}},
	}
	fixture.server.hub.mu.Lock()
	fixture.server.hub.connections[fixture.deviceID] = connection
	fixture.server.hub.mu.Unlock()
	fixture.server.workerUpdates.probeInterval = 10 * time.Millisecond
	fixture.server.workerUpdates.returnGrace = 50 * time.Millisecond
	return connection
}

func waitForWorkerUpdate(t *testing.T, server *Server, deviceID string, done func(*store.DeviceWorkerUpdate) bool) *store.DeviceWorkerUpdate {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		update := server.withWorkerUpdates([]store.DeviceProjection{{ID: deviceID, Worker: &store.DeviceWorker{Version: "0.5.7"}}})[0].WorkerUpdate
		if update != nil && done(update) {
			return update
		}
		if time.Now().After(deadline) {
			t.Fatalf("worker update = %+v; condition never met", update)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func TestWorkerUpdateProbeShowsTheStepAndFailsAtOnce(t *testing.T) {
	fixture := setupProjectedSessionFixture(t)
	connection := connectProbingWorker(t, fixture, workerUpdateCapability, workerUpdateStatusCapability)
	defer close(connection.done)
	exit := 1
	asked := make(chan string, 64)
	go fakeUpdatingWorker(connection, []wsWorkerUpdateStatus{
		{State: "running", Step: "downloading", Version: "0.5.8"},
		{State: "running", Step: "checking", Detail: "connect timeout; trying again in 5 s"},
		{State: "failed", Step: "checking", ExitCode: &exit, Error: "could not ask the server which worker it serves", LogTail: []string{"ERROR [E5001] COMMAND_FAILED"}},
	}, asked)
	path := "/api/devices/" + fixture.deviceID + "/worker/update"
	requestForTest(t, fixture.server, http.MethodPost, path, `{}`, http.StatusAccepted)

	waitForWorkerUpdate(t, fixture.server, fixture.deviceID, func(update *store.DeviceWorkerUpdate) bool {
		return update.Step == "downloading" || update.Step == "checking"
	})
	failed := waitForWorkerUpdate(t, fixture.server, fixture.deviceID, func(update *store.DeviceWorkerUpdate) bool {
		return update.Failure != ""
	})
	if failed.FailureCode != workerUpdateFailedExited || failed.ExitCode == nil || *failed.ExitCode != 1 || len(failed.LogTail) != 1 || failed.Step != "checking" || failed.Stalled {
		t.Fatalf("failed update = %+v", failed)
	}
	// A failed update may be started again at once.
	requestForTest(t, fixture.server, http.MethodPost, path, `{}`, http.StatusAccepted)
}

func TestWorkerUpdateThatEndsWithoutAWordFails(t *testing.T) {
	fixture := setupProjectedSessionFixture(t)
	connection := connectProbingWorker(t, fixture, workerUpdateCapability, workerUpdateStatusCapability)
	defer close(connection.done)
	asked := make(chan string, 64)
	go fakeUpdatingWorker(connection, []wsWorkerUpdateStatus{{State: "none", Step: "installing"}}, asked)
	requestForTest(t, fixture.server, http.MethodPost, "/api/devices/"+fixture.deviceID+"/worker/update", `{}`, http.StatusAccepted)
	failed := waitForWorkerUpdate(t, fixture.server, fixture.deviceID, func(update *store.DeviceWorkerUpdate) bool {
		return update.Failure != ""
	})
	if failed.FailureCode != workerUpdateFailedVanished || failed.Step != "installing" {
		t.Fatalf("failed update = %+v", failed)
	}
}

func TestWorkerUpdateFailsWhenTheWorkerDoesNotComeBack(t *testing.T) {
	fixture := setupProjectedSessionFixture(t)
	connection := connectProbingWorker(t, fixture, workerUpdateCapability, workerUpdateStatusCapability)
	defer close(connection.done)
	asked := make(chan string, 64)
	go fakeUpdatingWorker(connection, []wsWorkerUpdateStatus{{State: "succeeded", Step: "restarting"}}, asked)
	requestForTest(t, fixture.server, http.MethodPost, "/api/devices/"+fixture.deviceID+"/worker/update", `{}`, http.StatusAccepted)
	waitForWorkerUpdate(t, fixture.server, fixture.deviceID, func(update *store.DeviceWorkerUpdate) bool {
		return update.Step == "restarting"
	})
	// The worker restarts and never reconnects.
	fixture.server.hub.mu.Lock()
	delete(fixture.server.hub.connections, fixture.deviceID)
	fixture.server.hub.mu.Unlock()
	failed := waitForWorkerUpdate(t, fixture.server, fixture.deviceID, func(update *store.DeviceWorkerUpdate) bool {
		return update.Failure != ""
	})
	if failed.FailureCode != workerUpdateFailedNotBack || failed.Step != "restarting" {
		t.Fatalf("failed update = %+v", failed)
	}
}

func TestWorkerUpdateOfAnOlderWorkerIsNotProbed(t *testing.T) {
	fixture := setupProjectedSessionFixture(t)
	connection := connectProbingWorker(t, fixture, workerUpdateCapability)
	defer close(connection.done)
	asked := make(chan string, 64)
	go fakeUpdatingWorker(connection, []wsWorkerUpdateStatus{{State: "none"}}, asked)
	requestForTest(t, fixture.server, http.MethodPost, "/api/devices/"+fixture.deviceID+"/worker/update", `{}`, http.StatusAccepted)
	if kind := <-asked; kind != wsUpdateWorkerType {
		t.Fatalf("asked %q", kind)
	}
	select {
	case kind := <-asked:
		t.Fatalf("an older worker was asked %q", kind)
	case <-time.After(100 * time.Millisecond):
	}
	update := waitForWorkerUpdate(t, fixture.server, fixture.deviceID, func(*store.DeviceWorkerUpdate) bool { return true })
	if update.Failure != "" {
		t.Fatalf("update = %+v; an older worker keeps the window", update)
	}
}

func TestWorkerReportsAFailedUpdateUnasked(t *testing.T) {
	fixture := setupProjectedSessionFixture(t)
	connection := connectProbingWorker(t, fixture, workerUpdateCapability, workerUpdateStatusCapability)
	defer close(connection.done)
	// Probes go unanswered; the worker's own report ends the update.
	fixture.server.workerUpdates.probeInterval = time.Hour
	go func() {
		for envelope := range connection.send {
			if envelope.Type == wsUpdateWorkerType {
				payload, _ := json.Marshal(wsWorkerUpdateStarted{})
				_ = deliverDaemonResponse[wsWorkerUpdateStarted](connection, wsEnvelope{ID: envelope.ID, Type: wsWorkerUpdateStartedType, Payload: payload}, nil)
			}
		}
	}()
	requestForTest(t, fixture.server, http.MethodPost, "/api/devices/"+fixture.deviceID+"/worker/update", `{}`, http.StatusAccepted)
	payload, _ := json.Marshal(wsWorkerUpdateStatus{State: "failed", Step: "downloading", Error: "npm could not install"})
	if err := connection.handleEnvelope(context.Background(), wsEnvelope{ID: "unasked", Type: wsWorkerUpdateStatusType, Payload: payload}); err != nil {
		t.Fatal(err)
	}
	update := waitForWorkerUpdate(t, fixture.server, fixture.deviceID, func(update *store.DeviceWorkerUpdate) bool { return update.Failure != "" })
	if update.Failure != "npm could not install" || update.Step != "downloading" {
		t.Fatalf("update = %+v", update)
	}
}
