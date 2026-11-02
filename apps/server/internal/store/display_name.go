package store

import (
	"strings"
	"unicode/utf8"
)

// ValidDisplayName reports whether a trimmed name is 1–120 characters on one
// line: the rule for device, workspace, chat, chat group and service names.
func ValidDisplayName(name string) bool {
	return name != "" && utf8.RuneCountInString(name) <= 120 && !strings.ContainsAny(name, "\r\n\t")
}
