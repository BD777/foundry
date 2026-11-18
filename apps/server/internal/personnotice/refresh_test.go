package personnotice

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// refreshingSink is a sink that shows the notice's state on its message.
type refreshingSink struct {
	scriptedSink
	refreshed  []store.PersonNotice
	refreshErr error
}

func (s *refreshingSink) Refresh(_ context.Context, notice store.PersonNotice) error {
	s.refreshed = append(s.refreshed, notice)
	return s.refreshErr
}

// sentRefreshingNotice is a notice of a refreshing sink, sent to its message.
func sentRefreshingNotice(t *testing.T, h *noticeHarness, sink *refreshingSink, itemID string) store.PendingItem {
	t.Helper()
	if err := h.dispatcher.RegisterSink("sink_refresh_"+itemID, sink); err != nil {
		t.Fatal(err)
	}
	item := store.PendingItem{ID: itemID, UserID: "user_1", Title: "Pick", State: store.PendingOpen}
	if _, created, err := h.dispatcher.EnqueueNotice(context.Background(), item, Route{SinkID: "sink_refresh_" + itemID, Target: "chat", Kind: "question"}); err != nil || !created {
		t.Fatalf("enqueue %s: created=%v err=%v", itemID, created, err)
	}
	h.pump()
	return item
}

// A sent notice whose item is closed elsewhere has its message refreshed to
// the superseded state, once; a sink that is not a Refresher is not called.
func TestSupersededNoticeRefreshesItsMessageOnce(t *testing.T) {
	h := newNoticeHarness(t)
	sink := &refreshingSink{}
	item := sentRefreshingNotice(t, h, sink, "item_refresh")
	if err := h.dispatcher.Supersede(context.Background(), item.ID); err != nil {
		t.Fatal(err)
	}
	h.pump()
	if len(sink.refreshed) != 1 || sink.refreshed[0].State != store.NoticeSuperseded || sink.refreshed[0].ProviderMessageID == "" {
		t.Fatalf("refreshes = %+v, want the superseded notice once", sink.refreshed)
	}
	h.pump()
	if len(sink.refreshed) != 1 {
		t.Fatalf("the message was refreshed again: %d refreshes", len(sink.refreshed))
	}

	plain := newNoticeHarness(t)
	enqueued := plain.enqueue("item_plain")
	plain.pump()
	if err := plain.dispatcher.Supersede(context.Background(), "item_plain"); err != nil {
		t.Fatal(err)
	}
	plain.pump()
	if got, _ := plain.db.PersonNoticesOfItem(context.Background(), "item_plain"); len(got) != 1 || got[0].ID != enqueued.ID || got[0].State != store.NoticeSuperseded {
		t.Fatalf("plain notice = %+v", got)
	}
}

// A refresh that fails is tried again on later pumps for an hour after the
// change, then dropped: a message that cannot be patched does not hold the pump.
func TestFailedRefreshIsRetriedThenDropped(t *testing.T) {
	h := newNoticeHarness(t)
	sink := &refreshingSink{refreshErr: errors.New("feishu patch failed")}
	item := sentRefreshingNotice(t, h, sink, "item_retry")
	if err := h.dispatcher.Supersede(context.Background(), item.ID); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	if err := h.dispatcher.Pump(ctx); err == nil {
		t.Fatal("a failed refresh was not reported")
	}
	if err := h.dispatcher.Pump(ctx); err == nil || len(sink.refreshed) != 2 {
		t.Fatalf("the refresh was not retried: %d refreshes, err %v", len(sink.refreshed), err)
	}
	h.now = h.now.Add(2 * time.Hour)
	if err := h.dispatcher.Pump(ctx); err == nil {
		t.Fatal("the last refresh failure was not reported")
	}
	h.pump()
	if len(sink.refreshed) != 3 {
		t.Fatalf("refreshes = %d after the give-up, want 3 and none after", len(sink.refreshed))
	}
}
