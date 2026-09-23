package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"sync"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func TestDeviceAccountAuthorizationNeedsNoGlobalProfile(t *testing.T) {
	backing := newEmptyTestStore(t)
	registerPromotionDaemon(t, backing, store.AgentProfileProjection{ID: "codex_local", Runtime: "codex", ConnectionType: "local_login"})
	server := NewServer(backing)
	connection := newDaemonConnection(server.hub, nil)
	server.hub.connections["dev_1"] = connection
	defer close(connection.done)
	var mu sync.Mutex
	var calls []wsEnvelope
	go func() {
		for {
			select {
			case <-connection.done:
				return
			case envelope := <-connection.send:
				mu.Lock()
				calls = append(calls, envelope)
				mu.Unlock()
				authorization := store.ProfileAuthorization{ID: "flow1", ProfileID: "device-account:codex", Runtime: "codex", Status: "waiting_for_user"}
				switch envelope.Type {
				case wsStartProfileAuthorizationType:
					payload, _ := json.Marshal(wsProfileAuthorizationStartedPayload{Authorization: authorization})
					_ = deliverDaemonResponse[wsProfileAuthorizationStartedPayload](connection, wsEnvelope{ID: envelope.ID, Type: envelope.Type, Payload: payload}, nil)
				case wsCompleteProfileAuthorizationType:
					payload, _ := json.Marshal(wsProfileAuthorizationCompletedPayload{Authorization: authorization})
					_ = deliverDaemonResponse[wsProfileAuthorizationCompletedPayload](connection, wsEnvelope{ID: envelope.ID, Type: envelope.Type, Payload: payload}, nil)
				}
			}
		}
	}()
	requestForTest(t, server, http.MethodPost, "/api/devices/dev_1/accounts/codex/authorization", `{}`, http.StatusOK)
	requestForTest(t, server, http.MethodPost, "/api/devices/dev_1/accounts/codex/authorization/flow1", `{}`, http.StatusOK)
	// A code must never reach a flow for another runtime.
	requestForTest(t, server, http.MethodPost, "/api/devices/dev_1/accounts/claude/authorization/flow1", `{"authorizationResult":"private-code"}`, http.StatusConflict)
	mu.Lock()
	defer mu.Unlock()
	for _, call := range calls {
		if call.Type == wsStartProfileAuthorizationType {
			var payload wsStartProfileAuthorizationPayload
			_ = json.Unmarshal(call.Payload, &payload)
			if payload.ProfileID != "device-account:codex" || payload.Runtime != "codex" {
				t.Fatalf("wrong login target: %+v", payload)
			}
		}
		if call.Type == wsCompleteProfileAuthorizationType {
			var payload wsCompleteProfileAuthorizationPayload
			_ = json.Unmarshal(call.Payload, &payload)
			if payload.AuthorizationResult != "" {
				t.Fatal("authorization code was forwarded before checking flow identity")
			}
		}
	}
	profiles, _ := backing.ListProfiles(context.Background())
	bindings, _ := backing.ListDeviceProfiles(context.Background(), "")
	if len(profiles) != 0 || len(bindings) != 0 {
		t.Fatal("device login created a global profile or binding")
	}
}

func TestDeviceAccountAuthorizationRejectsUnknownOfflineAndInvalidTargets(t *testing.T) {
	backing := newEmptyTestStore(t)
	registerPromotionDaemon(t, backing, store.AgentProfileProjection{ID: "codex_local", Runtime: "codex"})
	server := NewServer(backing)
	requestForTest(t, server, http.MethodPost, "/api/devices/unknown/accounts/codex/authorization", `{}`, http.StatusNotFound)
	requestForTest(t, server, http.MethodPost, "/api/devices/dev_1/accounts/codex/authorization", `{}`, http.StatusConflict)
	requestForTest(t, server, http.MethodPost, "/api/devices/dev_1/accounts/other/authorization", `{}`, http.StatusBadRequest)
	requestForTest(t, server, http.MethodPost, "/api/devices/unknown/accounts/codex/inspect", `{}`, http.StatusNotFound)
	requestForTest(t, server, http.MethodPost, "/api/devices/dev_1/accounts/codex/inspect", `{}`, http.StatusConflict)
	requestForTest(t, server, http.MethodPost, "/api/devices/dev_1/accounts/other/inspect", `{}`, http.StatusBadRequest)
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
