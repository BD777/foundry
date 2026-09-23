package httpapi

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"errors"
	"github.com/gorilla/websocket"

	"github.com/foundry-dev/foundry/apps/server/internal/sqlitestore"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// A server-owned profile's agent exists only in the snapshot projection, never
// as a persisted agents row. Starting a session with that projected id must be
// resolved from trusted records (workspace owner + enabled binding + profile),
// not rejected as not found and never trustable from the client.
type projectedSessionFixture struct {
	server    *Server
	backing   *sqlitestore.Store
	deviceID  string
	workspace store.WorkspaceProjection
	profile   store.ProfileDefinition
	agentID   string
}

func setupProjectedSessionFixture(t *testing.T) projectedSessionFixture {
	t.Helper()
	backing := newSecretTestStore(t)
	ctx := context.Background()
	const deviceID = "dev_projected"
	if err := backing.RegisterDaemon(ctx, store.DaemonRegistration{
		Device:    store.DeviceProjection{ID: deviceID, Label: "Studio", Status: "connected", LastSeenLabel: "just now"},
		Workspace: store.WorkspaceProjection{ID: "ws_projected", Name: "Foundry", LocalPath: t.TempDir()},
	}); err != nil {
		t.Fatalf("register daemon: %v", err)
	}
	profile, err := backing.SaveProfile(ctx, store.SaveProfileInput{
		Runtime:        "claude",
		Label:          "Super Relay",
		ConnectionType: "anthropic_compatible",
		BaseURL:        "https://relay.internal",
	})
	if err != nil {
		t.Fatalf("save profile: %v", err)
	}
	if err := backing.SetDeviceProfiles(ctx, store.SetDeviceProfilesInput{
		DeviceID:   deviceID,
		ProfileIDs: []string{profile.ID},
	}); err != nil {
		t.Fatalf("bind profile: %v", err)
	}
	ws, err := backing.GetWorkspace(ctx, "ws_projected")
	if err != nil {
		t.Fatalf("get workspace: %v", err)
	}
	return projectedSessionFixture{
		server:    NewServer(backing),
		backing:   backing,
		deviceID:  deviceID,
		workspace: ws,
		profile:   profile,
		agentID:   store.ServerAgentID(deviceID, ws.ID, profile.ID),
	}
}

func postSession(t *testing.T, server *Server, body string) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(http.MethodPost, "/api/agent-sessions", strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	server.Routes().ServeHTTP(response, request)
	return response
}

// With no live daemon connection the request stops at the connection guard
// *after* the agent is resolved. Red: today it stops earlier at 404 because the
// projected id is absent from the agents table. Green: 409 daemon guard proves
// resolution accepted a trusted server-owned agent id.
func TestCreateSessionResolvesProjectedServerAgent(t *testing.T) {
	fixture := setupProjectedSessionFixture(t)
	body := `{"agentId":` + jsonString(fixture.agentID) +
		`,"workspaceId":` + jsonString(fixture.workspace.ID) +
		`,"provider":"claude","profileId":` + jsonString(fixture.profile.ID) +
		`,"prompt":"synthetic","source":"chat"}`
	response := postSession(t, fixture.server, body)
	if response.Code == http.StatusNotFound {
		t.Fatalf("projected server agent rejected as not found: %s", response.Body.String())
	}
	if response.Code != http.StatusConflict {
		t.Fatalf("expected daemon connection conflict after resolution, got %d: %s", response.Code, response.Body.String())
	}
}

// Store-level positive: even with no agents row, the trusted projection is
// resolved in the same transaction and the queued session is persisted carrying
// the server profile identity.
func TestStoreCreatesSessionForProjectedServerAgent(t *testing.T) {
	fixture := setupProjectedSessionFixture(t)
	session, err := fixture.backing.CreateAgentSession(context.Background(), store.CreateAgentSessionInput{
		AgentID:     fixture.agentID,
		WorkspaceID: fixture.workspace.ID,
		Provider:    "claude",
		ProfileID:   fixture.profile.ID,
		Prompt:      "synthetic",
		Source:      "chat",
	})
	if err != nil {
		t.Fatalf("create session for projected agent: %v", err)
	}
	if session.DeviceID != fixture.deviceID || session.ProfileID != fixture.profile.ID {
		t.Fatalf("session identity = %s/%s, want %s/%s", session.DeviceID, session.ProfileID, fixture.deviceID, fixture.profile.ID)
	}
}

func jsonString(value string) string {
	encoded, _ := json.Marshal(value)
	return string(encoded)
}

// --- Negative cases: none may create a session row -------------------------

func assertSessionRejected(t *testing.T, backing *sqlitestore.Store, input store.CreateAgentSessionInput) {
	t.Helper()
	_, err := backing.CreateAgentSession(context.Background(), input)
	if err == nil {
		t.Fatalf("expected rejection for %+v", input)
	}
}

func baseSessionInput(fixture projectedSessionFixture) store.CreateAgentSessionInput {
	return store.CreateAgentSessionInput{
		AgentID:     fixture.agentID,
		WorkspaceID: fixture.workspace.ID,
		Provider:    "claude",
		ProfileID:   fixture.profile.ID,
		Prompt:      "synthetic",
		Source:      "chat",
	}
}

func TestProjectedServerAgentRejectsForgedAndUnbound(t *testing.T) {
	fixture := setupProjectedSessionFixture(t)

	// Random / malformed id.
	forged := baseSessionInput(fixture)
	forged.AgentID = "agent_not_a_real_projection"
	assertSessionRejected(t, fixture.backing, forged)

	// Same shape naming a profile the device never bound.
	unbound := baseSessionInput(fixture)
	unbound.AgentID = store.ServerAgentID(fixture.deviceID, fixture.workspace.ID, "prof_does_not_exist")
	unbound.ProfileID = "prof_does_not_exist"
	assertSessionRejected(t, fixture.backing, unbound)

	// Provider on the request must match the resolved profile's runtime.
	wrongProvider := baseSessionInput(fixture)
	wrongProvider.Provider = "codex"
	assertSessionRejected(t, fixture.backing, wrongProvider)

	// A binding on another device cannot project onto this workspace: build a
	// second device/workspace with its own profile binding and ask for that id
	// against this workspace.
	const otherDevice = "dev_other_projected"
	if err := fixture.backing.RegisterDaemon(context.Background(), store.DaemonRegistration{
		Device:    store.DeviceProjection{ID: otherDevice, Label: "Laptop", Status: "connected"},
		Workspace: store.WorkspaceProjection{ID: "ws_other", Name: "Other", LocalPath: t.TempDir()},
	}); err != nil {
		t.Fatalf("register second daemon: %v", err)
	}
	otherProfile, err := fixture.backing.SaveProfile(context.Background(), store.SaveProfileInput{
		Runtime: "claude", Label: "Other Relay",
		ConnectionType: "anthropic_compatible", BaseURL: "https://other.internal",
	})
	if err != nil {
		t.Fatalf("save other profile: %v", err)
	}
	if err := fixture.backing.SetDeviceProfiles(context.Background(), store.SetDeviceProfilesInput{
		DeviceID: otherDevice, ProfileIDs: []string{otherProfile.ID},
	}); err != nil {
		t.Fatalf("bind other profile: %v", err)
	}
	otherWorkspace := baseSessionInput(fixture)
	otherWorkspace.AgentID = store.ServerAgentID(otherDevice, fixture.workspace.ID, otherProfile.ID)
	otherWorkspace.ProfileID = otherProfile.ID
	assertSessionRejected(t, fixture.backing, otherWorkspace)

	// Empty agent id must never resolve to a server-owned profile.
	empty := baseSessionInput(fixture)
	empty.AgentID = ""
	assertSessionRejected(t, fixture.backing, empty)

	// Unknown workspace.
	badWS := baseSessionInput(fixture)
	badWS.WorkspaceID = "ws_missing"
	assertSessionRejected(t, fixture.backing, badWS)
}

// The binding is re-read inside the write transaction: unbinding the profile
// before the insert commits must reject the session rather than create work
// for a profile the device can no longer run.
func TestProjectedServerAgentRejectedWhenBindingRevokedInTx(t *testing.T) {
	fixture := setupProjectedSessionFixture(t)
	ctx := context.Background()
	// The store serialises each create in its own transaction; revoking before
	// the call proves the resolution reads current bindings rather than a
	// pre-checked snapshot.
	if err := fixture.backing.SetDeviceProfiles(ctx, store.SetDeviceProfilesInput{
		DeviceID: fixture.deviceID, ProfileIDs: nil,
	}); err != nil {
		t.Fatalf("revoke binding: %v", err)
	}
	assertSessionRejected(t, fixture.backing, baseSessionInput(fixture))
}

// A removed device tombstone keeps the creation gate even for a valid
// projection (assertDeviceNotRemoved runs in the same write transaction).
func TestProjectedServerAgentRejectedForRemovedDevice(t *testing.T) {
	fixture := setupProjectedSessionFixture(t)
	ctx := context.Background()
	if _, err := fixture.backing.SoftRemoveDevice(ctx, fixture.deviceID); err != nil {
		t.Fatalf("remove device: %v", err)
	}
	_, err := fixture.backing.CreateAgentSession(ctx, baseSessionInput(fixture))
	if !errors.Is(err, store.ErrDeviceRemoved) {
		t.Fatalf("removed device error = %v, want ErrDeviceRemoved", err)
	}
}

// Daemon-reported agents keep their existing path: a persisted agent row still
// resolves from the agents table unchanged.
func TestPersistedDaemonAgentPathUnchanged(t *testing.T) {
	backing := newSecretTestStore(t)
	ctx := context.Background()
	const deviceID = "dev_daemon_path"
	if err := backing.RegisterDaemon(ctx, store.DaemonRegistration{
		Device:    store.DeviceProjection{ID: deviceID, Label: "Studio", Status: "connected", LastSeenLabel: "just now"},
		Workspace: store.WorkspaceProjection{ID: "ws_daemon_path", Name: "Foundry", LocalPath: t.TempDir()},
		Agents: []store.AgentProjection{{
			ID:          store.ServerAgentID(deviceID, "ws_daemon_path", "claude_local"),
			WorkspaceID: "ws_daemon_path",
			DeviceID:    deviceID,
			Provider:    "claude",
			ProfileID:   "claude_local",
			Status:      "healthy",
		}},
	}); err != nil {
		t.Fatalf("register daemon: %v", err)
	}
	_, err := backing.CreateAgentSession(ctx, store.CreateAgentSessionInput{
		AgentID:     store.ServerAgentID(deviceID, "ws_daemon_path", "claude_local"),
		WorkspaceID: "ws_daemon_path",
		Provider:    "claude",
		ProfileID:   "claude_local",
		Prompt:      "synthetic",
		Source:      "chat",
	})
	if err != nil {
		t.Fatalf("daemon agent session: %v", err)
	}
}

// safeAgentIDPart normalises '-' and '_' identically, so two distinct profiles
// whose ids differ only in those characters collide on one projected agent id.
// That candidate is ambiguous and must be rejected — never silently routed to
// whichever binding sorts first.
func TestProjectedServerAgentIDCollisionRejects(t *testing.T) {
	fixture := setupProjectedSessionFixture(t)
	ctx := context.Background()
	// Two profiles whose ids normalise to the same suffix on this device/ws.
	second, err := fixture.backing.SaveProfile(ctx, store.SaveProfileInput{
		ID:             strings.Replace(fixture.profile.ID, "-", "_", 1),
		Runtime:        "claude",
		Label:          "Super Relay Colliding",
		ConnectionType: "anthropic_compatible",
		BaseURL:        "https://relay-collide.internal",
	})
	if err != nil {
		t.Fatalf("save colliding profile: %v", err)
	}
	if second.ID == fixture.profile.ID {
		t.Fatal("test needs a distinct profile id that normalises the same")
	}
	if err := fixture.backing.SetDeviceProfiles(ctx, store.SetDeviceProfilesInput{
		DeviceID:   fixture.deviceID,
		ProfileIDs: []string{fixture.profile.ID, second.ID},
	}); err != nil {
		t.Fatalf("bind both profiles: %v", err)
	}
	// Both projected ids must collide; requesting either resolves ambiguously.
	for _, profileID := range []string{fixture.profile.ID, second.ID} {
		input := baseSessionInput(fixture)
		input.AgentID = store.ServerAgentID(fixture.deviceID, fixture.workspace.ID, profileID)
		input.ProfileID = profileID
		assertSessionRejected(t, fixture.backing, input)
	}
}

// End-to-end through the real HTTP server with a fake daemon over WS (no
// worker process, no inference): a server-owned profile selection creates the
// session (201) and dispatches a run_session envelope carrying the authoritative
// profile definition to the owning device.
func TestProjectedServerAgentSessionCreatesAndDispatches(t *testing.T) {
	backing := newSecretTestStore(t)
	server := NewServer(backing)
	testServer := httptest.NewServer(server.Routes())
	defer testServer.Close()

	wsURL := "ws" + strings.TrimPrefix(testServer.URL, "http") + "/api/daemon/ws"
	conn, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("dial daemon websocket: %v", err)
	}
	defer conn.Close()
	writeWSForTest(t, conn, "hello", map[string]any{
		"device": map[string]any{
			"id": "dev_fake", "label": "Studio", "status": "connected", "lastSeenLabel": "online",
		},
		"workspace": map[string]any{
			"id": "ws_fake", "name": "Foundry", "localPath": t.TempDir(),
			"baseline": "main", "contextSummary": "", "acceptedCount": 0, "resolvedCount": 0,
		},
		"providerHealth": []map[string]any{},
		"assets":         []map[string]any{},
	})
	readWSTypeForTest(t, conn, "registered")

	profile, err := backing.SaveProfile(context.Background(), store.SaveProfileInput{
		Runtime: "claude", Label: "Super Relay",
		ConnectionType: "anthropic_compatible", BaseURL: "https://relay.internal",
	})
	if err != nil {
		t.Fatalf("save profile: %v", err)
	}
	if err := backing.SetDeviceProfiles(context.Background(), store.SetDeviceProfilesInput{
		DeviceID: "dev_fake", ProfileIDs: []string{profile.ID},
	}); err != nil {
		t.Fatalf("bind profile: %v", err)
	}

	agentID := store.ServerAgentID("dev_fake", "ws_fake", profile.ID)
	body := `{"agentId":` + jsonString(agentID) +
		`,"workspaceId":"ws_fake","provider":"claude","profileId":` + jsonString(profile.ID) +
		`,"prompt":"synthetic","source":"chat"}`
	response, err := http.Post(testServer.URL+"/api/agent-sessions", "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatalf("post session: %v", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusCreated {
		raw, _ := io.ReadAll(response.Body)
		t.Fatalf("create session status = %d, want 201: %s", response.StatusCode, raw)
	}
	var session store.AgentSession
	if err := json.NewDecoder(response.Body).Decode(&session); err != nil {
		t.Fatalf("decode session: %v", err)
	}
	if session.DeviceID != "dev_fake" || session.ProfileID != profile.ID || session.Provider != "claude" {
		t.Fatalf("dispatched session identity = %s/%s/%s", session.DeviceID, session.ProfileID, session.Provider)
	}

	var envelope struct {
		Type    string `json:"type"`
		Payload struct {
			Session struct {
				ID        string `json:"id"`
				DeviceID  string `json:"deviceId"`
				ProfileID string `json:"profileId"`
			} `json:"session"`
			Profile *struct {
				ID      string `json:"id"`
				BaseURL string `json:"baseUrl"`
			} `json:"profile"`
			Credential string `json:"credential"`
		} `json:"payload"`
	}
	if err := conn.SetReadDeadline(time.Now().Add(3 * time.Second)); err != nil {
		t.Fatalf("read deadline: %v", err)
	}
	if err := conn.ReadJSON(&envelope); err != nil {
		t.Fatalf("read dispatch: %v", err)
	}
	if envelope.Type != "run_session" {
		t.Fatalf("dispatch type = %q, want run_session", envelope.Type)
	}
	if envelope.Payload.Session.ID != session.ID ||
		envelope.Payload.Session.DeviceID != "dev_fake" ||
		envelope.Payload.Session.ProfileID != profile.ID {
		t.Fatalf("dispatched envelope session = %+v", envelope.Payload.Session)
	}
	if envelope.Payload.Profile == nil ||
		envelope.Payload.Profile.ID != profile.ID ||
		envelope.Payload.Profile.BaseURL != "https://relay.internal" {
		t.Fatalf("dispatched profile = %+v", envelope.Payload.Profile)
	}
	// Keyless profile: no sealed credential is invented for the dispatch.
	if envelope.Payload.Credential != "" {
		t.Fatalf("keyless profile dispatched a credential: %q", envelope.Payload.Credential)
	}
}

// A removed device rejects session creation for a valid projection with 410.
func TestProjectedServerAgentSession410WhenDeviceRemoved(t *testing.T) {
	backing := newSecretTestStore(t)
	server := NewServer(backing)
	ctx := context.Background()
	const deviceID = "dev_gone"
	if err := backing.RegisterDaemon(ctx, store.DaemonRegistration{
		Device:    store.DeviceProjection{ID: deviceID, Label: "Studio", Status: "connected", LastSeenLabel: "just now"},
		Workspace: store.WorkspaceProjection{ID: "ws_gone", Name: "Foundry", LocalPath: t.TempDir()},
	}); err != nil {
		t.Fatalf("register daemon: %v", err)
	}
	profile, err := backing.SaveProfile(ctx, store.SaveProfileInput{
		Runtime: "claude", Label: "Relay",
		ConnectionType: "anthropic_compatible", BaseURL: "https://relay.internal",
	})
	if err != nil {
		t.Fatalf("save profile: %v", err)
	}
	if err := backing.SetDeviceProfiles(ctx, store.SetDeviceProfilesInput{
		DeviceID: deviceID, ProfileIDs: []string{profile.ID},
	}); err != nil {
		t.Fatalf("bind: %v", err)
	}
	if _, err := backing.SoftRemoveDevice(ctx, deviceID); err != nil {
		t.Fatalf("remove: %v", err)
	}
	// The 410 window is "tombstoned while a connection is still registered"
	// (removal normally drops the socket first, yielding 409). Inject the
	// stale connection to prove the store-level removed gate maps to 410
	// rather than creating work or surfacing a 500.
	server.hub.connections[deviceID] = &daemonConnection{
		deviceID:           deviceID,
		done:               make(chan struct{}),
		send:               make(chan wsEnvelope, 1),
		activeSessions:     map[string]bool{},
		dispatchedSessions: map[string]bool{},
	}
	body := `{"agentId":` + jsonString(store.ServerAgentID(deviceID, "ws_gone", profile.ID)) +
		`,"workspaceId":"ws_gone","provider":"claude","profileId":` + jsonString(profile.ID) +
		`,"prompt":"synthetic","source":"chat"}`
	response := requestForTest(t, server, http.MethodPost, "/api/agent-sessions", body, http.StatusGone)
	if !strings.Contains(response.Body.String(), "device_removed") {
		t.Fatalf("410 body = %q", response.Body.String())
	}
}
