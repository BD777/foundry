package sessions

import (
	"strings"
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

	message, stale := staleMessage(
		session,
		now,
		30*time.Minute,
		func(_, sessionID string) Claim { return Claim{Held: sessionID == "other-session"} },
	)
	if !stale {
		t.Fatal("staleMessage() stale = false, want true")
	}
	if message == "" {
		t.Fatal("staleMessage() returned an empty explanation")
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

	if _, stale := staleMessage(
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

	if _, stale := staleMessage(
		session,
		now,
		30*time.Minute,
		func(deviceID string, sessionID string) Claim {
			return Claim{Held: deviceID == "device" && sessionID == "session"}
		},
	); stale {
		t.Fatal("same-process reconnect claim was marked stale")
	}
}

// DEV-144: a session waiting 31 minutes on its own background task sent no
// events; its device still claimed it in every heartbeat, and the socket
// dropped for a few seconds. The claim's time keeps it alive between
// connections.
func TestRecentClaimKeepsSilentSessionAliveBetweenConnections(t *testing.T) {
	now := time.Date(2026, 11, 5, 18, 34, 20, 0, time.UTC)
	session := store.AgentSession{
		DeviceID:       "device",
		ID:             "session",
		LastActivityAt: now.Add(-31 * time.Minute).Format(time.RFC3339Nano),
		Status:         "running",
	}
	claims := func(deviceID string, sessionID string) Claim {
		if deviceID != "device" || sessionID != "session" {
			return Claim{}
		}
		return Claim{ConfirmedAt: now.Add(-20 * time.Second)}
	}
	if _, stale := staleMessage(session, now, 30*time.Minute, claims); stale {
		t.Fatal("a session its device claimed 20 s ago was marked stale")
	}
}

func TestSessionGoesStaleOnceItsDeviceStopsClaimingIt(t *testing.T) {
	now := time.Date(2026, 11, 5, 18, 34, 20, 0, time.UTC)
	session := store.AgentSession{
		DeviceID:       "device",
		ID:             "session",
		LastActivityAt: now.Add(-2 * time.Hour).Format(time.RFC3339Nano),
		Status:         "running",
	}
	// The worker went away (or restarted without the session) 31 minutes
	// ago: its last claim is as old as that.
	claims := func(string, string) Claim { return Claim{ConfirmedAt: now.Add(-31 * time.Minute)} }
	message, stale := staleMessage(session, now, 30*time.Minute, claims)
	if !stale {
		t.Fatal("a session no device claimed for 31 minutes was kept")
	}
	if !strings.Contains(message, "for 31m0s") {
		t.Fatalf("message = %q, want the time since the last claim", message)
	}
}

func TestClaimOfAnotherDeviceDoesNotKeepSessionAlive(t *testing.T) {
	now := time.Date(2026, 11, 5, 18, 34, 20, 0, time.UTC)
	session := store.AgentSession{
		DeviceID:       "device",
		ID:             "session",
		LastActivityAt: now.Add(-31 * time.Minute).Format(time.RFC3339Nano),
		Status:         "running",
	}
	claims := func(deviceID string, _ string) Claim {
		if deviceID == "device" {
			return Claim{}
		}
		return Claim{Held: true, ConfirmedAt: now}
	}
	if _, stale := staleMessage(session, now, 30*time.Minute, claims); !stale {
		t.Fatal("another device's claim kept the session alive")
	}
}
