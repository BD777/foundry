package store

import (
	"encoding/json"
	"os"
	"testing"
)

// Every review blocker the protocol defines belongs to exactly one rule.
func TestEveryReviewBlockerBelongsToOneExitRule(t *testing.T) {
	raw, err := os.ReadFile("evidence-schema.json")
	if err != nil {
		t.Fatal(err)
	}
	var schema struct {
		Defs map[string]struct {
			Enum []string `json:"enum"`
		} `json:"$defs"`
	}
	if err := json.Unmarshal(raw, &schema); err != nil {
		t.Fatal(err)
	}
	codes := schema.Defs["ReviewBlockerCode"].Enum
	if len(codes) == 0 {
		t.Fatal("the schema lists no review blocker codes")
	}
	for _, code := range codes {
		owners := 0
		for _, rule := range ExitRules {
			for _, blocker := range rule.Blockers {
				if blocker == code {
					owners++
				}
			}
		}
		if owners != 1 {
			t.Errorf("blocker %s belongs to %d exit rules, want 1", code, owners)
		}
	}
	results := EvaluateExitRules([]ReviewBlocker{{Code: "required_failed"}, {Code: "required_failed"}, {Code: "stale"}})
	broken := map[string][]string{}
	for _, result := range results.Results {
		if !result.Satisfied {
			broken[result.RuleID] = result.BlockerCodes
		}
	}
	if results.Version != ExitRulesVersion || len(results.Results) != len(ExitRules) || len(broken) != 2 || len(broken["R4"]) != 1 || len(broken["R6"]) != 1 {
		t.Fatalf("exit rules = %+v", results)
	}
}
