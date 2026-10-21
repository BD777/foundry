package sqlitestore

import (
	"context"
	"errors"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/personalagent/flow"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func inboxFixture(user, channel, message string) store.PersonalAgentInboxEntry {
	id := flow.Key("inbox", user, channel, message)
	return store.PersonalAgentInboxEntry{ID: id, UserID: user, Channel: channel,
		MessageID: message, InputID: flow.InputID(id), Text: "记下两个方向，先不要执行"}
}

func TestInboxConcurrentCaptureAndRestartKeepOneReceipt(t *testing.T) {
	path := filepath.Join(t.TempDir(), "inbox.db")
	db, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	input := inboxFixture("person-a", "web", "message-1")
	var wg sync.WaitGroup
	for range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			saved, err := db.CapturePersonalAgentInbox(ctx, input)
			if err != nil || saved.ID != input.ID || saved.Revision != 1 || saved.Status != "pending" {
				t.Errorf("capture: %+v, %v", saved, err)
			}
		}()
	}
	wg.Wait()
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	db, err = Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	saved, err := db.CapturePersonalAgentInbox(ctx, input)
	if err != nil || saved.Revision != 1 {
		t.Fatalf("replay after restart: %+v, %v", saved, err)
	}
	items, err := db.ListPersonalAgentInbox(ctx, input.UserID, 100)
	if err != nil || len(items) != 1 {
		t.Fatalf("duplicate captures: %+v, %v", items, err)
	}
	input.Text = "different intent"
	if _, err := db.CapturePersonalAgentInbox(ctx, input); !errors.Is(err, store.ErrIdempotencyConflict) {
		t.Fatalf("changed payload accepted: %v", err)
	}
	if _, err := db.GetPersonalAgentInbox(ctx, "person-b", saved.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("another person read the input: %v", err)
	}
}

func TestInboxLeaseCASAndImmutableSource(t *testing.T) {
	db, ctx := newTestStore(t), context.Background()
	initial, err := db.CapturePersonalAgentInbox(ctx, inboxFixture("person-a", "web", "message-1"))
	if err != nil {
		t.Fatal(err)
	}
	claimed := initial
	claimed.Status, claimed.LeaseUntil = "dispatching", time.Now().Add(time.Minute).UTC().Format(time.RFC3339Nano)
	claimed.Text = "must never replace original text"
	claimed, err = db.SavePersonalAgentInbox(ctx, claimed)
	if err != nil || claimed.Text != initial.Text || claimed.Revision != 2 {
		t.Fatalf("claim changed source: %+v, %v", claimed, err)
	}
	if _, err := db.SavePersonalAgentInbox(ctx, initial); !errors.Is(err, store.ErrPersonalAgentRevision) {
		t.Fatalf("stale writer accepted: %v", err)
	}
	if due, err := db.DuePersonalAgentInbox(ctx, paNow(), 20); err != nil || len(due) != 0 {
		t.Fatalf("active lease reissued: %+v %v", due, err)
	}
	if due, _ := db.DuePersonalAgentInbox(ctx, time.Now().Add(2*time.Minute).UTC().Format(time.RFC3339Nano), 20); len(due) != 1 {
		t.Fatal("lost worker lease cannot recover")
	}
	claimed.Status, claimed.SessionID, claimed.LeaseUntil = "delivered", "session-receipt", ""
	delivered, err := db.SavePersonalAgentInbox(ctx, claimed)
	if err != nil {
		t.Fatal(err)
	}
	delivered.SessionID = "a-second-session"
	if _, err := db.SavePersonalAgentInbox(ctx, delivered); err == nil {
		t.Fatal("receipt can be replaced by a duplicate execution")
	}
	delivered.SessionID, delivered.Status = "session-receipt", "resolved"
	closed, err := db.SavePersonalAgentInbox(ctx, delivered)
	if err != nil {
		t.Fatal(err)
	}
	closed.Status = "pending"
	if _, err := db.SavePersonalAgentInbox(ctx, closed); err == nil {
		t.Fatal("closed input redispatched")
	}
}

func TestInboxExplicitRetryKeepsRootAndDoesNotRaceUnknownDispatch(t *testing.T) {
	db, ctx := newTestStore(t), context.Background()
	input := inboxFixture("person-a", "web", "first")
	input.Timezone = "Asia/Shanghai"
	first, err := db.CapturePersonalAgentInbox(ctx, input)
	if err != nil {
		t.Fatal(err)
	}
	first.Status, first.WaitingReason = "waiting", "account_unavailable"
	first, err = db.SavePersonalAgentInbox(ctx, first)
	if err != nil {
		t.Fatal(err)
	}
	next := inboxFixture("ignored-user", "web", "retry-key")
	retry, err := db.RetryPersonalAgentInbox(ctx, first.UserID, first.ID, first.Revision, next)
	if err != nil || retry.RootID != first.ID || retry.Text != first.Text || retry.UserID != first.UserID || retry.Timezone != first.Timezone {
		t.Fatalf("retry changed source: %+v %v", retry, err)
	}
	again, err := db.RetryPersonalAgentInbox(ctx, first.UserID, first.ID, first.Revision, next)
	if err != nil || again.ID != retry.ID {
		t.Fatalf("retry request duplicated: %+v %v", again, err)
	}
	retry.Status = "dispatching"
	retry, err = db.SavePersonalAgentInbox(ctx, retry)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.RetryPersonalAgentInbox(ctx, retry.UserID, retry.ID, retry.Revision, inboxFixture("person-a", "web", "third")); err == nil {
		t.Fatal("unknown dispatch was repeated")
	}
}

func TestInboxResolvedFailureCanRetryWithoutReplayingASuccess(t *testing.T) {
	db, ctx := newTestStore(t), context.Background()
	entry, err := db.CapturePersonalAgentInbox(ctx, inboxFixture("person-a", "web", "failed-original"))
	if err != nil {
		t.Fatal(err)
	}
	control, e := db.EnsurePersonalAgentRunControl(ctx, store.PersonalAgentRunControl{ID: "failed-control", UserID: entry.UserID, SessionID: "historical-session", InputID: entry.InputID, DispatchAttempted: true})
	if e != nil {
		t.Fatal(e)
	}
	entry.Status = "resolved"
	entry.SessionID = "historical-session"
	entry.ResultStatus = "failed"
	entry, err = db.SavePersonalAgentInbox(ctx, entry)
	if err != nil {
		t.Fatal(err)
	}
	if _, e = db.RetryPersonalAgentInbox(ctx, entry.UserID, entry.ID, entry.Revision, inboxFixture("person-a", "web", "before-native-end")); e == nil {
		t.Fatal("desired cancellation was treated as actual cessation")
	}
	if e = db.NotePersonalAgentNativeEnd(ctx, control.SessionID, control.InputID, "failed"); e != nil {
		t.Fatal(e)
	}
	retry, err := db.RetryPersonalAgentInbox(ctx, entry.UserID, entry.ID, entry.Revision, inboxFixture("person-a", "web", "retry-failed"))
	if err != nil || retry.RootID != entry.ID {
		t.Fatalf("resolved failure did not retain its source on retry %+v %v", retry, err)
	}
	retry.Status = "resolved"
	retry.ResultStatus = "completed"
	retry.SessionID = "success-session"
	retry, err = db.SavePersonalAgentInbox(ctx, retry)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.RetryPersonalAgentInbox(ctx, retry.UserID, retry.ID, retry.Revision, inboxFixture("person-a", "web", "repeat-success")); err == nil {
		t.Fatal("success was repeated by failure recovery")
	}
}
