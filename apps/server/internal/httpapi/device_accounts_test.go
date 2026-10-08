package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func TestDeviceAccountRequestsRejectUnknownOfflineAndInvalidTargets(t *testing.T) {
	backing := newEmptyTestStore(t)
	registerPromotionDaemon(t, backing, store.AgentProfileProjection{ID: "codex_local", Runtime: "codex"})
	server := NewServer(backing)
	requestForTest(t, server, http.MethodPost, "/api/devices/unknown/accounts/codex/inspect", `{}`, http.StatusNotFound)
	requestForTest(t, server, http.MethodPost, "/api/devices/dev_1/accounts/codex/inspect", `{}`, http.StatusConflict)
	requestForTest(t, server, http.MethodPost, "/api/devices/dev_1/accounts/other/inspect", `{}`, http.StatusBadRequest)
	requestForTest(t, server, http.MethodPost, "/api/devices/unknown/accounts/codex/inspect", `{}`, http.StatusNotFound)
	requestForTest(t, server, http.MethodPost, "/api/devices/dev_1/accounts/codex/inspect", `{}`, http.StatusConflict)
	requestForTest(t, server, http.MethodPost, "/api/devices/dev_1/accounts/other/inspect", `{}`, http.StatusBadRequest)
	requestForTest(t, server, http.MethodPost, "/api/devices/unknown/accounts/claude/install", `{}`, http.StatusNotFound)
	requestForTest(t, server, http.MethodPost, "/api/devices/dev_1/accounts/claude/install", `{}`, http.StatusConflict)
	requestForTest(t, server, http.MethodPost, "/api/devices/dev_1/accounts/other/install", `{}`, http.StatusBadRequest)
}

func TestNativeCliInstallRunsOnTheDeviceAndReturnsItsResult(t *testing.T) {
	backing := newEmptyTestStore(t)
	registerPromotionDaemon(t, backing, store.AgentProfileProjection{ID: "codex_local", Runtime: "codex"})
	server := NewServer(backing)
	connection := newDaemonConnection(server.hub, nil)
	server.hub.connections["dev_1"] = connection
	defer close(connection.done)
	go func() {
		envelope := <-connection.send
		if envelope.Type != wsInstallNativeCliType {
			t.Errorf("wrong operation: %s", envelope.Type)
		}
		var input map[string]string
		_ = json.Unmarshal(envelope.Payload, &input)
		if input["runtime"] != "claude" {
			t.Errorf("wrong install target: %+v", input)
		}
		payload := json.RawMessage(`{"result":{"runtime":"claude","ok":true,"command":"official","log":"done","cli":{"installed":true,"version":"2.1.288","outdated":false,"installCommand":"official","updateCommand":"claude update"}}}`)
		_ = deliverDaemonResponse[wsNativeCliInstallResult](connection, wsEnvelope{ID: envelope.ID, Payload: payload}, nil)
	}()
	response := requestForTest(t, server, http.MethodPost, "/api/devices/dev_1/accounts/claude/install", `{}`, http.StatusOK)
	var result store.NativeCliInstallResult
	if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if !result.OK || result.Cli == nil || result.Cli.Version != "2.1.288" {
		t.Fatalf("install result not returned: %+v", result)
	}
}

func TestNativeAccountInspectionIsDeviceScopedAndDoesNotChangeProfiles(t *testing.T) {
	backing := newEmptyTestStore(t)
	registerPromotionDaemon(t, backing, store.AgentProfileProjection{ID: "codex_local", Runtime: "codex"})
	server := NewServer(backing)
	connection := newDaemonConnection(server.hub, nil)
	server.hub.connections["dev_1"] = connection
	defer close(connection.done)
	go func() {
		envelope := <-connection.send
		if envelope.Type != wsInspectNativeAccountType {
			t.Errorf("wrong operation: %s", envelope.Type)
		}
		var input map[string]string
		_ = json.Unmarshal(envelope.Payload, &input)
		if input["runtime"] != "codex" || input["source"] != "/native" {
			t.Errorf("wrong inspection target: %+v", input)
		}
		payload := json.RawMessage(`{"result":{"status":"verified","source":"/native","usage":[]}}`)
		_ = deliverDaemonResponse[wsNativeAccountInspectionResult](connection, wsEnvelope{ID: envelope.ID, Payload: payload}, nil)
	}()
	requestForTest(t, server, http.MethodPost, "/api/devices/dev_1/accounts/codex/inspect", `{"source":"/native"}`, http.StatusOK)
	profiles, _ := backing.ListProfiles(context.Background())
	if len(profiles) != 0 {
		t.Fatal("inspection created a profile")
	}
}

func TestWorkspaceSnapshotIncludesOtherDevicesWithoutTheirWorkspaceData(t *testing.T) {
	backing := newEmptyTestStore(t)
	for _, id := range []string{"one", "two"} {
		err := backing.RegisterDaemon(context.Background(), store.DaemonRegistration{
			Device:         store.DeviceProjection{ID: "dev_" + id, Label: id, Status: "connected"},
			Workspace:      store.WorkspaceProjection{ID: "ws_" + id, Name: id, LocalPath: t.TempDir()},
			AgentProfiles:  []store.AgentProfileProjection{{ID: "codex_local", DeviceID: "dev_" + id, Runtime: "codex", Origin: "device", ConnectionType: "local_login"}},
			ProviderHealth: []store.ProviderHealth{{Provider: "codex", Status: "missing_auth"}},
		})
		if err != nil {
			t.Fatal(err)
		}
	}
	server := NewServer(backing)
	snapshot, err := server.foundryData(context.Background(), "ws_one", visibility{scope: accessScope{all: true}})
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.Workspace.ID != "ws_one" || len(snapshot.AgentProfiles) != 2 || len(snapshot.ProviderHealth) != 2 {
		t.Fatalf("global device metadata missing: workspace=%s profiles=%d health=%d", snapshot.Workspace.ID, len(snapshot.AgentProfiles), len(snapshot.ProviderHealth))
	}
	for _, agent := range snapshot.Agents {
		if agent.WorkspaceID != "ws_one" {
			t.Fatal("another workspace's agent leaked into execution selection")
		}
	}
}
