package httpapi

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func TestHeartbeatStoresLatestRuntimeStateAsReported(t *testing.T) {
	db := newTestStore(t)
	ctx := context.Background()
	if err := db.RegisterDaemon(ctx, store.DaemonRegistration{
		Device: store.DeviceProjection{ID: "dev_runtime", Label: "Runtime", Status: "connected", LastSeenLabel: "online"},
	}); err != nil {
		t.Fatal(err)
	}
	hub := NewDaemonHub(db, newNotifiersForTest(nil).daemon(), "")
	hub.claims = newSessionClaims(time.Time{})
	connection := &daemonConnection{
		activeSessions: map[string]bool{},
		deviceID:       "dev_runtime",
		hub:            hub,
		registration: store.DaemonRegistration{
			Device: store.DeviceProjection{ID: "dev_runtime"},
		},
	}
	payload := json.RawMessage(`{
		"activeSessionIds": [],
		"runtimeState": {
			"capturedAt": "2026-11-10T02:00:00Z",
			"mode": "adaptive",
			"limit": 3,
			"running": 2,
			"queued": 1,
			"hardHold": false,
			"reasons": ["cpu_pressure_high"],
			"signals": {
				"cpuPressurePercent": 61.5,
				"memoryAvailableBytes": 2147483648
			},
			"estimates": [{
				"workspaceId": "ws_a",
				"runtime": "claude",
				"typicalRssBytes": 419430400,
				"peakRssBytes": 1610612736,
				"averageCpuCores": 0.3
			}]
		}
	}`)
	connection.noteHeartbeat(payload)

	devices, err := db.ListDevices(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var device *store.DeviceProjection
	for index := range devices {
		if devices[index].ID == "dev_runtime" {
			device = &devices[index]
			break
		}
	}
	if device == nil || device.RuntimeState == nil {
		t.Fatalf("runtime state not stored: %+v", devices)
	}
	got := device.RuntimeState
	if got.Mode != "adaptive" || got.Limit != 3 || got.Running != 2 || got.Queued != 1 {
		t.Fatalf("runtime state = %+v", got)
	}
	if got.Signals.MemoryAvailableBytes != 2<<30 ||
		len(got.Estimates) != 1 ||
		got.Estimates[0].PeakRssBytes != 3<<29 {
		t.Fatalf("runtime sample changed: %+v", got)
	}
}

func TestNormalizeAgentRuntimeSettingsInputAcceptsOldAndNewShapes(t *testing.T) {
	tests := []struct {
		name   string
		input  store.AgentRuntimeSettings
		mode   string
		limit  int
		notice string
	}{
		{
			name:   "old positive value becomes adaptive",
			input:  store.AgentRuntimeSettings{ActiveRuntimeTTLMs: 60_000, MaxConcurrentTasks: 7},
			mode:   "adaptive",
			notice: "adaptive_migrated",
		},
		{
			name:  "old zero becomes adaptive",
			input: store.AgentRuntimeSettings{ActiveRuntimeTTLMs: 60_000},
			mode:  "adaptive",
		},
		{
			name:  "forced keeps its value",
			input: store.AgentRuntimeSettings{ActiveRuntimeTTLMs: 60_000, Mode: "forced", ForcedLimit: 12},
			mode:  "forced",
			limit: 12,
		},
		{
			name:  "adaptive ignores a stale forced value",
			input: store.AgentRuntimeSettings{ActiveRuntimeTTLMs: 60_000, Mode: "adaptive", ForcedLimit: 9},
			mode:  "adaptive",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, err := normalizeAgentRuntimeSettingsInput(test.input)
			if err != nil {
				t.Fatal(err)
			}
			if got.Mode != test.mode || got.ForcedLimit != test.limit || got.MigrationNotice != test.notice {
				t.Fatalf("normalized = %+v", got)
			}
			if got.MaxConcurrentTasks != test.limit && !(test.mode == "adaptive" && got.MaxConcurrentTasks == 0) {
				t.Fatalf("legacy mirror = %+v", got)
			}
		})
	}
}

func TestNormalizeAgentRuntimeSettingsRejectsInvalidForcedLimit(t *testing.T) {
	for _, input := range []store.AgentRuntimeSettings{
		{ActiveRuntimeTTLMs: 60_000, MaxConcurrentTasks: 17},
		{ActiveRuntimeTTLMs: 60_000, Mode: "forced"},
		{ActiveRuntimeTTLMs: 60_000, Mode: "forced", ForcedLimit: 17},
		{ActiveRuntimeTTLMs: 60_000, Mode: "turbo"},
	} {
		if _, err := normalizeAgentRuntimeSettingsInput(input); err == nil {
			t.Fatalf("accepted invalid settings: %+v", input)
		}
	}
}
