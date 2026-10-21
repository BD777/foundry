package httpapi

import (
	"encoding/json"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"net/http"
	"testing"
)

func TestAccountUsageRejectsUnselectedAndChangedProfiles(t *testing.T) {
	for _, tc := range []struct {
		name, connection, base, generation, body string
		status                                   int
	}{
		{"endpoint", "api_key", "https://endpoint.test", "g", `{"profileId":"selected","runtimeGeneration":"g"}`, http.StatusBadRequest},
		{"gateway", "local_login", "https://gateway.test", "g", `{"profileId":"selected","runtimeGeneration":"g"}`, http.StatusBadRequest},
		{"changed", "local_login", "", "new", `{"profileId":"selected","runtimeGeneration":"old"}`, http.StatusConflict},
		{"arbitrary-source", "local_login", "", "g", `{"profileId":"selected","runtimeGeneration":"g","source":"/other"}`, http.StatusBadRequest},
		{"missing-selection", "local_login", "", "g", `{"runtimeGeneration":"g"}`, http.StatusBadRequest},
	} {
		t.Run(tc.name, func(t *testing.T) {
			backing := newEmptyTestStore(t)
			registerPromotionDaemon(t, backing, store.AgentProfileProjection{ID: "selected", Runtime: "codex", ConnectionType: tc.connection, BaseURL: tc.base, RuntimeGeneration: tc.generation})
			server := NewServer(backing)
			connection := newDaemonConnection(server.hub, nil)
			server.hub.connections["dev_1"] = connection
			defer close(connection.done)
			requestForTest(t, server, http.MethodPost, "/api/devices/dev_1/accounts/codex/inspect", tc.body, tc.status)
			select {
			case <-connection.send:
				t.Fatal("invalid selection reached worker")
			default:
			}
		})
	}
}

func TestAccountUsageBindsWorkerResponseAndPreservesUnknownPercentage(t *testing.T) {
	for _, generation := range []string{"g", "old", ""} {
		t.Run("response-"+generation, func(t *testing.T) {
			backing := newEmptyTestStore(t)
			registerPromotionDaemon(t, backing, store.AgentProfileProjection{ID: "selected", Runtime: "codex", ConnectionType: "local_login", RuntimeGeneration: "g"})
			server := NewServer(backing)
			connection := newDaemonConnection(server.hub, nil)
			server.hub.connections["dev_1"] = connection
			defer close(connection.done)
			go func() {
				envelope := <-connection.send
				var input struct {
					RuntimeGeneration string `json:"runtimeGeneration"`
					Refresh           bool   `json:"refresh"`
				}
				_ = json.Unmarshal(envelope.Payload, &input)
				if input.RuntimeGeneration != "g" || !input.Refresh {
					t.Errorf("selection not forwarded: %+v", input)
				}
				payload, _ := json.Marshal(map[string]any{"result": map[string]any{"runtimeGeneration": generation, "authMode": "subscription", "quotaStatus": "supported", "usage": []map[string]any{{"id": "unknown"}, {"id": "zero", "usedPercent": 0}}}})
				_ = deliverDaemonResponse[wsNativeAccountInspectionResult](connection, wsEnvelope{ID: envelope.ID, Payload: payload}, nil)
			}()
			status := http.StatusConflict
			if generation == "g" {
				status = http.StatusOK
			}
			response := requestForTest(t, server, http.MethodPost, "/api/devices/dev_1/accounts/codex/inspect", `{"profileId":"selected","runtimeGeneration":"g","refresh":true}`, status)
			if status == http.StatusOK {
				var result store.NativeAccountInspection
				if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
					t.Fatal(err)
				}
				if result.Usage[0].UsedPercent != nil || result.Usage[1].UsedPercent == nil || *result.Usage[1].UsedPercent != 0 {
					t.Fatal("unknown quota became zero")
				}
			}
		})
	}
}

func TestAccountUsageIsDeviceOwnerOnly(t *testing.T) {
	// The existing owner rule runs before native/device reads, including for workspace members.
	server, handler := newAccountsTestServer(t)
	owner := setupOwner(t, server, handler)
	member := inviteAndJoin(t, handler, owner, store.RoleMember, "quota-member")
	token := issuePairingToken(t, handler, owner)
	paired := doAuthCall(t, handler, authCall{method: http.MethodPost, path: "/api/daemon/pair", body: pairBody(token, "quota-worker", "quota-account", "quota-device")})
	expectStatus(t, paired, http.StatusCreated, "pair quota device")
	response := doAuthCall(t, handler, authCall{method: http.MethodPost, path: "/api/devices/quota-device/accounts/codex/inspect", body: `{}`, cookie: member, origin: accountsTestOrigin})
	if response.Code != http.StatusForbidden && response.Code != http.StatusNotFound {
		t.Fatalf("non-owner read account quota: %d", response.Code)
	}
}
