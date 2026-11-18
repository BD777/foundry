package personnotice

import (
	"slices"
	"strconv"
	"strings"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// NoOption is the index MatchOption returns for a reply that names none.
const NoOption = -1

// optionAliases are the other words a person may answer an approval with,
// keyed by the option label the notice shows (同意 / 拒绝).
var optionAliases = map[string][]string{
	"同意": {"批准"},
	"拒绝": {"不同意"},
}

// MatchOption reports which option of the notice a reply names: its label,
// one of its aliases, or the number the notice lists it under (1, 2, ...).
// The reply is trimmed first; anything else is free text.
func MatchOption(notice store.PersonNotice, reply string) (int, bool) {
	text := strings.TrimSpace(reply)
	for index, option := range notice.Options {
		if text == option.Label || slices.Contains(optionAliases[option.Label], text) || text == strconv.Itoa(index+1) {
			return index, true
		}
	}
	return NoOption, false
}
