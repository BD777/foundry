package httpapi

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// The person's message that arrived while the assistant's turn ran starts
// its next turn, before a helper's message that waited for that turn to end
// (live e2e 2026-11-24 P3), and as soon as the turn ends, not at the
// message's next scheduled try. The helper's message follows in the turn
// after.
func TestAssistantPersonMessageGoesBeforeHeldHelperMessages(t *testing.T) {
	f := newDigestFixture(t)
	ctx := context.Background()
	agent := defaultAssistantOf(t, f.server, f.aliceID)
	first, err := f.server.assistant.CaptureInbox(ctx, agent, "web", store.PersonalAgentInboxCapture{MessageID: "first", Text: "修一下 zspread 的读写报错"})
	if err != nil {
		t.Fatal(err)
	}
	f.server.assistant.DrainInbox(ctx)
	run := f.daemon.nextChatRun()
	if run.Session.Input.ID != first.InputID {
		t.Fatalf("first turn input = %+v", run.Session.Input)
	}
	home, err := f.db.GetAgentSessionRecord(ctx, run.Session.ID)
	if err != nil {
		t.Fatal(err)
	}
	helper, err := f.db.CreateAgentSession(ctx, store.CreateAgentSessionInput{
		CreatedByUserID: f.aliceID, WorkspaceID: "ws_budget", AgentID: "agent_budget", Provider: "claude",
		Prompt: "fix zspread", Title: "Fix zspread", Source: store.SessionSourceAgent, ParentSessionID: home.ID,
	})
	if err != nil {
		t.Fatal(err)
	}
	_, receipt, err := f.server.sessionService.SendInboxMessage(ctx, home, "", helper.ID, store.DeliveryTurnEnd, "helper: zspread fixed, health 200", nil, nil)
	if err != nil || receipt.State != store.InboxHeld {
		t.Fatalf("helper message receipt = %+v, %v; want held for the running turn", receipt, err)
	}
	second, err := f.server.assistant.CaptureInbox(ctx, agent, "web", store.PersonalAgentInboxCapture{MessageID: "second", Text: "12 月 8 号是星期几？"})
	if err != nil {
		t.Fatal(err)
	}
	f.server.assistant.DrainInbox(ctx)
	if waiting, _ := f.db.GetPersonalAgentInbox(ctx, agent.ID, second.ID); waiting.Status != "waiting" || waiting.WaitingReason != "assistant_busy" {
		t.Fatalf("person's message during the turn = %+v, want waiting for the busy assistant", waiting)
	}

	f.daemon.complete(run.Session, "已安排帮手修复。")
	waitForStatus(t, f.db, home.ID, "completed")
	// The session inbox tries first, as when its pump wakes before the
	// assistant's inbox does.
	f.server.sessionService.PumpInbox(ctx)
	deadline := time.Now().Add(5 * time.Second)
	for {
		f.server.assistant.DrainInbox(ctx)
		entry, _ := f.db.GetPersonalAgentInbox(ctx, agent.ID, second.ID)
		if entry.Status == "delivered" || time.Now().After(deadline) {
			break
		}
		f.server.sessionService.PumpInbox(ctx)
		time.Sleep(20 * time.Millisecond)
	}
	next := f.daemon.nextChatRun()
	if next.Session.ID != home.ID || next.Session.Input.ID != second.InputID {
		t.Fatalf("turn after the busy one took %q (%s), want the person's message %s", next.Session.Input.Prompt, next.Session.Input.ID, second.InputID)
	}
	held, ok, err := f.db.SessionInboxItem(ctx, home.ID, receipt.InputID)
	if err != nil || !ok || held.State != store.InboxHeld {
		t.Fatalf("helper message = %+v, want it still held", held)
	}

	f.daemon.complete(next.Session, "星期二。")
	waitForStatus(t, f.db, home.ID, "completed")
	f.server.sessionService.PumpInbox(ctx)
	after := f.daemon.nextChatRun()
	if after.Session.ID != home.ID || !strings.Contains(after.Session.Input.Prompt, "zspread fixed") {
		t.Fatalf("turn after the person's = %q, want the helper's message", after.Session.Input.Prompt)
	}
}
