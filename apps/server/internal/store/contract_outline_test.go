package store

import (
	"encoding/json"
	"slices"
	"strings"
	"testing"
)

// The outline answers each part, small enough to read before drafting, and its
// enums are the schema's own.
func TestContractOutlineAnswersEachPartWithTheSchemasValues(t *testing.T) {
	for _, part := range ContractPartNames() {
		outline, err := ContractOutline(part)
		if err != nil {
			t.Fatalf("part %s: %v", part, err)
		}
		if len(outline) > 2500 {
			t.Errorf("part %s is %d bytes, want at most 2500", part, len(outline))
		}
		var answer struct {
			Part     string                    `json:"part"`
			Required []string                  `json:"required"`
			Fields   map[string]map[string]any `json:"fields"`
		}
		if err := json.Unmarshal([]byte(outline), &answer); err != nil {
			t.Fatalf("part %s is not JSON: %v", part, err)
		}
		if answer.Part != part || len(answer.Required) == 0 || len(answer.Fields) == 0 {
			t.Fatalf("part %s answered %+v", part, answer)
		}
	}

	criterion, err := ContractOutline("criterion")
	if err != nil {
		t.Fatal(err)
	}
	var answer struct {
		Fields map[string]struct {
			Type   string   `json:"type"`
			Values []string `json:"values"`
		} `json:"fields"`
	}
	if err := json.Unmarshal([]byte(criterion), &answer); err != nil {
		t.Fatal(err)
	}
	if got := answer.Fields["proofKind"].Values; !slices.Equal(got, []string{"functional", "visual_interaction", "quality", "data_correctness", "content_completeness", "constraint_compliance", "other"}) {
		t.Errorf("proofKind values %v", got)
	}
	if got := answer.Fields["evaluationMode"].Values; !slices.Equal(got, []string{"deterministic", "agent"}) {
		t.Errorf("evaluationMode values %v", got)
	}
	if answer.Fields["proofKind"].Type != "enum" {
		t.Errorf("proofKind is %q, want enum", answer.Fields["proofKind"].Type)
	}
}

func TestContractOutlineRefusesAnUnknownPart(t *testing.T) {
	if _, err := ContractOutline("everything"); err == nil || !strings.Contains(err.Error(), "part is one of") {
		t.Fatalf("an unknown part: %v", err)
	}
}

// A validation problem that names an enum field gets its allowed values; one
// that names none is left alone.
func TestContractProblemHintsNameTheAllowedValues(t *testing.T) {
	problem := "ContractContent/criteria/0: missing properties 'proofKind', 'evaluationMode', 'rubric', 'evidenceRequirements'"
	hinted := ContractProblemHints(problem)
	for _, want := range []string{
		"proofKind: functional, visual_interaction, quality",
		"evaluationMode: deterministic, agent",
	} {
		if !strings.Contains(hinted, want) {
			t.Errorf("hint %q lacks %q", hinted, want)
		}
	}
	if !strings.HasPrefix(hinted, problem) {
		t.Errorf("hint changed the problem itself: %q", hinted)
	}
	const plain = "ContractContent/goal: blank string"
	if got := ContractProblemHints(plain); got != plain {
		t.Errorf("a problem with no enum field changed to %q", got)
	}
}
