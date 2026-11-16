package httpapi

import (
	"context"
	"net/http"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func TestInboxEntryNeedsThePersonOnlyWhenAnAttemptFailedOrItWaitsOnThem(t *testing.T) {
	cases := []struct {
		name  string
		entry store.PersonalAgentInboxEntry
		want  bool
	}{
		{"failed attempt", store.PersonalAgentInboxEntry{Status: "delivered", SessionID: "sess_1", ResultStatus: "failed"}, true},
		{"stopped attempt", store.PersonalAgentInboxEntry{Status: "delivered", SessionID: "sess_1", ResultStatus: "canceled"}, true},
		{"waits on the computer", store.PersonalAgentInboxEntry{Status: "waiting", WaitingReason: "device_offline"}, true},
		{"busy assistant clears itself", store.PersonalAgentInboxEntry{Status: "waiting", WaitingReason: "assistant_busy"}, false},
		{"attempt still running", store.PersonalAgentInboxEntry{Status: "delivered", SessionID: "sess_1"}, false},
		{"answered", store.PersonalAgentInboxEntry{Status: "resolved", SessionID: "sess_1", ResultStatus: "completed"}, false},
		{"dismissed", store.PersonalAgentInboxEntry{Status: "cancelled", WaitingReason: "device_offline"}, false},
	}
	for _, tc := range cases {
		if got := inboxEntryNeedsPerson(tc.entry); got != tc.want {
			t.Errorf("%s: needs the person = %v, want %v", tc.name, got, tc.want)
		}
	}
}

func TestFailedInboxAttemptIsOneItemOnItsMessage(t *testing.T) {
	f := newDigestFixture(t)
	ctx := context.Background()
	agent := defaultAssistantOf(t, f.server, f.aliceID)
	entry, err := f.server.assistant.CaptureInbox(ctx, agent, "web", store.PersonalAgentInboxCapture{MessageID: "web-request-failed", Text: "写一份周报"})
	if err != nil {
		t.Fatalf("capture: %v", err)
	}
	f.server.assistant.DrainInbox(ctx)
	run := f.daemon.nextChatRun()
	failed, err := f.server.store.GetPersonalAgentInbox(ctx, agent.ID, entry.ID)
	if err != nil {
		t.Fatal(err)
	}
	const failure = "API Error: 429 rate_limit_error"
	failed.SessionID, failed.ResultStatus, failed.ResultError = run.Session.ID, "failed", failure
	failed.Status, failed.WaitingReason = "delivered", "execution_failed"
	if _, err := f.server.store.SavePersonalAgentInbox(ctx, failed); err != nil {
		t.Fatal(err)
	}

	// The turn's own failure belongs to the message's item, not to a second one.
	pendingReactions{f.server}.recordTurnFailure(ctx, run.Session, failure, "model_rate_limit")
	if !f.server.assistantInboxTurn(ctx, run.Session) {
		t.Fatal("the attempt is not recognised as an unprocessed message's turn")
	}
	if !f.server.reconcileInboxPending(ctx, f.aliceID, map[string]bool{}) {
		t.Fatal("the failed message has no pending item")
	}
	items, err := f.server.store.ListPendingItems(ctx, f.aliceID, []string{store.PendingOpen}, "", 50)
	if err != nil {
		t.Fatal(err)
	}
	var inbox []store.PendingItem
	turnFailed := 0
	for _, item := range items {
		switch item.Source {
		case store.PendingSourceAssistantInbox:
			inbox = append(inbox, item)
		case store.PendingSourceTurnFailed:
			turnFailed++
		}
	}
	if turnFailed != 0 || len(inbox) != 1 {
		t.Fatalf("one failed message wants one item: turn_failed %d, items %+v", turnFailed, items)
	}
	if inbox[0].Key != "inbox:"+entry.ID || inbox[0].FailureCategory != "rate_limited" {
		t.Fatalf("the message's item = %+v", inbox[0])
	}
	if f.server.reconcileInboxPending(ctx, f.aliceID, map[string]bool{inbox[0].Key: true}) {
		t.Fatal("reconciling an unchanged inbox changed its items")
	}

	answered, err := f.server.store.GetPersonalAgentInbox(ctx, agent.ID, entry.ID)
	if err != nil {
		t.Fatal(err)
	}
	answered.Status, answered.ResultStatus, answered.WaitingReason = "resolved", "completed", ""
	if _, err := f.server.store.SavePersonalAgentInbox(ctx, answered); err != nil {
		t.Fatal(err)
	}
	f.server.reconcileInboxPending(ctx, f.aliceID, map[string]bool{inbox[0].Key: true})
	closed, err := f.server.store.GetPendingItem(ctx, f.aliceID, inbox[0].ID)
	if err != nil {
		t.Fatal(err)
	}
	if closed.State != store.PendingDone {
		t.Fatalf("an answered message's item = %+v, want done", closed)
	}
}

func TestInboxRetryBeforeTheNativeEndReceiptIsRefusedWithItsCode(t *testing.T) {
	f := newDigestFixture(t)
	ctx := context.Background()
	agent := defaultAssistantOf(t, f.server, f.aliceID)
	entry, err := f.server.assistant.CaptureInbox(ctx, agent, "web", store.PersonalAgentInboxCapture{MessageID: "web-request-refused", Text: "写一份月报"})
	if err != nil {
		t.Fatalf("capture: %v", err)
	}
	f.server.assistant.DrainInbox(ctx)
	run := f.daemon.nextChatRun()
	failed, err := f.server.store.GetPersonalAgentInbox(ctx, agent.ID, entry.ID)
	if err != nil {
		t.Fatal(err)
	}
	failed.SessionID, failed.ResultStatus, failed.ResultError = run.Session.ID, "failed", "API Error: 429 rate_limit_error"
	failed.Status, failed.WaitingReason = "delivered", "execution_failed"
	saved, err := f.server.store.SavePersonalAgentInbox(ctx, failed)
	if err != nil {
		t.Fatal(err)
	}
	// The attempt has no native end receipt yet, so the retry is refused.
	_, err = f.server.assistant.RetryInbox(ctx, agent, entry.ID, store.PersonalAgentInboxAction{
		Action: "retry", Revision: saved.Revision, RequestID: "retry-refused-1",
	})
	if err == nil {
		t.Fatal("a retry before the native end receipt was accepted")
	}
	code, status := inboxRetryRefusal(err)
	if code != inboxRetryNotSettledCode || status != http.StatusConflict {
		t.Fatalf("refusal = %q/%d, want %q/409 (err %v)", code, status, inboxRetryNotSettledCode, err)
	}
}

func TestUnprocessedMessageShowsWhenItWasSent(t *testing.T) {
	f := newDigestFixture(t)
	ctx := context.Background()
	agent := defaultAssistantOf(t, f.server, f.aliceID)
	entry, err := f.server.assistant.CaptureInbox(ctx, agent, "web", store.PersonalAgentInboxCapture{MessageID: "web-request-sent-at", Text: "记下这件事"})
	if err != nil {
		t.Fatalf("capture: %v", err)
	}
	saved, err := f.server.store.GetPersonalAgentInbox(ctx, agent.ID, entry.ID)
	if err != nil {
		t.Fatal(err)
	}
	got := f.server.inboxMessageAt(ctx, f.aliceID, store.PendingItem{
		UserID: f.aliceID, AssistantID: agent.ID, Source: store.PendingSourceAssistantInbox, Key: "inbox:" + entry.ID,
	})
	if got == "" || got != saved.CreatedAt {
		t.Fatalf("message time = %q, want the entry's %q", got, saved.CreatedAt)
	}
}
