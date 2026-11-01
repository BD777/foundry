package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"github.com/gorilla/websocket"
)

func listResourcesForTest(t *testing.T, server *Server, query string) store.ResourceList {
	t.Helper()
	request := httptest.NewRequest(http.MethodGet, "/api/resources"+query, nil)
	response := httptest.NewRecorder()
	server.Routes().ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("GET /api/resources%s: %d %s", query, response.Code, response.Body.String())
	}
	var list store.ResourceList
	if err := json.NewDecoder(response.Body).Decode(&list); err != nil {
		t.Fatal(err)
	}
	return list
}

// readUntilForTest reads envelopes until one of type want arrives.
func readUntilForTest(t *testing.T, conn *websocket.Conn, want string) {
	t.Helper()
	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	defer func() { _ = conn.SetReadDeadline(time.Time{}) }()
	for {
		var envelope struct {
			Type string `json:"type"`
		}
		if err := conn.ReadJSON(&envelope); err != nil {
			t.Fatalf("waiting for %s: %v", want, err)
		}
		if envelope.Type == want {
			return
		}
	}
}

func waitForResources(t *testing.T, server *Server, query string, ok func(store.ResourceList) bool) store.ResourceList {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		list := listResourcesForTest(t, server, query)
		if ok(list) {
			return list
		}
		if time.Now().After(deadline) {
			t.Fatalf("resources never became as expected: %+v", list)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// A worker that declares resources_v1 reports its inventory; the server
// keeps it per device, lists it by type and device, and lists it offline
// once the device disconnects.
func TestDeviceResourcesReportIsListed(t *testing.T) {
	db := newTestStore(t)
	registerMacWorkspaces(t, db)
	server := NewServer(db)
	httpServer := httptest.NewServer(server.Routes())
	t.Cleanup(httpServer.Close)
	conn := dialDaemonForTest(t, httpServer)
	writeWSForTest(t, conn, "hello", macHello([]string{store.DaemonCapabilityResources}, nil))
	readWSTypeForTest(t, conn, "registered")

	writeWSIDForTest(t, conn, "report_1", wsResourcesReportType, store.ResourcesReport{
		ScannerVersion: 1,
		Instances: []store.DetectedResource{
			{Key: "toolchain/git", Type: "toolchain", Platform: "macos", Name: "git", Detector: "toolchain@1",
				Readiness: store.ResourceReadiness{Ready: true, Level: "installed"}, Details: map[string]string{"version": "2.45.0"}},
			{Key: "simulator/ios/ABC", Type: "simulator", Platform: "ios", Name: "iPhone 16", Detector: "simulator.ios@1",
				Readiness: store.ResourceReadiness{Ready: false, Level: "installed", Reason: "Shutdown"}},
		},
		DetectorErrors: []store.ResourceDetectorError{{Detector: "gpu@1", Type: "gpu", Error: "timeout after 3000ms"}},
	})
	readUntilForTest(t, conn, wsAckType)

	list := listResourcesForTest(t, server, "")
	if len(list.Instances) != 2 || len(list.Sources) != 1 || !list.Sources[0].Online || list.Sources[0].Label != "mac-desktop" {
		t.Fatalf("list = %+v", list)
	}
	if errors := list.Sources[0].DetectorErrors; len(errors) != 1 || errors[0].Detector != "gpu@1" {
		t.Fatalf("detector errors = %+v", errors)
	}
	simulators := listResourcesForTest(t, server, "?type=simulator&device=dev_mac")
	if len(simulators.Instances) != 1 || simulators.Instances[0].State != store.ResourceUnready || simulators.Instances[0].StateReason != "Shutdown" {
		t.Fatalf("simulators = %+v", simulators.Instances)
	}
	if other := listResourcesForTest(t, server, "?device=dev_other"); len(other.Instances) != 0 || len(other.Sources) != 0 {
		t.Fatalf("another device lists %+v", other)
	}

	conn.Close()
	waitForResources(t, server, "", func(list store.ResourceList) bool {
		return len(list.Instances) == 2 && list.Instances[0].State == store.ResourceOffline && !list.Sources[0].Online
	})
}
