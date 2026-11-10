package httpapi

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/sessionalerts"
	"github.com/foundry-dev/foundry/apps/server/internal/sessions"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func startAndFailAlertChild(t *testing.T, f *childReportFixture, failure string, code string) store.AgentSession {
	t.Helper()
	ctx := context.Background()
	if _, err := f.db.StartAgentSession(ctx, f.child.ID); err != nil {
		t.Fatalf("start child: %v", err)
	}
	if code != "" {
		if err := f.db.AppendAgentSessionEvent(ctx, store.AgentSessionEvent{
			ID: "evt_failure_" + f.child.Input.ID, SessionID: f.child.ID, Label: store.ProcessLabelSessionFailed,
			Detail: failure, Level: "error", Metadata: &store.AgentSessionEventMetadata{
				WorkerFailure: &store.WorkerFailure{Version: 1, Code: code, InputID: f.child.Input.ID},
			},
		}); err != nil {
			t.Fatalf("record worker failure: %v", err)
		}
	}
	failed, err := f.db.FailAgentSession(ctx, f.child.ID, failure)
	if err != nil {
		t.Fatalf("fail child: %v", err)
	}
	return failed
}

func parentAlertItems(t *testing.T, f *childReportFixture) []store.SessionInboxItem {
	t.Helper()
	items, err := f.db.SessionInboxItems(context.Background(), f.parent.ID, time.Now().Add(-time.Hour), 100)
	if err != nil {
		t.Fatalf("list parent inbox: %v", err)
	}
	var alerts []store.SessionInboxItem
	for _, item := range items {
		if item.SenderSessionID == f.child.ID && strings.HasPrefix(item.Prompt, sessionalerts.Prefix) {
			alerts = append(alerts, item)
		}
	}
	return alerts
}

func childAlerts(t *testing.T, f *childReportFixture) []store.SessionAlert {
	t.Helper()
	alerts, err := f.db.SessionAlertsForChild(context.Background(), f.child.ID, 20)
	if err != nil {
		t.Fatalf("list child alerts: %v", err)
	}
	return alerts
}

func TestSessionAlertFailureIsImmediateAndSupersededReportsDoNotSettleIt(t *testing.T) {
	ctx := context.Background()
	f := newChildReportFixture(t)
	waiting, err := f.db.AdmitSessionInboxItem(ctx, store.SessionInboxItem{
		SessionID: f.child.ID, InputID: "parent_newer_message", SenderSessionID: f.parent.ID,
		Prompt: "try the release branch too", RequestedDelivery: store.DeliveryTurnEnd,
	}, store.SessionInboxRules{Now: time.Now().UTC()})
	if err != nil {
		t.Fatalf("hold parent's newer message: %v", err)
	}
	if !waiting.Item.Pending() {
		t.Fatalf("parent's newer message = %+v", waiting.Item)
	}
	failed := startAndFailAlertChild(t, f, "unexpected status 405 from wss://tokenhub.example/v1/responses", "model_rate_limit")

	sessionAlertReactions{f.server}.SessionChanged(ctx, sessions.Completed, sessions.Slim(failed))
	alerts := childAlerts(t, f)
	if len(alerts) != 1 || alerts[0].Code != "model_rate_limit" || alerts[0].Occurrences != 1 {
		t.Fatalf("alerts = %+v, want one model_rate_limit alert", alerts)
	}
	items := parentAlertItems(t, f)
	if len(items) != 1 {
		t.Fatalf("sent alerts = %d, want 1 immediately", len(items))
	}
	if items[0].Delivery != store.DeliveryBoundary {
		t.Fatalf("busy parent alert delivery = %q, want boundary", items[0].Delivery)
	}
	if !strings.Contains(items[0].Prompt, failed.ID) || !strings.Contains(items[0].Prompt, "Code: model_rate_limit") ||
		!strings.Contains(items[0].Prompt, "Automatic retry: no") || !strings.Contains(items[0].Prompt, "send_message") {
		t.Fatalf("alert text is incomplete:\n%s", items[0].Prompt)
	}

	childReportReactions{f.server}.SessionChanged(ctx, sessions.Completed, sessions.Slim(failed))
	reports := f.reports()
	if len(reports) != 1 || reports[0].Reason != childReportSupersededReason {
		t.Fatalf("reports = %+v, want the result report superseded", reports)
	}
	items = parentAlertItems(t, f)
	if len(items) != 1 || items[0].Reason == childReportSupersededReason || items[0].State == store.InboxConsumed {
		t.Fatalf("child report supersession changed the alert: %+v", items)
	}
}

func TestHumanStartedFailureSendsNoAlert(t *testing.T) {
	ctx := context.Background()
	db, human := lineageFixture(t)
	server := NewServer(db)
	if _, err := db.StartAgentSession(ctx, human.ID); err != nil {
		t.Fatalf("start human session: %v", err)
	}
	failed, err := db.FailAgentSession(ctx, human.ID, "startup failed")
	if err != nil {
		t.Fatalf("fail human session: %v", err)
	}
	sessionAlertReactions{server}.SessionChanged(ctx, sessions.Completed, sessions.Slim(failed))
	alerts, err := db.SessionAlertsForChild(ctx, human.ID, 20)
	if err != nil {
		t.Fatal(err)
	}
	if len(alerts) != 0 {
		t.Fatalf("human-started session alerts = %+v, want none", alerts)
	}
}

func TestStartupFailureIsAlertedImmediately(t *testing.T) {
	ctx := context.Background()
	f := newChildReportFixture(t)
	failed := startAndFailAlertChild(t, f, "Cannot read Codex's bundled model definitions", "")
	sessionAlertReactions{f.server}.SessionChanged(ctx, sessions.Completed, sessions.Slim(failed))
	alerts := childAlerts(t, f)
	if len(alerts) != 1 || alerts[0].Code != "startup" || alerts[0].NotifiedAt == nil {
		t.Fatalf("startup alerts = %+v, want an immediate startup alert", alerts)
	}
}

func TestCanceledSessionAlertsUnlessItsOwnInitiatorCanceledIt(t *testing.T) {
	ctx := context.Background()
	t.Run("person cancellation", func(t *testing.T) {
		f := newChildReportFixture(t)
		if _, err := f.db.StartAgentSession(ctx, f.child.ID); err != nil {
			t.Fatal(err)
		}
		canceled, err := f.db.CancelAgentSession(ctx, f.child.ID, "Canceled by user")
		if err != nil {
			t.Fatal(err)
		}
		sessionAlertReactions{f.server}.SessionChanged(ctx, sessions.Completed, sessions.Slim(canceled))
		alerts := childAlerts(t, f)
		if len(alerts) != 1 || alerts[0].Code != sessionalerts.CodeCanceled {
			t.Fatalf("alerts = %+v, want one cancellation alert", alerts)
		}
		if items := parentAlertItems(t, f); len(items) != 1 || !strings.Contains(items[0].Prompt, "was canceled") {
			t.Fatalf("cancel alert = %+v", items)
		}
	})

	t.Run("initiator cancellation", func(t *testing.T) {
		f := newChildReportFixture(t)
		if _, err := f.db.StartAgentSession(ctx, f.child.ID); err != nil {
			t.Fatal(err)
		}
		canceled, err := f.db.CancelAgentSession(ctx, f.child.ID, "Canceled by orchestrator session")
		if err != nil {
			t.Fatal(err)
		}
		if err := f.db.AppendAgentSessionEvent(ctx, store.AgentSessionEvent{
			ID: "evt_parent_canceled_child", SessionID: f.child.ID, Label: "Canceled by orchestrator",
			Detail: f.parent.ID, Level: "info", Metadata: &store.AgentSessionEventMetadata{TaskID: f.parent.ID},
		}); err != nil {
			t.Fatal(err)
		}
		sessionAlertReactions{f.server}.SessionChanged(ctx, sessions.Completed, sessions.Slim(canceled))
		if alerts := childAlerts(t, f); len(alerts) != 0 {
			t.Fatalf("initiator's own cancellation alerts = %+v, want none", alerts)
		}
	})
}

func TestWaitingSlotAlertsOnceAfterThresholdWithOccurrences(t *testing.T) {
	ctx := context.Background()
	f := newChildReportFixture(t)
	reaction := sessionAlertReactions{f.server}
	before := time.Now().UTC()
	for _, id := range []string{"evt_slot_wait_1", "evt_slot_wait_2"} {
		reaction.SessionEventRecorded(ctx, store.AgentSessionEvent{
			ID: id, SessionID: f.child.ID, Label: store.ProcessLabelWaitingForSlot,
			Detail: "4 of 4 turns are running on this device; this turn starts when one ends.",
		})
	}
	alerts := childAlerts(t, f)
	if len(alerts) != 1 || alerts[0].Occurrences != 2 || alerts[0].NotifiedAt != nil {
		t.Fatalf("waiting alerts before threshold = %+v", alerts)
	}
	f.server.sessionAlerts.Pump(ctx, before.Add(sessionalerts.WaitAlertAfter-time.Second))
	if items := parentAlertItems(t, f); len(items) != 0 {
		t.Fatalf("wait alert was sent before threshold: %+v", items)
	}
	f.server.sessionAlerts.Pump(ctx, before.Add(sessionalerts.WaitAlertAfter+time.Second))
	items := parentAlertItems(t, f)
	if len(items) != 1 || !strings.Contains(items[0].Prompt, "Occurrences: 2") ||
		!strings.Contains(items[0].Prompt, "waiting for a slot") {
		t.Fatalf("wait alert after threshold = %+v", items)
	}
	f.server.sessionAlerts.Pump(ctx, before.Add(2*sessionalerts.WaitAlertAfter))
	if items := parentAlertItems(t, f); len(items) != 1 {
		t.Fatalf("deduplicated wait alerts = %d, want 1", len(items))
	}
}

func TestRecoveredWaitDoesNotAlertOrRepeat(t *testing.T) {
	ctx := context.Background()
	f := newChildReportFixture(t)
	reaction := sessionAlertReactions{f.server}
	before := time.Now().UTC()
	reaction.SessionEventRecorded(ctx, store.AgentSessionEvent{
		ID: "evt_slot_wait_recovered", SessionID: f.child.ID, Label: store.ProcessLabelWaitingForSlot,
		Detail: "This conversation's previous turn is still running; this turn starts when it ends.",
	})
	started, err := f.db.StartAgentSession(ctx, f.child.ID)
	if err != nil {
		t.Fatal(err)
	}
	reaction.SessionChanged(ctx, sessions.Started, sessions.Slim(started))
	f.server.sessionAlerts.Pump(ctx, before.Add(sessionalerts.WaitAlertAfter+time.Minute))
	if items := parentAlertItems(t, f); len(items) != 0 {
		t.Fatalf("recovered wait alerted: %+v", items)
	}
	alerts := childAlerts(t, f)
	if len(alerts) != 1 || alerts[0].ResolvedAt == nil || alerts[0].NotifiedAt != nil {
		t.Fatalf("recovered alert = %+v, want one resolved unnotified incident", alerts)
	}
}

func TestBlockedSessionAlertsOnceAfterThreshold(t *testing.T) {
	ctx := context.Background()
	f := newChildReportFixture(t)
	if _, err := f.db.StartAgentSession(ctx, f.child.ID); err != nil {
		t.Fatal(err)
	}
	blocked, err := f.db.BlockAgentSession(ctx, f.child.ID, "Rate limited, waiting to retry")
	if err != nil {
		t.Fatal(err)
	}
	before := time.Now().UTC()
	sessionAlertReactions{f.server}.SessionChanged(ctx, sessions.Blocked, sessions.Slim(blocked))
	f.server.sessionAlerts.Pump(ctx, before.Add(sessionalerts.WaitAlertAfter+time.Second))
	items := parentAlertItems(t, f)
	if len(items) != 1 || !strings.Contains(items[0].Prompt, "Code: blocked") ||
		!strings.Contains(items[0].Prompt, "Automatic retry: yes") {
		t.Fatalf("blocked alert = %+v", items)
	}
	alerts := childAlerts(t, f)
	if len(alerts) != 1 || alerts[0].Occurrences != 1 {
		t.Fatalf("blocked incidents = %+v, want one", alerts)
	}
}

func TestOfflineDeviceAlertsOnceAfterThreshold(t *testing.T) {
	ctx := context.Background()
	f := newChildReportFixture(t)
	before := time.Now().UTC()
	sessionAlertReactions{f.server}.SessionEventRecorded(ctx, store.AgentSessionEvent{
		ID: "evt_device_wait_offline", SessionID: f.child.ID, Label: store.EventLabelDeviceWait,
		Detail: "Studio is offline. This waits and starts by itself when it is back online.",
	})
	f.server.sessionAlerts.Pump(ctx, before.Add(sessionalerts.WaitAlertAfter+time.Second))
	items := parentAlertItems(t, f)
	if len(items) != 1 || !strings.Contains(items[0].Prompt, "Code: device_offline") ||
		!strings.Contains(items[0].Prompt, "when the device reconnects") {
		t.Fatalf("offline alert = %+v", items)
	}
}

func TestSessionAlertStartsAnIdleInitiatorsTurn(t *testing.T) {
	ctx := context.Background()
	f := newChildReportFixture(t)
	if _, err := f.db.CompleteAgentSession(ctx, f.parent.ID, "ready for child results", "native-parent"); err != nil {
		t.Fatalf("complete parent: %v", err)
	}
	failed := startAndFailAlertChild(t, f, "disk full while writing the output", "disk_full")
	sessionAlertReactions{f.server}.SessionChanged(ctx, sessions.Completed, sessions.Slim(failed))
	items := parentAlertItems(t, f)
	if len(items) != 1 || items[0].Delivery != store.DeliveryTurnEnd {
		t.Fatalf("idle parent alert = %+v, want one turn_end message", items)
	}
	if _, err := f.db.AdmitSessionInboxItem(ctx, store.SessionInboxItem{
		SessionID: f.parent.ID, InputID: "sibling_report", SenderSessionID: f.child.ID,
		Prompt: sessions.ChildReportPrefix + " sibling report", RequestedDelivery: store.DeliveryTurnEnd,
	}, store.SessionInboxRules{Now: time.Now().UTC()}); err != nil {
		t.Fatalf("admit sibling report: %v", err)
	}

	f.server.sessionService.PumpInbox(ctx)
	parent, err := f.db.GetAgentSessionSummary(ctx, f.parent.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(parent.Input.Prompt, sessionalerts.Prefix) || parent.Input.SentBySessionID != f.child.ID {
		t.Fatalf("parent's next turn = %+v, want the child alert", parent.Input)
	}
}
