package store

import (
	"encoding/json"
	"os"
	"reflect"
	"testing"
)

// The web and workers fingerprint answers against the same fixtures
// (packages/protocol/test/subagent-responses.test.mjs).
func TestSubagentResponseFingerprintMatchesJavaScript(t *testing.T) {
	raw, err := os.ReadFile("../../../../packages/protocol/test/subagent-response-fixtures.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixtures []struct {
		Text        string `json:"text"`
		Fingerprint string `json:"fingerprint"`
	}
	if err := json.Unmarshal(raw, &fixtures); err != nil {
		t.Fatal(err)
	}
	if len(fixtures) == 0 {
		t.Fatal("no fixtures")
	}
	for _, fixture := range fixtures {
		if got := SubagentResponseFingerprint(fixture.Text); got != fixture.Fingerprint {
			t.Errorf("SubagentResponseFingerprint(%q) = %s, want %s", fixture.Text, got, fixture.Fingerprint)
		}
	}
}

func TestSubagentDigestKeepsWhatAChatShows(t *testing.T) {
	usage := &SubagentUsage{TotalTokens: 10, ToolUses: 1, DurationMs: 100}
	digest := AgentSubagentSummary{
		Prompt:        "Survey the repo",
		ResponseTexts: []string{"Three packages.", " Three packages.\n", "\u00a0", "Done."},
		SessionID:     "sess_1",
		Status:        "completed",
		SubagentType:  "Explore",
		TaskID:        "task_1",
		Title:         "Survey",
		ToolUseID:     "tool_1",
		Usage:         usage,
	}.Digest()
	want := AgentSubagentDigest{
		ResponseFingerprints: []string{SubagentResponseFingerprint("Three packages."), SubagentResponseFingerprint("Done.")},
		SessionID:            "sess_1",
		Status:               "completed",
		SubagentType:         "Explore",
		TaskID:               "task_1",
		Title:                "Survey",
		ToolUseID:            "tool_1",
		Usage:                usage,
	}
	if !reflect.DeepEqual(digest, want) {
		t.Fatalf("digest = %+v, want %+v", digest, want)
	}
	if encoded, _ := json.Marshal(AgentSubagentSummary{}.Digest()); string(encoded) != `{"responseFingerprints":[],"sessionId":"","status":"","taskId":"","title":"","toolUseId":""}` {
		t.Fatalf("empty digest encodes as %s", encoded)
	}
}
