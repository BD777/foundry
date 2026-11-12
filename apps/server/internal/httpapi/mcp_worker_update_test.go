package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

type workerUpdateMCPStatus struct {
	DeviceID      string                    `json:"deviceId"`
	Online        bool                      `json:"online"`
	Connection    string                    `json:"connection"`
	WorkerVersion string                    `json:"workerVersion"`
	ServerVersion string                    `json:"serverVersion"`
	State         string                    `json:"state"`
	InProgress    bool                      `json:"inProgress"`
	ElapsedMs     int64                     `json:"elapsedMs"`
	Message       string                    `json:"message"`
	Update        *store.DeviceWorkerUpdate `json:"update"`
}

func configureWorkerReleaseForTest(t *testing.T, f *externalAccountsFixture, version string) {
	t.Helper()
	dir := t.TempDir()
	manifest := `{"version":"` + version + `","packages":[{"name":"@bd777/foundry-worker","file":"worker.tgz"}]}`
	if err := os.WriteFile(filepath.Join(dir, "release.json"), []byte(manifest), 0o600); err != nil {
		t.Fatal(err)
	}
	f.server.options.WorkerPackagesDir = dir
}

func setStoredWorkerVersion(t *testing.T, f *externalAccountsFixture, deviceID, version string) {
	t.Helper()
	suffix := strings.TrimPrefix(deviceID, "dev_")
	workspaceID := "ws_" + suffix
	if err := f.db.RegisterDaemon(context.Background(), store.DaemonRegistration{
		Device:    store.DeviceProjection{ID: deviceID, Label: "Device", Status: "connected", Worker: &store.DeviceWorker{Version: version}},
		Workspace: store.WorkspaceProjection{ID: workspaceID, Name: "W", LocalPath: "/tmp/" + workspaceID},
		Agents: []store.AgentProjection{{
			ID: "agent_" + suffix, WorkspaceID: workspaceID, DeviceID: deviceID, Provider: "claude", Status: "healthy",
			AuthMode: "local_config", SecretStored: "local", ConfigScope: "workspace", ConfigLabel: "local", LastSeenLabel: "online",
		}},
	}); err != nil {
		t.Fatal(err)
	}
}

func attachUpdateWorkerForTest(t *testing.T, f *externalAccountsFixture, deviceID, version string) *daemonConnection {
	t.Helper()
	connection := newDaemonConnection(f.server.hub, nil)
	connection.deviceID = deviceID
	connection.registration = store.DaemonRegistration{
		Device: store.DeviceProjection{ID: deviceID, Worker: &store.DeviceWorker{Version: version}},
	}
	f.server.hub.mu.Lock()
	f.server.hub.connections[deviceID] = connection
	f.server.hub.mu.Unlock()
	t.Cleanup(func() {
		f.server.hub.mu.Lock()
		delete(f.server.hub.connections, deviceID)
		f.server.hub.mu.Unlock()
		close(connection.done)
	})
	return connection
}

func TestUpdateWorkerMCPStartsAndReportsOwnedDevice(t *testing.T) {
	f := newExternalAccountsFixture(t)
	configureWorkerReleaseForTest(t, f, "0.6.0")
	setStoredWorkerVersion(t, f, "dev_alice", "0.5.7")
	alice := f.providerSession(store.CreateAgentSessionInput{CreatedByUserID: f.aliceID})
	connection := attachUpdateWorkerForTest(t, f, "dev_alice", "0.5.7")
	asked := make(chan string, 8)
	go fakeUpdatingWorker(connection, []wsWorkerUpdateStatus{{State: "running", Step: "downloading", Version: "0.6.0"}}, asked)

	content, isError := mcpContentCall(t, f.handler, alice.token, "update_worker", map[string]any{
		"deviceId": "dev_alice", "action": "start",
	})
	if isError {
		t.Fatalf("start = %v", content)
	}
	var started struct {
		DeviceID      string `json:"deviceId"`
		UpdateID      string `json:"updateId"`
		Started       bool   `json:"started"`
		StartedAt     string `json:"startedAt"`
		Step          string `json:"step"`
		TargetVersion string `json:"targetVersion"`
		Log           string `json:"log"`
	}
	if err := json.Unmarshal([]byte(content[0]["text"].(string)), &started); err != nil {
		t.Fatal(err)
	}
	if !started.Started || started.DeviceID != "dev_alice" || !strings.HasPrefix(started.UpdateID, "wupd_") ||
		started.StartedAt == "" || started.Step != "starting" || started.TargetVersion != "0.6.0" ||
		started.Log != "/state/logs/self-update.log" {
		t.Fatalf("started = %+v", started)
	}
	if kind := <-asked; kind != wsUpdateWorkerType {
		t.Fatalf("asked %q, want %q", kind, wsUpdateWorkerType)
	}

	status := workerUpdateMCPStatusForTest(t, f, alice.token, map[string]any{"deviceId": "dev_alice"})
	if status.DeviceID != "dev_alice" || !status.Online || status.WorkerVersion != "0.5.7" || status.ServerVersion != "0.6.0" ||
		status.Connection != "online" || status.State != "in_progress" || !status.InProgress ||
		status.Update == nil || status.Update.ID != started.UpdateID || status.Update.StartedAt != started.StartedAt {
		t.Fatalf("status = %+v", status)
	}
}

func TestUpdateWorkerMCPRefusesOfflineOwnedDevice(t *testing.T) {
	f := newExternalAccountsFixture(t)
	configureWorkerReleaseForTest(t, f, "0.6.0")
	setStoredWorkerVersion(t, f, "dev_alice", "0.5.7")
	alice := f.providerSession(store.CreateAgentSessionInput{CreatedByUserID: f.aliceID})

	content, isError := mcpContentCall(t, f.handler, alice.token, "update_worker", map[string]any{
		"deviceId": "dev_alice", "action": "start",
	})
	if !isError || !strings.Contains(content[0]["text"].(string), "The device is offline") {
		t.Fatalf("offline start = %v", content)
	}
}

func TestUpdateWorkerMCPRefusesWorkspaceMembersAndMissingDevices(t *testing.T) {
	f := newExternalAccountsFixture(t)
	configureWorkerReleaseForTest(t, f, "0.6.0")
	setStoredWorkerVersion(t, f, "dev_alice", "0.5.7")
	expectStatus(t, doAuthCall(t, f.handler, f.as(f.alice, http.MethodPost, "/api/workspaces/ws_alice/members", `{"username":"bob","role":"member"}`)),
		http.StatusNoContent, "share alice's workspace")
	bob := f.providerSession(store.CreateAgentSessionInput{
		CreatedByUserID: f.bobID, WorkspaceID: "ws_bob", AgentID: "agent_bob",
	})
	for _, action := range []string{"start", "status"} {
		content, isError := mcpContentCall(t, f.handler, bob.token, "update_worker", map[string]any{
			"deviceId": "dev_alice", "action": action,
		})
		if !isError || !strings.Contains(content[0]["text"].(string), "not found among devices you own") {
			t.Fatalf("non-owner %s = %v", action, content)
		}
		if raw := content[0]["text"].(string); strings.Contains(raw, "0.5.7") || strings.Contains(raw, "0.6.0") {
			t.Fatalf("non-owner %s leaked a version: %s", action, raw)
		}
	}
	content, isError := mcpContentCall(t, f.handler, bob.token, "update_worker", map[string]any{
		"deviceId": "dev_missing", "action": "status",
	})
	if !isError || !strings.Contains(content[0]["text"].(string), "dev_missing") ||
		!strings.Contains(content[0]["text"].(string), "not found among devices you own") {
		t.Fatalf("missing device = %v", content)
	}
}

func TestUpdateWorkerMCPStatusReportsRunningStalledAndFailed(t *testing.T) {
	f := newExternalAccountsFixture(t)
	configureWorkerReleaseForTest(t, f, "0.6.0")
	setStoredWorkerVersion(t, f, "dev_alice", "0.5.7")
	attachUpdateWorkerForTest(t, f, "dev_alice", "0.5.7")
	alice := f.providerSession(store.CreateAgentSessionInput{CreatedByUserID: f.aliceID})
	now := time.Now().UTC()

	for _, test := range []struct {
		name    string
		update  store.DeviceWorkerUpdate
		state   string
		active  bool
		stalled bool
		failure string
	}{
		{
			name:   "running",
			update: store.DeviceWorkerUpdate{StartedAt: now.Format(time.RFC3339Nano), Version: "0.6.0", FromVersion: "0.5.7", Step: "downloading"},
			state:  "in_progress", active: true,
		},
		{
			name:   "stalled",
			update: store.DeviceWorkerUpdate{StartedAt: now.Add(-workerUpdateWindow).Format(time.RFC3339Nano), Version: "0.6.0", FromVersion: "0.5.7", Step: "installing"},
			state:  "stalled", active: true, stalled: true,
		},
		{
			name:   "failed",
			update: store.DeviceWorkerUpdate{StartedAt: now.Format(time.RFC3339Nano), Version: "0.6.0", FromVersion: "0.5.7", Step: "downloading", Failure: "download failed"},
			state:  "failed", active: true, failure: "download failed",
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			f.server.workerUpdates.start("dev_alice", test.update)
			status := workerUpdateMCPStatusForTest(t, f, alice.token, map[string]any{
				"deviceId": "dev_alice", "action": "status",
			})
			if status.State != test.state || status.InProgress != (test.state == "in_progress") ||
				status.ServerVersion != "0.6.0" || status.WorkerVersion != "0.5.7" || !status.Online {
				t.Fatalf("status = %+v", status)
			}
			if (status.Update != nil) != test.active {
				t.Fatalf("update = %+v, want active %v", status.Update, test.active)
			}
			if status.Update != nil && (status.Update.Stalled != test.stalled || status.Update.Failure != test.failure) {
				t.Fatalf("update = %+v, want stalled=%v failure=%q", status.Update, test.stalled, test.failure)
			}
		})
	}
}

func TestUpdateWorkerMCPStatusKeepsTheLastSuccessfulUpdate(t *testing.T) {
	f := newExternalAccountsFixture(t)
	configureWorkerReleaseForTest(t, f, "0.6.0")
	setStoredWorkerVersion(t, f, "dev_alice", "0.6.0")
	alice := f.providerSession(store.CreateAgentSessionInput{CreatedByUserID: f.aliceID})
	now := time.Now().UTC()
	f.server.workerUpdates.start("dev_alice", store.DeviceWorkerUpdate{
		ID:          "wupd_completed",
		StartedAt:   now.Add(-90 * time.Second).Format(time.RFC3339Nano),
		Version:     "0.6.0",
		FromVersion: "0.5.7",
		Step:        "downloading",
	})
	if _, active := f.server.workerUpdates.active("dev_alice", "0.6.0", now); active {
		t.Fatal("the device reports the target version: the update is complete")
	}

	status := workerUpdateMCPStatusForTest(t, f, alice.token, map[string]any{"deviceId": "dev_alice"})
	if status.State != "succeeded" || status.InProgress || status.WorkerVersion != "0.6.0" ||
		status.Update == nil || status.Update.ID != "wupd_completed" ||
		status.Update.FromVersion != "0.5.7" || status.Update.Version != "0.6.0" ||
		status.Update.CompletedAt == "" || status.ElapsedMs < 90_000 || !strings.Contains(status.Message, "updated from 0.5.7 to 0.6.0") {
		t.Fatalf("status = %+v", status)
	}
}

func TestUpdateWorkerMCPStatusExplainsRestartAsReconnecting(t *testing.T) {
	f := newExternalAccountsFixture(t)
	configureWorkerReleaseForTest(t, f, "0.6.0")
	setStoredWorkerVersion(t, f, "dev_alice", "0.5.7")
	attachUpdateWorkerForTest(t, f, "dev_alice", "0.5.7")
	alice := f.providerSession(store.CreateAgentSessionInput{CreatedByUserID: f.aliceID})
	now := time.Now().UTC()
	f.server.workerUpdates.start("dev_alice", store.DeviceWorkerUpdate{
		ID: "wupd_restarting", StartedAt: now.Add(-10 * time.Second).Format(time.RFC3339Nano),
		Version: "0.6.0", FromVersion: "0.5.7", Step: "restarting",
	})
	f.server.hub.mu.Lock()
	delete(f.server.hub.connections, "dev_alice")
	reconnect := &deviceReconnect{
		since: now, until: now.Add(time.Minute), done: make(chan struct{}), changed: make(chan struct{}),
	}
	f.server.hub.reconnects["dev_alice"] = reconnect
	f.server.hub.mu.Unlock()
	t.Cleanup(func() {
		f.server.hub.mu.Lock()
		delete(f.server.hub.reconnects, "dev_alice")
		f.server.hub.mu.Unlock()
		reconnect.notify()
	})

	status := workerUpdateMCPStatusForTest(t, f, alice.token, map[string]any{"deviceId": "dev_alice"})
	if status.Online || status.Connection != "reconnecting" || status.State != "in_progress" ||
		!status.InProgress || !strings.Contains(status.Message, "reconnecting after switching hosts") {
		t.Fatalf("status = %+v", status)
	}
}

func workerUpdateMCPStatusForTest(t *testing.T, f *externalAccountsFixture, token string, arguments map[string]any) workerUpdateMCPStatus {
	t.Helper()
	content, isError := mcpContentCall(t, f.handler, token, "update_worker", arguments)
	if isError {
		t.Fatalf("status = %v", content)
	}
	var status workerUpdateMCPStatus
	if err := json.Unmarshal([]byte(content[0]["text"].(string)), &status); err != nil {
		t.Fatal(err)
	}
	return status
}
