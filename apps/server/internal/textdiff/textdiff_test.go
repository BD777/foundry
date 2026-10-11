package textdiff

import (
	"strings"
	"testing"
)

func TestUnifiedWritesHunksAsDiffDoes(t *testing.T) {
	before := "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n"
	after := "one\ntwo\n3\nfour\nfive\nsix\nseven\neight\nnine\nten\neleven\n"
	diff, ok := Unified("a/f.txt", "b/f.txt", before, after, 1)
	if !ok {
		t.Fatal("diff refused")
	}
	want := "--- a/f.txt\n+++ b/f.txt\n" +
		"@@ -2,3 +2,3 @@\n two\n-three\n+3\n four\n" +
		"@@ -10 +10,2 @@\n ten\n+eleven\n"
	if diff != want {
		t.Fatalf("diff =\n%s\nwant\n%s", diff, want)
	}
}

func TestUnifiedEdgeCases(t *testing.T) {
	if diff, ok := Unified("a", "b", "same\n", "same\n", 3); diff != "" || !ok {
		t.Fatalf("equal texts = %q %v", diff, ok)
	}
	created, _ := Unified("a", "b", "", "new\n", 3)
	if !strings.Contains(created, "@@ -0,0 +1 @@\n+new\n") {
		t.Fatalf("a created file = %q", created)
	}
	deleted, _ := Unified("a", "b", "gone\nalso\n", "", 3)
	if !strings.Contains(deleted, "@@ -1,2 +0,0 @@\n-gone\n-also\n") {
		t.Fatalf("a deleted file = %q", deleted)
	}
	unterminated, _ := Unified("a", "b", "x\n", "x\ny", 3)
	if !strings.Contains(unterminated, "+y\n\\ No newline at end of file\n") {
		t.Fatalf("a last line without a newline = %q", unterminated)
	}
	// Changes closer than twice the context share one hunk.
	joined, _ := Unified("a", "b", "1\n2\n3\n4\n5\n", "x\n2\n3\n4\ny\n", 2)
	if strings.Count(joined, "@@ -") != 1 {
		t.Fatalf("near changes = %q", joined)
	}
	var many, other strings.Builder
	for index := 0; index < MaxEdits; index++ {
		many.WriteString("a\n")
		other.WriteString("b\n")
	}
	if _, ok := Unified("a", "b", many.String(), other.String(), 3); ok {
		t.Fatal("a diff past MaxEdits must be refused")
	}
}

// Every diff applies: replaying the edits on before gives after.
func TestUnifiedEditsReplayToTheNewText(t *testing.T) {
	cases := [][2]string{
		{"a\nb\nc\nd\n", "b\nc\ne\nd\nf\n"},
		{"x\ny\nz\n", "z\ny\nx\n"},
		{"1\n2\n3\n", "1\n2\n3\n4\n5\n"},
	}
	for _, pair := range cases {
		edits, ok := lineEdits(splitLines(pair[0]), splitLines(pair[1]))
		if !ok {
			t.Fatalf("%q: refused", pair)
		}
		var rebuilt, original strings.Builder
		for _, item := range edits {
			if item.op != remove {
				rebuilt.WriteString(item.line)
			}
			if item.op != add {
				original.WriteString(item.line)
			}
		}
		if rebuilt.String() != pair[1] || original.String() != pair[0] {
			t.Fatalf("%q: rebuilt %q from %q", pair, rebuilt.String(), original.String())
		}
	}
}
