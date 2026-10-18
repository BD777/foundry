package sqlitestore

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// The person's list: open items always listed, closed ones since a time;
// closing stamps the time and reopening clears it; a reminder goes out
// once per time, and a new time makes it due again; another person's
// items are out of reach.
func TestPersonalAgentListKeepsItemsAndRemindersOnce(t *testing.T) {
	db, ctx := newTestStore(t), context.Background()
	past := time.Now().Add(-time.Minute).UTC().Format(time.RFC3339)
	wechat, err := db.AddPersonalAgentItem(ctx, store.PersonalAgentListItem{UserID: "user_a", Text: "Reply on WeChat", When: "after work", At: past, Remind: true})
	if err != nil || wechat.Status != store.PersonalAgentItemOpen || wechat.ClosedAt != "" {
		t.Fatalf("added %+v (%v)", wechat, err)
	}
	qa, err := db.AddPersonalAgentItem(ctx, store.PersonalAgentListItem{UserID: "user_a", Text: "Talked to QA", Status: store.PersonalAgentItemDone})
	if err != nil || qa.ClosedAt == "" {
		t.Fatalf("a done item = %+v (%v)", qa, err)
	}
	if _, err := db.AddPersonalAgentItem(ctx, store.PersonalAgentListItem{UserID: "user_b", Text: "Someone else's"}); err != nil {
		t.Fatal(err)
	}
	if open, _ := db.ListPersonalAgentItems(ctx, "user_a", ""); len(open) != 1 || open[0].ID != wechat.ID {
		t.Fatalf("open only = %+v", open)
	}
	since := time.Now().Add(-time.Hour).UTC().Format(time.RFC3339Nano)
	if all, _ := db.ListPersonalAgentItems(ctx, "user_a", since); len(all) != 2 || all[0].ID != wechat.ID || all[1].ID != qa.ID {
		t.Fatalf("open and closed since = %+v", all)
	}
	if _, err := db.GetPersonalAgentItem(ctx, "user_b", wechat.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("another person reads it: %v", err)
	}

	now := time.Now().UTC().Format(time.RFC3339)
	due, _ := db.DuePersonalAgentReminders(ctx, now)
	if len(due) != 1 || due[0].ID != wechat.ID {
		t.Fatalf("due = %+v", due)
	}
	if claimed, _ := db.ClaimPersonalAgentReminder(ctx, "user_a", wechat.ID, past); !claimed {
		t.Fatal("the first claim")
	}
	if claimed, _ := db.ClaimPersonalAgentReminder(ctx, "user_a", wechat.ID, past); claimed {
		t.Fatal("a reminder went out twice")
	}
	if due, _ := db.DuePersonalAgentReminders(ctx, now); len(due) != 0 {
		t.Fatalf("still due = %+v", due)
	}
	reminded, _ := db.GetPersonalAgentItem(ctx, "user_a", wechat.ID)
	reminded.At = time.Now().Add(-time.Second).UTC().Format(time.RFC3339)
	moved, err := db.SavePersonalAgentItem(ctx, reminded)
	if err != nil || moved.RemindedAt != "" {
		t.Fatalf("a new time = %+v (%v)", moved, err)
	}
	if due, _ := db.DuePersonalAgentReminders(ctx, time.Now().UTC().Format(time.RFC3339)); len(due) != 1 {
		t.Fatalf("a new time is due again: %+v", due)
	}

	moved.Status = store.PersonalAgentItemDone
	done, err := db.SavePersonalAgentItem(ctx, moved)
	if err != nil || done.ClosedAt == "" || done.CreatedAt != wechat.CreatedAt {
		t.Fatalf("done = %+v (%v)", done, err)
	}
	if due, _ := db.DuePersonalAgentReminders(ctx, time.Now().UTC().Format(time.RFC3339)); len(due) != 0 {
		t.Fatalf("a done item is due: %+v", due)
	}
	done.Status = store.PersonalAgentItemOpen
	if reopened, _ := db.SavePersonalAgentItem(ctx, done); reopened.ClosedAt != "" {
		t.Fatalf("reopened = %+v", reopened)
	}
	if err := db.DeletePersonalAgentItem(ctx, "user_b", qa.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("another person deletes it: %v", err)
	}
	if err := db.DeletePersonalAgentItem(ctx, "user_a", qa.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.GetPersonalAgentItem(ctx, "user_a", qa.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("deleted item: %v", err)
	}
}

// The daily digest goes out once a day.
func TestPersonalAgentDigestIsClaimedOncePerDay(t *testing.T) {
	db, ctx := newTestStore(t), context.Background()
	if _, err := db.CreatePersonalAgent(ctx, store.PersonalAgent{UserID: "user_a", WorkspaceID: "ws_pa", HomeDeviceID: "dev_a"}); err != nil {
		t.Fatal(err)
	}
	for day, want := range []bool{true, false} {
		if claimed, err := db.ClaimPersonalAgentDigest(ctx, "user_a", "2026-10-15"); err != nil || claimed != want {
			t.Fatalf("claim %d = %v (%v)", day, claimed, err)
		}
	}
	if claimed, _ := db.ClaimPersonalAgentDigest(ctx, "user_a", "2026-10-16"); !claimed {
		t.Fatal("the next day's digest")
	}
	if agents, err := db.ListPersonalAgents(ctx); err != nil || len(agents) != 1 || agents[0].UserID != "user_a" {
		t.Fatalf("agents = %+v (%v)", agents, err)
	}
}
