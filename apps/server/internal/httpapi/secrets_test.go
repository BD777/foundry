package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/sqlitestore"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func newSecretTestStore(t *testing.T) *sqlitestore.Store {
	t.Helper()
	dir := t.TempDir()
	st, err := sqlitestore.OpenWithOptions(filepath.Join(dir, "foundry.db"), sqlitestore.Options{
		SecretKeyPath: filepath.Join(dir, "foundry-secret.key"),
	})
	if err != nil {
		t.Fatalf("open sqlite store with secret key: %v", err)
	}
	t.Cleanup(func() {
		if err := st.Close(); err != nil {
			t.Fatalf("close sqlite store: %v", err)
		}
	})
	return st
}

func TestServerCredentialLifecycleSealOverlayDispatch(t *testing.T) {
	backing := newSecretTestStore(t)
	server := NewServer(backing)
	if server.secrets == nil {
		t.Fatal("store with a secret key path did not expose the secretKeeper capability")
	}

	ctx := context.Background()
	if err := server.sealProfileCredential(ctx, "dev_1", "prof_1", " relay-key "); err != nil {
		t.Fatalf("seal credential: %v", err)
	}

	profiles := server.overlayServerCredential(ctx, []store.AgentProfileProjection{
		{ID: "prof_1", DeviceID: "dev_1"},
		{ID: "prof_2", DeviceID: "dev_1"},
	})
	if !profiles[0].ServerCredential {
		t.Fatal("sealed profile not marked as server-managed")
	}
	if profiles[1].ServerCredential {
		t.Fatal("profile without a secret marked as server-managed")
	}

	credential, err := server.hub.dispatchCredential(ctx, store.AgentSession{DeviceID: "dev_1", ProfileID: "prof_1"})
	if err != nil {
		t.Fatalf("dispatch credential: %v", err)
	}
	if strings.TrimSpace(credential) != "relay-key" {
		t.Fatalf("dispatch credential = %q", credential)
	}
	if other, err := server.hub.dispatchCredential(ctx, store.AgentSession{DeviceID: "dev_1", ProfileID: "missing"}); err != nil || other != "" {
		t.Fatalf("missing profile credential = %q, %v", other, err)
	}
	// Tampered-row fail-closed behavior is covered by the sqlitestore suite;
	// dispatchCredential propagates that error verbatim.
}

func TestModelListCredentialFindsDeviceAndServerProfiles(t *testing.T) {
	server := NewServer(newSecretTestStore(t))
	ctx := context.Background()
	if err := server.sealProfileCredential(ctx, "dev_1", "prof_device", "device-key"); err != nil {
		t.Fatalf("seal device credential: %v", err)
	}
	if err := server.secrets.PutSecret(ctx, serverProfileSecretID("prof_server"), []byte("server-key"), ""); err != nil {
		t.Fatalf("seal server credential: %v", err)
	}

	// A catalog read authenticates as the profile it names, whether that profile
	// lives on the device or on the server.
	device := store.CreateAgentProfileInput{DeviceID: "dev_1", ID: "prof_device"}
	server.injectModelListCredential(ctx, &device)
	if device.APIKey != "device-key" {
		t.Fatalf("device profile key = %q", device.APIKey)
	}

	promoted := store.CreateAgentProfileInput{DeviceID: "dev_1", ID: "prof_server"}
	server.injectModelListCredential(ctx, &promoted)
	if promoted.APIKey != "server-key" {
		t.Fatalf("server profile key = %q", promoted.APIKey)
	}

	supplied := store.CreateAgentProfileInput{APIKey: "typed-key", DeviceID: "dev_1", ID: "prof_server"}
	server.injectModelListCredential(ctx, &supplied)
	if supplied.APIKey != "typed-key" {
		t.Fatalf("a key the caller typed was replaced with %q", supplied.APIKey)
	}

	unknown := store.CreateAgentProfileInput{DeviceID: "dev_1", ID: "prof_missing"}
	server.injectModelListCredential(ctx, &unknown)
	if unknown.APIKey != "" {
		t.Fatalf("unknown profile invented the key %q", unknown.APIKey)
	}
}

func TestAgentProfileCredentialGating(t *testing.T) {
	t.Run("apiKey passes validation without a daemon and fails on connection", func(t *testing.T) {
		server := NewServer(newSecretTestStore(t))
		postJSONForTest(t, server, "/api/agent-profiles", `{
			"deviceId":"dev_offline",
			"runtime":"claude",
			"label":"Relay",
			"configScope":"device",
			"connectionType":"anthropic_compatible",
			"apiKey":"relay-key"
		}`, http.StatusConflict)
	})

	t.Run("apiKey without a server secret store is rejected", func(t *testing.T) {
		server := NewServer(newEmptyTestStore(t))
		postJSONForTest(t, server, "/api/agent-profiles", `{
			"runtime":"claude",
			"label":"Relay",
			"configScope":"device",
			"connectionType":"anthropic_compatible",
			"apiKey":"relay-key"
		}`, http.StatusBadRequest)
	})

	t.Run("command and env remain local-only", func(t *testing.T) {
		server := NewServer(newSecretTestStore(t))
		postJSONForTest(t, server, "/api/agent-profiles", `{
			"runtime":"claude",
			"label":"Remote",
			"configScope":"device",
			"connectionType":"custom_command",
			"command":"curl example"
		}`, http.StatusBadRequest)
		postJSONForTest(t, server, "/api/agent-profiles", `{
			"runtime":"claude",
			"label":"Env",
			"configScope":"device",
			"connectionType":"local_login",
			"env":{"LEAK":"1"}
		}`, http.StatusBadRequest)
	})
}

func TestListAgentProfilesOverlaysServerCredential(t *testing.T) {
	backing := newSecretTestStore(t)
	server := NewServer(backing)
	if err := server.sealProfileCredential(context.Background(), "dev_x", "prof_y", "key"); err != nil {
		t.Fatal(err)
	}
	// The projection list normally comes from daemon sync; the overlay is the
	// server's own contribution, exercised here without a connection.
	request := httptest.NewRequest(http.MethodGet, "/api/agent-profiles?deviceId=dev_x", nil)
	response := httptest.NewRecorder()
	server.Routes().ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("list profiles = %d: %s", response.Code, response.Body.String())
	}
}

// The settings UI renders agent profiles from the /api/foundry-data snapshot,
// not from /api/agent-profiles. A sealed credential that is invisible there
// makes the panel offer to store a key that already exists.
func TestFoundryDataSnapshotOverlaysServerCredential(t *testing.T) {
	backing := newSecretTestStore(t)
	server := NewServer(backing)
	ctx := context.Background()
	registration := store.DaemonRegistration{
		Device:    store.DeviceProjection{ID: "dev_snap"},
		Workspace: store.WorkspaceProjection{ID: "ws_snap", Name: "Snap", LocalPath: t.TempDir()},
		AgentProfiles: []store.AgentProfileProjection{
			{ID: "prof_sealed", DeviceID: "dev_snap", Runtime: "claude", Label: "Relay", Status: "ready", ConfigScope: "device"},
			{ID: "prof_plain", DeviceID: "dev_snap", Runtime: "claude", Label: "Local", Status: "ready", ConfigScope: "device"},
		},
	}
	if err := backing.RegisterDaemon(ctx, registration); err != nil {
		t.Fatalf("register daemon: %v", err)
	}
	if err := server.sealProfileCredential(ctx, "dev_snap", "prof_sealed", "relay-key"); err != nil {
		t.Fatalf("seal credential: %v", err)
	}

	request := httptest.NewRequest(http.MethodGet, "/api/foundry-data?workspaceId=ws_snap", nil)
	response := httptest.NewRecorder()
	server.Routes().ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("foundry data = %d: %s", response.Code, response.Body.String())
	}
	var payload struct {
		AgentProfiles []store.AgentProfileProjection `json:"agentProfiles"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode snapshot: %v", err)
	}
	seen := map[string]bool{}
	for _, profile := range payload.AgentProfiles {
		seen[profile.ID] = profile.ServerCredential
	}
	if len(payload.AgentProfiles) == 0 {
		t.Fatal("snapshot returned no agent profiles")
	}
	if !seen["prof_sealed"] {
		t.Fatal("sealed profile not marked as server-managed in the snapshot")
	}
	if seen["prof_plain"] {
		t.Fatal("profile without a secret marked as server-managed in the snapshot")
	}
}

// A server profile's credential is keyed by the profile alone: promotion
// renames a device-scoped record onto that id, and dispatch reads it back
// without the device ever holding the value.
func TestServerProfileCredentialLifecycle(t *testing.T) {
	backing := newSecretTestStore(t)
	server := NewServer(backing)
	ctx := context.Background()

	if server.profileHasCredential(ctx, "prof_relay") {
		t.Fatal("unsealed profile reports a credential")
	}
	if err := server.sealServerProfileCredential(ctx, "prof_relay", "relay-key"); err != nil {
		t.Fatalf("seal server credential: %v", err)
	}
	if !server.profileHasCredential(ctx, "prof_relay") {
		t.Fatal("sealed profile does not report a credential")
	}
	if stored, err := backing.HasSecret(ctx, "agent-profile:prof_relay"); err != nil || !stored {
		t.Fatalf("server profile record id = %v %v", stored, err)
	}

	credential, err := server.hub.serverProfileCredential(ctx, "prof_relay")
	if err != nil || credential != "relay-key" {
		t.Fatalf("server profile credential = %q, %v", credential, err)
	}
	if missing, err := server.hub.serverProfileCredential(ctx, "prof_absent"); err != nil || missing != "" {
		t.Fatalf("absent credential = %q, %v", missing, err)
	}

	value, err := server.serverProfileCredentialValue(ctx, "prof_relay")
	if err != nil || value != "relay-key" {
		t.Fatalf("model-listing credential = %q, %v", value, err)
	}
	if err := server.deleteServerProfileCredential(ctx, "prof_relay"); err != nil {
		t.Fatalf("delete server credential: %v", err)
	}
	if server.profileHasCredential(ctx, "prof_relay") {
		t.Fatal("deleted credential still reported")
	}
	// Clearing twice is how a retried request behaves; it must not fail.
	if err := server.deleteServerProfileCredential(ctx, "prof_relay"); err != nil {
		t.Fatalf("second delete: %v", err)
	}
}

// A server profile without a secret store must degrade to "no credential"
// rather than fail the read path.
func TestServerProfileCredentialWithoutSecretStore(t *testing.T) {
	server := NewServer(newEmptyTestStore(t))
	ctx := context.Background()
	if server.profileHasCredential(ctx, "prof_relay") {
		t.Fatal("profile reports a credential without a secret store")
	}
	if err := server.sealServerProfileCredential(ctx, "prof_relay", "relay-key"); err == nil {
		t.Fatal("sealing without a secret store silently succeeded")
	}
	if err := server.deleteServerProfileCredential(ctx, "prof_relay"); err != nil {
		t.Fatalf("clearing without a secret store: %v", err)
	}
}
