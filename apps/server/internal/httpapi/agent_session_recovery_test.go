package httpapi

import (
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func TestStaleAgentSessionIsNotKeptAliveByUnrelatedDeviceConnection(t *testing.T) {
	now := time.Date(2026, 9, 3, 5, 0, 0, 0, time.UTC)
	session := store.AgentSession{
		DeviceID:       "device",
		ID:             "session",
		LastActivityAt: now.Add(-31 * time.Minute).Format(time.RFC3339Nano),
		Status:         "running",
	}

	message, stale := staleAgentSessionMessage(
		session,
		now,
		30*time.Minute,
		func(_, sessionID string) bool { return sessionID == "other-session" },
	)
	if !stale {
		t.Fatal("staleAgentSessionMessage() stale = false, want true")
	}
	if message == "" {
		t.Fatal("staleAgentSessionMessage() returned an empty explanation")
	}
}

func TestRecentAgentSessionHeartbeatKeepsRunAlive(t *testing.T) {
	now := time.Date(2026, 9, 3, 5, 0, 0, 0, time.UTC)
	session := store.AgentSession{
		DeviceID:       "device",
		ID:             "session",
		LastActivityAt: now.Add(-time.Minute).Format(time.RFC3339Nano),
		Status:         "running",
	}

	if _, stale := staleAgentSessionMessage(
		session,
		now,
		30*time.Minute,
		nil,
	); stale {
		t.Fatal("recent session heartbeat was marked stale")
	}
}

func TestActiveSessionClaimSurvivesStaleHeartbeatAcrossReconnect(t *testing.T) {
	now := time.Date(2026, 9, 3, 5, 0, 0, 0, time.UTC)
	session := store.AgentSession{
		DeviceID:       "device",
		ID:             "session",
		LastActivityAt: now.Add(-time.Hour).Format(time.RFC3339Nano),
		Status:         "running",
	}

	if _, stale := staleAgentSessionMessage(
		session,
		now,
		30*time.Minute,
		func(deviceID string, sessionID string) bool {
			return deviceID == "device" && sessionID == "session"
		},
	); stale {
		t.Fatal("same-process reconnect claim was marked stale")
	}
}
