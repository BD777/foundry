package feishu

import "testing"

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
