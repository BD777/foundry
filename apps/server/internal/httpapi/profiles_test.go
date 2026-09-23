package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/sqlitestore"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// requestForTest drives one request through the real route table so path
// parameters and method matching are exercised alongside the handler.
func requestForTest(t *testing.T, server *Server, method string, path string, body string, expectedStatus int) *httptest.ResponseRecorder {
	t.Helper()
	var request *http.Request
	if body == "" {
		request = httptest.NewRequest(method, path, nil)
	} else {
		request = httptest.NewRequest(method, path, strings.NewReader(body))
		request.Header.Set("Content-Type", "application/json")
	}
	response := httptest.NewRecorder()
	server.Routes().ServeHTTP(response, request)
	if response.Code != expectedStatus {
		t.Fatalf("%s %s expected status %d, got %d: %s", method, path, expectedStatus, response.Code, response.Body.String())
	}
	return response
}

func decodeProfileForTest(t *testing.T, response *httptest.ResponseRecorder) store.ProfileDefinition {
	t.Helper()
	var profile store.ProfileDefinition
	if err := json.Unmarshal(response.Body.Bytes(), &profile); err != nil {
		t.Fatalf("decode profile: %v", err)
	}
	return profile
}

const relayProfileBody = `{
	"runtime":"claude",
	"label":"Relay",
	"connectionType":"anthropic_compatible",
	"baseUrl":"https://relay.internal/v1",
	"apiKey":"relay-key-0123456789"
}`

// A credential submitted to the control plane must be observable only as a
// boolean. The raw bytes are asserted because a struct-level check would miss
// a key leaking through an unexpected field.
func TestCreateProfileSealsCredentialWithoutEchoingIt(t *testing.T) {
	backing := newSecretTestStore(t)
	server := NewServer(backing)

	created := decodeProfileForTest(t, requestForTest(t, server, http.MethodPost, "/api/profiles", relayProfileBody, http.StatusCreated))
	if created.ID == "" {
		t.Fatal("created profile has no id")
	}
	if !created.HasCredential {
		t.Fatal("profile created with an apiKey does not report a credential")
	}

	listed := requestForTest(t, server, http.MethodGet, "/api/profiles", "", http.StatusOK)
	if strings.Contains(listed.Body.String(), "relay-key-0123456789") {
		t.Fatalf("profile list leaked the credential: %s", listed.Body.String())
	}
	if strings.Contains(created.BaseURL, "relay-key") {
		t.Fatal("credential leaked into the base url")
	}
	var profiles []store.ProfileDefinition
	if err := json.Unmarshal(listed.Body.Bytes(), &profiles); err != nil {
		t.Fatalf("decode profile list: %v", err)
	}
	if len(profiles) != 1 || !profiles[0].HasCredential {
		t.Fatalf("profile list = %+v", profiles)
	}

	sealed, err := backing.GetSecret(context.Background(), "agent-profile:"+created.ID)
	if err != nil {
		t.Fatalf("read sealed credential: %v", err)
	}
	if string(sealed) != "relay-key-0123456789" {
		t.Fatalf("sealed credential = %q", string(sealed))
	}
}

// An update without an apiKey keeps the stored credential: re-typing a key to
// rename a profile would be a trap.
func TestUpdateProfileKeepsStoredCredential(t *testing.T) {
	server := NewServer(newSecretTestStore(t))
	created := decodeProfileForTest(t, requestForTest(t, server, http.MethodPost, "/api/profiles", relayProfileBody, http.StatusCreated))

	updated := decodeProfileForTest(t, requestForTest(t, server, http.MethodPut, "/api/profiles/"+created.ID, `{
		"runtime":"claude",
		"label":"Relay renamed",
		"connectionType":"anthropic_compatible",
		"baseUrl":"https://relay.internal/v1"
	}`, http.StatusOK))
	if updated.Label != "Relay renamed" {
		t.Fatalf("label = %q", updated.Label)
	}
	if !updated.HasCredential {
		t.Fatal("update without an apiKey dropped the stored credential")
	}

	requestForTest(t, server, http.MethodPut, "/api/profiles/prof_missing", `{
		"runtime":"claude",
		"label":"Ghost",
		"connectionType":"anthropic_compatible",
		"baseUrl":"https://relay.internal/v1"
	}`, http.StatusNotFound)
}

func TestProfileWriteValidation(t *testing.T) {
	t.Run("official profiles derive local login", func(t *testing.T) {
		server := NewServer(newSecretTestStore(t))
		profile := decodeProfileForTest(t, requestForTest(t, server, http.MethodPost, "/api/profiles", `{
			"runtime":"claude",
			"label":"Claude subscription",
			"authMode":"official",
			"connectionType":"openai_compatible",
			"baseUrl":"https://ignored.example"
		}`, http.StatusCreated))
		if profile.ConnectionType != "local_login" || profile.BaseURL != "" {
			t.Fatalf("official profile was not normalized: %+v", profile)
		}
	})

	t.Run("baseUrl is required", func(t *testing.T) {
		server := NewServer(newSecretTestStore(t))
		requestForTest(t, server, http.MethodPost, "/api/profiles", `{
			"runtime":"codex",
			"label":"Relay",
			"connectionType":"openai_compatible"
		}`, http.StatusBadRequest)
	})

	t.Run("label and runtime are required", func(t *testing.T) {
		server := NewServer(newSecretTestStore(t))
		requestForTest(t, server, http.MethodPost, "/api/profiles", `{
			"runtime":"claude",
			"label":"   ",
			"connectionType":"anthropic_compatible",
			"baseUrl":"https://relay.internal/v1"
		}`, http.StatusBadRequest)
		requestForTest(t, server, http.MethodPost, "/api/profiles", `{
			"runtime":"gemini",
			"label":"Relay",
			"connectionType":"anthropic_compatible",
			"baseUrl":"https://relay.internal/v1"
		}`, http.StatusBadRequest)
	})

	t.Run("apiKey without a server secret store is rejected", func(t *testing.T) {
		server := NewServer(newEmptyTestStore(t))
		requestForTest(t, server, http.MethodPost, "/api/profiles", relayProfileBody, http.StatusBadRequest)
		listed := requestForTest(t, server, http.MethodGet, "/api/profiles", "", http.StatusOK)
		if strings.Contains(listed.Body.String(), "relay-key-0123456789") {
			t.Fatalf("rejected credential reached the store: %s", listed.Body.String())
		}
	})
}

func TestDeleteProfileRemovesRowBindingAndSecret(t *testing.T) {
	backing := newSecretTestStore(t)
	server := NewServer(backing)
	ctx := context.Background()
	created := decodeProfileForTest(t, requestForTest(t, server, http.MethodPost, "/api/profiles", relayProfileBody, http.StatusCreated))
	if err := backing.SetDeviceProfiles(ctx, store.SetDeviceProfilesInput{DeviceID: "dev_1", ProfileIDs: []string{created.ID}}); err != nil {
		t.Fatalf("bind profile: %v", err)
	}

	deleted := decodeProfileForTest(t, requestForTest(t, server, http.MethodDelete, "/api/profiles/"+created.ID, "", http.StatusOK))
	if deleted.ID != created.ID || deleted.Label != "Relay" {
		t.Fatalf("delete returned %+v", deleted)
	}
	if _, err := backing.GetProfile(ctx, created.ID); err == nil {
		t.Fatal("deleted profile is still readable")
	}
	if stored, err := backing.HasSecret(ctx, "agent-profile:"+created.ID); err != nil || stored {
		t.Fatalf("credential survived the delete: %v %v", stored, err)
	}
	bindings, err := backing.ListDeviceProfiles(ctx, "dev_1")
	if err != nil {
		t.Fatalf("list bindings: %v", err)
	}
	for _, binding := range bindings {
		if binding.ProfileID == created.ID && binding.Enabled {
			t.Fatal("binding survived the delete")
		}
	}
}

func TestClearProfileCredentialKeepsTheProfile(t *testing.T) {
	backing := newSecretTestStore(t)
	server := NewServer(backing)
	created := decodeProfileForTest(t, requestForTest(t, server, http.MethodPost, "/api/profiles", relayProfileBody, http.StatusCreated))

	cleared := decodeProfileForTest(t, requestForTest(t, server, http.MethodPost, "/api/profiles/"+created.ID+"/credential/clear", "", http.StatusOK))
	if cleared.ID != created.ID {
		t.Fatalf("cleared profile = %+v", cleared)
	}
	if cleared.HasCredential {
		t.Fatal("profile still reports a credential after clearing it")
	}
	if stored, err := backing.HasSecret(context.Background(), "agent-profile:"+created.ID); err != nil || stored {
		t.Fatalf("credential survived the clear: %v %v", stored, err)
	}
}

func registerPromotionDaemon(t *testing.T, backing *sqlitestore.Store, profile store.AgentProfileProjection) {
	t.Helper()
	registration := store.DaemonRegistration{
		Device:        store.DeviceProjection{ID: "dev_1", Label: "Studio", Status: "connected"},
		Workspace:     store.WorkspaceProjection{ID: "ws_1", Name: "Foundry", LocalPath: t.TempDir()},
		AgentProfiles: []store.AgentProfileProjection{profile},
	}
	if err := backing.RegisterDaemon(context.Background(), registration); err != nil {
		t.Fatalf("register daemon: %v", err)
	}
}

// answerCredentialReads attaches a socket-less daemon connection for dev_1 and
// answers every read_profile_credential request with the given key, which is
// how a real device hands its key over during promotion.
func answerCredentialReads(t *testing.T, server *Server, credential string) {
	t.Helper()
	connection := newDaemonConnection(server.hub, nil)
	server.hub.mu.Lock()
	server.hub.connections["dev_1"] = connection
	server.hub.mu.Unlock()
	t.Cleanup(func() {
		server.hub.mu.Lock()
		delete(server.hub.connections, "dev_1")
		server.hub.mu.Unlock()
	})
	go func() {
		for {
			select {
			case <-connection.done:
				return
			case envelope := <-connection.send:
				if envelope.Type != wsReadProfileCredentialType {
					continue
				}
				payload, err := json.Marshal(wsProfileCredentialReadPayload{Credential: credential})
				if err != nil {
					return
				}
				_ = deliverDaemonResponse[wsProfileCredentialReadPayload](connection, wsEnvelope{
					ID:      envelope.ID,
					Type:    wsReadProfileCredentialType,
					Payload: payload,
				}, nil)
			}
		}
	}()
}

// Promotion of a credential the server already holds must cost the user
// nothing: the record is renamed under its own key, never re-entered.
func TestPromoteProfileAdoptsSealedCredential(t *testing.T) {
	backing := newSecretTestStore(t)
	server := NewServer(backing)
	ctx := context.Background()
	registerPromotionDaemon(t, backing, store.AgentProfileProjection{
		ID:             "relay_local",
		DeviceID:       "dev_1",
		Runtime:        "claude",
		Label:          "Relay local",
		Status:         "healthy",
		ConfigScope:    "device",
		ConnectionType: "anthropic_compatible",
		BaseURL:        "https://relay.internal/v1",
		Model:          "claude-sonnet",
	})
	if err := server.sealProfileCredential(ctx, "dev_1", "relay_local", "relay-key-0123456789"); err != nil {
		t.Fatalf("seal device credential: %v", err)
	}
	existing, err := backing.SaveProfile(ctx, store.SaveProfileInput{
		Runtime:        "codex",
		Label:          "Already enabled",
		ConnectionType: "openai_compatible",
		BaseURL:        "https://other.internal/v1",
	})
	if err != nil {
		t.Fatalf("save existing profile: %v", err)
	}
	if err := backing.SetDeviceProfiles(ctx, store.SetDeviceProfilesInput{DeviceID: "dev_1", ProfileIDs: []string{existing.ID}}); err != nil {
		t.Fatalf("bind existing profile: %v", err)
	}

	response := requestForTest(t, server, http.MethodPost, "/api/profiles/promote", `{"deviceId":"dev_1","profileId":"relay_local"}`, http.StatusCreated)
	if strings.Contains(response.Body.String(), "relay-key-0123456789") {
		t.Fatalf("promote leaked the credential: %s", response.Body.String())
	}
	promoted := decodeProfileForTest(t, response)
	if promoted.ID != "relay_local" {
		t.Fatalf("promotion did not keep the profile id: %q", promoted.ID)
	}
	if !promoted.HasCredential {
		t.Fatal("promoted profile lost its credential")
	}
	if promoted.BaseURL != "https://relay.internal/v1" || promoted.Model != "claude-sonnet" {
		t.Fatalf("promoted profile = %+v", promoted)
	}

	if stored, err := backing.HasSecret(ctx, "agent-profile:dev_1:relay_local"); err != nil || stored {
		t.Fatalf("device-scoped record survived promotion: %v %v", stored, err)
	}
	sealed, err := backing.GetSecret(ctx, "agent-profile:relay_local")
	if err != nil {
		t.Fatalf("read promoted credential: %v", err)
	}
	if string(sealed) != "relay-key-0123456789" {
		t.Fatalf("promotion changed the credential: %q", string(sealed))
	}

	// The device the profile was promoted from keeps running it, and its other
	// bindings survive the union.
	bindings, err := backing.ListDeviceProfiles(ctx, "dev_1")
	if err != nil {
		t.Fatalf("list bindings: %v", err)
	}
	enabled := map[string]bool{}
	for _, binding := range bindings {
		if binding.Enabled {
			enabled[binding.ProfileID] = true
		}
	}
	if !enabled["relay_local"] {
		t.Fatalf("promotion left the source device without the profile: %+v", bindings)
	}
	if !enabled[existing.ID] {
		t.Fatalf("promotion dropped an unrelated binding: %+v", bindings)
	}
}

// A device that hands over no key cannot produce a usable server profile, so
// the promotion fails and leaves nothing behind.
func TestPromoteProfileWithoutCredentialIsRejected(t *testing.T) {
	backing := newSecretTestStore(t)
	server := NewServer(backing)
	registerPromotionDaemon(t, backing, store.AgentProfileProjection{
		ID:             "relay_local",
		DeviceID:       "dev_1",
		Runtime:        "codex",
		Label:          "Relay local",
		ConfigScope:    "device",
		ConnectionType: "openai_compatible",
		BaseURL:        "https://relay.internal/v1",
	})
	answerCredentialReads(t, server, "")

	response := requestForTest(t, server, http.MethodPost, "/api/profiles/promote", `{"deviceId":"dev_1","profileId":"relay_local"}`, http.StatusBadRequest)
	if !strings.Contains(response.Body.String(), "cannot authenticate anywhere") {
		t.Fatalf("rejection did not explain why: %s", response.Body.String())
	}
	profiles, err := backing.ListProfiles(context.Background())
	if err != nil {
		t.Fatalf("list profiles: %v", err)
	}
	if len(profiles) != 0 {
		t.Fatalf("failed promotion left %d profile(s) behind", len(profiles))
	}
}

// Promotion always carries the device key, so the promoted profile can
// authenticate from any device without the user retyping anything.
func TestPromoteProfileUploadsTheDeviceKey(t *testing.T) {
	backing := newSecretTestStore(t)
	server := NewServer(backing)
	registerPromotionDaemon(t, backing, store.AgentProfileProjection{
		ID:             "relay_local",
		DeviceID:       "dev_1",
		Runtime:        "codex",
		Label:          "Relay local",
		ConfigScope:    "device",
		ConnectionType: "openai_compatible",
		BaseURL:        "https://relay.internal/v1",
	})
	answerCredentialReads(t, server, "device-key-0123456789")

	response := requestForTest(t, server, http.MethodPost, "/api/profiles/promote", `{"deviceId":"dev_1","profileId":"relay_local"}`, http.StatusCreated)
	if strings.Contains(response.Body.String(), "device-key-0123456789") {
		t.Fatalf("promote echoed the credential: %s", response.Body.String())
	}
	promoted := decodeProfileForTest(t, response)
	if !promoted.HasCredential {
		t.Fatal("promoted profile did not adopt the device key")
	}
	if stored, err := backing.HasSecret(context.Background(), "agent-profile:"+promoted.ID); err != nil || !stored {
		t.Fatalf("credential was not sealed server-side: %v %v", stored, err)
	}
}

func TestPromoteRejectsDeviceLocalProfile(t *testing.T) {
	backing := newSecretTestStore(t)
	server := NewServer(backing)
	registerPromotionDaemon(t, backing, store.AgentProfileProjection{
		ID:             "local_cmd",
		DeviceID:       "dev_1",
		Runtime:        "claude",
		Label:          "Wrapper script",
		ConfigScope:    "device",
		ConnectionType: "custom_command",
		CommandLabel:   "claude-wrapper",
	})

	response := requestForTest(t, server, http.MethodPost, "/api/profiles/promote", `{"deviceId":"dev_1","profileId":"local_cmd"}`, http.StatusBadRequest)
	if !strings.Contains(response.Body.String(), "machine-local state") {
		t.Fatalf("rejection did not explain why: %s", response.Body.String())
	}
	profiles, err := backing.ListProfiles(context.Background())
	if err != nil {
		t.Fatalf("list profiles: %v", err)
	}
	if len(profiles) != 0 {
		t.Fatalf("rejected promotion still created %d profile(s)", len(profiles))
	}
}

func TestSetDeviceProfilesReturnsBindings(t *testing.T) {
	backing := newSecretTestStore(t)
	server := NewServer(backing)
	created := decodeProfileForTest(t, requestForTest(t, server, http.MethodPost, "/api/profiles", relayProfileBody, http.StatusCreated))

	response := requestForTest(t, server, http.MethodPut, "/api/devices/dev_1/profiles", `{"deviceId":"dev_1","profileIds":["`+created.ID+`"]}`, http.StatusOK)
	var bindings []store.DeviceProfileBinding
	if err := json.Unmarshal(response.Body.Bytes(), &bindings); err != nil {
		t.Fatalf("decode bindings: %v", err)
	}
	enabled := false
	for _, binding := range bindings {
		if binding.DeviceID == "dev_1" && binding.ProfileID == created.ID {
			enabled = binding.Enabled
		}
	}
	if !enabled {
		t.Fatalf("bindings = %+v", bindings)
	}
}

func TestProfileAuthorizationRequiresOfficialProfileAndConnectedDevice(t *testing.T) {
	backing := newSecretTestStore(t)
	server := NewServer(backing)
	custom := decodeProfileForTest(t, requestForTest(t, server, http.MethodPost, "/api/profiles", relayProfileBody, http.StatusCreated))
	requestForTest(t, server, http.MethodPost, "/api/profiles/"+custom.ID+"/authorization", `{"deviceId":"dev_missing"}`, http.StatusBadRequest)

	official := decodeProfileForTest(t, requestForTest(t, server, http.MethodPost, "/api/profiles", `{
		"runtime":"codex",
		"label":"ChatGPT",
		"authMode":"official"
	}`, http.StatusCreated))
	response := requestForTest(t, server, http.MethodPost, "/api/profiles/"+official.ID+"/authorization", `{"deviceId":"dev_missing"}`, http.StatusConflict)
	if !strings.Contains(response.Body.String(), "daemon") {
		t.Fatalf("missing daemon error = %s", response.Body.String())
	}
}

func foundryProfileSnapshot(t *testing.T, server *Server, workspaceID string) store.FoundryDataProjection {
	t.Helper()
	response := requestForTest(t, server, http.MethodGet, "/api/foundry-data?workspaceId="+workspaceID, "", http.StatusOK)
	var payload store.FoundryDataProjection
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode snapshot: %v", err)
	}
	return payload
}

func findAgentProfile(profiles []store.AgentProfileProjection, id string) (store.AgentProfileProjection, bool) {
	for _, profile := range profiles {
		if profile.ID == id {
			return profile, true
		}
	}
	return store.AgentProfileProjection{}, false
}

// The snapshot is what the devices page and the chat composer read, so a
// server profile is only usable once it appears there with a status the
// composer accepts.
func TestFoundryDataProjectsServerProfiles(t *testing.T) {
	newServerWithBinding := func(t *testing.T, deviceStatus string, sealCredential bool) (*Server, *sqlitestore.Store, string) {
		t.Helper()
		backing := newSecretTestStore(t)
		server := NewServer(backing)
		ctx := context.Background()
		if err := backing.RegisterDaemon(ctx, store.DaemonRegistration{
			Device:    store.DeviceProjection{ID: "dev_1", Label: "Studio", Status: deviceStatus, LastSeenLabel: "just now"},
			Workspace: store.WorkspaceProjection{ID: "ws_1", Name: "Foundry", LocalPath: t.TempDir()},
		}); err != nil {
			t.Fatalf("register daemon: %v", err)
		}
		profile, err := backing.SaveProfile(ctx, store.SaveProfileInput{
			Runtime:        "claude",
			Label:          "Relay",
			ConnectionType: "anthropic_compatible",
			BaseURL:        "https://relay.internal/v1",
		})
		if err != nil {
			t.Fatalf("save profile: %v", err)
		}
		if err := backing.SetDeviceProfiles(ctx, store.SetDeviceProfilesInput{DeviceID: "dev_1", ProfileIDs: []string{profile.ID}}); err != nil {
			t.Fatalf("bind profile: %v", err)
		}
		if sealCredential {
			if err := server.sealServerProfileCredential(ctx, profile.ID, "relay-key-0123456789"); err != nil {
				t.Fatalf("seal credential: %v", err)
			}
		}
		return server, backing, profile.ID
	}

	t.Run("connected device with a credential is healthy", func(t *testing.T) {
		server, _, profileID := newServerWithBinding(t, "connected", true)
		snapshot := foundryProfileSnapshot(t, server, "ws_1")
		if len(snapshot.Profiles) != 1 || snapshot.Profiles[0].ID != profileID || !snapshot.Profiles[0].HasCredential {
			t.Fatalf("profiles = %+v", snapshot.Profiles)
		}
		if len(snapshot.DeviceProfiles) != 1 || !snapshot.DeviceProfiles[0].Enabled {
			t.Fatalf("deviceProfiles = %+v", snapshot.DeviceProfiles)
		}
		projected, ok := findAgentProfile(snapshot.AgentProfiles, profileID)
		if !ok {
			t.Fatalf("agentProfiles = %+v", snapshot.AgentProfiles)
		}
		if projected.Origin != "server" || projected.SecretStored != "server" || !projected.ServerCredential {
			t.Fatalf("server profile projected as %+v", projected)
		}
		if projected.Status != "healthy" || projected.DeviceID != "dev_1" {
			t.Fatalf("server profile status = %q on %q", projected.Status, projected.DeviceID)
		}
		selectable := false
		for _, agent := range snapshot.Agents {
			if agent.ProfileID == profileID {
				selectable = agent.Status == "healthy" && agent.SecretStored == "server" && agent.WorkspaceID == "ws_1"
			}
		}
		if !selectable {
			t.Fatalf("no healthy agent for the server profile: %+v", snapshot.Agents)
		}
	})

	t.Run("offline device is unavailable", func(t *testing.T) {
		server, _, profileID := newServerWithBinding(t, "disconnected", true)
		snapshot := foundryProfileSnapshot(t, server, "ws_1")
		projected, ok := findAgentProfile(snapshot.AgentProfiles, profileID)
		if !ok {
			t.Fatalf("agentProfiles = %+v", snapshot.AgentProfiles)
		}
		if projected.Status != "unavailable" || projected.StatusDetail != "Device is offline." {
			t.Fatalf("offline projection = %+v", projected)
		}
	})

	// A custom API/gateway profile need not seal a key: internal proxies can
	// authenticate themselves. Such a profile is configured and selectable
	// (healthy never means online-verified), while still reporting honestly
	// that the server holds no credential for it.
	t.Run("keyless custom profile is configured without claiming a credential", func(t *testing.T) {
		server, _, profileID := newServerWithBinding(t, "connected", false)
		snapshot := foundryProfileSnapshot(t, server, "ws_1")
		projected, ok := findAgentProfile(snapshot.AgentProfiles, profileID)
		if !ok {
			t.Fatalf("agentProfiles = %+v", snapshot.AgentProfiles)
		}
		if projected.Status != "healthy" {
			t.Fatalf("keyless custom projection = %+v", projected)
		}
		if projected.AuthMode != "local_config" {
			t.Fatalf("keyless custom authMode = %q, want local_config", projected.AuthMode)
		}
		if projected.ServerCredential {
			t.Fatal("keyless profile claims a server credential")
		}
		if projected.SecretStored != "server" {
			t.Fatalf("keyless profile secret placement = %q, want server", projected.SecretStored)
		}
		selectable := false
		for _, agent := range snapshot.Agents {
			if agent.ProfileID == profileID {
				selectable = agent.Status == "healthy"
			}
		}
		if !selectable {
			t.Fatalf("keyless profile is not selectable: %+v", snapshot.Agents)
		}
	})

	// The binding is what makes a profile a device's to run, so a saved profile
	// nobody enabled has no server projection and therefore no status. The web
	// app relies on this to tell an unusable profile from a working one: without
	// it a sealed credential alone read as healthy.
	t.Run("a profile no device may run has no server projection", func(t *testing.T) {
		backing := newSecretTestStore(t)
		server := NewServer(backing)
		ctx := context.Background()
		if err := backing.RegisterDaemon(ctx, store.DaemonRegistration{
			Device:    store.DeviceProjection{ID: "dev_1", Label: "Studio", Status: "connected", LastSeenLabel: "just now"},
			Workspace: store.WorkspaceProjection{ID: "ws_1", Name: "Foundry", LocalPath: t.TempDir()},
		}); err != nil {
			t.Fatalf("register daemon: %v", err)
		}
		profile, err := backing.SaveProfile(ctx, store.SaveProfileInput{
			Runtime:        "claude",
			Label:          "Relay",
			ConnectionType: "anthropic_compatible",
			BaseURL:        "https://relay.internal/v1",
		})
		if err != nil {
			t.Fatalf("save profile: %v", err)
		}
		// Sealed on purpose: a credential must not be mistaken for usability.
		if err := server.sealServerProfileCredential(ctx, profile.ID, "relay-key-0123456789"); err != nil {
			t.Fatalf("seal credential: %v", err)
		}

		snapshot := foundryProfileSnapshot(t, server, "ws_1")
		if len(snapshot.DeviceProfiles) != 0 {
			t.Fatalf("deviceProfiles = %+v", snapshot.DeviceProfiles)
		}
		if _, ok := findAgentProfile(snapshot.AgentProfiles, profile.ID); ok {
			t.Fatalf("unbound profile projected a row: %+v", snapshot.AgentProfiles)
		}
		// It is still a saved definition the Profiles page must list.
		if len(snapshot.Profiles) != 1 || !snapshot.Profiles[0].HasCredential {
			t.Fatalf("profiles = %+v", snapshot.Profiles)
		}
	})

	t.Run("daemon rows keep the device origin", func(t *testing.T) {
		backing := newSecretTestStore(t)
		server := NewServer(backing)
		registerPromotionDaemon(t, backing, store.AgentProfileProjection{
			ID:             "relay_local",
			DeviceID:       "dev_1",
			Runtime:        "claude",
			Label:          "Relay local",
			Status:         "healthy",
			ConfigScope:    "device",
			ConnectionType: "anthropic_compatible",
			BaseURL:        "https://relay.internal/v1",
		})
		snapshot := foundryProfileSnapshot(t, server, "ws_1")
		projected, ok := findAgentProfile(snapshot.AgentProfiles, "relay_local")
		if !ok {
			t.Fatalf("agentProfiles = %+v", snapshot.AgentProfiles)
		}
		if projected.Origin != "device" {
			t.Fatalf("daemon-reported profile origin = %q", projected.Origin)
		}

		// The devices page also reads the list endpoint directly, where an
		// unset origin would render as neither device- nor server-owned.
		listed := requestForTest(t, server, http.MethodGet, "/api/agent-profiles?deviceId=dev_1", "", http.StatusOK)
		var rows []store.AgentProfileProjection
		if err := json.Unmarshal(listed.Body.Bytes(), &rows); err != nil {
			t.Fatalf("decode agent profiles: %v", err)
		}
		if len(rows) != 1 || rows[0].Origin != "device" || rows[0].SecretStored != "local" {
			t.Fatalf("agent profile list = %+v", rows)
		}
	})
}

// A session that runs a server profile must carry the definition, otherwise
// the daemon falls back to its own file and silently drops baseUrl.
func TestServerProfileForSessionResolvesEnabledBindingsOnly(t *testing.T) {
	backing := newSecretTestStore(t)
	server := NewServer(backing)
	ctx := context.Background()
	profile, err := backing.SaveProfile(ctx, store.SaveProfileInput{
		Runtime:        "claude",
		Label:          "Relay",
		ConnectionType: "anthropic_compatible",
		BaseURL:        "https://relay.internal/v1",
	})
	if err != nil {
		t.Fatalf("save profile: %v", err)
	}

	unbound, err := server.hub.serverProfileForSession(ctx, store.AgentSession{DeviceID: "dev_1", ProfileID: profile.ID})
	if err != nil {
		t.Fatalf("resolve unbound profile: %v", err)
	}
	if unbound != nil {
		t.Fatal("an unbound profile resolved as server-owned")
	}

	if err := backing.SetDeviceProfiles(ctx, store.SetDeviceProfilesInput{DeviceID: "dev_1", ProfileIDs: []string{profile.ID}}); err != nil {
		t.Fatalf("bind profile: %v", err)
	}
	resolved, err := server.hub.serverProfileForSession(ctx, store.AgentSession{DeviceID: "dev_1", ProfileID: profile.ID})
	if err != nil {
		t.Fatalf("resolve bound profile: %v", err)
	}
	if resolved == nil || resolved.BaseURL != "https://relay.internal/v1" {
		t.Fatalf("resolved profile = %+v", resolved)
	}

	deviceLocal, err := server.hub.serverProfileForSession(ctx, store.AgentSession{DeviceID: "dev_1", ProfileID: "relay_local"})
	if err != nil {
		t.Fatalf("resolve device-local profile: %v", err)
	}
	if deviceLocal != nil {
		t.Fatal("a device-local profile resolved as server-owned")
	}
}

// A session pinned to a device-local connection id still runs the server
// connection when the two are a promotion twin: same runtime and custom
// endpoint, enabled on this device, and the device copy has no control-plane
// credential while the server copy does. This is the 401-on-resume repair.
func TestServerProfileForSessionEndpointTwin(t *testing.T) {
	backing := newSecretTestStore(t)
	server := NewServer(backing)
	ctx := context.Background()

	local := store.AgentProfileProjection{
		ID:             "relay_local",
		DeviceID:       "dev_1",
		Runtime:        "claude",
		Label:          "team-relay",
		Status:         "healthy",
		ConfigScope:    "device",
		ConnectionType: "anthropic_compatible",
		BaseURL:        "https://relay.internal/v1",
	}
	registerPromotionDaemon(t, backing, local)

	twin, err := backing.SaveProfile(ctx, store.SaveProfileInput{
		Runtime:        "claude",
		Label:          "team-relay",
		ConnectionType: "anthropic_compatible",
		BaseURL:        "https://relay.internal/v1",
	})
	if err != nil {
		t.Fatalf("save twin: %v", err)
	}
	pinned := store.AgentSession{DeviceID: "dev_1", ProfileID: "relay_local"}

	// Bound but credential-less: no twin dispatch (keyless gateways can still
	// self-authenticate, but resolving here would not help — it resolves as a
	// local run as before).
	if err := backing.SetDeviceProfiles(ctx, store.SetDeviceProfilesInput{DeviceID: "dev_1", ProfileIDs: []string{twin.ID}}); err != nil {
		t.Fatalf("bind twin: %v", err)
	}
	if resolved, err := server.hub.serverProfileForSession(ctx, pinned); err != nil || resolved != nil {
		t.Fatalf("credential-less twin resolved = %v, err = %v", resolved, err)
	}

	if err := server.secrets.PutSecret(ctx, serverProfileSecretID(twin.ID), []byte("twin-key"), ""); err != nil {
		t.Fatalf("seal twin credential: %v", err)
	}
	resolved, err := server.hub.serverProfileForSession(ctx, pinned)
	if err != nil {
		t.Fatalf("resolve twin: %v", err)
	}
	if resolved == nil || resolved.ID != twin.ID {
		t.Fatalf("pinned local session did not resolve onto its twin: %+v", resolved)
	}

	// A device-held credential wins: a working local configuration is never
	// swapped onto another account.
	if err := server.secrets.PutSecret(ctx, agentProfileSecretID("dev_1", "relay_local"), []byte("device-key"), ""); err != nil {
		t.Fatalf("seal device credential: %v", err)
	}
	if resolved, err := server.hub.serverProfileForSession(ctx, pinned); err != nil || resolved != nil {
		t.Fatalf("device-credentialed connection was swapped: %v, err = %v", resolved, err)
	}
}

// Endpoint fallback must never fire for local logins, disabled bindings,
// server-owned ids, or ambiguous credential matches.
func TestServerProfileForSessionEndpointTwinGuards(t *testing.T) {
	backing := newSecretTestStore(t)
	server := NewServer(backing)
	ctx := context.Background()
	registerPromotionDaemon(t, backing, store.AgentProfileProjection{
		ID:             "relay_local",
		DeviceID:       "dev_1",
		Runtime:        "claude",
		Label:          "team-relay",
		Status:         "healthy",
		ConfigScope:    "device",
		ConnectionType: "anthropic_compatible",
		BaseURL:        "https://relay.internal/v1",
	})
	mkTwin := func(label string, idSeed string) store.ProfileDefinition {
		profile, err := backing.SaveProfile(ctx, store.SaveProfileInput{
			ID:             idSeed,
			Runtime:        "claude",
			Label:          label,
			ConnectionType: "anthropic_compatible",
			BaseURL:        "https://relay.internal/v1",
		})
		if err != nil {
			t.Fatalf("save twin: %v", err)
		}
		if err := server.secrets.PutSecret(ctx, serverProfileSecretID(profile.ID), []byte("key-"+profile.ID), ""); err != nil {
			t.Fatalf("seal: %v", err)
		}
		return profile
	}
	pinned := store.AgentSession{DeviceID: "dev_1", ProfileID: "relay_local"}

	// Unbound (or disabled — both are absent from the enabled binding set)
	// does not twin.
	mkTwin("team-relay", "prof_disabled")
	if resolved, err := server.hub.serverProfileForSession(ctx, pinned); err != nil || resolved != nil {
		t.Fatalf("unbound twin resolved silently: %v, err = %v", resolved, err)
	}

	// Two credential-bearing twins with the same label and endpoint:
	// ambiguous accounts, never guessed.
	enabledA := mkTwin("team-relay", "prof_a")
	enabledB := mkTwin("team-relay", "prof_b")
	if err := backing.SetDeviceProfiles(ctx, store.SetDeviceProfilesInput{DeviceID: "dev_1", ProfileIDs: []string{enabledA.ID, enabledB.ID}}); err != nil {
		t.Fatalf("bind both: %v", err)
	}
	if resolved, err := server.hub.serverProfileForSession(ctx, pinned); err != nil || resolved != nil {
		t.Fatalf("ambiguous twins resolved silently: %v, err = %v", resolved, err)
	}

	// A server-owned id that is merely unbound is never bypassed onto a twin.
	unboundServer := store.AgentSession{DeviceID: "dev_1", ProfileID: enabledB.ID}
	if err := backing.SetDeviceProfiles(ctx, store.SetDeviceProfilesInput{DeviceID: "dev_1", ProfileIDs: []string{enabledA.ID}}); err != nil {
		t.Fatalf("unbind b: %v", err)
	}
	if resolved, err := server.hub.serverProfileForSession(ctx, unboundServer); err != nil || resolved != nil {
		t.Fatalf("unbound server id was bypassed: %v, err = %v", resolved, err)
	}
}
