package sqlitestore

import (
	"context"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// sentNotice is a notice a sink accepted: claimed, then settled as sent.
func sentNotice(t *testing.T, db *Store, id, itemID, providerID string) {
	t.Helper()
	ctx := context.Background()
	if _, _, err := db.CreatePersonNotice(ctx, queuedNotice(id, itemID)); err != nil {
		t.Fatal(err)
	}
	if _, claimed, err := db.ClaimPersonNotice(ctx, id, noticeTestTime); err != nil || !claimed {
		t.Fatalf("claim %s: claimed=%v err=%v", id, claimed, err)
	}
	if _, err := db.SettlePersonNotice(ctx, id, store.PersonNoticeSettlement{State: store.NoticeSent, ProviderMessageID: providerID, At: noticeTestTime}); err != nil {
		t.Fatal(err)
	}
}

func openPendingItem(id string) store.PendingItem {
	return store.PendingItem{
		ID: id, UserID: "user_1", WorkspaceID: "ws_1", Source: store.PendingSourceQuestion, Key: "key_" + id, State: store.PendingOpen,
		Title: "Pick one", CreatedAt: formatTime(noticeTestTime), UpdatedAt: formatTime(noticeTestTime),
	}
}

// However an item closes, its queued and sent notices end with it; a notice
// answered already is left as it is.
func TestClosingAnItemEndsItsUnansweredNotices(t *testing.T) {
	db := newTestStore(t)
	ctx := context.Background()
	closing, _, err := db.RecordPendingItem(ctx, openPendingItem("item_close"))
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := db.CreatePersonNotice(ctx, queuedNotice("notice_queued", closing.ID)); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ResolvePendingItem(ctx, "user_1", closing.ID, store.PendingDone, store.PendingOutcomePersonAnswered, store.PendingAnswer{Text: "Left", By: store.PendingAnsweredByPerson}); err != nil {
		t.Fatal(err)
	}
	notices, err := db.PersonNoticesOfItem(ctx, closing.ID)
	if err != nil || len(notices) != 1 || notices[0].State != store.NoticeSuperseded {
		t.Fatalf("queued notice after its item closed = %+v (%v), want superseded", notices, err)
	}

	answering, _, err := db.RecordPendingItem(ctx, openPendingItem("item_answered"))
	if err != nil {
		t.Fatal(err)
	}
	sentNotice(t, db, "notice_answered", answering.ID, "om_answered")
	if answered, err := db.AnswerPersonNotice(ctx, "notice_answered", store.PendingAnsweredByPerson, "Left", noticeTestTime); err != nil || !answered {
		t.Fatalf("answer the sent notice: answered=%v err=%v", answered, err)
	}
	if _, err := db.ResolvePendingItem(ctx, "user_1", answering.ID, store.PendingDone, store.PendingOutcomePersonAnswered, store.PendingAnswer{Text: "Left", By: store.PendingAnsweredByPerson}); err != nil {
		t.Fatal(err)
	}
	notices, err = db.PersonNoticesOfItem(ctx, answering.ID)
	if err != nil || len(notices) != 1 || notices[0].State != store.NoticeAnswered || notices[0].AnswerText != "Left" {
		t.Fatalf("answered notice after its item closed = %+v (%v), want still answered", notices, err)
	}
}

// Only the first answer to a sent notice takes it; an undone answer can be
// taken again, and a reply is found by the message id its sink reported.
func TestOnlyTheFirstAnswerSettlesASentNotice(t *testing.T) {
	db := newTestStore(t)
	ctx := context.Background()
	sentNotice(t, db, "notice_1", "item_1", "om_1")

	if won, err := db.AnswerPersonNotice(ctx, "notice_1", store.PendingAnsweredByPerson, "Left", noticeTestTime); err != nil || !won {
		t.Fatalf("first answer: won=%v err=%v", won, err)
	}
	if won, err := db.AnswerPersonNotice(ctx, "notice_1", store.PendingAnsweredByPerson, "Right", noticeTestTime); err != nil || won {
		t.Fatalf("second answer: won=%v err=%v, want refused", won, err)
	}
	notice, found, err := db.PersonNoticeByMessage(ctx, "sink_a", "om_1")
	if err != nil || !found || notice.State != store.NoticeAnswered || notice.AnswerText != "Left" || notice.AnsweredBy != store.PendingAnsweredByPerson {
		t.Fatalf("notice by message = %+v found=%v err=%v", notice, found, err)
	}

	if reopened, err := db.ReopenPersonNotice(ctx, "notice_1", noticeTestTime); err != nil || !reopened {
		t.Fatalf("reopen: reopened=%v err=%v", reopened, err)
	}
	notice, _, _ = db.PersonNoticeByMessage(ctx, "sink_a", "om_1")
	if notice.State != store.NoticeSent || notice.AnswerText != "" || notice.AnsweredBy != "" {
		t.Fatalf("reopened notice = %+v, want sent with no answer", notice)
	}
	if won, err := db.AnswerPersonNotice(ctx, "notice_1", store.PendingAnsweredByPerson, "Right", noticeTestTime); err != nil || !won {
		t.Fatalf("answer after reopening: won=%v err=%v", won, err)
	}

	if _, found, err := db.PersonNoticeByMessage(ctx, "sink_a", "om_unknown"); err != nil || found {
		t.Fatalf("an unknown message found a notice: found=%v err=%v", found, err)
	}
	if _, found, err := db.PersonNoticeByMessage(ctx, "sink_b", "om_1"); err != nil || found {
		t.Fatalf("another sink's message found a notice: found=%v err=%v", found, err)
	}
}
