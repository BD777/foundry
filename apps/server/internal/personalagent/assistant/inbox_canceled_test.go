package assistant

import (
	"context"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/sqlitestore"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// A canceled turn settles its message: the cancel says this turn does not
// run, so the entry stops being "delivered" and never asks the person to
// retry it. A failed attempt still waits for them (DEV-279).
func TestInboxResultSettlesCanceledTurns(t *testing.T) {
	for status, want := range map[string][2]string{
		"completed": {"resolved", ""},
		"canceled":  {"resolved", ""},
		"failed":    {"delivered", "execution_failed"},
	} {
		gotStatus, gotReason := inboxResultStatus(status)
		if gotStatus != want[0] || gotReason != want[1] {
			t.Fatalf("%s: %q/%q, want %q/%q", status, gotStatus, gotReason, want[0], want[1])
		}
	}
}

// A canceled attempt an older server left "delivered" is settled by the next
// pass without reading its session back: it no longer counts as a message
// the person has to deal with (DEV-279).
func TestRecoverSettlesAnOldCanceledAttempt(t *testing.T) {
	db, err := sqlitestore.Open(t.TempDir() + "/foundry.db")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	ctx := context.Background()
	entry, err := db.CapturePersonalAgentInbox(ctx, store.PersonalAgentInboxEntry{
		ID: "inbox_canceled", UserID: "user_1", AssistantID: "asst_1", Channel: "mc:mch_1:key",
		MessageID: "om_1", Text: "统一看看这个", InputID: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
	})
	if err != nil {
		t.Fatal(err)
	}
	entry.Status, entry.SessionID, entry.ResultStatus = "delivered", "sess_1", "canceled"
	if _, err := db.SavePersonalAgentInbox(ctx, entry); err != nil {
		t.Fatal(err)
	}
	service := &Service{store: db}
	service.recoverInboxResults(ctx)
	settled, err := db.GetPersonalAgentInbox(ctx, "asst_1", entry.ID)
	if err != nil {
		t.Fatal(err)
	}
	if settled.Status != "resolved" || settled.WaitingReason != "" || settled.ResultStatus != "canceled" {
		t.Fatalf("a canceled attempt = %+v, want resolved/canceled", settled)
	}
	// The repair runs once: nothing is left for the next pass to settle.
	unresolved, err := db.UnresolvedPersonalAgentInboxResults(ctx, 10)
	if err != nil || len(unresolved) != 0 {
		t.Fatalf("unresolved after settling = %+v, %v", unresolved, err)
	}
}
