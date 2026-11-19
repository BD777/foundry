package store

import (
	"fmt"
	"strings"
)

func (input CreateIssueInput) ValidateRuntimeOptions() error {
	if input.CodexSpeed != "" && (input.Runtime != "codex" || (input.CodexSpeed != "standard" && input.CodexSpeed != "fast")) {
		return fmt.Errorf("invalid Codex speed")
	}
	for _, value := range []string{input.Model, input.ProfileID} {
		if len(value) > 256 || strings.ContainsAny(value, "\r\n\x00") {
			return fmt.Errorf("invalid Issue model or profile identifier")
		}
	}
	if input.ClaudeEffort != "" {
		if input.Runtime != "claude" {
			return fmt.Errorf("Claude effort requires Claude runtime")
		}
		switch input.ClaudeEffort {
		case "low", "medium", "high", "xhigh", "max":
		default:
			return fmt.Errorf("invalid Claude effort")
		}
	}
	if input.CodexReasoningEffort != "" {
		if input.Runtime != "codex" {
			return fmt.Errorf("Codex effort requires Codex runtime")
		}
		if !ValidCodexEffort(input.CodexReasoningEffort) {
			return fmt.Errorf("invalid Codex effort")
		}
	}
	return nil
}

// ValidCodexEffort reports whether effort has the shape of a Codex reasoning
// effort. Codex types the value as an open string that each model advertises
// in its own catalog, so the server keeps no list of values: the model decides
// which ones it accepts.
func ValidCodexEffort(effort string) bool {
	if effort == "" || len(effort) > 64 {
		return false
	}
	for _, character := range effort {
		if !(character >= 'a' && character <= 'z' || character >= '0' && character <= '9' || character == '-' || character == '_') {
			return false
		}
	}
	return true
}
