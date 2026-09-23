package httpapi

import (
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// Promotion must not make a profile look like it left the machine: the device
// keeps its row, tagged with the server profile it became.
func TestPromotedProfileKeepsItsDeviceRow(t *testing.T) {
	rows := []store.AgentProfileProjection{{
		ID:             "claude_local",
		DeviceID:       "dev_1",
		Runtime:        "claude",
		Label:          "team-relay",
		BaseURL:        "https://relay.internal",
		ConnectionType: "anthropic_compatible",
		Origin:         profileOriginDevice,
	}}

	rows = markPromotedDeviceProfile(rows, "dev_1", store.ProfileDefinition{
		ID:      "claude_local",
		Runtime: "claude",
		BaseURL: "https://relay.internal",
	})
	rows = upsertAgentProfileRow(rows, store.AgentProfileProjection{
		ID:       "claude_local",
		DeviceID: "dev_1",
		Runtime:  "claude",
		Label:    "team-relay",
		Origin:   profileOriginServer,
	})

	if len(rows) != 2 {
		t.Fatalf("expected the device row beside the server row, got %+v", rows)
	}
	if rows[0].Origin != profileOriginDevice || rows[0].PromotedProfileID != "claude_local" {
		t.Fatalf("device row lost its promotion tag: %+v", rows[0])
	}
	if rows[1].Origin != profileOriginServer {
		t.Fatalf("server row missing: %+v", rows[1])
	}
}

// A profile discovered after promotion carries a different id, so the endpoint
// is what identifies it.
func TestPromotionTagMatchesOnEndpoint(t *testing.T) {
	rows := []store.AgentProfileProjection{
		{
			ID:       "claude_env_endpoint",
			DeviceID: "dev_1",
			Runtime:  "claude",
			BaseURL:  "https://relay.internal",
			Origin:   profileOriginDevice,
		},
		{
			ID:       "codex_local",
			DeviceID: "dev_1",
			Runtime:  "codex",
			Origin:   profileOriginDevice,
		},
	}

	rows = markPromotedDeviceProfile(rows, "dev_1", store.ProfileDefinition{
		ID:      "prof_generated",
		Runtime: "claude",
		BaseURL: "https://relay.internal",
	})

	if rows[0].PromotedProfileID != "prof_generated" {
		t.Fatalf("endpoint match failed: %+v", rows[0])
	}
	if rows[1].PromotedProfileID != "" {
		t.Fatalf("unrelated profile was tagged: %+v", rows[1])
	}
}

// Another device running the same server profile must not tag this device's
// rows.
func TestPromotionTagIsScopedToTheDevice(t *testing.T) {
	rows := []store.AgentProfileProjection{{
		ID:       "claude_local",
		DeviceID: "dev_1",
		Runtime:  "claude",
		BaseURL:  "https://relay.internal",
		Origin:   profileOriginDevice,
	}}

	rows = markPromotedDeviceProfile(rows, "dev_2", store.ProfileDefinition{
		ID:      "claude_local",
		Runtime: "claude",
		BaseURL: "https://relay.internal",
	})

	if rows[0].PromotedProfileID != "" {
		t.Fatalf("a different device's binding tagged this row: %+v", rows[0])
	}
}
