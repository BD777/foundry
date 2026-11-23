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
	return store.PersonalAgentInboxEntry{ID: id, UserID: user, AssistantID: "asst_" + user, Channel: channel,
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
	items, err := db.ListPersonalAgentInbox(ctx, input.AssistantID, 100)
	if err != nil || len(items) != 1 {
		t.Fatalf("duplicate captures: %+v, %v", items, err)
	}
	input.Text = "different intent"
	if _, err := db.CapturePersonalAgentInbox(ctx, input); !errors.Is(err, store.ErrIdempotencyConflict) {
		t.Fatalf("changed payload accepted: %v", err)
	}
	if _, err := db.GetPersonalAgentInbox(ctx, "asst_person-b", saved.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("another assistant read the input: %v", err)
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
	retry, err := db.RetryPersonalAgentInbox(ctx, first.AssistantID, first.ID, first.Revision, next)
	if err != nil || retry.RootID != first.ID || retry.Text != first.Text || retry.UserID != first.UserID || retry.AssistantID != first.AssistantID || retry.Timezone != first.Timezone {
		t.Fatalf("retry changed source: %+v %v", retry, err)
	}
	again, err := db.RetryPersonalAgentInbox(ctx, first.AssistantID, first.ID, first.Revision, next)
	if err != nil || again.ID != retry.ID {
		t.Fatalf("retry request duplicated: %+v %v", again, err)
	}
	retry.Status = "dispatching"
	retry, err = db.SavePersonalAgentInbox(ctx, retry)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.RetryPersonalAgentInbox(ctx, retry.AssistantID, retry.ID, retry.Revision, inboxFixture("person-a", "web", "third")); err == nil {
		t.Fatal("unknown dispatch was repeated")
	}
}

func TestInboxKeepsWebAttachmentsAcrossRetry(t *testing.T) {
	db, ctx := newTestStore(t), context.Background()
	files := []store.ChatAttachment{
		{ID: "att_1", Name: "photo.png", Path: "inbox/photo.png", MIMEType: "image/png", Size: 12, Kind: "image"},
		{ID: "att_2", Name: "notes.txt", Path: "inbox/notes.txt", MIMEType: "text/plain", Size: 4, Kind: "file"},
	}
	input := inboxFixture("person-a", "web", "with-files")
	input.Text, input.Attachments = "", files
	first, err := db.CapturePersonalAgentInbox(ctx, input)
	if err != nil {
		t.Fatal(err)
	}
	if len(first.Attachments) != 2 || first.Attachments[0].ID != "att_1" {
		t.Fatalf("captured attachments = %+v", first.Attachments)
	}
	replayed, err := db.CapturePersonalAgentInbox(ctx, input)
	if err != nil || len(replayed.Attachments) != 2 {
		t.Fatalf("replay lost its files: %+v %v", replayed, err)
	}
	changed := input
	changed.Attachments = files[:1]
	if _, err := db.CapturePersonalAgentInbox(ctx, changed); !errors.Is(err, store.ErrIdempotencyConflict) {
		t.Fatalf("changed files reused the message id: %v", err)
	}
	empty := inboxFixture("person-a", "web", "no-content")
	empty.Text = ""
	if _, err := db.CapturePersonalAgentInbox(ctx, empty); err == nil {
		t.Fatal("an empty message without files was accepted")
	}
	first.Status, first.WaitingReason = "waiting", "device_offline"
	first, err = db.SavePersonalAgentInbox(ctx, first)
	if err != nil {
		t.Fatal(err)
	}
	retry, err := db.RetryPersonalAgentInbox(ctx, first.AssistantID, first.ID, first.Revision, inboxFixture("person-a", "web", "retry-files"))
	if err != nil || len(retry.Attachments) != 2 || retry.Attachments[1].Name != "notes.txt" {
		t.Fatalf("retry lost its files: %+v %v", retry, err)
	}
}

func TestInboxDismissCancelsAHeldMessageAndRecordsWho(t *testing.T) {
	db, ctx := newTestStore(t), context.Background()
	entry, err := db.CapturePersonalAgentInbox(ctx, inboxFixture("person-a", "web", "dismiss-me"))
	if err != nil {
		t.Fatal(err)
	}
	entry.Status, entry.SessionID, entry.ResultStatus = "resolved", "failed-session", "failed"
	entry, err = db.SavePersonalAgentInbox(ctx, entry)
	if err != nil {
		t.Fatal(err)
	}
	dismissed, err := db.DismissPersonalAgentInbox(ctx, entry.AssistantID, entry.ID, entry.Revision, entry.UserID)
	if err != nil || dismissed.Status != "cancelled" || dismissed.DismissedBy != entry.UserID ||
		dismissed.DismissedAt == "" || dismissed.Revision != entry.Revision+1 {
		t.Fatalf("dismiss = %+v (%v)", dismissed, err)
	}
	again, err := db.DismissPersonalAgentInbox(ctx, entry.AssistantID, entry.ID, dismissed.Revision, entry.UserID)
	if err != nil || again.Revision != dismissed.Revision || again.Status != "cancelled" {
		t.Fatalf("dismiss was not idempotent: %+v (%v)", again, err)
	}
	if _, err := db.DismissPersonalAgentInbox(ctx, entry.AssistantID, entry.ID, entry.Revision, entry.UserID); !errors.Is(err, store.ErrPersonalAgentRevision) {
		t.Fatalf("stale revision dismissed: %v", err)
	}

	dispatching, err := db.CapturePersonalAgentInbox(ctx, inboxFixture("person-a", "web", "dispatching"))
	if err != nil {
		t.Fatal(err)
	}
	dispatching.Status = "dispatching"
	dispatching, err = db.SavePersonalAgentInbox(ctx, dispatching)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.DismissPersonalAgentInbox(ctx, dispatching.AssistantID, dispatching.ID, dispatching.Revision, dispatching.UserID); err == nil {
		t.Fatal("a message being dispatched was dismissed")
	}
}

func TestInboxResolvedFailureCanRetryWithoutReplayingASuccess(t *testing.T) {
	db, ctx := newTestStore(t), context.Background()
	entry, err := db.CapturePersonalAgentInbox(ctx, inboxFixture("person-a", "web", "failed-original"))
	if err != nil {
		t.Fatal(err)
	}
	control, e := db.EnsurePersonalAgentRunControl(ctx, store.PersonalAgentRunControl{ID: "failed-control", UserID: entry.UserID, AssistantID: entry.AssistantID, SessionID: "historical-session", InputID: entry.InputID, DispatchAttempted: true})
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
	if _, e = db.RetryPersonalAgentInbox(ctx, entry.AssistantID, entry.ID, entry.Revision, inboxFixture("person-a", "web", "before-native-end")); e == nil {
		t.Fatal("desired cancellation was treated as actual cessation")
	}
	if e = db.NotePersonalAgentNativeEnd(ctx, control.SessionID, control.InputID, "failed"); e != nil {
		t.Fatal(e)
	}
	retry, err := db.RetryPersonalAgentInbox(ctx, entry.AssistantID, entry.ID, entry.Revision, inboxFixture("person-a", "web", "retry-failed"))
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
	if _, err = db.RetryPersonalAgentInbox(ctx, retry.AssistantID, retry.ID, retry.Revision, inboxFixture("person-a", "web", "repeat-success")); err == nil {
		t.Fatal("success was repeated by failure recovery")
	}
}

func TestInboxKeepsAnswerAnnotationsAcrossReplayAndRetry(t *testing.T) {
	db, ctx := newTestStore(t), context.Background()
	annotations := []store.SessionInputAnnotation{{ID: "ann_1", SelectedText: "passage", Comment: "why", SourceEventID: "evt_answer", MessageAt: "2026-11-17T01:00:00Z"}}
	input := inboxFixture("person-a", "web", "with-annotations")
	input.Annotations = annotations
	first, err := db.CapturePersonalAgentInbox(ctx, input)
	if err != nil {
		t.Fatal(err)
	}
	if len(first.Annotations) != 1 || first.Annotations[0].SelectedText != "passage" || first.Annotations[0].Comment != "why" {
		t.Fatalf("captured annotations = %+v", first.Annotations)
	}
	replayed, err := db.CapturePersonalAgentInbox(ctx, input)
	if err != nil || len(replayed.Annotations) != 1 {
		t.Fatalf("replay lost its annotations: %+v %v", replayed, err)
	}
	changed := input
	changed.Annotations = nil
	if _, err := db.CapturePersonalAgentInbox(ctx, changed); !errors.Is(err, store.ErrIdempotencyConflict) {
		t.Fatalf("changed annotations reused the message id: %v", err)
	}
	first.Status, first.WaitingReason = "waiting", "device_offline"
	first, err = db.SavePersonalAgentInbox(ctx, first)
	if err != nil {
		t.Fatal(err)
	}
	retry, err := db.RetryPersonalAgentInbox(ctx, first.AssistantID, first.ID, first.Revision, inboxFixture("person-a", "web", "retry-annotations"))
	if err != nil || len(retry.Annotations) != 1 || retry.Annotations[0].ID != "ann_1" {
		t.Fatalf("retry lost its annotations: %+v %v", retry, err)
	}
}

// The person's message awaits its conversation's turn while it is new,
// being delivered or waiting for the busy assistant; not when it waits for
// anything else, is delivered, or is a message channel's. A turn's end
// makes the busy waits due at once.
func TestInboxAwaitsTurnAndReleasesBusyWaits(t *testing.T) {
	db, ctx := newTestStore(t), context.Background()
	assistantID := "asst_person-a"
	awaits := func() bool {
		t.Helper()
		waiting, err := db.PersonalAgentInboxAwaitsTurn(ctx, assistantID)
		if err != nil {
			t.Fatal(err)
		}
		return waiting
	}
	if _, err := db.CapturePersonalAgentInbox(ctx, inboxFixture("person-a", "mc:chan:conv", "channel-1")); err != nil {
		t.Fatal(err)
	}
	if awaits() {
		t.Fatal("a message channel's entry held the person's conversation")
	}
	entry, err := db.CapturePersonalAgentInbox(ctx, inboxFixture("person-a", "web", "message-1"))
	if err != nil {
		t.Fatal(err)
	}
	if !awaits() {
		t.Fatal("a new message does not await the turn")
	}
	save := func(status, reason, lease string) {
		t.Helper()
		entry.Status, entry.WaitingReason, entry.LeaseUntil = status, reason, lease
		if entry, err = db.SavePersonalAgentInbox(ctx, entry); err != nil {
			t.Fatal(err)
		}
	}
	later := time.Now().Add(10 * time.Second).UTC().Format(time.RFC3339Nano)
	save("waiting", "device_offline", later)
	if awaits() {
		t.Fatal("a message waiting for its device held the conversation")
	}
	save("waiting", "assistant_busy", later)
	if !awaits() {
		t.Fatal("a message waiting for the busy assistant does not await the turn")
	}
	webDue := func() []store.PersonalAgentInboxEntry {
		t.Helper()
		due, err := db.DuePersonalAgentInbox(ctx, paNow(), 20)
		if err != nil {
			t.Fatal(err)
		}
		var web []store.PersonalAgentInboxEntry
		for _, item := range due {
			if item.Channel == "web" {
				web = append(web, item)
			}
		}
		return web
	}
	if due := webDue(); len(due) != 0 {
		t.Fatalf("busy wait due before its lease: %+v", due)
	}
	if err := db.ReleasePersonalAgentInboxBusy(ctx, assistantID); err != nil {
		t.Fatal(err)
	}
	if due := webDue(); len(due) != 1 || due[0].ID != entry.ID || due[0].Revision != entry.Revision {
		t.Fatalf("released busy wait = %+v; want due with its revision", due)
	}
	entry.SessionID = "sess_home"
	save("delivered", "", "")
	if awaits() {
		t.Fatal("a delivered message still holds the conversation")
	}
}
