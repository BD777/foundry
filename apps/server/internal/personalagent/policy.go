package personalagent

import (
	"fmt"
	"slices"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// The policy (§4) is checked by the server on every write tool call; a
// prompt that lost "ask me first" in compaction changes nothing.

// ValidAction reports whether action is a managed action, a policy key.
// Actions that are never allowed have none.
func ValidAction(action string) bool { return slices.Contains(store.PersonalAgentActions, action) }

// ValidDecision reports whether decision is auto, ask or deny.
func ValidDecision(decision string) bool {
	switch decision {
	case store.PersonalAgentAuto, store.PersonalAgentAsk, store.PersonalAgentDeny:
		return true
	}
	return false
}

// strictness orders decisions: deny holds the assistant back most.
var strictness = map[string]int{store.PersonalAgentAuto: 0, store.PersonalAgentAsk: 1, store.PersonalAgentDeny: 2}

// Decide is what the policy says for one action: a key the policy lacks
// takes the default, an unknown action is denied.
func Decide(policy store.PersonalAgentPolicy, action string) string {
	if !ValidAction(action) {
		return store.PersonalAgentDeny
	}
	if decision, ok := policy[action]; ok && ValidDecision(decision) {
		return decision
	}
	return DefaultPolicy()[action]
}

// Tightens reports whether moving from one decision to another makes the
// assistant ask more or do less; staying the same also counts.
func Tightens(from, to string) bool { return strictness[to] >= strictness[from] }

// Strictest is the stricter of two decisions.
func Strictest(a, b string) string {
	if strictness[a] >= strictness[b] {
		return a
	}
	return b
}

// CompletePolicy is policy with every managed action decided: missing keys
// take the default. Unknown keys and decisions are an error.
func CompletePolicy(policy store.PersonalAgentPolicy) (store.PersonalAgentPolicy, error) {
	complete := DefaultPolicy()
	for action, decision := range policy {
		if !ValidAction(action) {
			return nil, fmt.Errorf("%q is not an action the assistant can be allowed to take", action)
		}
		if !ValidDecision(decision) {
			return nil, fmt.Errorf("%s: %q is not auto, ask or deny", action, decision)
		}
		complete[action] = decision
	}
	return complete, nil
}

// RuleChange is what update_rules does with a change: Apply at once when
// it tightens, Propose when it loosens.
type RuleChange struct {
	Apply   bool
	Propose bool
	From    string
}

// PlanRuleChange checks an update_rules change against the policy.
func PlanRuleChange(policy store.PersonalAgentPolicy, change store.PersonalAgentRuleChange) (RuleChange, error) {
	if !ValidAction(change.Action) {
		return RuleChange{}, fmt.Errorf("%q is not an action the rules cover; deleting, sharing, device settings and projects the person does not own are never allowed", change.Action)
	}
	if !ValidDecision(change.Decision) {
		return RuleChange{}, fmt.Errorf("decision must be auto, ask or deny, not %q", change.Decision)
	}
	from := Decide(policy, change.Action)
	if Tightens(from, change.Decision) {
		return RuleChange{Apply: true, From: from}, nil
	}
	return RuleChange{Propose: true, From: from}, nil
}

// WithRule is policy with one action's decision changed.
func WithRule(policy store.PersonalAgentPolicy, change store.PersonalAgentRuleChange) store.PersonalAgentPolicy {
	next := store.PersonalAgentPolicy{}
	for action, decision := range policy {
		next[action] = decision
	}
	next[change.Action] = change.Decision
	return next
}
