package builtinskills

import "strings"

// GuidanceSection is one "## " section of a SKILL.md as a list of points.
type GuidanceSection struct {
	Heading string
	Points  []string
}

// Guidance lists what a SKILL.md tells agents, read from the file itself so
// the list cannot drift from it: each "## " section, one point per bullet or
// paragraph, the point being that block's first sentence. The text before
// the first section introduces the skill and is left out, as are code
// blocks. The foundry skill writes every bullet lead sentence first
// (TestFoundryGuidanceReadsAsPoints keeps it so).
func Guidance(manifest string) []GuidanceSection {
	var sections []GuidanceSection
	var block []string
	flush := func() {
		if len(block) > 0 && len(sections) > 0 {
			if point := firstSentence(strings.Join(block, " ")); point != "" {
				last := &sections[len(sections)-1]
				last.Points = append(last.Points, point)
			}
		}
		block = nil
	}
	fenced := false
	for _, line := range strings.Split(skillBody(manifest), "\n") {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "```") {
			flush()
			fenced = !fenced
			continue
		}
		switch {
		case fenced:
		case strings.HasPrefix(trimmed, "#"):
			flush()
			if heading, ok := strings.CutPrefix(trimmed, "## "); ok {
				sections = append(sections, GuidanceSection{Heading: strings.TrimSpace(heading)})
			} else if !strings.HasPrefix(trimmed, "# ") {
				// A deeper heading opens a section of its own.
				sections = append(sections, GuidanceSection{Heading: strings.TrimSpace(strings.TrimLeft(trimmed, "#"))})
			}
		case trimmed == "":
			flush()
		case strings.HasPrefix(trimmed, "- ") || strings.HasPrefix(trimmed, "* "):
			flush()
			block = append(block, strings.TrimSpace(trimmed[2:]))
		default:
			block = append(block, trimmed)
		}
	}
	flush()
	out := sections[:0]
	for _, section := range sections {
		if len(section.Points) > 0 {
			out = append(out, section)
		}
	}
	return out
}

// skillBody is a SKILL.md without its frontmatter.
func skillBody(manifest string) string {
	if !strings.HasPrefix(manifest, "---") {
		return manifest
	}
	rest := manifest[3:]
	end := strings.Index(rest, "\n---")
	if end < 0 {
		return manifest
	}
	return rest[end+len("\n---"):]
}

// firstSentence ends at the first ".", "!" or "?" followed by a space or the
// end, outside inline code.
func firstSentence(text string) string {
	code := false
	for index, char := range text {
		switch {
		case char == '`':
			code = !code
		case code:
		case char == '.' || char == '!' || char == '?':
			if next := index + 1; next == len(text) || text[next] == ' ' {
				return strings.TrimSpace(text[:next])
			}
		}
	}
	return strings.TrimSpace(text)
}
