package textcut

import "testing"

func TestPrefixEndsOnAWholeCharacter(t *testing.T) {
	for _, c := range []struct {
		text  string
		limit int
		want  string
	}{
		{"hello", 10, "hello"},
		{"hello", 3, "hel"},
		{"héllo", 2, "h"},
		{"日本語", 4, "日"},
		{"日本語", 6, "日本"},
		{"abc", 0, ""},
		{"abc", -1, ""},
	} {
		if got := Prefix(c.text, c.limit); got != c.want {
			t.Errorf("Prefix(%q, %d) = %q, want %q", c.text, c.limit, got, c.want)
		}
	}
}

func TestExcerptFitsTheLimitAndMarksTheCut(t *testing.T) {
	for _, c := range []struct {
		text  string
		limit int
		want  string
	}{
		{"  short  ", 10, "short"},
		{"exactly", 7, "exactly"},
		{"one two three", 8, "one two…"},
		{"one two three", 9, "one two…"},
		{"日本語のテキスト", 4, "日本語…"},
		{"abc", 1, "…"},
		{"abc", 0, ""},
	} {
		if got := Excerpt(c.text, c.limit); got != c.want {
			t.Errorf("Excerpt(%q, %d) = %q, want %q", c.text, c.limit, got, c.want)
		}
	}
}
