package sqlitestore

import (
	"context"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

var noticeTestTime = time.Date(2026, 11, 18, 9, 0, 0, 0, time.UTC)

func queuedNotice(id, itemID string) store.PersonNotice {
	return store.PersonNotice{
		ID: id, UserID: "user_1", ItemID: itemID, Kind: "question", Title: "Pick one", Text: "Which way?",
		Options: []store.PersonNoticeOption{{ID: "0", Label: "Left"}, {ID: "1", Label: "Right"}},
		SinkID:  "sink_a", Target: "chat_self", State: store.NoticeQueued,
		NextAttemptAt: noticeTestTime, CreatedAt: noticeTestTime, UpdatedAt: noticeTestTime,
	}
}

func TestNoticeMigrationIsIdempotent(t *testing.T) {
	db := newTestStore(t)
	ctx := context.Background()
	for range 2 {
		if err := db.setupPersonNotices(ctx); err != nil {
			t.Fatalf("migration: %v", err)
		}
	}
	var indexes int
	if err := db.conn().QueryRowContext(ctx, `SELECT count(*) FROM sqlite_master
		WHERE type = 'index' AND name = 'person_notices_active_item' AND sql LIKE '%WHERE state IN%'`).Scan(&indexes); err != nil {
		t.Fatal(err)
	}
	if indexes != 1 {
		t.Fatalf("one-live-notice index missing after migrating twice")
	}
}

func TestNoticeOneLiveNoticePerItem(t *testing.T) {
	db := newTestStore(t)
	ctx := context.Background()
	first, created, err := db.CreatePersonNotice(ctx, queuedNotice("notice_1", "item_1"))
	if err != nil || !created || first.ID != "notice_1" {
		t.Fatalf("first notice = %+v created=%v err=%v", first, created, err)
	}
	existing, created, err := db.CreatePersonNotice(ctx, queuedNotice("notice_2", "item_1"))
	if err != nil || created || existing.ID != "notice_1" {
		t.Fatalf("second notice for a live item = %+v created=%v err=%v; want notice_1 back", existing, created, err)
	}
	if _, err := db.SupersedePersonNotices(ctx, "item_1", noticeTestTime); err != nil {
		t.Fatal(err)
	}
	if _, created, err := db.CreatePersonNotice(ctx, queuedNotice("notice_3", "item_1")); err != nil || !created {
		t.Fatalf("notice after the live one ended: created=%v err=%v", created, err)
	}
}

func TestNoticeRoundTripsItsOptionsAndTimes(t *testing.T) {
	db := newTestStore(t)
	ctx := context.Background()
	if _, _, err := db.CreatePersonNotice(ctx, queuedNotice("notice_1", "item_1")); err != nil {
		t.Fatal(err)
	}
	notices, err := db.PersonNoticesOfItem(ctx, "item_1")
	if err != nil || len(notices) != 1 {
		t.Fatalf("notices = %+v err=%v", notices, err)
	}
	got := notices[0]
	if len(got.Options) != 2 || got.Options[1] != (store.PersonNoticeOption{ID: "1", Label: "Right"}) {
		t.Fatalf("options = %+v", got.Options)
	}
	if !got.NextAttemptAt.Equal(noticeTestTime) || got.State != store.NoticeQueued || got.SinkID != "sink_a" {
		t.Fatalf("notice = %+v", got)
	}
}

// Deleting a workspace deletes the notices of its pending items, and only
// those: the item's own owner decides, as for every workspace-owned row.
func TestNoticeDeletionRemovesRowsWithItsWorkspace(t *testing.T) {
	db := newTestStore(t)
	ctx := context.Background()
	if err := db.RegisterDaemon(ctx, homeRegistration("dev_home", "linux-dev")); err != nil {
		t.Fatal(err)
	}
	registerOtherWorkspace(t, db)
	execAll(t, db,
		`INSERT INTO pending_items (id, user_id, workspace_id, source, item_key, state, payload_json, created_at, updated_at)
		 VALUES ('item_home', 'user_1', 'ws_home', 'question', 'k_home', 'open', '{}', '', ''),
		        ('item_other', 'user_1', 'ws_other', 'question', 'k_other', 'open', '{}', '', '')`)
	for _, itemID := range []string{"item_home", "item_other"} {
		if _, _, err := db.CreatePersonNotice(ctx, queuedNotice("notice_"+itemID, itemID)); err != nil {
			t.Fatal(err)
		}
	}

	if _, err := db.DeleteWorkspace(ctx, "ws_home"); err != nil {
		t.Fatal(err)
	}
	if notices, err := db.PersonNoticesOfItem(ctx, "item_home"); err != nil || len(notices) != 0 {
		t.Fatalf("notices of the deleted workspace's item = %+v err=%v", notices, err)
	}
	if notices, err := db.PersonNoticesOfItem(ctx, "item_other"); err != nil || len(notices) != 1 {
		t.Fatalf("notice of another workspace's item = %+v err=%v; want it kept", notices, err)
	}
}
