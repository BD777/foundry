package builtinskills

import (
	"slices"
	"strings"
	"testing"
)

func TestGuidanceListsEachBlocksFirstSentence(t *testing.T) {
	manifest := "---\nname: demo\ndescription: d.\n---\n\n# Demo\n\nIntro is left out.\n\n" +
		"## Who\n\n- `a.b` names a file. More detail.\n- Wrapped\n  bullet ends here: done. Later.\n\n" +
		"```\n- not a point\n```\n\n" +
		"## Empty\n\n## Cost\n\nA paragraph point? Rest.\nSame paragraph.\n"
	got := Guidance(manifest)
	want := []GuidanceSection{
		{Heading: "Who", Points: []string{"`a.b` names a file.", "Wrapped bullet ends here: done."}},
		{Heading: "Cost", Points: []string{"A paragraph point?"}},
	}
	if len(got) != len(want) {
		t.Fatalf("Guidance = %+v, want %+v", got, want)
	}
	for index := range want {
		if got[index].Heading != want[index].Heading || !slices.Equal(got[index].Points, want[index].Points) {
			t.Fatalf("section %d = %+v, want %+v", index, got[index], want[index])
		}
	}
}

// The web app lists the foundry skill's guidance as one line per point, read
// from SKILL.md. Every section must yield points, and each lead sentence must
// stay short enough to read as one item: write SKILL.md bullets lead first.
func TestFoundryGuidanceReadsAsPoints(t *testing.T) {
	skill, ok := Lookup("builtin-claude-foundry")
	if !ok {
		t.Fatal("foundry skill missing")
	}
	sections := Guidance(skill.Manifest)
	headings := 0
	for _, line := range strings.Split(skill.Manifest, "\n") {
		if strings.HasPrefix(line, "## ") {
			headings++
		}
	}
	if len(sections) == 0 || len(sections) != headings {
		t.Fatalf("guidance has %d sections, SKILL.md %d headings: every section needs bullets or paragraphs", len(sections), headings)
	}
	for _, section := range sections {
		for _, point := range section.Points {
			if len(point) > 260 || !strings.ContainsAny(point[len(point)-1:], ".!?") {
				t.Fatalf("%s: %q does not read as one sentence of at most 260 bytes", section.Heading, point)
			}
		}
	}
}
