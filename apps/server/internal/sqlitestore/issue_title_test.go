package sqlitestore

import (
	"strings"
	"testing"
	"unicode/utf8"
)

func TestGeneratedTitlePreservesUnicode(t *testing.T) {
	for _, input := range []string{strings.Repeat("真实验收", 30), strings.Repeat("a🙂中文", 30), strings.Repeat("ASCII ", 30)} {
		title := titleFromInput(input)
		if !utf8.ValidString(title) || utf8.RuneCountInString(title) != 72 || !strings.HasSuffix(title, "...") {
			t.Fatalf("invalid truncated title: %q", title)
		}
	}
	if got := titleFromInput("  真实\n验收  🙂 "); got != "真实 验收 🙂" {
		t.Fatalf("unexpected short title: %q", got)
	}
}
