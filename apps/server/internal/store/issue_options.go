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
		switch input.CodexReasoningEffort {
		case "minimal", "low", "medium", "high", "xhigh":
		default:
			return fmt.Errorf("invalid Codex effort")
		}
	}
	return nil
}
