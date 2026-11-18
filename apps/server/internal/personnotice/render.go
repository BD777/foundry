package personnotice

import (
	"fmt"
	"regexp"
	"strings"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// The reply lines are Chinese, the language the person reads notices in. A
// reply quotes the notice: that is how the answer finds its item (DEV-294).
const (
	replyOptionOnly = "引用本条消息，回复上面选项的文字即可。"
	replyTextOnly   = "引用本条消息，直接回复你的意见。"
	replyEither     = "引用本条消息，回复选项的文字；也可以直接回复你的意见。"
)

// emailPattern is a local@domain.tld string, the top-level domain of any
// length. The Feishu audit rejects a whole message that contains one (error
// 230028), so the @ is spelled out.
var emailPattern = regexp.MustCompile(`([A-Za-z0-9._%+-]+)@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]+)`)

// Redact spells out the @ of every email-like string: x@y.z becomes x [at] y.z.
func Redact(text string) string {
	return emailPattern.ReplaceAllString(text, "${1} [at] ${2}")
}

// RenderText is the notice's plain text: its title, its text, its options
// numbered in the order the item lists them, and the line that says how to
// answer. The text carries no link; a sink adds the Web link itself. Every
// email-like string is redacted, so a sink may send it as it is.
func RenderText(notice store.PersonNotice) string {
	var parts []string
	if title := strings.TrimSpace(notice.Title); title != "" {
		parts = append(parts, title)
	}
	if text := strings.TrimSpace(notice.Text); text != "" {
		parts = append(parts, text)
	}
	if len(notice.Options) > 0 {
		lines := make([]string, len(notice.Options))
		for index, option := range notice.Options {
			lines[index] = fmt.Sprintf("%d. %s", index+1, option.Label)
		}
		parts = append(parts, strings.Join(lines, "\n"))
	}
	if reply := replyLine(notice); reply != "" {
		parts = append(parts, reply)
	}
	return Redact(strings.Join(parts, "\n\n"))
}

// replyLine says how the person may answer; "" when the notice takes neither
// an option nor free text, and the Web link is the only way to answer.
func replyLine(notice store.PersonNotice) string {
	switch {
	case len(notice.Options) > 0 && notice.AllowFreeText:
		return replyEither
	case len(notice.Options) > 0:
		return replyOptionOnly
	case notice.AllowFreeText:
		return replyTextOnly
	default:
		return ""
	}
}
