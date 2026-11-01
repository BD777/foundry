package httpapi

import (
	"context"
	"errors"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func TestAssistantInboxCapturesWithoutDeviceAndDoesNotDispatch(t *testing.T) {
	f := newAssistantFixture(t) // registered device, no live daemon connection
	ctx := context.Background()
	input := store.PersonalAgentInboxCapture{MessageID: "web-request-1", Text: "记下两个方向，先不要执行"}
	entry, err := f.server.captureAssistantInbox(ctx, f.aliceID, "web", input)
	if err != nil || entry.Status != "pending" {
		t.Fatalf("capture: %+v %v", entry, err)
	}
	again, err := f.server.captureAssistantInbox(ctx, f.aliceID, "web", input)
	if err != nil || again.ID != entry.ID {
		t.Fatalf("duplicate capture: %+v %v", again, err)
	}
	before, _ := f.server.store.ListAgentSessionSummaries(ctx, "ws_pa")
	f.server.drainPersonalAgentInbox(ctx)
	saved, err := f.server.store.GetPersonalAgentInbox(ctx, f.aliceID, entry.ID)
	if err != nil || saved.Status != "waiting" || saved.WaitingReason != "device_offline" || saved.SessionID != "" {
		t.Fatalf("offline receipt: %+v %v", saved, err)
	}
	after, _ := f.server.store.ListAgentSessionSummaries(ctx, "ws_pa")
	if len(after) != len(before) {
		t.Fatal("capture created work while offline")
	}
	input.Text = "different message"
	if _, err := f.server.captureAssistantInbox(ctx, f.aliceID, "web", input); !errors.Is(err, store.ErrIdempotencyConflict) {
		t.Fatalf("reused message ID: %v", err)
	}
}

func TestAssistantInboxReconcilesLostReceiptAndContinuesConversation(t *testing.T) {
	f := newDigestFixture(t)
	ctx := context.Background()
	entry, err := f.server.captureAssistantInbox(ctx, f.aliceID, "web",
		store.PersonalAgentInboxCapture{MessageID: "first", Text: "请记下研究导出格式，不要实施"})
	if err != nil {
		t.Fatal(err)
	}
	f.server.drainPersonalAgentInbox(ctx)
	run := f.daemon.nextChatRun()
	if run.Session.Input.ID != entry.InputID || run.Session.Input.Prompt == "" {
		t.Fatalf("wrong durable input: %+v", run.Session)
	}
	delivered, _ := f.server.store.GetPersonalAgentInbox(ctx, f.aliceID, entry.ID)
	if delivered.Status != "delivered" || delivered.SessionID != run.Session.ID {
		t.Fatalf("no dispatch receipt: %+v", delivered)
	}
	// Simulate a committed session whose delivery acknowledgement was lost.
	// The stable input lookup, not another CreateAgentSession, recovers it.
	delivered.Status, delivered.LeaseUntil = "dispatching", ""
	delivered, err = f.server.store.SavePersonalAgentInbox(ctx, delivered)
	if err != nil {
		t.Fatal(err)
	}
	before, _ := f.db.ListAgentSessionSummaries(ctx, "ws_pa")
	f.server.drainPersonalAgentInbox(ctx)
	after, _ := f.db.ListAgentSessionSummaries(ctx, "ws_pa")
	recovered, _ := f.server.store.GetPersonalAgentInbox(ctx, f.aliceID, entry.ID)
	if len(before) != len(after) || recovered.Status != "delivered" || recovered.SessionID != run.Session.ID {
		t.Fatalf("lost receipt duplicated work: %+v", recovered)
	}
	f.daemon.complete(run.Session, "已记下，没有开始执行。")
	waitForStatus(t, f.db, run.Session.ID, "completed")
	next, err := f.server.captureAssistantInbox(ctx, f.aliceID, "web",
		store.PersonalAgentInboxCapture{MessageID: "second", Text: "补充：只比较 CSV 和 JSON"})
	if err != nil {
		t.Fatal(err)
	}
	f.server.drainPersonalAgentInbox(ctx)
	continued := f.daemon.nextChatRun()
	if continued.Session.ID != run.Session.ID || continued.Session.Input.ID != next.InputID {
		t.Fatalf("follow-up lost the conversation: old=%s new=%+v", run.Session.ID, continued.Session)
	}
}
