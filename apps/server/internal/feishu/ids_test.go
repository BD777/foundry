package feishu

import "testing"

func TestLinkFoundryIDs(t *testing.T) {
	SetWebOrigin("https://foundry.example/")
	t.Cleanup(func() { SetWebOrigin("") })
	ws := "ws_8d046eba-109d-4017-b22f-6311250f90a7"
	cases := []struct{ in, want string }{
		{"see sess_12 now", "see [sess_12](https://foundry.example/chats/sess_12) now"},
		{"会话sess_12已完成。", "会话[sess_12](https://foundry.example/chats/sess_12)已完成。"},
		{"`sess_12`", "[sess_12](https://foundry.example/chats/sess_12)"},
		{"`run sess_12`", "`run sess_12`"},
		{"[open](https://foundry.example/chats/sess_12?workspace=" + ws + ")", "[open](https://foundry.example/chats/sess_12?workspace=" + ws + ")"},
		{"https://x.example/chats/sess_12", "https://x.example/chats/sess_12"},
		{"a/sess_12 sess_12x foo_sess_12", "a/sess_12 sess_12x foo_sess_12"},
		{"iss_7 in " + ws, "[iss_7](https://foundry.example/issues/iss_7) in [" + ws + "](https://foundry.example/locations/" + ws + ")"},
		{"native_claude_abc stays", "native_claude_abc stays"},
	}
	for _, c := range cases {
		if got := linkFoundryIDs(c.in); got != c.want {
			t.Errorf("linkFoundryIDs(%q) = %q, want %q", c.in, got, c.want)
		}
	}
	if got := NormalizeFeishuMarkdown("```\nsess_12\n```"); got != "```\nsess_12\n```" {
		t.Errorf("code block changed: %q", got)
	}
}

func TestLinkFoundryIDsWithoutOrigin(t *testing.T) {
	SetWebOrigin("")
	if got := linkFoundryIDs("see sess_12"); got != "see sess_12" {
		t.Errorf("got %q", got)
	}
}
