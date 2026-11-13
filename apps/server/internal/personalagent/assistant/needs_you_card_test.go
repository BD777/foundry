package assistant

import "testing"

func TestWithoutIDsDropsFoundryIDsOnly(t *testing.T) {
	for text, want := range map[string]string{
		"sess_1793189579694075630 sess_1793262362249887906 这两个session以及他们的sub": "这两个session以及他们的sub",
		"看看sess_12的日志":                                  "看看 的日志",
		"ws_4e5616b1-f6cf-44ad-93f4-e0f3fbb08817 build": "build",
		"logs/sess_12.txt and foo_sess_3 stay":          "logs/sess_12.txt and foo_sess_3 stay",
		"sess_12":                                       "",
	} {
		if got := withoutIDs(text); got != want {
			t.Errorf("withoutIDs(%q) = %q, want %q", text, got, want)
		}
	}
}
