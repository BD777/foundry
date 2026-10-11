package store

import (
	"encoding/hex"
	"hash/fnv"
	"strings"
	"unicode"
)

// SubagentResponseFingerprint is a subagent's answer as a chat compares it
// with the main transcript: FNV-1a 64 of the UTF-8 of its text trimmed as
// JavaScript's String.prototype.trim trims, in hex. The web and workers
// compute the same (subagentResponseFingerprint in the protocol package);
// both are checked against packages/protocol/test/subagent-response-fixtures.json.
func SubagentResponseFingerprint(text string) string {
	hash := fnv.New64a()
	_, _ = hash.Write([]byte(strings.TrimFunc(text, javaScriptSpace)))
	return hex.EncodeToString(hash.Sum(nil))
}

// javaScriptSpace is what String.prototype.trim removes: Go's spaces but
// U+0085, and U+FEFF.
func javaScriptSpace(r rune) bool {
	return r == 0xFEFF || (r != 0x85 && unicode.IsSpace(r))
}

// Digest is the subagent as a chat lists it.
func (subagent AgentSubagentSummary) Digest() AgentSubagentDigest {
	fingerprints := make([]string, 0, len(subagent.ResponseTexts))
	seen := make(map[string]bool, len(subagent.ResponseTexts))
	for _, text := range subagent.ResponseTexts {
		if strings.TrimFunc(text, javaScriptSpace) == "" {
			continue
		}
		fingerprint := SubagentResponseFingerprint(text)
		if !seen[fingerprint] {
			seen[fingerprint] = true
			fingerprints = append(fingerprints, fingerprint)
		}
	}
	return AgentSubagentDigest{
		ResponseFingerprints: fingerprints,
		SessionID:            subagent.SessionID,
		Status:               subagent.Status,
		SubagentType:         subagent.SubagentType,
		TaskID:               subagent.TaskID,
		Title:                subagent.Title,
		ToolUseID:            subagent.ToolUseID,
		Usage:                subagent.Usage,
	}
}
