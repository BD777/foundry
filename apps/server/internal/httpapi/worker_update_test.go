package httpapi

import (
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
	updates.start("dev", store.DeviceWorkerUpdate{StartedAt: now.Format(time.RFC3339), Version: "0.5.8"})
	if _, ok := updates.active("dev", "0.5.7", now); !ok {
		t.Fatal("the old version still runs: the update is in progress")
	}
	if _, ok := updates.active("dev", "0.5.8", now); ok {
		t.Fatal("the device runs the new version: the update is over")
	}
	updates.start("dev", store.DeviceWorkerUpdate{StartedAt: now.Format(time.RFC3339), Version: "0.5.9"})
	if _, ok := updates.active("dev", "0.5.8", now.Add(workerUpdateWindow)); ok {
		t.Fatal("past its window an update no longer counts as running")
	}
}
