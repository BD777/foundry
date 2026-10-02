package sqlitestore

import "unicode"

// writtenInChinese says whether a person wrote this text in Chinese, so the
// few fixed sentences Foundry adds follow the language of the conversation.
func writtenInChinese(text string) bool {
	for _, r := range text {
		if unicode.Is(unicode.Han, r) {
			return true
		}
	}
	return false
}
