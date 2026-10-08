package httpapi

import (
	"encoding/json"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// A worker one build behind still registers: the fields it reports that this
// server dropped are ignored, not a reason to refuse it.
func TestWorkerPayloadToleratesFieldsFromOtherBuilds(t *testing.T) {
	payload := json.RawMessage(`{"id":"codex_provider_aiden","label":"Aiden","keySet":true,"keyFingerprint":"aa11"}`)
	var profile store.AgentProfileProjection
	if err := decodeWebSocketPayload(payload, &profile); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if profile.ID != "codex_provider_aiden" || profile.Label != "Aiden" {
		t.Fatalf("decoded %+v", profile)
	}
	if err := decodeWebSocketPayload(json.RawMessage(`{"id":"a"} {"id":"b"}`), &profile); err == nil {
		t.Fatal("two JSON values must still be refused")
	}
}
