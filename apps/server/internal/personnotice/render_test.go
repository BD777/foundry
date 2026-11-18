package personnotice

import (
	"strings"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func TestRenderTextNumbersOptionsAndSaysHowToAnswer(t *testing.T) {
	notice := store.PersonNotice{
		Title:         "选一个方向",
		Text:          "下一步怎么做？",
		Options:       []store.PersonNoticeOption{{ID: "0", Label: "左边"}, {ID: "1", Label: "右边"}},
		AllowFreeText: true,
	}
	want := "选一个方向\n\n下一步怎么做？\n\n1. 左边\n2. 右边\n\n引用本条消息，回复选项的文字；也可以直接回复你的意见。"
	if got := RenderText(notice); got != want {
		t.Fatalf("RenderText =\n%q\nwant\n%q", got, want)
	}
}

func TestRenderTextAnswerLineFollowsWhatTheNoticeAccepts(t *testing.T) {
	options := []store.PersonNoticeOption{{ID: "0", Label: "同意"}}
	cases := map[string]struct {
		notice store.PersonNotice
		line   string
	}{
		"options only": {store.PersonNotice{Options: options}, replyOptionOnly},
		"free text":    {store.PersonNotice{AllowFreeText: true}, replyTextOnly},
		"neither":      {store.PersonNotice{Title: "只看一眼"}, ""},
	}
	for name, tc := range cases {
		got := RenderText(tc.notice)
		if tc.line == "" && strings.Contains(got, "引用本条消息") {
			t.Errorf("%s: unexpected answer line in %q", name, got)
		}
		if tc.line != "" && !strings.HasSuffix(got, tc.line) {
			t.Errorf("%s: %q does not end with %q", name, got, tc.line)
		}
	}
}

func TestRenderTextKeepsQuotesNewlinesAndChineseAsWritten(t *testing.T) {
	notice := store.PersonNotice{Title: `他说"好"`, Text: "第一行\n第二行 \\ 结束"}
	got := RenderText(notice)
	for _, want := range []string{`他说"好"`, "第一行\n第二行 \\ 结束"} {
		if !strings.Contains(got, want) {
			t.Errorf("RenderText lost %q: %q", want, got)
		}
	}
}

func TestRedactSpellsOutEmailAddresses(t *testing.T) {
	cases := map[string]string{
		"联系 alice@example.com 即可":       "联系 alice [at] example.com 即可",
		"bob.x+tag@sub.foo.cn 与 c@d.io": "bob.x+tag [at] sub.foo.cn 与 c [at] d.io",
		"@ alone and 1@2 are kept":      "@ alone and 1@2 are kept",
		"no address here":               "no address here",
	}
	for input, want := range cases {
		if got := Redact(input); got != want {
			t.Errorf("Redact(%q) = %q, want %q", input, got, want)
		}
	}
}

func TestRenderTextRedactsTitleAndText(t *testing.T) {
	notice := store.PersonNotice{Title: "发给 a@b.co", Text: "原文 x@y.z"}
	got := RenderText(notice)
	if strings.Contains(got, "@") {
		t.Fatalf("RenderText left an @ in %q", got)
	}
}
