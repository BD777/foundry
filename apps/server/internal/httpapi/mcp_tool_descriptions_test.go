package httpapi

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestMCPGenericToolDescriptionsStateContractsWithoutWorkflowPolicy(t *testing.T) {
	targets := map[string]bool{
		"list_resources":        true,
		"model_guides":          true,
		"get_execution_default": true,
		"create_session":        true,
		"send_message":          true,
		"create_scheduled_work": true,
		"ask_person":            true,
		"list_issues":           true,
		"read_knowledge":        true,
	}
	policy := []string{"prefer", "normally", "never choose", "start a session for", "use only the default"}
	total := 0
	seen := map[string]bool{}
	for _, tool := range remoteMCPTools {
		if !targets[tool.name] {
			continue
		}
		var definition struct {
			Description string `json:"description"`
		}
		if err := json.Unmarshal(tool.definition, &definition); err != nil {
			t.Fatalf("%s: %v", tool.name, err)
		}
		seen[tool.name] = true
		total += len(definition.Description)
		lower := strings.ToLower(definition.Description)
		for _, phrase := range policy {
			if strings.Contains(lower, phrase) {
				t.Errorf("%s description contains workflow policy %q: %s", tool.name, phrase, definition.Description)
			}
		}
	}
	if len(seen) != len(targets) {
		t.Fatalf("found %d of %d target tools", len(seen), len(targets))
	}
	if total > 5200 {
		t.Errorf("target descriptions total %d characters, want at most 5200", total)
	}
}
