package personalagent

import (
	"fmt"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// NoticePrefix starts every input the server, not the person, sends an
// assistant session: a task's event, a proposal's answer, a fixed notice.
// What the assistant remembers in such a turn is never the person's word.
const NoticePrefix = "[Foundry] "

// Notice is a server message to the assistant.
func Notice(text string) string { return NoticePrefix + strings.TrimSpace(text) }

// IsNotice reports whether an input came from the server.
func IsNotice(prompt string) bool {
	return strings.HasPrefix(strings.TrimSpace(prompt), strings.TrimSpace(NoticePrefix))
}

// MemoryOrigin is where a remembered fact came from, decided by the
// server (§2): the assistant's guess is inferred; a fact whose quote the
// server found in the person's own words of the conversation
// (QuoteGrounded over PersonWords) is stated; anything else (a document,
// a web page, a helper's output, a server notice) is external and waits
// for the person.
func MemoryOrigin(inferred, grounded bool) string {
	switch {
	case inferred:
		return store.PersonalAgentMemoryInferred
	case grounded:
		return store.PersonalAgentMemoryStated
	default:
		return store.PersonalAgentMemoryExternal
	}
}

// PersonWords is an input's text when the person wrote it: a server
// notice and a timer's prompt (the assistant's own) are not theirs. What
// the person attached is never in the text, only its marker.
func PersonWords(input store.SessionInput) (string, bool) {
	if input.SentBySessionID != "" || input.TimerFire != nil || IsNotice(input.Prompt) || strings.TrimSpace(input.Prompt) == "" {
		return "", false
	}
	return input.Prompt, true
}

// QuoteMinChars is the fewest letters or digits a quote has.
const QuoteMinChars = 2

// quoteGaps split a quote into the parts it kept of the person's words.
var quoteGaps = strings.NewReplacer("……", "\x00", "…", "\x00", "...", "\x00")

// QuoteGrounded reports whether quote is the person's own words: each part
// of it (parts are split at an ellipsis, for words left out) appears in one
// of said, compared as whole words (each CJK character a word) ignoring
// case, full or half width, punctuation and spacing.
func QuoteGrounded(quote string, said []string) bool {
	normalized := make([]string, 0, len(said))
	for _, text := range said {
		if words := quoteWords(text); words != "" {
			normalized = append(normalized, " "+words+" ")
		}
	}
	found, letters := false, 0
	for _, part := range strings.Split(quoteGaps.Replace(quote), "\x00") {
		words := quoteWords(part)
		if words == "" {
			continue
		}
		letters += utf8.RuneCountInString(strings.ReplaceAll(words, " ", ""))
		inSaid := false
		for _, text := range normalized {
			if strings.Contains(text, " "+words+" ") {
				inSaid = true
				break
			}
		}
		if !inSaid {
			return false
		}
		found = true
	}
	return found && letters >= QuoteMinChars
}

// quoteWords is text as QuoteGrounded compares it: lower-case letters and
// digits, full-width forms folded, one space between words, and each CJK
// character a word of its own.
func quoteWords(text string) string {
	var out strings.Builder
	space := false
	word := func() {
		if out.Len() > 0 {
			space = true
		}
	}
	for _, r := range text {
		if r >= 0xFF01 && r <= 0xFF5E {
			r -= 0xFEE0
		}
		r = unicode.ToLower(r)
		switch {
		case unicode.In(r, unicode.Han, unicode.Hiragana, unicode.Katakana, unicode.Hangul):
			word()
			if space {
				out.WriteByte(' ')
				space = false
			}
			out.WriteRune(r)
			word()
		case unicode.IsLetter(r) || unicode.IsDigit(r) || unicode.Is(unicode.Mn, r):
			if space {
				out.WriteByte(' ')
				space = false
			}
			out.WriteRune(r)
		default:
			word()
		}
	}
	return out.String()
}

// MemoryStatus is a new item's status: external items wait for the person.
func MemoryStatus(origin string) string {
	if origin == store.PersonalAgentMemoryExternal {
		return store.PersonalAgentMemoryPending
	}
	return store.PersonalAgentMemoryActive
}

// MemoryContent checks one item's text: one short statement.
func MemoryContent(content string) (string, error) {
	content = strings.Join(strings.Fields(content), " ")
	if content == "" {
		return "", fmt.Errorf("item.content is required")
	}
	if utf8.RuneCountInString(content) > MemoryItemMaxChars {
		return "", fmt.Errorf("item.content is at most %d characters: keep one short fact per item", MemoryItemMaxChars)
	}
	return content, nil
}
