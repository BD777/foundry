package httpapi

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/sessions"
	"github.com/foundry-dev/foundry/apps/server/internal/sqlitestore"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// childReportFixture is a running parent and a child it created.
type childReportFixture struct {
	t      *testing.T
	db     *sqlitestore.Store
	server *Server
	parent store.AgentSession
	child  store.AgentSession
}

func newChildReportFixture(t *testing.T) *childReportFixture {
	t.Helper()
	db, parent := lineageFixture(t)
	ctx := context.Background()
	parent, err := db.StartAgentSession(ctx, parent.ID)
	if err != nil {
		t.Fatalf("start parent: %v", err)
	}
	child, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{
		WorkspaceID: "ws_lineage", AgentID: "agent_lineage", Provider: "claude",
		Prompt: "check the build", Title: "Build check", Source: "agent", ParentSessionID: parent.ID,
	})
	if err != nil {
		t.Fatalf("create child: %v", err)
	}
	return &childReportFixture{t: t, db: db, server: NewServer(db), parent: parent, child: child}
}

// finish runs the child's current input to its end with answer.
func (f *childReportFixture) finish(answer string) store.AgentSession {
	f.t.Helper()
	ctx := context.Background()
	if current, err := f.db.GetAgentSessionSummary(ctx, f.child.ID); err != nil || current.Status == "queued" {
		if _, err := f.db.StartAgentSession(ctx, f.child.ID); err != nil {
			f.t.Fatalf("start child: %v", err)
		}
	}
	child, err := f.db.CompleteAgentSession(ctx, f.child.ID, answer, "native-child")
	if err != nil {
		f.t.Fatalf("complete child: %v", err)
	}
	f.child = child
	childReportReactions{f.server}.SessionChanged(ctx, sessions.Completed, sessions.Slim(child))
	return child
}

// reports lists the parent's messages from the child, newest first.
func (f *childReportFixture) reports() []store.SessionInboxItem {
	f.t.Helper()
	items, err := f.db.SessionInboxItems(context.Background(), f.parent.ID, time.Now().Add(-time.Hour), 50)
	if err != nil {
		f.t.Fatalf("list parent inbox: %v", err)
	}
	var reports []store.SessionInboxItem
	for _, item := range items {
		if item.SenderSessionID == f.child.ID && strings.HasPrefix(item.Prompt, sessions.ChildReportPrefix) {
			reports = append(reports, item)
		}
	}
	return reports
}

// A child's ended turn reaches its parent once, as a turn_end message that
// carries its title, status and answer; its next turn reports again.
func TestChildReportReachesItsParentOncePerInput(t *testing.T) {
	f := newChildReportFixture(t)
	ctx := context.Background()
	child := f.finish("The build passes on main.")
	reports := f.reports()
	if len(reports) != 1 {
		t.Fatalf("reports = %d, want 1", len(reports))
	}
	report := reports[0]
	if report.InputID != childReportInputID(child) || report.Delivery != store.DeliveryTurnEnd || report.State != store.InboxHeld {
		t.Fatalf("report = %+v", report)
	}
	for _, want := range []string{child.ID, `"Build check"`, "finished a turn: completed", "Final answer:\nThe build passes on main."} {
		if !strings.Contains(report.Prompt, want) {
			t.Fatalf("report lacks %q:\n%s", want, report.Prompt)
		}
	}
	// The same end told again reports nothing new.
	childReportReactions{f.server}.SessionChanged(ctx, sessions.Completed, sessions.Slim(child))
	if got := len(f.reports()); got != 1 {
		t.Fatalf("reports after a repeated end = %d, want 1", got)
	}
	if _, err := f.db.SendAgentSessionInput(ctx, child.ID, store.SendAgentSessionInput{Prompt: "and on the release branch?"}); err != nil {
		t.Fatalf("send child input: %v", err)
	}
	f.finish("The release branch fails one test.")
	if got := len(f.reports()); got != 2 {
		t.Fatalf("reports after the next turn = %d, want 2", got)
	}
}

// A long answer is cut to its first 1500 characters, saying so.
func TestChildReportCutsALongAnswer(t *testing.T) {
	f := newChildReportFixture(t)
	f.finish(strings.Repeat("é", 4000))
	reports := f.reports()
	if len(reports) != 1 {
		t.Fatalf("reports = %d, want 1", len(reports))
	}
	if !strings.Contains(reports[0].Prompt, "first 1500 of 4000 characters") || len([]rune(reports[0].Prompt)) > 2000 {
		t.Fatalf("report of a long answer:\n%.400s… (%d runes)", reports[0].Prompt, len([]rune(reports[0].Prompt)))
	}
}

// A child created with reportBack: false, or whose parent is stopped or
// archived, reports nothing.
func TestChildReportSkipsOptOutAndEndedParents(t *testing.T) {
	ctx := context.Background()
	t.Run("opt-out", func(t *testing.T) {
		f := newChildReportFixture(t)
		if err := f.db.SetChildReportBack(ctx, f.child.ID, false); err != nil {
			t.Fatal(err)
		}
		f.finish("done")
		if got := len(f.reports()); got != 0 {
			t.Fatalf("reports = %d, want 0", got)
		}
		if err := f.db.SetChildReportBack(ctx, f.child.ID, true); err != nil {
			t.Fatal(err)
		}
		if back, err := f.db.ChildReportBack(ctx, f.child.ID); err != nil || !back {
			t.Fatalf("report back after turning it on = %v, %v", back, err)
		}
	})
	t.Run("stopped parent", func(t *testing.T) {
		f := newChildReportFixture(t)
		if _, err := f.db.CancelAgentSession(ctx, f.parent.ID, "stopped"); err != nil {
			t.Fatal(err)
		}
		f.finish("done")
		if got := len(f.reports()); got != 0 {
			t.Fatalf("reports = %d, want 0", got)
		}
	})
	t.Run("archived parent", func(t *testing.T) {
		f := newChildReportFixture(t)
		if _, err := f.db.CompleteAgentSession(ctx, f.parent.ID, "parent done", "native-parent"); err != nil {
			t.Fatal(err)
		}
		if _, err := f.db.ArchiveChats(ctx, store.ArchiveChatsInput{WorkspaceID: "ws_lineage", ChatIDs: []string{f.parent.ID}}, false); err != nil {
			t.Fatalf("archive parent: %v", err)
		}
		f.finish("done")
		if got := len(f.reports()); got != 0 {
			t.Fatalf("reports = %d, want 0", got)
		}
	})
	t.Run("scheduled run", func(t *testing.T) {
		f := newChildReportFixture(t)
		run, err := f.db.CreateAgentSession(ctx, store.CreateAgentSessionInput{
			WorkspaceID: "ws_lineage", AgentID: "agent_lineage", Provider: "claude",
			Prompt: "nightly", Source: "chat", ParentSessionID: f.parent.ID,
		})
		if err != nil {
			t.Fatal(err)
		}
		f.child = run
		f.finish("nightly done")
		if got := len(f.reports()); got != 0 {
			t.Fatalf("reports = %d, want 0", got)
		}
	})
}

// A child whose own message to its parent repeats its answer, or came just
// before its turn ended, already handed off: no report. One sent earlier
// in the turn leaves the report.
func TestChildReportDedupesTheChildsOwnHandoff(t *testing.T) {
	ctx := context.Background()
	send := func(f *childReportFixture, text string, at time.Time) {
		t.Helper()
		if _, err := f.db.AdmitSessionInboxItem(ctx, store.SessionInboxItem{
			SessionID: f.parent.ID, InputID: "0b6c3d2e-1f4a-4b5c-8d9e-" + at.Format("150405000000"), SenderSessionID: f.child.ID,
			Prompt: text, RequestedDelivery: store.DeliveryTurnEnd,
		}, store.SessionInboxRules{Now: at}); err != nil {
			t.Fatalf("admit child message: %v", err)
		}
	}
	// Messages sent during the turn; the window decides which counts as
	// sent just before its end.
	window := childReportHandoffWindow
	t.Cleanup(func() { childReportHandoffWindow = window })
	t.Run("same text", func(t *testing.T) {
		childReportHandoffWindow = 0
		f := newChildReportFixture(t)
		send(f, "Deployed  build 42.\n", time.Now())
		f.finish("Deployed build 42.")
		if got := len(f.reports()); got != 0 {
			t.Fatalf("reports = %d, want 0", got)
		}
	})
	t.Run("final handoff", func(t *testing.T) {
		childReportHandoffWindow = window
		f := newChildReportFixture(t)
		send(f, "DEV-1 handoff: everything is deployed and checked.", time.Now())
		f.finish("Everything is live on dev; details below.")
		if got := len(f.reports()); got != 0 {
			t.Fatalf("reports = %d, want 0", got)
		}
	})
	t.Run("early status", func(t *testing.T) {
		childReportHandoffWindow = 0
		f := newChildReportFixture(t)
		send(f, "Deploying now.", time.Now())
		f.finish("Deployed and checked.")
		if got := len(f.reports()); got != 1 {
			t.Fatalf("reports = %d, want 1", got)
		}
	})
}

// A parent that read the child's answer itself (get_session)
// has the report settled as read; it is not delivered again.
func TestChildReportReadByItsParentIsNotDelivered(t *testing.T) {
	ctx := context.Background()
	parentActor := func(f *childReportFixture) Actor {
		return Actor{Kind: ActorAgent, Identity: store.SessionTokenIdentity{SessionID: f.parent.ID, WorkspaceID: "ws_lineage", DeviceID: "dev_lineage"}}
	}
	t.Run("read after the report", func(t *testing.T) {
		f := newChildReportFixture(t)
		child := f.finish("All green.")
		other := Actor{Kind: ActorAgent, Identity: store.SessionTokenIdentity{SessionID: "sess_other", WorkspaceID: "ws_lineage"}}
		f.server.childReportRead(ctx, other, child)
		if reports := f.reports(); len(reports) != 1 || reports[0].State != store.InboxHeld {
			t.Fatalf("another session's read settled the report: %+v", reports)
		}
		f.server.childReportRead(ctx, parentActor(f), child)
		reports := f.reports()
		if len(reports) != 1 || reports[0].State != store.InboxConsumed || reports[0].Reason != childReportReadReason {
			t.Fatalf("reports after the parent read = %+v", reports)
		}
	})
	t.Run("read before the report", func(t *testing.T) {
		f := newChildReportFixture(t)
		if _, err := f.db.StartAgentSession(ctx, f.child.ID); err != nil {
			t.Fatal(err)
		}
		child, err := f.db.CompleteAgentSession(ctx, f.child.ID, "All green.", "native-child")
		if err != nil {
			t.Fatal(err)
		}
		f.child = child
		f.server.childReportRead(ctx, parentActor(f), child)
		childReportReactions{f.server}.SessionChanged(ctx, sessions.Completed, sessions.Slim(child))
		reports := f.reports()
		if len(reports) != 1 || reports[0].State != store.InboxConsumed {
			t.Fatalf("reports = %+v, want one consumed", reports)
		}
	})
}

// send_message's receipt counts what the sender sent the recipient in the
// last hour; Foundry's reports are not the sender's.
func TestSendReceiptCountsRecentMessagesToTheRecipient(t *testing.T) {
	f := newChildReportFixture(t)
	ctx := context.Background()
	f.finish("report one")
	now := time.Now().UTC()
	for index, delivery := range []string{store.DeliveryBoundary, store.DeliveryTurnEnd, store.DeliveryInterrupt} {
		if _, err := f.db.AdmitSessionInboxItem(ctx, store.SessionInboxItem{
			SessionID: f.parent.ID, InputID: "1c2d3e4f-5a6b-4c7d-8e9f-00000000000" + string(rune('1'+index)), SenderSessionID: f.child.ID,
			Prompt: "message " + delivery, RequestedDelivery: delivery,
		}, store.SessionInboxRules{Now: now}); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := f.db.AdmitSessionInboxItem(ctx, store.SessionInboxItem{
		SessionID: f.parent.ID, InputID: "1c2d3e4f-5a6b-4c7d-8e9f-000000000009", SenderSessionID: f.child.ID,
		Prompt: "too old", RequestedDelivery: store.DeliveryBoundary,
	}, store.SessionInboxRules{Now: now.Add(-2 * time.Hour)}); err != nil {
		t.Fatal(err)
	}
	recent := f.server.sessionService.RecentToRecipient(ctx, f.parent.ID, f.child.ID)
	if recent == nil || recent.LastHour != 3 || recent.BoundaryOrInterrupt != 2 {
		t.Fatalf("recent = %+v, want 3 in the last hour, 2 boundary or interrupt", recent)
	}
}

// Children that end close together start one turn of their idle parent;
// that turn sends the children nothing, so nothing goes back and forth.
func TestChildReportsOfSiblingsStartOneParentTurn(t *testing.T) {
	f := newChildReportFixture(t)
	ctx := context.Background()
	gather := sessions.ChildReportGather
	t.Cleanup(func() { sessions.ChildReportGather = gather })
	sessions.ChildReportGather = 300 * time.Millisecond
	if _, err := f.db.CompleteAgentSession(ctx, f.parent.ID, "waiting for the children", "native-parent"); err != nil {
		t.Fatal(err)
	}
	first := f.child
	f.finish("first child done")
	second, err := f.db.CreateAgentSession(ctx, store.CreateAgentSessionInput{
		WorkspaceID: "ws_lineage", AgentID: "agent_lineage", Provider: "claude",
		Prompt: "second", Title: "Second", Source: "agent", ParentSessionID: f.parent.ID,
	})
	if err != nil {
		t.Fatal(err)
	}
	f.child = second
	f.finish("second child done")
	f.server.sessionService.PumpInbox(ctx)
	f.child = first
	one := f.reports()
	f.child = second
	two := f.reports()
	if len(one) != 1 || len(two) != 1 || one[0].State != store.InboxHeld || two[0].State != store.InboxHeld {
		t.Fatalf("fresh reports were placed before their siblings could join: %+v %+v", one, two)
	}
	time.Sleep(sessions.ChildReportGather)
	f.server.sessionService.PumpInbox(ctx)
	f.child = first
	one = f.reports()
	f.child = second
	two = f.reports()
	if one[0].State != store.InboxDelivered || one[0].DeliveredAs != "turn" || one[0].DeliveredInputID != two[0].DeliveredInputID {
		t.Fatalf("reports after gathering = %+v and %+v, want one parent turn", one[0], two[0])
	}
	parent, err := f.db.GetAgentSessionRecord(ctx, f.parent.ID)
	if err != nil {
		t.Fatal(err)
	}
	if parent.Input.ID != one[0].DeliveredInputID || !strings.Contains(parent.Input.Prompt, "Message 2 of 2") {
		t.Fatalf("parent's next input = %s %.200q, want both reports", parent.Input.ID, parent.Input.Prompt)
	}
	// The parent's turn has no parent of its own to report to, and sends
	// its children nothing.
	for _, child := range []string{first.ID, second.ID} {
		if items, err := f.db.SessionInboxItems(ctx, child, time.Now().Add(-time.Hour), 10); err != nil || len(items) != 0 {
			t.Fatalf("child %s inbox = %+v, %v; want empty", child, items, err)
		}
	}
	if _, err := f.db.StartAgentSession(ctx, f.parent.ID); err != nil {
		t.Fatal(err)
	}
	ended, err := f.db.CompleteAgentSession(ctx, f.parent.ID, "both children reported", "native-parent")
	if err != nil {
		t.Fatal(err)
	}
	childReportReactions{f.server}.SessionChanged(ctx, sessions.Completed, sessions.Slim(ended))
	for _, child := range []string{first.ID, second.ID} {
		if items, err := f.db.SessionInboxItems(ctx, child, time.Now().Add(-time.Hour), 10); err != nil || len(items) != 0 {
			t.Fatalf("child %s inbox after the parent's turn = %+v, %v; want empty", child, items, err)
		}
	}
}

// A turn that ends while the parent's newer message to the child waits is
// not reported alone: the next turn's report carries what it said.
func TestChildReportOutdatedByTheParentsWaitingMessage(t *testing.T) {
	ctx := context.Background()
	message := func(f *childReportFixture, sender, inputID string) store.SessionInboxItem {
		t.Helper()
		admission, err := f.db.AdmitSessionInboxItem(ctx, store.SessionInboxItem{
			SessionID: f.child.ID, InputID: inputID, SenderSessionID: sender,
			Prompt: "Approved: chown the file, then rerun admission.", RequestedDelivery: store.DeliveryBoundary,
		}, store.SessionInboxRules{Now: time.Now().UTC()})
		if err != nil {
			t.Fatalf("admit message to the child: %v", err)
		}
		return admission.Item
	}
	t.Run("carried by the next report", func(t *testing.T) {
		f := newChildReportFixture(t)
		if _, err := f.db.StartAgentSession(ctx, f.child.ID); err != nil {
			t.Fatal(err)
		}
		waiting := message(f, f.parent.ID, "4d2c7b1e-0a3f-4e5d-9c8b-7a6f5e4d3c2b")
		outdated := f.finish("Root cause: the file is owned by 1001; the fix awaits approval.")
		reports := f.reports()
		if len(reports) != 1 || reports[0].State != store.InboxConsumed || reports[0].Reason != childReportSupersededReason || reports[0].InputID != childReportInputID(outdated) {
			t.Fatalf("outdated report = %+v, want one settled as superseded", reports)
		}
		// Foundry starts the child's next turn with the parent's message.
		next, err := f.db.SendAgentSessionInput(ctx, f.child.ID, store.SendAgentSessionInput{Prompt: waiting.Prompt, SentBySessionID: f.parent.ID})
		if err != nil {
			t.Fatalf("start the next turn: %v", err)
		}
		if _, _, err := f.db.ChangeSessionInboxItem(ctx, f.child.ID, waiting.InputID, store.SessionInboxChange{
			From: []string{store.InboxHeld}, State: store.InboxDelivered, DeliveredAs: "turn", DeliveredInputID: next.Input.ID,
		}); err != nil {
			t.Fatalf("deliver the message: %v", err)
		}
		f.finish("Owner fixed; admission passes and the machine is enabled.")
		reports = f.reports()
		if len(reports) != 2 || reports[0].State != store.InboxHeld {
			t.Fatalf("reports = %+v, want the new one held", reports)
		}
		prompt := reports[0].Prompt
		for _, want := range []string{"Final answer:\nOwner fixed", "while your newer message to it waited", "Root cause: the file is owned by 1001"} {
			if !strings.Contains(prompt, want) {
				t.Fatalf("report lacks %q:\n%s", want, prompt)
			}
		}
		if strings.Count(prompt, sessions.ChildReportPrefix) != 1 {
			t.Fatalf("report repeats the outdated heading:\n%s", prompt)
		}
	})
	t.Run("another sender's message", func(t *testing.T) {
		f := newChildReportFixture(t)
		if _, err := f.db.StartAgentSession(ctx, f.child.ID); err != nil {
			t.Fatal(err)
		}
		message(f, "sess_sibling", "5e3d8c2f-1b4a-4f6e-8d9c-8b7a6f5e4d3c")
		f.finish("Done.")
		if reports := f.reports(); len(reports) != 1 || reports[0].State != store.InboxHeld {
			t.Fatalf("reports = %+v, want one held", reports)
		}
	})
	t.Run("a message this turn took", func(t *testing.T) {
		f := newChildReportFixture(t)
		if _, err := f.db.StartAgentSession(ctx, f.child.ID); err != nil {
			t.Fatal(err)
		}
		taken := message(f, f.parent.ID, "6f4e9d3a-2c5b-4a7f-9e8d-9c8b7a6f5e4d")
		if _, _, err := f.db.ChangeSessionInboxItem(ctx, f.child.ID, taken.InputID, store.SessionInboxChange{
			From: []string{store.InboxHeld}, State: store.InboxConsumed, DeliveredAs: "steer",
		}); err != nil {
			t.Fatalf("consume the message: %v", err)
		}
		f.finish("Done with the steer applied.")
		if reports := f.reports(); len(reports) != 1 || reports[0].State != store.InboxHeld {
			t.Fatalf("reports = %+v, want one held", reports)
		}
	})
}

// A turn the child's own schedule started is not reported, unless the
// parent's message reached it; the child's other turns still are.
func TestChildReportSkipsATurnItsTimerStarted(t *testing.T) {
	ctx := context.Background()
	fire := func(f *childReportFixture) {
		t.Helper()
		f.finish("Started the wait.")
		if _, err := f.db.SendAgentSessionInput(ctx, f.child.ID, store.SendAgentSessionInput{
			Prompt: "Check the batch again.", TimerFire: &store.AgentSessionTimerFire{ID: "work_batch", Origin: "scheduled", Prompt: "Check the batch again."},
		}); err != nil {
			t.Fatalf("fire the schedule: %v", err)
		}
		if _, err := f.db.StartAgentSession(ctx, f.child.ID); err != nil {
			t.Fatalf("start the scheduled turn: %v", err)
		}
	}
	t.Run("a scheduled check", func(t *testing.T) {
		f := newChildReportFixture(t)
		fire(f)
		f.finish("The batch still has 3 running.")
		if reports := f.reports(); len(reports) != 1 || !strings.Contains(reports[0].Prompt, "Started the wait.") {
			t.Fatalf("reports = %+v, want only the first turn's", reports)
		}
		if _, err := f.db.SendAgentSessionInput(ctx, f.child.ID, store.SendAgentSessionInput{Prompt: "stop waiting", SentBySessionID: f.parent.ID}); err != nil {
			t.Fatalf("send the next input: %v", err)
		}
		f.finish("Stopped.")
		if got := len(f.reports()); got != 2 {
			t.Fatalf("reports after a turn the parent started = %d, want 2", got)
		}
	})
	t.Run("the parent's message steered in", func(t *testing.T) {
		f := newChildReportFixture(t)
		fire(f)
		admission, err := f.db.AdmitSessionInboxItem(ctx, store.SessionInboxItem{
			SessionID: f.child.ID, InputID: "7a5f0e4b-3d6c-4b8a-8f9e-0d9c8b7a6f5e", SenderSessionID: f.parent.ID,
			Prompt: "Stop waiting and continue now.", RequestedDelivery: store.DeliveryBoundary,
		}, store.SessionInboxRules{Now: time.Now().UTC()})
		if err != nil {
			t.Fatalf("admit the parent's message: %v", err)
		}
		if _, _, err := f.db.ChangeSessionInboxItem(ctx, f.child.ID, admission.Item.InputID, store.SessionInboxChange{
			From: []string{store.InboxHeld}, State: store.InboxDelivered, DeliveredAs: "steer",
		}); err != nil {
			t.Fatalf("steer the message: %v", err)
		}
		f.finish("Continued: prepared and admitted.")
		if reports := f.reports(); len(reports) != 2 || !strings.Contains(reports[0].Prompt, "Continued: prepared and admitted.") {
			t.Fatalf("reports = %+v, want the scheduled turn reported", reports)
		}
	})
}

// An outdated report reaches the parent however the turn meant to carry it
// ends: the waiting message fails, the next turn is canceled or hands off
// itself, or the parent reads only the next answer. The decision is taken
// from the ended turn even when Foundry already started the next one.
func TestChildReportOutdatedReportsAreNeverLost(t *testing.T) {
	ctx := context.Background()
	const rootCause = "Root cause: the file is owned by 1001."
	// outdate ends the child's turn while the parent's message waits.
	outdate := func(t *testing.T) (*childReportFixture, store.SessionInboxItem) {
		t.Helper()
		f := newChildReportFixture(t)
		if _, err := f.db.StartAgentSession(ctx, f.child.ID); err != nil {
			t.Fatal(err)
		}
		admission, err := f.db.AdmitSessionInboxItem(ctx, store.SessionInboxItem{
			SessionID: f.child.ID, InputID: "8b6a1f5c-4e7d-4c9b-9a0f-1e0d9c8b7a6f", SenderSessionID: f.parent.ID,
			Prompt: "Approved: fix the owner.", RequestedDelivery: store.DeliveryBoundary,
		}, store.SessionInboxRules{Now: time.Now().UTC()})
		if err != nil {
			t.Fatalf("admit the parent's message: %v", err)
		}
		f.finish(rootCause)
		if reports := f.reports(); len(reports) != 1 || reports[0].Reason != childReportSupersededReason {
			t.Fatalf("reports = %+v, want one superseded", reports)
		}
		return f, admission.Item
	}
	// next starts the child's next turn with the waiting message.
	next := func(t *testing.T, f *childReportFixture, waiting store.SessionInboxItem) {
		t.Helper()
		session, err := f.db.SendAgentSessionInput(ctx, f.child.ID, store.SendAgentSessionInput{Prompt: waiting.Prompt, SentBySessionID: f.parent.ID})
		if err != nil {
			t.Fatalf("start the next turn: %v", err)
		}
		f.server.sessionService.ChangeInboxItem(ctx, waiting, store.SessionInboxChange{
			From: []string{store.InboxHeld}, State: store.InboxDelivered, DeliveredAs: "turn", DeliveredInputID: session.Input.ID,
		})
		if _, err := f.db.StartAgentSession(ctx, f.child.ID); err != nil {
			t.Fatalf("run the next turn: %v", err)
		}
	}
	released := func(t *testing.T, f *childReportFixture, why string) {
		t.Helper()
		reports := f.reports()
		if len(reports) != 2 || reports[0].State != store.InboxHeld {
			t.Fatalf("reports = %+v, want a released one held", reports)
		}
		for _, want := range []string{why, rootCause} {
			if !strings.Contains(reports[0].Prompt, want) {
				t.Fatalf("released report lacks %q:\n%s", want, reports[0].Prompt)
			}
		}
	}
	t.Run("the waiting message fails", func(t *testing.T) {
		f, waiting := outdate(t)
		f.server.sessionService.ChangeInboxItem(ctx, waiting, store.SessionInboxChange{From: []string{store.InboxHeld}, State: store.InboxFailed, Reason: "the session is archived"})
		released(t, f, "your message to it failed: the session is archived")
	})
	t.Run("the next turn is canceled", func(t *testing.T) {
		f, waiting := outdate(t)
		next(t, f, waiting)
		canceled, err := f.db.CancelAgentSession(ctx, f.child.ID, "stopped")
		if err != nil {
			t.Fatalf("cancel the next turn: %v", err)
		}
		childReportReactions{f.server}.SessionChanged(ctx, sessions.Completed, sessions.Slim(canceled))
		released(t, f, "status canceled")
	})
	t.Run("the next turn hands off itself", func(t *testing.T) {
		f, waiting := outdate(t)
		next(t, f, waiting)
		if _, err := f.db.AdmitSessionInboxItem(ctx, store.SessionInboxItem{
			SessionID: f.parent.ID, InputID: "9c7b2a6d-5f8e-4dab-8b1a-2f1e0d9c8b7a", SenderSessionID: f.child.ID,
			Prompt: "Owner fixed and admitted.", RequestedDelivery: store.DeliveryTurnEnd,
		}, store.SessionInboxRules{Now: time.Now().UTC()}); err != nil {
			t.Fatalf("admit the child's handoff: %v", err)
		}
		f.finish("Done: owner fixed, admission passes.")
		released(t, f, "came")
	})
	t.Run("the parent reads only the next answer", func(t *testing.T) {
		f, waiting := outdate(t)
		next(t, f, waiting)
		child := f.finish("Owner fixed.")
		parent := Actor{Kind: ActorAgent, Identity: store.SessionTokenIdentity{SessionID: f.parent.ID, WorkspaceID: "ws_lineage", DeviceID: "dev_lineage"}}
		f.server.childReportRead(ctx, parent, child)
		if reports := f.reports(); len(reports) != 2 || reports[0].State != store.InboxHeld || !strings.Contains(reports[0].Prompt, rootCause) {
			t.Fatalf("reports = %+v, want the carrying report still held", reports)
		}
	})
	t.Run("Foundry already started the next turn", func(t *testing.T) {
		f := newChildReportFixture(t)
		if _, err := f.db.StartAgentSession(ctx, f.child.ID); err != nil {
			t.Fatal(err)
		}
		admission, err := f.db.AdmitSessionInboxItem(ctx, store.SessionInboxItem{
			SessionID: f.child.ID, InputID: "ad8c3b7e-6a9f-4ebc-9c2b-3a2f1e0d9c8b", SenderSessionID: f.parent.ID,
			Prompt: "Approved: fix the owner.", RequestedDelivery: store.DeliveryBoundary,
		}, store.SessionInboxRules{Now: time.Now().UTC()})
		if err != nil {
			t.Fatal(err)
		}
		ended, err := f.db.CompleteAgentSession(ctx, f.child.ID, rootCause, "native-child")
		if err != nil {
			t.Fatal(err)
		}
		next(t, f, admission.Item)
		childReportReactions{f.server}.SessionChanged(ctx, sessions.Completed, sessions.Slim(ended))
		reports := f.reports()
		if len(reports) != 1 || reports[0].InputID != childReportInputID(ended) || reports[0].Reason != childReportSupersededReason {
			t.Fatalf("reports = %+v, want the ended turn's report superseded", reports)
		}
		f.finish("Owner fixed.")
		if reports := f.reports(); len(reports) != 2 || !strings.Contains(reports[0].Prompt, rootCause) {
			t.Fatalf("reports = %+v, want the next one carrying it", reports)
		}
	})
}
