package store

import "testing"

func TestCanonicalTimeWritesTheStoredWidth(t *testing.T) {
	cases := map[string]string{
		"2026-11-18T16:37:17.070755Z":      "2026-11-18T16:37:17.070755000Z",
		"2026-11-18T16:37:17Z":             "2026-11-18T16:37:17.000000000Z",
		"2026-11-18T16:37:17.070755000Z":   "2026-11-18T16:37:17.070755000Z",
		"2026-11-19T00:37:17.070755+08:00": "2026-11-18T16:37:17.070755000Z",
		"":                                 "",
		"not a time":                       "not a time",
	}
	for in, want := range cases {
		if got := CanonicalTime(in); got != want {
			t.Errorf("CanonicalTime(%q) = %q, want %q", in, got, want)
		}
	}
}
