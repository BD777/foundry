package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/sqlitestore"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

const setupCommand = "curl -fsSL https://gateway.example/install.sh | sh -s -- --profile default"

func registerSetupDevice(t *testing.T, backing *sqlitestore.Store, deviceID, label string, profiles ...store.AgentProfileProjection) {
	t.Helper()
	registration := store.DaemonRegistration{
		Device:        store.DeviceProjection{ID: deviceID, Label: label, Status: "connected", System: &store.DeviceSystem{Hostname: label, OS: "Debian GNU/Linux", Arch: "x64", User: "person"}},
		Workspace:     store.WorkspaceProjection{ID: "ws_" + deviceID, Name: label, LocalPath: t.TempDir()},
		AgentProfiles: profiles,
	}
	if err := backing.RegisterDaemon(context.Background(), registration); err != nil {
		t.Fatalf("register daemon: %v", err)
	}
}

func setupSource(command, at string) store.AgentProfileProjection {
	return store.AgentProfileProjection{
		ID: "company", Runtime: "claude", ConnectionType: "external", Label: "Company", Status: "healthy",
		Model: "sonnet", Models: []string{"sonnet", "haiku"}, Check: &store.AgentProfileCheck{Status: "passed"},
		ExternalSetup: &store.ExternalConnectionSetupInfo{Command: command, SignIn: "device_code", RegisteredAt: at},
	}
}

// attachSetupWorker connects deviceID's worker; answer returns the payload
// for each request it is sent.
func attachSetupWorker(t *testing.T, server *Server, deviceID string, capabilities []string, answer func(wsEnvelope) string) chan wsEnvelope {
	t.Helper()
	connection := newDaemonConnection(server.hub, nil)
	connection.registration = store.DaemonRegistration{Capabilities: capabilities}
	server.hub.mu.Lock()
	server.hub.connections[deviceID] = connection
	server.hub.mu.Unlock()
	t.Cleanup(func() {
		server.hub.mu.Lock()
		delete(server.hub.connections, deviceID)
		server.hub.mu.Unlock()
		close(connection.done)
	})
	asked := make(chan wsEnvelope, 16)
	go func() {
		for {
			select {
			case envelope := <-connection.send:
				asked <- envelope
				_ = deliverDaemonResponse[json.RawMessage](connection, wsEnvelope{ID: envelope.ID, Payload: json.RawMessage(answer(envelope))}, nil)
			case <-connection.done:
				return
			}
		}
	}()
	return asked
}

func setupServer(t *testing.T) *Server {
	t.Helper()
	backing := newEmptyTestStore(t)
	registerSetupDevice(t, backing, "dev_1", "laptop", setupSource(setupCommand, "2026-10-29T08:00:00Z"))
	registerSetupDevice(t, backing, "dev_2", "server")
	return NewServer(backing)
}

func TestExternalConnectionOffersComeFromTheOwnersOtherDevices(t *testing.T) {
	server := setupServer(t)
	response := requestForTest(t, server, http.MethodGet, "/api/devices/dev_2/external-connection-setups", "", http.StatusOK)
	var list struct {
		Offers []externalConnectionOffer `json:"offers"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &list); err != nil {
		t.Fatal(err)
	}
	if len(list.Offers) != 1 {
		t.Fatalf("offers = %+v", list.Offers)
	}
	offer := list.Offers[0]
	if offer.ProfileID != "company" || offer.Stage != "not_set_up" || offer.Setup == nil || offer.Setup.Command != setupCommand ||
		offer.SetupDigest != externalSetupDigest(setupCommand) || offer.SetupSource == nil || offer.SetupSource.Label != "laptop" ||
		len(offer.SourceDevices) != 1 || offer.SourceDevices[0].ID != "dev_1" {
		t.Fatalf("offer = %+v", offer)
	}
	// On the device that has it, the same connection is simply ready.
	response = requestForTest(t, server, http.MethodGet, "/api/devices/dev_1/external-connection-setups", "", http.StatusOK)
	_ = json.Unmarshal(response.Body.Bytes(), &list)
	if len(list.Offers) != 1 || list.Offers[0].Stage != "ready" {
		t.Fatalf("own offers = %+v", list.Offers)
	}
}

func TestExternalConnectionOffersShowTheNewestCommandAndListOthers(t *testing.T) {
	backing := newEmptyTestStore(t)
	registerSetupDevice(t, backing, "dev_1", "laptop", setupSource("install --old", "2026-10-28T08:00:00Z"))
	registerSetupDevice(t, backing, "dev_3", "desktop", setupSource("install --new", "2026-10-29T08:00:00Z"))
	registerSetupDevice(t, backing, "dev_2", "server")
	server := NewServer(backing)
	response := requestForTest(t, server, http.MethodGet, "/api/devices/dev_2/external-connection-setups", "", http.StatusOK)
	var list struct {
		Offers []externalConnectionOffer `json:"offers"`
	}
	_ = json.Unmarshal(response.Body.Bytes(), &list)
	offer := list.Offers[0]
	if offer.Setup.Command != "install --new" || offer.SetupSource.DeviceID != "dev_3" ||
		len(offer.OtherSetups) != 1 || offer.OtherSetups[0].Command != "install --old" || offer.OtherSetups[0].Label != "laptop" {
		t.Fatalf("offer = %+v", offer)
	}
}

func TestExternalConnectionSetupDetailReadsTheDeviceLive(t *testing.T) {
	server := setupServer(t)
	// Offline: what the device last reported, and why it cannot run there.
	response := requestForTest(t, server, http.MethodGet, "/api/devices/dev_2/external-connection-setups/company", "", http.StatusOK)
	var detail externalConnectionSetupDetail
	_ = json.Unmarshal(response.Body.Bytes(), &detail)
	if detail.Live || detail.Remote.Available || detail.Remote.Reason != "offline" || detail.Device.User != "person" || detail.Offer.Stage != "not_set_up" {
		t.Fatalf("offline detail = %+v", detail)
	}

	asked := attachSetupWorker(t, server, "dev_2", []string{externalConnectionSetupCapability}, func(envelope wsEnvelope) string {
		return `{"remoteCommands":true,"progress":{"profileId":"company","state":"waiting_sign_in","updatedAt":"2026-10-29T09:00:00Z","signInUrl":"https://gateway.example/device","userCode":"ABCD-1234"},
			"run":{"runId":"setup_1","profileId":"company","state":"running","startedAt":"2026-10-29T08:59:00Z","output":"open the page","offset":0,"nextOffset":13}}`
	})
	response = requestForTest(t, server, http.MethodGet, "/api/devices/dev_2/external-connection-setups/company?runId=setup_1&after=5", "", http.StatusOK)
	envelope := <-asked
	var read wsReadExternalConnectionSetup
	_ = json.Unmarshal(envelope.Payload, &read)
	if envelope.Type != wsReadExternalConnectionSetupType || read.ProfileID != "company" || read.RunID != "setup_1" || read.After != 5 {
		t.Fatalf("asked %s %+v", envelope.Type, read)
	}
	detail = externalConnectionSetupDetail{}
	_ = json.Unmarshal(response.Body.Bytes(), &detail)
	if !detail.Live || !detail.Remote.Available || detail.Offer.Stage != "waiting_sign_in" || detail.Progress.UserCode != "ABCD-1234" || detail.Run.Output != "open the page" {
		t.Fatalf("live detail = %+v", detail)
	}
	// The picker remembers the step, without the run's output.
	response = requestForTest(t, server, http.MethodGet, "/api/devices/dev_2/external-connection-setups", "", http.StatusOK)
	if !strings.Contains(response.Body.String(), `"stage":"waiting_sign_in"`) || strings.Contains(response.Body.String(), "open the page") {
		t.Fatalf("picker = %s", response.Body.String())
	}
}

func TestExternalConnectionSetupStagesFollowRegistrationAndCheck(t *testing.T) {
	failed := "failed"
	for _, tc := range []struct {
		name     string
		live     *externalConnectionLiveState
		progress *externalConnectionSetupProgress
		run      *externalConnectionSetupRun
		stage    string
	}{
		{"nothing yet", nil, nil, nil, "not_set_up"},
		{"installer running", nil, nil, &externalConnectionSetupRun{State: "running"}, "in_progress"},
		{"installed", nil, &externalConnectionSetupProgress{State: "installed"}, nil, "in_progress"},
		{"setup failed", nil, &externalConnectionSetupProgress{State: failed, Message: "no network"}, nil, "setup_failed"},
		{"run failed", nil, nil, &externalConnectionSetupRun{State: "failed"}, "setup_failed"},
		// Without any progress report, registration and check move it on.
		{"registered", &externalConnectionLiveState{HelperAvailable: true, Check: externalConnectionCheck{Status: "unchecked"}}, nil, nil, "unchecked"},
		{"check failed", &externalConnectionLiveState{HelperAvailable: true, Check: externalConnectionCheck{Status: failed, Message: "quota"}}, nil, nil, "check_failed"},
		{"ready", &externalConnectionLiveState{HelperAvailable: true, Check: externalConnectionCheck{Status: "passed"}}, &externalConnectionSetupProgress{State: "waiting_sign_in"}, nil, "ready"},
		{"helper missing", &externalConnectionLiveState{Check: externalConnectionCheck{Status: "passed"}}, nil, nil, "not_set_up"},
	} {
		stage, _ := externalSetupStage(nil, tc.live, tc.progress, tc.run)
		if stage != tc.stage {
			t.Errorf("%s: stage = %s, want %s", tc.name, stage, tc.stage)
		}
	}
}

func TestExternalConnectionSetupRunsOnlyTheShownCommand(t *testing.T) {
	server := setupServer(t)
	run := "/api/devices/dev_2/external-connection-setups/company/run"
	digest := externalSetupDigest(setupCommand)
	requestForTest(t, server, http.MethodPost, run, `{"digest":"`+digest+`"}`, http.StatusConflict) // offline
	attachSetupWorker(t, server, "dev_2", nil, func(wsEnvelope) string { return `{}` })
	requestForTest(t, server, http.MethodPost, run, `{"digest":"`+digest+`"}`, http.StatusConflict) // old worker
	server.hub.mu.Lock()
	delete(server.hub.connections, "dev_2")
	server.hub.mu.Unlock()

	asked := attachSetupWorker(t, server, "dev_2", []string{externalConnectionSetupCapability}, func(envelope wsEnvelope) string {
		return `{"run":{"runId":"setup_1","profileId":"company","state":"running","startedAt":"2026-10-29T09:00:00Z","output":"","offset":0,"nextOffset":0}}`
	})
	// A command registered after the panel loaded is not run.
	requestForTest(t, server, http.MethodPost, run, `{"digest":"`+externalSetupDigest("something else")+`"}`, http.StatusConflict)
	if len(asked) != 0 {
		t.Fatal("a stale digest reached the device")
	}
	requestForTest(t, server, http.MethodPost, run, `{"digest":"`+digest+`"}`, http.StatusOK)
	envelope := <-asked
	var start wsStartExternalConnectionSetup
	_ = json.Unmarshal(envelope.Payload, &start)
	if envelope.Type != wsStartExternalConnectionSetupType || start.ProfileID != "company" || start.Command != setupCommand {
		t.Fatalf("asked %s %+v", envelope.Type, start)
	}
	// The body cannot supply a command of its own.
	requestForTest(t, server, http.MethodPost, run, `{"digest":"`+digest+`","command":"rm -rf ~"}`, http.StatusBadRequest)
}

func TestExternalConnectionSetupRefusalsKeepTheirMeaning(t *testing.T) {
	server := setupServer(t)
	attachSetupWorker(t, server, "dev_2", []string{externalConnectionSetupCapability}, func(wsEnvelope) string {
		return `{"error":"Remote commands are off on this device","errorCode":"remote_commands_off"}`
	})
	response := requestForTest(t, server, http.MethodPost, "/api/devices/dev_2/external-connection-setups/company/run",
		`{"digest":"`+externalSetupDigest(setupCommand)+`"}`, http.StatusConflict)
	if !strings.Contains(response.Body.String(), "Remote commands are off") {
		t.Fatalf("refusal = %s", response.Body.String())
	}
	requestForTest(t, server, http.MethodGet, "/api/devices/dev_2/external-connection-setups/unknown", "", http.StatusNotFound)
}

// Only the device's owner sees offers, progress and output, or runs setup.
func TestExternalConnectionSetupIsTheDeviceOwners(t *testing.T) {
	f := newIsolationFixture(t)
	for _, call := range []struct{ method, path string }{
		{http.MethodGet, "/api/devices/dev_alice/external-connection-setups"},
		{http.MethodGet, "/api/devices/dev_alice/external-connection-setups/company"},
		{http.MethodPost, "/api/devices/dev_alice/external-connection-setups/company/run"},
		{http.MethodDelete, "/api/devices/dev_alice/external-connection-setups/company/run?runId=x"},
	} {
		if code := doAuthCall(t, f.handler, f.as(f.bob, call.method, call.path, "")).Code; code != http.StatusNotFound {
			t.Fatalf("bob %s %s: %d", call.method, call.path, code)
		}
	}
}

// The worker's answers are routed to the waiting request; without these
// entries a real worker's answer was dropped as an unknown message.
func TestExternalConnectionAnswersAreKnownMessages(t *testing.T) {
	for _, kind := range []string{
		wsExternalConnectionCheckedType, wsExternalConnectionRemovedType,
		wsExternalConnectionSetupReadType, wsExternalConnectionSetupStartedType, wsExternalConnectionSetupCancelledType,
	} {
		if inboundHandlers[kind] == nil {
			t.Errorf("%s has no inbound handler", kind)
		}
	}
}
