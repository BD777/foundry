// Package textcut shortens text to a limit, the two ways the server needs:
// a byte budget a store column, a wire field or a prompt holds (Prefix),
// and an excerpt a person or an agent reads (Excerpt).
package textcut

import (
	"strings"
	"unicode/utf8"
)

// Prefix is text's longest prefix of at most limit bytes that ends on a
// whole character; "" for a limit below one.
func Prefix(text string, limit int) string {
	if len(text) <= limit {
		return text
	}
	if limit <= 0 {
		return ""
	}
	for limit > 0 && !utf8.RuneStart(text[limit]) {
		limit--
	}
	return text[:limit]
}

// Excerpt is text, trimmed, in at most limit characters: a cut drops the
// space before it and ends in "…", which counts toward the limit.
func Excerpt(text string, limit int) string {
	text = strings.TrimSpace(text)
	if utf8.RuneCountInString(text) <= limit {
		return text
	}
	if limit <= 0 {
		return ""
	}
	return strings.TrimSpace(string([]rune(text)[:limit-1])) + "…"
}
