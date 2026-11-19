package httpapi

import (
	"encoding/json"
	"slices"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func TestListModelsCarriesEachModelsEfforts(t *testing.T) {
	profile := store.AgentProfileProjection{ID: "codex_official", Runtime: "codex"}
	models := []store.AgentModelOption{{
		ID:                     "gpt-6-astra",
		Label:                  "GPT-6-Astra",
		ReasoningEfforts:       []string{"low", "medium", "high", "xhigh", "max", "ultra"},
		DefaultReasoningEffort: "medium",
	}}
	answer, err := pageAgentModelsForMCP(profile, models, map[string]json.RawMessage{})
	if err != nil {
		t.Fatal(err)
	}
	var page mcpModelPage
	if err := json.Unmarshal([]byte(answer), &page); err != nil {
		t.Fatal(err)
	}
	if len(page.Models) != 1 {
		t.Fatalf("listed %d models, want 1: %s", len(page.Models), answer)
	}
	listed := page.Models[0]
	if !slices.Equal(listed.ReasoningEfforts, models[0].ReasoningEfforts) || listed.DefaultReasoningEffort != "medium" {
		t.Fatalf("model lists efforts %v (default %q), want the catalog's: %s", listed.ReasoningEfforts, listed.DefaultReasoningEffort, answer)
	}
}
