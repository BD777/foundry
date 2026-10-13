package resources

import "strings"

// clip cuts reported text to maxTextLength bytes, on a rune boundary.
func clip(text string) string {
	if len(text) <= maxTextLength {
		return text
	}
	cut := maxTextLength
	for cut > 0 && !isRuneStart(text[cut]) {
		cut--
	}
	return text[:cut]
}

func isRuneStart(b byte) bool { return b&0xC0 != 0x80 }

func nameOr(name, fallback string) string {
	if strings.TrimSpace(name) == "" {
		return fallback
	}
	return name
}

// clipRunes shortens text shown to people to limit runes, marking the cut.
func clipRunes(text string, limit int) string {
	runes := []rune(text)
	if len(runes) <= limit {
		return text
	}
	return string(runes[:limit]) + "…"
}
