package httpapi

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/feishu"
	"github.com/foundry-dev/foundry/apps/server/internal/personnotice"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// A helper's question relayed to its running assistant says who asks, what,
// and how an answer reaches it; it tells the assistant nothing about when to
// involve the person (that is the needs_you tool's contract).
func TestRelayedHelperQuestionCarriesFactsOnly(t *testing.T) {
	f := newNeedsYouFixture(t)
	questionEventOf(t, f, f.helper, "facts", "Which branch?", questionDeliveryAsync)
	relayed := helperInboxQuestions(t, f)
	if len(relayed) != 1 {
		t.Fatalf("relayed questions = %d, want 1", len(relayed))
	}
	prompt := relayed[0].Prompt
	if !strings.Contains(prompt, "Which branch?") || !strings.Contains(prompt, "Answer with send_message to "+f.helper.ID) {
		t.Fatalf("relayed question lacks its facts: %q", prompt)
	}
	for _, guidance := range []string{"If only the person can decide", "do not guess", "needs_you", "decide whether", "question tool"} {
		if strings.Contains(prompt, guidance) {
			t.Fatalf("relayed question carries guidance %q: %q", guidance, prompt)
		}
	}
}

// A note the assistant told the person asks for nothing: it is listed, but no
// count of Needs you counts it, and it is not an item's "waiting on you".
func TestNeedsYouCountsRequestsNotNotes(t *testing.T) {
	f := newPendingFixture(t)
	ctx := context.Background()
	userID := f.session.CreatedByUserID
	for _, item := range []store.PendingItem{
		{UserID: userID, WorkspaceID: "ws_pending", SessionID: f.session.ID, Source: store.PendingSourceQuestion, Key: "question:count", MessageID: "in/call_count", Title: "Which way?", Excerpt: "Which way?", Handler: store.PendingHandlerPerson},
		{UserID: userID, WorkspaceID: "ws_pending", SessionID: f.session.ID, Source: store.PendingSourceNotice, Key: "notice:count", Title: "The file did not make it", Excerpt: "The file did not make it", Note: "The file did not make it", Handler: store.PendingHandlerPerson},
	} {
		if _, _, err := f.server.store.RecordPendingItem(ctx, item); err != nil {
			t.Fatal(err)
		}
	}
	list := f.list()
	if list.Open != 1 || list.BySession[f.session.ID] != 1 || list.NoticeOpen != 1 || len(list.Items) != 2 {
		t.Fatalf("open %d, by session %+v, notes %d, items %d; want 1 request, 1 note, both listed", list.Open, list.BySession, list.NoticeOpen, len(list.Items))
	}
	if waitsOnPerson(store.PendingItem{State: store.PendingOpen, Source: store.PendingSourceNotice, Handler: store.PendingHandlerPerson}) {
		t.Fatal("a note counts as waiting on the person")
	}
	if !waitsOnPerson(store.PendingItem{State: store.PendingOpen, Source: store.PendingSourceQuestion}) {
		t.Fatal("an open question does not count as waiting on the person")
	}
}

// Each open request in the list says what became of its notice: the state of
// the notice it has, or why it has none. Failures, which never get a notice,
// say nothing.
func TestNeedsYouListShowsEachRequestsNotice(t *testing.T) {
	f, agent := itemNoticeFixture(t, "question", "approval")
	ctx := context.Background()
	unsent, _, err := f.server.store.RecordPendingItem(ctx, f.questionItem(agent, "q_unsent", false, "Left", "Right"))
	if err != nil {
		t.Fatal(err)
	}
	sent, _, err := f.server.store.RecordPendingItem(ctx, f.questionItem(agent, "q_sent", false, "Left", "Right"))
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := f.server.personNotices.EnqueueNotice(ctx, sent, personnotice.Route{SinkID: feishu.NoticeSinkID, Kind: "question", AllowFreeText: true}); err != nil {
		t.Fatal(err)
	}
	failure, _, err := f.server.store.RecordPendingItem(ctx, store.PendingItem{
		UserID: f.session.CreatedByUserID, WorkspaceID: "ws_pending", SessionID: f.session.ID, Source: store.PendingSourceTurnFailed,
		Key: "failure:notice", Title: "The model endpoint is not reachable", Excerpt: "The model endpoint is not reachable", Handler: store.PendingHandlerPerson,
	})
	if err != nil {
		t.Fatal(err)
	}
	views := map[string]*pendingNoticeView{}
	for _, item := range f.list().Items {
		views[item.ID] = item.Notice
	}
	// The fixture's person has no direct chat with the Foundry bot.
	if view := views[unsent.ID]; view == nil || view.Skipped != noticeSkipBotNotPaired {
		t.Fatalf("unsent request's notice = %+v, want skipped %q", view, noticeSkipBotNotPaired)
	}
	if view := views[sent.ID]; view == nil || view.State != store.NoticeQueued {
		t.Fatalf("sent request's notice = %+v, want queued", view)
	}
	if view := views[failure.ID]; view != nil {
		t.Fatalf("a turn failure has a notice view %+v, want none", view)
	}
}

// Requests opened while no sink could carry them get their notice once one
// can: saving the notice setting queues one notice per open request that has
// none, and saving again sends nothing twice.
func TestOpenRequestsGetTheirNoticeOnceTheSettingIsSaved(t *testing.T) {
	f := newExternalAccountsFixture(t)
	f.server.options.AllowedOrigin = noticeItemsOrigin
	ctx := context.Background()
	agent, err := f.db.CreatePersonalAgent(ctx, store.PersonalAgent{
		UserID: f.aliceID, WorkspaceID: "ws_pa", HomeDeviceID: "dev_alice",
		Settings: store.PersonalAgentSettings{FeishuDirectChat: true},
	})
	if err != nil {
		t.Fatal(err)
	}
	app, err := f.db.CreateExternalProviderApp(ctx, store.ExternalProviderApp{Provider: "feishu", OwnerUserID: f.aliceID, Label: "Foundry", ClientID: "cli_foundry"})
	if err != nil {
		t.Fatal(err)
	}
	if err := f.db.SetWorkspaceFeishuBotApp(ctx, "ws_alice", app.ID); err != nil {
		t.Fatal(err)
	}
	pairing, err := f.db.SetFeishuPairingCode(ctx, "ws_alice", feishu.HashPairingCode("FND-oc_dm"), f.aliceID, time.Now().Add(time.Minute).UTC().Format(time.RFC3339))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.BindFeishuChat(ctx, pairing, store.FeishuBotRoute{Kind: store.FeishuRouteP2P, ChatID: "oc_dm", BoundUserID: f.aliceID}); err != nil {
		t.Fatal(err)
	}
	// Recorded before any sink was saved: no notice.
	item, _, err := f.server.recordPendingItem(ctx, store.PendingItem{
		UserID: f.aliceID, AssistantID: agent.ID, WorkspaceID: "ws_alice", Source: store.PendingSourceAssistantQuestion, Key: "ask:backfill",
		Title: "Which batch?", Excerpt: "Which batch?", Options: []string{"A", "B"}, Handler: store.PendingHandlerPerson,
	})
	if err != nil {
		t.Fatal(err)
	}
	if notices, _ := f.db.PersonNoticesOfItem(ctx, item.ID); len(notices) != 0 {
		t.Fatalf("a request got a notice with no sink saved: %+v", notices)
	}
	save := func(kinds ...string) {
		t.Helper()
		settings := agent.Settings
		settings.Notify = store.PersonalAgentNotifySettings{Sinks: []store.PersonalAgentNotifySink{{ConnectorInstanceID: feishu.NoticeSinkID, Kinds: kinds}}}
		saved, err := f.server.saveAssistantSettings(ctx, agent, settings)
		if err != nil {
			t.Fatalf("save the notice setting: %v", err)
		}
		agent = saved
	}
	save("ask")
	notices, err := f.db.PersonNoticesOfItem(ctx, item.ID)
	if err != nil || len(notices) != 1 || notices[0].Kind != "ask" || notices[0].SinkID != feishu.NoticeSinkID || notices[0].AssistantID != agent.ID {
		t.Fatalf("notices after saving the setting = %+v (%v), want one ask card", notices, err)
	}
	save("ask", "question")
	if again, _ := f.db.PersonNoticesOfItem(ctx, item.ID); len(again) != 1 {
		t.Fatalf("saving again queued %d notices, want the one", len(again))
	}
}
