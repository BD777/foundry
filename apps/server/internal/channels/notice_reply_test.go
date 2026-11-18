package channels_test

import (
	"context"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/channels"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// A notice's echo comes back as the person's own message. It is dropped as an
// own write before the notice-reply port is asked, so it can never settle
// anything; a reply the port settles is dropped as a notice answer.
func TestNoticeEchoIsDroppedBeforeReplySettlement(t *testing.T) {
	f := newFixture(t, store.MessageChannelLimits{PerHour: 20, PerDay: 100, Concurrency: 3})
	ctx := context.Background()
	post := func(cursor string, change map[string]any) map[string]string {
		f.feed.answers = []feedAnswer{changes(cursor, change)}
		f.poll(t)
		f.now = f.now.Add(channels.Debounce + time.Second)
		before := f.inbox.all()
		f.runner.Dispatch(ctx)
		out := map[string]string{}
		for id, text := range f.inbox.all() {
			if _, seen := before[id]; !seen {
				out[id] = text
			}
		}
		return out
	}

	f.noticeEchoes["n_echo"] = true
	f.noticeReplies["n_echo"] = true
	if got := post("c1", larkChange("n_echo", "oc_self", "p2p", "[Foundry] 请决定", false, true)); len(got) != 0 {
		t.Fatalf("a notice's echo started a turn: %v", got)
	}
	if len(f.noticeAsked) != 0 {
		t.Fatalf("the echo was offered to the reply port: %v", f.noticeAsked)
	}
	found := false
	for _, record := range f.records(t, store.MessageDeliveryDropped) {
		if record.Envelope.MessageID == "n_echo" {
			found = record.Reason == channels.ReasonOwnWrite && record.Envelope.Text == ""
		}
	}
	if !found {
		t.Fatalf("the echo is not recorded as an own write")
	}

	f.noticeReplies["n_reply"] = true
	if got := post("c2", larkChange("n_reply", "oc_self", "p2p", "同意", false, true)); len(got) != 0 {
		t.Fatalf("a settled reply started a turn: %v", got)
	}
	if len(f.noticeAsked) != 1 || f.noticeAsked[0] != "n_reply" {
		t.Fatalf("the reply port was asked %v, want the reply alone", f.noticeAsked)
	}
	settled := false
	for _, record := range f.records(t, store.MessageDeliveryDropped) {
		if record.Envelope.MessageID == "n_reply" {
			settled = record.Reason == channels.ReasonNoticeAnswer && record.Envelope.Text == ""
		}
	}
	if !settled {
		t.Fatalf("the settled reply is not recorded as a notice answer")
	}
}

// A reply the port does not settle goes on as before: it is not recorded as a
// notice answer, and its text is kept for the assistant's inbox.
func TestUnsettledReplyGoesOnToTheInbox(t *testing.T) {
	f := newFixture(t, store.MessageChannelLimits{PerHour: 20, PerDay: 100, Concurrency: 3})
	ctx := context.Background()
	post := func(cursor string, change map[string]any) {
		f.feed.answers = []feedAnswer{changes(cursor, change)}
		f.poll(t)
		f.now = f.now.Add(channels.Debounce + time.Second)
		f.runner.Dispatch(ctx)
	}
	post("c1", larkChange("m_free", "oc_a", "p2p", "随便说说", false, false))
	if len(f.noticeAsked) != 1 {
		t.Fatalf("the reply port was asked %v, want one message", f.noticeAsked)
	}
	for _, record := range f.records(t, store.MessageDeliveryDropped) {
		if record.Reason == channels.ReasonNoticeAnswer {
			t.Fatalf("an unsettled message was recorded as a notice answer: %+v", record)
		}
	}
}
