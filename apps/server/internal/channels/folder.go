package channels

import (
	"strings"
	"unicode"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// FolderSlug is a channel's folder name under the assistant home's
// channels/ directory (DEV-251): its name, letters and digits of any
// script kept, every other run one "-", ASCII lowercased, at most 48
// characters. "channel" when the name has nothing usable.
func FolderSlug(channel store.MessageChannel) string {
	var out strings.Builder
	dash := false
	for _, r := range strings.ToLower(strings.TrimSpace(channel.Name)) {
		switch {
		case unicode.IsLetter(r) || unicode.IsDigit(r):
			if dash && out.Len() > 0 {
				out.WriteByte('-')
			}
			dash = false
			out.WriteRune(r)
		default:
			dash = true
		}
		if out.Len() >= 48 {
			break
		}
	}
	slug := strings.Trim(out.String(), "-")
	if slug == "" {
		slug = "channel"
		if id := strings.TrimPrefix(channel.ID, "mch_"); id != "" {
			slug += "-" + shortID(id)
		}
	}
	return slug
}

// shortID is at most eight identifier characters.
func shortID(id string) string {
	var out strings.Builder
	for _, r := range id {
		if r >= 'a' && r <= 'z' || r >= '0' && r <= '9' || r == '-' || r == '_' {
			out.WriteRune(r)
		}
		if out.Len() >= 8 {
			break
		}
	}
	return strings.Trim(out.String(), "-_")
}
