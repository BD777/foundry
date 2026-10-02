package store

import "slices"

// ExitRulesVersion names the rule set a review is judged by. Change the
// version whenever a rule's meaning or the blockers it covers change.
const ExitRulesVersion = "foundry-exit-rules/v1"

// ExitRule is one numbered condition every review must meet before Accept,
// held when none of its blockers is present.
type ExitRule struct {
	ID       string
	Name     string
	Blockers []ReviewBlockerCode
}

// ExitRules, in order. Every review blocker belongs to exactly one rule.
var ExitRules = []ExitRule{
	{ID: "R1", Name: "contract confirmed", Blockers: []ReviewBlockerCode{"contract_unconfirmed", "contract_amendment_pending"}},
	{ID: "R2", Name: "candidate current", Blockers: []ReviewBlockerCode{"candidate_changed", "baseline_changed"}},
	{ID: "R3", Name: "every required criterion judged", Blockers: []ReviewBlockerCode{"checker_missing", "verification_pending", "verification_error"}},
	{ID: "R4", Name: "every required criterion passed", Blockers: []ReviewBlockerCode{"required_failed", "required_inconclusive"}},
	{ID: "R5", Name: "evidence available", Blockers: []ReviewBlockerCode{"evidence_missing", "material_unavailable"}},
	{ID: "R6", Name: "judgments current", Blockers: []ReviewBlockerCode{"stale", "input_unbound"}},
}

// EvaluateExitRules says which rules the review's blockers break.
func EvaluateExitRules(blockers []ReviewBlocker) ExitRuleResults {
	results := ExitRuleResults{Version: ExitRulesVersion, Results: []ExitRuleResult{}}
	for _, rule := range ExitRules {
		result := ExitRuleResult{RuleID: rule.ID, BlockerCodes: []ReviewBlockerCode{}}
		for _, blocker := range blockers {
			for _, code := range rule.Blockers {
				if blocker.Code == code && !slices.Contains(result.BlockerCodes, code) {
					result.BlockerCodes = append(result.BlockerCodes, code)
				}
			}
		}
		result.Satisfied = len(result.BlockerCodes) == 0
		results.Results = append(results.Results, result)
	}
	return results
}
