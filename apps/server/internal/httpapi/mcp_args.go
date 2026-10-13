package httpapi

import (
	"encoding/json"
	"strconv"
	"strings"
)

// Reading a tool call's arguments. Models send loosely typed JSON ("true"
// for a boolean, "60000" for a number, a comma-separated string for a
// list), so each reader accepts the forms they use and falls back on
// anything else.

func mcpArgString(args map[string]json.RawMessage, key string) string {
	raw, ok := args[key]
	if !ok {
		return ""
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return ""
	}
	return strings.TrimSpace(value)
}

// mcpArgAlias reads an argument by its name, else by an older name that a
// session holding an earlier tool list may still send.
func mcpArgAlias(args map[string]json.RawMessage, key string, older ...string) string {
	for _, name := range append([]string{key}, older...) {
		if value := mcpArgString(args, name); value != "" {
			return value
		}
	}
	return ""
}

func mcpArgBool(args map[string]json.RawMessage, key string) bool {
	raw, ok := args[key]
	if !ok {
		return false
	}
	var value bool
	if json.Unmarshal(raw, &value) == nil {
		return value
	}
	// Models sometimes send "true" for a boolean.
	var text string
	return json.Unmarshal(raw, &text) == nil && strings.EqualFold(strings.TrimSpace(text), "true")
}

func mcpArgNumber(args map[string]json.RawMessage, key string, fallback int) int {
	raw, ok := args[key]
	if !ok {
		return fallback
	}
	var value float64
	if json.Unmarshal(raw, &value) != nil {
		// Models sometimes send "60000" for a number.
		var text string
		if json.Unmarshal(raw, &text) != nil {
			return fallback
		}
		parsed, err := strconv.ParseFloat(strings.TrimSpace(text), 64)
		if err != nil {
			return fallback
		}
		value = parsed
	}
	if value <= 0 {
		return fallback
	}
	return int(value)
}

// mcpArgList reads a list argument sent as an array or a comma-separated
// string.
func mcpArgList(args map[string]json.RawMessage, key string) []string {
	raw, ok := args[key]
	if !ok {
		return nil
	}
	var values []string
	if json.Unmarshal(raw, &values) != nil {
		var text string
		if json.Unmarshal(raw, &text) != nil {
			return nil
		}
		values = strings.Split(text, ",")
	}
	out := []string{}
	for _, value := range values {
		if value = strings.TrimSpace(value); value != "" {
			out = append(out, value)
		}
	}
	return out
}

// mcpSessionID reads a session argument given as an id or a Foundry link.
func mcpSessionID(args map[string]json.RawMessage, key string) string {
	return inspectedID(mcpArgString(args, key))
}

// maxMCPWaitMs bounds one waiting tool call. The worker gives the agent's MCP
// client a longer limit (foundryToolTimeoutMs), so the server always answers
// first; a caller that needs longer waits again.
const maxMCPWaitMs = 600_000

func mcpWaitMs(args map[string]json.RawMessage) int {
	wait := mcpArgNumber(args, "timeoutMs", maxMCPWaitMs)
	if wait <= 0 || wait > maxMCPWaitMs {
		return maxMCPWaitMs
	}
	return wait
}
