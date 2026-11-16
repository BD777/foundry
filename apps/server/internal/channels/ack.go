package channels

import (
	"strings"
	"unicode/utf8"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// DefaultFooter is a channel's AI-footer line until the person sets another.
const DefaultFooter = "> 来自AI"

// MaxFooter bounds a channel's footer line.
const MaxFooter = 200

// AckEnabled reports whether the channel puts the source's acknowledgement
// reaction on handed messages; a channel that never said means on.
func AckEnabled(channel store.MessageChannel) bool {
	return channel.Ack == nil || *channel.Ack
}

// FooterText is the line appended to the assistant's own replies in the
// channel; "" when the person turned it off.
func FooterText(channel store.MessageChannel) string {
	if channel.Footer == nil {
		return DefaultFooter
	}
	return strings.TrimSpace(*channel.Footer)
}

// CleanFooter trims a channel's footer and reports whether it is one
// bounded line.
func CleanFooter(value string) (string, bool) {
	value = strings.TrimSpace(value)
	if strings.ContainsAny(value, "\r\n") || utf8.RuneCountInString(value) > MaxFooter {
		return "", false
	}
	return value, true
}
