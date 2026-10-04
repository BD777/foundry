package feishu

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

func TestCardsShowWorkerLabelsInChinese(t *testing.T) {
	for label, want := range map[string]string{
		"Using tool":    "正在使用工具",
		"正在使用工具":        "正在使用工具",
		"Bash · ls -la": "Bash · ls -la",
	} {
		if got := cardProcessLabel(label); got != want {
			t.Fatalf("cardProcessLabel(%q) = %q, want %q", label, got, want)
		}
	}
	for label, want := range map[string]bool{"Thinking": true, "Thought": true, "正在思考": true, "Ran command": false} {
		if got := isThinkingLabel(label); got != want {
			t.Fatalf("isThinkingLabel(%q) = %v", label, got)
		}
	}
}

// Every label the protocol defines must have a Chinese card label, so a label
// added to packages/protocol/src/process-labels.ts cannot reach a Feishu card
// in English.
func TestEveryProtocolProcessLabelHasAChineseCardLabel(t *testing.T) {
	source, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "packages", "protocol", "src", "process-labels.ts"))
	if err != nil {
		t.Fatal(err)
	}
	text := string(source)
	start := strings.Index(text, "export const processLabels = {")
	end := strings.Index(text, "} as const;")
	if start < 0 || end < start {
		t.Fatal("processLabels not found in process-labels.ts")
	}
	labels := regexp.MustCompile(`\w+:\s*"([^"]*)"`).FindAllStringSubmatch(text[start:end], -1)
	if len(labels) < 30 {
		t.Fatalf("parsed only %d protocol labels", len(labels))
	}
	for _, match := range labels {
		if _, ok := chineseProcessLabels[match[1]]; !ok {
			t.Errorf("no Chinese card label for protocol label %q", match[1])
		}
	}
	if len(chineseProcessLabels) != len(labels) {
		t.Errorf("%d card labels for %d protocol labels", len(chineseProcessLabels), len(labels))
	}
}
