package httpapi

import (
	"encoding/json"
	"testing"
)

// A waiting tool call never outlasts the agent's MCP client limit.
func TestMCPWaitIsCappedBelowTheClientLimit(t *testing.T) {
	for raw, want := range map[string]int{
		`{}`:                     maxMCPWaitMs,
		`{"timeoutMs":30000}`:    30000,
		`{"timeoutMs":"45000"}`:  45000,
		`{"timeoutMs":36000000}`: maxMCPWaitMs,
		`{"timeoutMs":0}`:        maxMCPWaitMs,
		`{"timeoutMs":-5}`:       maxMCPWaitMs,
	} {
		var args map[string]json.RawMessage
		if err := json.Unmarshal([]byte(raw), &args); err != nil {
			t.Fatal(err)
		}
		if got := mcpWaitMs(args); got != want {
			t.Errorf("%s → %d, want %d", raw, got, want)
		}
	}
}
