package personnotice

import (
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func TestMatchOptionNamesAnOptionByLabelAliasOrNumber(t *testing.T) {
	notice := store.PersonNotice{Options: []store.PersonNoticeOption{{ID: "0", Label: "同意"}, {ID: "1", Label: "拒绝"}}}
	cases := []struct {
		reply string
		index int
		named bool
	}{
		{"同意", 0, true},
		{"  同意\n", 0, true},
		{"批准", 0, true},
		{"拒绝", 1, true},
		{"不同意", 1, true},
		{"2", 1, true},
		{"1", 0, true},
		{"同意吧", NoOption, false},
		{"我再想想", NoOption, false},
		{"", NoOption, false},
		{"3", NoOption, false},
	}
	for _, c := range cases {
		index, named := MatchOption(notice, c.reply)
		if index != c.index || named != c.named {
			t.Errorf("MatchOption(%q) = %d, %v; want %d, %v", c.reply, index, named, c.index, c.named)
		}
	}
}
