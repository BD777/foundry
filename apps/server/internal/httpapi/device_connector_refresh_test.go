package httpapi

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// A device that connects again has the device-held connectors it has a
// stored reading of read again, so a warning its previous Worker reported
// does not wait for the owner to check: at once for a new Worker version,
// and otherwise not more than once per deviceConnectorRefreshEvery.
func TestDeviceConnectorsAreReadAgainWhenTheDeviceConnects(t *testing.T) {
	f := newIsolationFixture(t)
	httpServer := httptest.NewServer(f.handler)
	defer httpServer.Close()
	worker := &fakeConnectorWorker{t: t, signedIn: true, expires: time.Now().Add(48 * time.Hour), workerVersion: "1.0.0"}
	connect := func() {
		t.Helper()
		worker.connect(httpServer.URL, f.aliceDevice)
		waitFor(t, "the device to connect", func() bool { return f.server.hub.HasConnection("dev_alice") })
	}
	reconnect := func() {
		t.Helper()
		worker.disconnect()
		waitFor(t, "the device to go", func() bool { return !f.server.hub.HasConnection("dev_alice") })
		connect()
	}
	reads := func(want int) {
		t.Helper()
		waitFor(t, "the status reads", func() bool { return worker.count("status") >= want })
		// Nothing more arrives after the expected reads.
		time.Sleep(300 * time.Millisecond)
		if got := worker.count("status"); got != want {
			t.Fatalf("status reads = %d, want %d", got, want)
		}
	}

	// The first connection has nothing stored to read again; the page reads.
	connect()
	time.Sleep(300 * time.Millisecond)
	if got := worker.count("status"); got != 0 {
		t.Fatalf("status reads before the page = %d, want 0", got)
	}
	recorder := doAuthCall(t, f.handler, f.as(f.alice, http.MethodGet, "/api/connectors/devices?refresh=1", ""))
	expectStatus(t, recorder, http.StatusOK, "connectors page")
	reads(5)

	// The Worker restarts: every stored connector is read again.
	reconnect()
	reads(10)
	// Again within the interval, same build: no more reads.
	reconnect()
	reads(10)
	// A new Worker build reads at once.
	worker.workerVersion = "1.0.1"
	reconnect()
	reads(15)
	worker.disconnect()
}

func TestDeviceConnectorRefreshIsDueOnANewVersionOrAfterTheInterval(t *testing.T) {
	var refreshes deviceConnectorRefreshes
	now := time.Now()
	if !refreshes.due("dev_a", "1", now) {
		t.Fatal("first connection should be due")
	}
	if refreshes.due("dev_a", "1", now.Add(time.Minute)) {
		t.Fatal("same version within the interval should not be due")
	}
	if !refreshes.due("dev_b", "1", now.Add(time.Minute)) {
		t.Fatal("another device keeps its own interval")
	}
	if !refreshes.due("dev_a", "2", now.Add(2*time.Minute)) {
		t.Fatal("a new version should be due at once")
	}
	if !refreshes.due("dev_a", "2", now.Add(2*time.Minute+deviceConnectorRefreshEvery)) {
		t.Fatal("the same version should be due after the interval")
	}
}
