package personnotice

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/sqlitestore"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// scriptedSink answers its calls in order: a nil entry (or a call past the
// script) is accepted. It records every notice it was asked to send.
type scriptedSink struct {
	script []error
	calls  []store.PersonNotice
}

func (s *scriptedSink) Send(_ context.Context, notice store.PersonNotice) (SendResult, error) {
	s.calls = append(s.calls, notice)
	if index := len(s.calls) - 1; index < len(s.script) && s.script[index] != nil {
		return SendResult{}, s.script[index]
	}
	return SendResult{ProviderMessageID: "provider_" + notice.ID}, nil
}

type noticeHarness struct {
	t          *testing.T
	dispatcher *Dispatcher
	db         *sqlitestore.Store
	sink       *scriptedSink
	now        time.Time
	ids        int
}

func newNoticeHarness(t *testing.T, script ...error) *noticeHarness {
	t.Helper()
	db, err := sqlitestore.Open(t.TempDir() + "/foundry.db")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	harness := &noticeHarness{t: t, db: db, sink: &scriptedSink{script: script}, now: time.Date(2026, 11, 18, 9, 0, 0, 0, time.UTC)}
	harness.dispatcher = New(db)
	harness.dispatcher.now = func() time.Time { return harness.now }
	harness.dispatcher.newID = func() string {
		harness.ids++
		return fmt.Sprintf("notice_%d", harness.ids)
	}
	if err := harness.dispatcher.RegisterSink("sink_a", harness.sink); err != nil {
		t.Fatal(err)
	}
	return harness
}

func (h *noticeHarness) enqueue(itemID string) store.PersonNotice {
	h.t.Helper()
	item := store.PendingItem{ID: itemID, UserID: "user_1", Title: "Pick one", Excerpt: "Which way?", State: store.PendingOpen, Options: []string{"Left", "Right"}}
	notice, created, err := h.dispatcher.EnqueueNotice(context.Background(), item, Route{SinkID: "sink_a", Target: "chat_self", Kind: "question"})
	if err != nil || !created {
		h.t.Fatalf("enqueue %s: created=%v err=%v", itemID, created, err)
	}
	return notice
}

func (h *noticeHarness) pump() {
	h.t.Helper()
	if err := h.dispatcher.Pump(context.Background()); err != nil {
		h.t.Fatalf("pump: %v", err)
	}
}

func (h *noticeHarness) only(itemID string) store.PersonNotice {
	h.t.Helper()
	notices, err := h.db.PersonNoticesOfItem(context.Background(), itemID)
	if err != nil || len(notices) == 0 {
		h.t.Fatalf("notices of %s = %+v err=%v", itemID, notices, err)
	}
	return notices[len(notices)-1]
}

func TestNoticeSendsOnceWithTheNoticeIDAsKey(t *testing.T) {
	h := newNoticeHarness(t)
	notice := h.enqueue("item_1")
	h.pump()
	h.pump()

	if len(h.sink.calls) != 1 || h.sink.calls[0].ID != notice.ID {
		t.Fatalf("sink calls = %+v, want one call with %s", h.sink.calls, notice.ID)
	}
	got := h.only("item_1")
	if got.State != store.NoticeSent || got.ProviderMessageID != "provider_"+notice.ID || got.Attempts != 1 {
		t.Fatalf("settled notice = %+v", got)
	}
}

// A transient failure is retried with the same ID, after the backoff.
func TestNoticeRetryUsesTheSameIDAfterBackoff(t *testing.T) {
	h := newNoticeHarness(t, Transient(errors.New("502 from the provider")), nil)
	notice := h.enqueue("item_1")
	h.pump()
	if got := h.only("item_1"); got.State != store.NoticeQueued || got.ErrorReason != "502 from the provider" {
		t.Fatalf("after a transient failure = %+v", got)
	}

	h.now = h.now.Add(29 * time.Second)
	h.pump()
	if len(h.sink.calls) != 1 {
		t.Fatalf("resent before the 30 s backoff: %d calls", len(h.sink.calls))
	}

	h.now = h.now.Add(time.Second)
	h.pump()
	if len(h.sink.calls) != 2 || h.sink.calls[1].ID != notice.ID {
		t.Fatalf("retry calls = %+v, want the same ID %s", h.sink.calls, notice.ID)
	}
	if got := h.only("item_1"); got.State != store.NoticeSent || got.Attempts != 2 {
		t.Fatalf("after the retry = %+v", got)
	}
}

// The backoff is 30 s, 2 min, 10 min; the fourth send is the last.
func TestNoticeTransientBackoffScheduleAndCap(t *testing.T) {
	transient := errors.New("connection reset")
	h := newNoticeHarness(t, Transient(transient), Transient(transient), Transient(transient), Transient(transient))
	h.enqueue("item_1")
	waits := []time.Duration{30 * time.Second, 2 * time.Minute, 10 * time.Minute}
	for index, wait := range waits {
		h.pump()
		got := h.only("item_1")
		if got.State != store.NoticeQueued {
			t.Fatalf("attempt %d: state %s, want queued", index+1, got.State)
		}
		if due := got.NextAttemptAt.Sub(h.now); due != wait {
			t.Fatalf("attempt %d: next attempt in %s, want %s", index+1, due, wait)
		}
		h.now = got.NextAttemptAt
	}
	h.pump()
	got := h.only("item_1")
	if len(h.sink.calls) != MaxAttempts || got.State != store.NoticeFailed {
		t.Fatalf("calls = %d, notice = %+v; want %d sends then failed", len(h.sink.calls), got, MaxAttempts)
	}
}

func TestNoticePermanentFailureIsNotRetried(t *testing.T) {
	h := newNoticeHarness(t, Permanent(errors.New("content audit rejected the message")))
	h.enqueue("item_1")
	h.pump()
	h.now = h.now.Add(24 * time.Hour)
	h.pump()

	got := h.only("item_1")
	if len(h.sink.calls) != 1 || got.State != store.NoticeFailed || got.ErrorReason != "content audit rejected the message" {
		t.Fatalf("calls = %d, notice = %+v; want one send and failed with its reason", len(h.sink.calls), got)
	}
}

func TestNoticeUnclassifiedFailureIsNotRetried(t *testing.T) {
	h := newNoticeHarness(t, errors.New("something nobody classified"))
	h.enqueue("item_1")
	h.pump()
	h.now = h.now.Add(time.Hour)
	h.pump()
	if len(h.sink.calls) != 1 || h.only("item_1").State != store.NoticeFailed {
		t.Fatalf("calls = %d; an unclassified failure must not be resent", len(h.sink.calls))
	}
}

func TestNoticeSupersededBeforeSendIsNeverSent(t *testing.T) {
	h := newNoticeHarness(t)
	h.enqueue("item_1")
	if err := h.dispatcher.Supersede(context.Background(), "item_1"); err != nil {
		t.Fatal(err)
	}
	h.pump()
	if len(h.sink.calls) != 0 || h.only("item_1").State != store.NoticeSuperseded {
		t.Fatalf("sink calls = %d after supersede, want none", len(h.sink.calls))
	}
}

func TestNoticeSupersedeEndsASentNotice(t *testing.T) {
	h := newNoticeHarness(t)
	h.enqueue("item_1")
	h.pump()
	if err := h.dispatcher.Supersede(context.Background(), "item_1"); err != nil {
		t.Fatal(err)
	}
	if got := h.only("item_1"); got.State != store.NoticeSuperseded || got.ProviderMessageID == "" {
		t.Fatalf("superseded notice = %+v, want superseded with the sent message kept", got)
	}
}

func TestNoticeAmbiguousFailurePastAnHourIsNotResent(t *testing.T) {
	h := newNoticeHarness(t, Ambiguous(errors.New("timeout after the request left")), nil)
	h.enqueue("item_1")
	h.pump()
	first := h.only("item_1")
	if first.AmbiguousAt.IsZero() || first.State != store.NoticeQueued {
		t.Fatalf("after an ambiguous failure = %+v", first)
	}

	h.now = h.now.Add(AmbiguousLimit + time.Minute)
	h.pump()
	got := h.only("item_1")
	if len(h.sink.calls) != 1 || got.State != store.NoticeFailed {
		t.Fatalf("calls = %d, notice = %+v; want no resend and failed", len(h.sink.calls), got)
	}
}

// A send that never reported back (the process stopped mid-send) is
// requeued as ambiguous, and the same ID is used again.
func TestNoticeLostSendIsRequeuedWithTheSameID(t *testing.T) {
	h := newNoticeHarness(t)
	notice := h.enqueue("item_1")
	if _, claimed, err := h.db.ClaimPersonNotice(context.Background(), notice.ID, h.now); err != nil || !claimed {
		t.Fatalf("claim: claimed=%v err=%v", claimed, err)
	}
	h.now = h.now.Add(staleAfter + time.Second)
	h.pump()
	if len(h.sink.calls) != 1 || h.sink.calls[0].ID != notice.ID || h.only("item_1").State != store.NoticeSent {
		t.Fatalf("calls = %+v, notice = %+v; want one resend with %s", h.sink.calls, h.only("item_1"), notice.ID)
	}
}

func TestNoticeEnqueueSkipsItemsThatAreNoLongerOpen(t *testing.T) {
	h := newNoticeHarness(t)
	item := store.PendingItem{ID: "item_1", UserID: "user_1", State: store.PendingReplied}
	if _, created, err := h.dispatcher.EnqueueNotice(context.Background(), item, Route{SinkID: "sink_a", Kind: "question"}); err != nil || created {
		t.Fatalf("notice for a replied item: created=%v err=%v", created, err)
	}
	if notices, _ := h.db.PersonNoticesOfItem(context.Background(), "item_1"); len(notices) != 0 {
		t.Fatalf("notices = %+v, want none", notices)
	}
}

func TestNoticeWithoutRegisteredSinkFails(t *testing.T) {
	h := newNoticeHarness(t)
	item := store.PendingItem{ID: "item_1", UserID: "user_1", State: store.PendingOpen}
	if _, _, err := h.dispatcher.EnqueueNotice(context.Background(), item, Route{SinkID: "sink_missing", Kind: "question"}); err != nil {
		t.Fatal(err)
	}
	h.pump()
	if got := h.only("item_1"); got.State != store.NoticeFailed || got.ErrorReason == "" {
		t.Fatalf("notice for an unregistered sink = %+v, want failed with a reason", got)
	}
}

// The id a sink reports for a sent notice is the one the echo check looks
// for: it is listed under the notice's sink, within the window, and nowhere
// else.
func TestSentNoticeIDsListTheIDTheSinkReported(t *testing.T) {
	harness := newNoticeHarness(t)
	notice := harness.enqueue("item_1")
	harness.pump()
	ctx := context.Background()
	ids, err := harness.db.PersonNoticeSentIDs(ctx, "sink_a", harness.now.Add(-time.Hour))
	if err != nil || len(ids) != 1 || ids[0] != "provider_"+notice.ID {
		t.Fatalf("sent ids = %v, %v", ids, err)
	}
	if ids, err := harness.db.PersonNoticeSentIDs(ctx, "sink_other", harness.now.Add(-time.Hour)); err != nil || len(ids) != 0 {
		t.Fatalf("another sink's ids = %v, %v", ids, err)
	}
	if ids, err := harness.db.PersonNoticeSentIDs(ctx, "sink_a", harness.now.Add(time.Hour)); err != nil || len(ids) != 0 {
		t.Fatalf("ids outside the window = %v, %v", ids, err)
	}
}

// A sink resolved on demand delivers a notice that names its id, and an id
// the resolver does not know fails the notice permanently.
func TestSinkResolverDeliversNamedSinks(t *testing.T) {
	harness := newNoticeHarness(t)
	resolved := &scriptedSink{}
	harness.dispatcher.SetSinkResolver(func(id string) (Sink, bool) {
		if id == "ext:app_9" {
			return resolved, true
		}
		return nil, false
	})
	item := store.PendingItem{ID: "item_r", UserID: "user_1", Title: "t", State: store.PendingOpen}
	if _, created, err := harness.dispatcher.EnqueueNotice(context.Background(), item, Route{SinkID: "ext:app_9", Kind: "question"}); err != nil || !created {
		t.Fatalf("enqueue: created=%v err=%v", created, err)
	}
	harness.pump()
	if len(resolved.calls) != 1 {
		t.Fatalf("the resolved sink was called %d times", len(resolved.calls))
	}
	other := store.PendingItem{ID: "item_u", UserID: "user_1", Title: "t", State: store.PendingOpen}
	if _, _, err := harness.dispatcher.EnqueueNotice(context.Background(), other, Route{SinkID: "ext:unknown", Kind: "question"}); err != nil {
		t.Fatal(err)
	}
	harness.pump()
	notices, err := harness.db.PersonNoticesOfItem(context.Background(), "item_u")
	if err != nil || len(notices) != 1 || notices[0].State != store.NoticeFailed {
		t.Fatalf("an unknown sink fails the notice: %+v, %v", notices, err)
	}
}
