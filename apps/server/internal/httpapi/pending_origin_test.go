package httpapi

import "testing"

// An item's origin is the person's own words: the newest message they sent
// in a channel turn, or what they typed in Foundry; never what another
// session or Foundry sent.
func TestPersonWordsOf(t *testing.T) {
	channel := `{"label":"User message","metadata":{"inputSource":{"kind":"channel"},"channelOrigin":{"channelName":"openlark","source":"openlark","conversation":{"id":"c1","kind":"direct","name":"高逸斌"},"messages":[{"at":"2026-11-19T05:12:50Z","text":"前天那批 case 修好了","sender":{"name":"高逸斌","isSelf":false}},{"at":"2026-11-19T05:12:56Z","text":"/ai 确认一下，然后用autorun重跑我们前天那十几个case的复现","sender":{"name":"邓灿文","isSelf":true}}]}},"message":{"at":"2026-11-19T05:13:03Z","text":"[Message channel: …]"}}`
	origin, ok := personWordsOf(channel)
	if !ok || origin.Text != "/ai 确认一下，然后用autorun重跑我们前天那十几个case的复现" || origin.Channel != "openlark" ||
		origin.Conversation != "高逸斌" || origin.ConversationKind != "direct" || origin.At != "2026-11-19T05:12:56Z" {
		t.Fatalf("channel origin = %+v (%v)", origin, ok)
	}
	if _, ok := personWordsOf(`{"metadata":{"channelOrigin":{"messages":[{"text":"hi","sender":{"isSelf":false}}]}},"message":{"text":"x"}}`); ok {
		t.Fatal("a channel turn without the person's message is no origin")
	}
	typed, ok := personWordsOf(`{"metadata":{"inputSource":{"kind":"person"}},"message":{"at":"2026-11-20T01:00:00Z","text":"  plan my week  "}}`)
	if !ok || typed.Text != "plan my week" || typed.Channel != "" {
		t.Fatalf("typed origin = %+v (%v)", typed, ok)
	}
	if _, ok := personWordsOf(`{"metadata":{},"message":{"text":"legacy message without a source"}}`); !ok {
		t.Fatal("a message without a source is the person's")
	}
	for _, other := range []string{
		`{"metadata":{"sentBySessionId":"sess_parent"},"message":{"text":"do the export"}}`,
		`{"metadata":{"inputSource":{"kind":"child_report"}},"message":{"text":"Foundry report"}}`,
		`{"metadata":{"inputSource":{"kind":"foundry_notice"}},"message":{"text":"reminder"}}`,
	} {
		if origin, ok := personWordsOf(other); ok {
			t.Fatalf("%s read as the person's words: %+v", other, origin)
		}
	}
}
