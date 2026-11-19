package httpapi

import (
	"bytes"
	"context"
	"log"
	"strings"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/personnotice"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

const noticeItemsOrigin = "https://foundry.example"

func noticeItemsChat(context.Context, string, string) (string, error) {
	return "oc_self", nil
}

// itemNoticeFixture is a person with an assistant whose notice sink takes kinds.
// The pending fixture's chat session is the conversation that asks.
func itemNoticeFixture(t *testing.T, kinds ...string) (*pendingFixture, store.PersonalAgent) {
	t.Helper()
	f := newPendingFixture(t)
	f.server.options.AllowedOrigin = noticeItemsOrigin
	agent, err := f.server.store.CreatePersonalAgent(context.Background(), store.PersonalAgent{
		UserID: f.session.CreatedByUserID, WorkspaceID: "ws_pending", HomeDeviceID: "dev_pending",
		Settings: store.PersonalAgentSettings{Notify: store.PersonalAgentNotifySettings{
			Sinks: []store.PersonalAgentNotifySink{{ConnectorInstanceID: "app_notify", Kinds: kinds}},
		}},
	})
	if err != nil {
		t.Fatalf("create the assistant: %v", err)
	}
	return f, agent
}

// questionItem is an open question of the fixture's chat that the person
// answers, held by the person.
func (f *pendingFixture) questionItem(agent store.PersonalAgent, id string, approval bool, options ...string) store.PendingItem {
	return store.PendingItem{
		UserID: f.session.CreatedByUserID, AssistantID: agent.ID, WorkspaceID: "ws_pending", SessionID: f.session.ID,
		Source: store.PendingSourceQuestion, Key: "question:" + id, EventID: "evt_" + id, MessageID: "in_1/call_" + id,
		Title: "Which way " + id + "?", Excerpt: "Which way " + id + "?", Options: options, Approval: approval,
		Handler: store.PendingHandlerPerson,
	}
}

// noticeSent queues the item's notice through its sink and settles it as the
// sink sent it, so a reply has a sent notice to match.
func (f *pendingFixture) noticeSent(t *testing.T, item store.PendingItem) store.PersonNotice {
	t.Helper()
	ctx := context.Background()
	stored, _, err := f.server.store.RecordPendingItem(ctx, item)
	if err != nil {
		t.Fatal(err)
	}
	f.server.queueItemNotice(ctx, stored, noticeItemsChat)
	notices, err := f.server.store.PersonNoticesOfItem(ctx, stored.ID)
	if err != nil || len(notices) != 1 {
		t.Fatalf("notices of item %s = %+v (%v), want one", stored.ID, notices, err)
	}
	notice := notices[0]
	if _, claimed, err := f.server.store.ClaimPersonNotice(ctx, notice.ID, time.Now().UTC()); err != nil || !claimed {
		t.Fatalf("claim the notice: claimed=%v err=%v", claimed, err)
	}
	if _, err := f.server.store.SettlePersonNotice(ctx, notice.ID, store.PersonNoticeSettlement{
		State: store.NoticeSent, ProviderMessageID: "om_" + item.EventID, At: time.Now().UTC(),
	}); err != nil {
		t.Fatal(err)
	}
	return f.reloadNotice(t, notice)
}

func (f *pendingFixture) reloadNotice(t *testing.T, notice store.PersonNotice) store.PersonNotice {
	t.Helper()
	notices, err := f.server.store.PersonNoticesOfItem(context.Background(), notice.ItemID)
	if err != nil {
		t.Fatal(err)
	}
	for _, current := range notices {
		if current.ID == notice.ID {
			return current
		}
	}
	t.Fatalf("notice %s is gone", notice.ID)
	return store.PersonNotice{}
}

// replyFrom is the person's own message in the notice's chat, quoting it.
func replyFrom(notice store.PersonNotice, text string) store.MessageEnvelope {
	return store.MessageEnvelope{
		ID: "reply_" + notice.ID, Kind: "message", MessageID: "reply_" + notice.ID, Text: text,
		Sender:       store.MessageEnvelopeSender{ID: "ou_me", IsSelf: true},
		Conversation: store.MessageEnvelopeConversation{ID: notice.Target, Kind: "self"},
		Attributes:   map[string]string{"replyTo": notice.ProviderMessageID},
	}
}

func TestPersonNoticeKindFollowsWhatTheItemAsks(t *testing.T) {
	cases := []struct {
		name string
		item store.PendingItem
		want string
	}{
		{"question", store.PendingItem{Source: store.PendingSourceQuestion, MessageID: "m", Title: "Q"}, "question"},
		{"approval question", store.PendingItem{Source: store.PendingSourceQuestion, MessageID: "m", Title: "Q", Approval: true}, "approval"},
		{"handed-over question", store.PendingItem{Source: store.PendingSourceQuestion, MessageID: "m", Title: "Q", HandedAt: "2026-11-18T09:00:00Z"}, "hand_over"},
		{"assistant question", store.PendingItem{Source: store.PendingSourceAssistantQuestion, Title: "Q"}, "ask"},
		{"handed-over question without its message", store.PendingItem{Source: store.PendingSourceQuestion, Title: "Q", HandedAt: "2026-11-19T05:19:42Z"}, "hand_over"},
		{"connector write", store.PendingItem{Source: store.PendingSourceConnectorWrite, ConnectorWrite: &store.PendingConnectorWriteDetail{ProposalID: "p"}}, "approval"},
	}
	for _, c := range cases {
		kind, ok := personNoticeKind(c.item)
		if !ok || kind != c.want {
			t.Errorf("%s: kind = %q, %v; want %q", c.name, kind, ok, c.want)
		}
	}
	for name, item := range map[string]store.PendingItem{
		"a question without its message": {Source: store.PendingSourceQuestion, Title: "Q"},
		"a turn failure":                 {Source: store.PendingSourceTurnFailed, Title: "failed"},
		"a note the assistant told":      {Source: store.PendingSourceNotice, HandedAt: "2026-11-18T09:00:00Z"},
		"an account sign-in":             {Source: store.PendingSourceAccount},
	} {
		if kind, ok := personNoticeKind(item); ok {
			t.Errorf("%s earned a %q notice", name, kind)
		}
	}
}

// An item opening notices the person only through a sink whose kinds take it,
// and only once.
func TestAnOpenItemIsNoticedOnlyForTheKindsItsSinkTakes(t *testing.T) {
	f, agent := itemNoticeFixture(t, "approval")
	ctx := context.Background()

	question, _, err := f.server.store.RecordPendingItem(ctx, f.questionItem(agent, "q_kind", false, "Left", "Right"))
	if err != nil {
		t.Fatal(err)
	}
	f.server.queueItemNotice(ctx, question, noticeItemsChat)
	if notices, _ := f.server.store.PersonNoticesOfItem(ctx, question.ID); len(notices) != 0 {
		t.Fatalf("a question reached a sink that takes approvals only: %+v", notices)
	}

	approval, _, err := f.server.store.RecordPendingItem(ctx, f.questionItem(agent, "a_kind", true, "Approve", "Deny"))
	if err != nil {
		t.Fatal(err)
	}
	f.server.queueItemNotice(ctx, approval, noticeItemsChat)
	f.server.queueItemNotice(ctx, approval, noticeItemsChat)
	notices, err := f.server.store.PersonNoticesOfItem(ctx, approval.ID)
	if err != nil || len(notices) != 1 {
		t.Fatalf("approval notices = %+v (%v), want exactly one", notices, err)
	}
	notice := notices[0]
	if notice.Kind != "approval" || notice.State != store.NoticeQueued || notice.Target != "oc_self" || !notice.AllowFreeText {
		t.Fatalf("approval notice = %+v", notice)
	}
	if want := noticeItemsOrigin + "/pending?item=" + approval.ID; notice.Link != want {
		t.Fatalf("notice link = %q, want %q", notice.Link, want)
	}
	if len(notice.Options) != 2 || notice.Options[0].Label != "同意" || notice.Options[1].Label != "拒绝" {
		t.Fatalf("approval options = %+v, want 同意 and 拒绝", notice.Options)
	}
}

// An option reply answers a question through its envelope in the asking chat;
// the item then closes through the chat's own events.
func TestOptionReplyAnswersAQuestionInItsChat(t *testing.T) {
	f, agent := itemNoticeFixture(t, "question")
	ctx := context.Background()
	notice := f.noticeSent(t, f.questionItem(agent, "q_reply", false, "Left", "Right"))

	if !noticeAnswersFrom(notice, f.session.CreatedByUserID, replyFrom(notice, "2")) {
		t.Fatal("the person's quoted reply is not an answer to its notice")
	}
	if !settledByReply(f.server, ctx, notice, replyFrom(notice, " 2 ")) {
		t.Fatal("an option reply was not settled")
	}
	answered := f.reloadNotice(t, notice)
	if answered.State != store.NoticeAnswered || answered.AnswerText != "Right" || answered.AnsweredBy != store.PendingAnsweredByPerson {
		t.Fatalf("answered notice = %+v", answered)
	}
	queue, err := f.server.store.ChatQueue(ctx, "ws_pending", f.session.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(queue.Items) != 1 || !strings.Contains(queue.Items[0].Text, agentQuestionReplyOpen) ||
		!strings.Contains(queue.Items[0].Text, "call_q_reply") || !strings.Contains(queue.Items[0].Text, "Right") {
		t.Fatalf("the chat queue = %+v, want the answer envelope for the question", queue.Items)
	}
	if noticeAnswersFrom(answered, f.session.CreatedByUserID, replyFrom(notice, "1")) {
		t.Fatal("an answered notice takes a second reply")
	}
}

// A free-text reply answers a question as it is written.
func TestFreeTextReplyAnswersAQuestion(t *testing.T) {
	f, agent := itemNoticeFixture(t, "question")
	ctx := context.Background()
	notice := f.noticeSent(t, f.questionItem(agent, "q_free", false, "Left", "Right"))
	if !settledByReply(f.server, ctx, notice, replyFrom(notice, "第三种：中间")) {
		t.Fatal("a free-text reply to a question was not settled")
	}
	if answered := f.reloadNotice(t, notice); answered.State != store.NoticeAnswered || answered.AnswerText != "第三种：中间" {
		t.Fatalf("answered notice = %+v", answered)
	}
}

// On an approval, free text is more information: the notice stays sent so the
// person can still decide by an option, and the decision is then the option.
func TestFreeTextOnAnApprovalDoesNotDecideIt(t *testing.T) {
	f, agent := itemNoticeFixture(t, "approval")
	ctx := context.Background()
	notice := f.noticeSent(t, f.questionItem(agent, "a_free", true, "Approve", "Deny"))

	if !settledByReply(f.server, ctx, notice, replyFrom(notice, "再看看第二段")) {
		t.Fatal("a reply that is more information was not consumed")
	}
	if kept := f.reloadNotice(t, notice); kept.State != store.NoticeSent || kept.AnswerText != "" {
		t.Fatalf("notice after free text = %+v, want still sent and unanswered", kept)
	}
	if item, err := f.server.store.GetPendingItem(ctx, f.session.CreatedByUserID, notice.ItemID); err != nil || item.State != store.PendingOpen {
		t.Fatalf("the approval after free text = %+v (%v), want open", item, err)
	}
	if !settledByReply(f.server, ctx, notice, replyFrom(notice, "同意")) {
		t.Fatal("the approve option was not settled after the free text")
	}
	if decided := f.reloadNotice(t, notice); decided.State != store.NoticeAnswered || decided.AnswerText != "Approve" {
		t.Fatalf("decided notice = %+v, want answered with Approve", decided)
	}
}

// The assistant's own question is answered through the item, as the web does.
func TestOptionReplyAnswersTheAssistantsQuestion(t *testing.T) {
	f, agent := itemNoticeFixture(t, "ask")
	ctx := context.Background()
	notice := f.noticeSent(t, store.PendingItem{
		UserID: f.session.CreatedByUserID, AssistantID: agent.ID, WorkspaceID: "ws_pending", SessionID: f.session.ID,
		Source: store.PendingSourceAssistantQuestion, Key: "ask:tea", Title: "Tea or coffee?", Excerpt: "Tea or coffee?",
		Options: []string{"Tea", "Coffee"}, Handler: store.PendingHandlerPerson,
	})
	if notice.Kind != "ask" {
		t.Fatalf("notice kind = %q, want ask", notice.Kind)
	}
	if !settledByReply(f.server, ctx, notice, replyFrom(notice, "Coffee")) {
		t.Fatal("the option reply to the assistant's question was not settled")
	}
	closed, err := f.server.store.GetPendingItem(ctx, f.session.CreatedByUserID, notice.ItemID)
	if err != nil || closed.State != store.PendingDone || closed.Answer != "Coffee" || closed.AnsweredBy != store.PendingAnsweredByPerson {
		t.Fatalf("the assistant's question after the reply = %+v (%v), want done with Coffee by the person", closed, err)
	}
}

// Only the person's own reply, in the notice's chat, answers the notice.
func TestOnlyThePersonsReplyInTheNoticeChatAnswers(t *testing.T) {
	f, agent := itemNoticeFixture(t, "question")
	notice := f.noticeSent(t, f.questionItem(agent, "q_identity", false, "Left", "Right"))
	userID := f.session.CreatedByUserID

	other := replyFrom(notice, "1")
	other.Sender = store.MessageEnvelopeSender{ID: "ou_peer", IsSelf: false}
	if noticeAnswersFrom(notice, userID, other) {
		t.Fatal("another sender's reply answered the notice")
	}
	elsewhere := replyFrom(notice, "1")
	elsewhere.Conversation.ID = "oc_other_chat"
	if noticeAnswersFrom(notice, userID, elsewhere) {
		t.Fatal("a reply in another chat answered the notice")
	}
	written := replyFrom(notice, "1")
	written.Sender.IsOwnWrite = true
	if noticeAnswersFrom(notice, userID, written) {
		t.Fatal("the assistant's own write answered the notice")
	}
	if noticeAnswersFrom(notice, "user_other", replyFrom(notice, "1")) {
		t.Fatal("another person's notice was answered by this account")
	}
	if !noticeAnswersFrom(notice, userID, replyFrom(notice, "1")) {
		t.Fatal("the person's own reply in the notice chat did not answer it")
	}
}

// A reply that does not settle is not consumed: free text a notice does not
// take stays with the assistant's inbox.
func TestUnsettledRepliesAreNotConsumed(t *testing.T) {
	f, agent := itemNoticeFixture(t, "question")
	ctx := context.Background()
	optionsOnly := f.noticeSent(t, f.questionItem(agent, "q_options", false, "Left", "Right"))
	optionsOnly.AllowFreeText = false
	if settledByReply(f.server, ctx, optionsOnly, replyFrom(optionsOnly, "随便")) {
		t.Fatal("free text settled a notice that takes options only")
	}
}

// A reply to an item answered elsewhere is no answer. Closing the item ends
// its notice, and the item keeps its first answer.
func TestReplyToAnItemAnsweredElsewhereIsNotAnAnswer(t *testing.T) {
	f, agent := itemNoticeFixture(t, "question")
	ctx := context.Background()
	notice := f.noticeSent(t, f.questionItem(agent, "q_elsewhere", false, "Left", "Right"))
	if _, err := f.server.store.ResolvePendingItem(ctx, f.session.CreatedByUserID, notice.ItemID, store.PendingDone, store.PendingOutcomePersonAnswered,
		store.PendingAnswer{Text: "Left", By: store.PendingAnsweredByPerson}); err != nil {
		t.Fatal(err)
	}
	if settledByReply(f.server, ctx, notice, replyFrom(notice, "Right")) {
		t.Fatal("a reply to an item answered on the web was consumed")
	}
	item, err := f.server.store.GetPendingItem(ctx, f.session.CreatedByUserID, notice.ItemID)
	if err != nil || item.Answer != "Left" {
		t.Fatalf("the item's answer = %+v (%v), want the first answer Left", item, err)
	}
	if ended := f.reloadNotice(t, notice); ended.State != store.NoticeSuperseded {
		t.Fatalf("the notice of the closed item = %+v, want superseded", ended)
	}
}

// A reply that cannot reach its question gives the notice back, so a later
// reply can still settle it; the reply itself is not consumed.
func TestUnsettledAnswerReopensTheNotice(t *testing.T) {
	f, agent := itemNoticeFixture(t, "question")
	ctx := context.Background()
	item := f.questionItem(agent, "q_nomessage", false, "Left", "Right")
	item.MessageID = ""
	stored, _, err := f.server.store.RecordPendingItem(ctx, item)
	if err != nil {
		t.Fatal(err)
	}
	notice, _, err := f.server.personNotices.EnqueueNotice(ctx, stored, personnotice.Route{
		SinkID: noticeSinkID("app_notify"), Target: "oc_self", Kind: "question", AllowFreeText: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, claimed, err := f.server.store.ClaimPersonNotice(ctx, notice.ID, time.Now().UTC()); err != nil || !claimed {
		t.Fatalf("claim: claimed=%v err=%v", claimed, err)
	}
	if _, err := f.server.store.SettlePersonNotice(ctx, notice.ID, store.PersonNoticeSettlement{
		State: store.NoticeSent, ProviderMessageID: "om_nomessage", At: time.Now().UTC(),
	}); err != nil {
		t.Fatal(err)
	}
	if settledByReply(f.server, ctx, notice, replyFrom(notice, "Left")) {
		t.Fatal("an answer that could not reach its question was consumed")
	}
	if reopened := f.reloadNotice(t, notice); reopened.State != store.NoticeSent || reopened.AnswerText != "" {
		t.Fatalf("notice after the failed answer = %+v, want sent again", reopened)
	}
}

// setSinks saves the notify sinks of one of the channel fixture person's
// assistants and returns the assistant.
func (f channelSessionFixture) setSinks(t *testing.T, assistantID string, sinks []store.PersonalAgentNotifySink) store.PersonalAgent {
	t.Helper()
	ctx := context.Background()
	agent, err := f.server.store.GetAssistant(ctx, assistantID)
	if err != nil {
		t.Fatal(err)
	}
	settings := agent.Settings
	settings.Notify = store.PersonalAgentNotifySettings{Sinks: sinks}
	agent, err = f.server.store.SavePersonalAgentSettings(ctx, assistantID, settings)
	if err != nil {
		t.Fatalf("save the notify settings: %v", err)
	}
	return agent
}

// notifyKinds gives the channel fixture's default assistant a sink to the
// app_notify connector that takes kinds, and returns the assistant.
func (f channelSessionFixture) notifyKinds(t *testing.T, kinds ...string) store.PersonalAgent {
	t.Helper()
	return f.setSinks(t, f.agent.ID, []store.PersonalAgentNotifySink{{ConnectorInstanceID: "app_notify", Kinds: kinds}})
}

// secondAssistant creates an assistant of the channel fixture's person that is
// not the default, with the sinks given.
func (f channelSessionFixture) secondAssistant(t *testing.T, workspaceID string, sinks []store.PersonalAgentNotifySink) store.PersonalAgent {
	t.Helper()
	agent, err := f.server.store.CreatePersonalAgent(context.Background(), store.PersonalAgent{
		UserID: f.aliceID, WorkspaceID: workspaceID,
		Settings: store.PersonalAgentSettings{Notify: store.PersonalAgentNotifySettings{Sinks: sinks}},
	})
	if err != nil {
		t.Fatalf("create the second assistant: %v", err)
	}
	return agent
}

// noticeTestItem is an open question the person holds, asked in session by
// assistantID; handed marks it handed over from its answer.
func noticeTestItem(session store.AgentSession, assistantID, source, id string, handed bool) store.PendingItem {
	item := store.PendingItem{
		UserID: session.CreatedByUserID, AssistantID: assistantID, WorkspaceID: session.WorkspaceID, SessionID: session.ID,
		Source: source, Key: source + ":" + id, EventID: "evt_" + id, MessageID: "in_" + id + "/call",
		Title: "Which way " + id + "?", Excerpt: "Which way " + id + "?", Handler: store.PendingHandlerPerson,
	}
	if handed {
		item.HandedAt = formatPendingTime(time.Now())
	}
	return item
}

// queueTestNotice records the item and queues its notice through the test's
// chat lookup, and returns the notices the item has.
func queueTestNotice(t *testing.T, s *Server, item store.PendingItem) []store.PersonNotice {
	t.Helper()
	ctx := context.Background()
	stored, _, err := s.store.RecordPendingItem(ctx, item)
	if err != nil {
		t.Fatal(err)
	}
	s.queueItemNotice(ctx, stored, noticeItemsChat)
	notices, err := s.store.PersonNoticesOfItem(ctx, stored.ID)
	if err != nil {
		t.Fatal(err)
	}
	return notices
}

// captureLog returns what run logs.
func captureLog(run func()) string {
	var buf bytes.Buffer
	previous := log.Writer()
	log.SetOutput(&buf)
	defer log.SetOutput(previous)
	run()
	return buf.String()
}

// A notice goes through the item's own assistant's sinks when it has some,
// and names that assistant.
func TestNoticeUsesTheItemsAssistantsOwnSinks(t *testing.T) {
	f := newChannelSessionFixture(t)
	f.server.options.AllowedOrigin = noticeItemsOrigin
	f.setSinks(t, f.agent.ID, []store.PersonalAgentNotifySink{{ConnectorInstanceID: "app_default", Kinds: []string{"question"}}})
	own := f.secondAssistant(t, "ws_notice_own", []store.PersonalAgentNotifySink{{ConnectorInstanceID: "app_own", Kinds: []string{"question"}}})
	notices := queueTestNotice(t, f.server, noticeTestItem(f.conversation, own.ID, store.PendingSourceQuestion, "own_q", false))
	if len(notices) != 1 || notices[0].SinkID != noticeSinkID("app_own") || notices[0].AssistantID != own.ID {
		t.Fatalf("notices = %+v, want one through the item's own sink", notices)
	}
}

// With no sinks of its own, an item's notice goes through the person's default
// assistant's sinks, and that assistant is the one the notice speaks through.
func TestNoticeFallsBackToTheDefaultAssistantsSinks(t *testing.T) {
	f := newChannelSessionFixture(t)
	f.server.options.AllowedOrigin = noticeItemsOrigin
	f.setSinks(t, f.agent.ID, []store.PersonalAgentNotifySink{{ConnectorInstanceID: "app_default", Kinds: []string{"question"}}})
	bare := f.secondAssistant(t, "ws_notice_fallback", nil)
	notices := queueTestNotice(t, f.server, noticeTestItem(f.conversation, bare.ID, store.PendingSourceQuestion, "fallback_q", false))
	if len(notices) != 1 || notices[0].SinkID != noticeSinkID("app_default") || notices[0].AssistantID != f.agent.ID {
		t.Fatalf("notices = %+v, want one through the default assistant's sink", notices)
	}
}

// A notice that is skipped says why in the log: the item's id and the reason,
// never the item's content, and nothing is queued.
func TestNoticeSkippedForAReasonIsLoggedWithoutContent(t *testing.T) {
	f := newChannelSessionFixture(t)
	f.server.options.AllowedOrigin = noticeItemsOrigin
	ctx := context.Background()
	f.setSinks(t, f.agent.ID, []store.PersonalAgentNotifySink{{ConnectorInstanceID: "app_default", Kinds: []string{"question"}}})
	bare := f.secondAssistant(t, "ws_notice_bare", nil)
	approvalOnly := f.secondAssistant(t, "ws_notice_approval", []store.PersonalAgentNotifySink{{ConnectorInstanceID: "app_own", Kinds: []string{"approval"}}})
	cases := []struct {
		name   string
		item   store.PendingItem
		reason string
	}{
		{"no assistant", noticeTestItem(f.conversation, "", store.PendingSourceQuestion, "none_q", false), "the item has no assistant"},
		{"own sinks absent and the default's absent too", noticeTestItem(f.conversation, bare.ID, store.PendingSourceQuestion, "nosink_q", false), ""},
		{"own sinks do not take the kind", noticeTestItem(f.conversation, approvalOnly.ID, store.PendingSourceQuestion, "kind_q", false), "no notify sink takes kind question"},
	}
	// With the default's sinks cleared, the bare assistant has no sinks anywhere.
	f.setSinks(t, f.agent.ID, nil)
	cases[1].reason = "neither its assistant nor the default assistant has notify sinks"
	for _, c := range cases {
		stored, _, err := f.server.store.RecordPendingItem(ctx, c.item)
		if err != nil {
			t.Fatalf("%s: record: %v", c.name, err)
		}
		logged := captureLog(func() { f.server.queueItemNotice(ctx, stored, noticeItemsChat) })
		if want := "person notice for item " + stored.ID + " skipped: " + c.reason; !strings.Contains(logged, want) {
			t.Fatalf("%s: log = %q, want a line containing %q", c.name, logged, want)
		}
		if strings.Contains(logged, "Which way") {
			t.Fatalf("%s: the log carries the item's content: %q", c.name, logged)
		}
		if notices, err := f.server.store.PersonNoticesOfItem(ctx, stored.ID); err != nil || len(notices) != 0 {
			t.Fatalf("%s: notices = %+v (%v), want none", c.name, notices, err)
		}
	}
}

// A helper's question that the assistant hands over from its answer, with no
// question card, is noticed as a hand-over that takes no reply: its answer goes
// through the assistant, so a reply in the notice's chat is not consumed. The
// helper is the channel's and the home conversation's alike.
func TestHandOverWithoutCardIsNoticedAndTakesNoReply(t *testing.T) {
	f := newChannelSessionFixture(t)
	f.server.options.AllowedOrigin = noticeItemsOrigin
	ctx := context.Background()
	agent := f.notifyKinds(t, "hand_over")
	for _, helper := range []store.AgentSession{f.helper, f.conversation} {
		item, err := f.server.handOverWithoutCard(ctx, agent, helper, "turn_"+helper.ID, "Pick a colour: blue or green?", noticeItemsChat)
		if err != nil {
			t.Fatal(err)
		}
		notices, err := f.server.store.PersonNoticesOfItem(ctx, item.ID)
		if err != nil || len(notices) != 1 {
			t.Fatalf("notices of %s = %+v (%v), want one", item.ID, notices, err)
		}
		notice := notices[0]
		if notice.Kind != "hand_over" || notice.AllowFreeText || notice.Target != "oc_self" || notice.Title != item.Title {
			t.Fatalf("notice of a helper's question = %+v", notice)
		}
		if _, claimed, err := f.server.store.ClaimPersonNotice(ctx, notice.ID, time.Now().UTC()); err != nil || !claimed {
			t.Fatalf("claim the notice: claimed=%v err=%v", claimed, err)
		}
		if _, err := f.server.store.SettlePersonNotice(ctx, notice.ID, store.PersonNoticeSettlement{
			State: store.NoticeSent, ProviderMessageID: "om_" + notice.ID, At: time.Now().UTC(),
		}); err != nil {
			t.Fatal(err)
		}
		if settledByReply(f.server, ctx, notice, replyFrom(notice, "blue")) {
			t.Fatal("a reply to a hand-over notice of a question without a card was consumed")
		}
		if open, err := f.server.store.GetPendingItem(ctx, item.UserID, item.ID); err != nil || open.State != store.PendingOpen {
			t.Fatalf("item after the reply = %+v (%v), want open", open, err)
		}
	}
}

// Questions, asks and hand-overs from the home conversation and from a channel
// conversation each get a notice of their kind, and a reply can answer them.
func TestAskingItemsOfHomeAndChannelChatsAreNoticed(t *testing.T) {
	f := newChannelSessionFixture(t)
	f.server.options.AllowedOrigin = noticeItemsOrigin
	ctx := context.Background()
	agent := f.notifyKinds(t, "question", "ask", "hand_over")
	asked := func(session store.AgentSession, source, id string, handed bool) store.PendingItem {
		item := store.PendingItem{
			UserID: f.aliceID, AssistantID: agent.ID, WorkspaceID: session.WorkspaceID, SessionID: session.ID,
			Source: source, Key: source + ":" + id, EventID: "evt_" + id, MessageID: "in_" + id + "/call",
			Title: "Which way " + id + "?", Excerpt: "Which way " + id + "?", Handler: store.PendingHandlerPerson,
		}
		if handed {
			item.HandedAt = formatPendingTime(time.Now())
		}
		return item
	}
	cases := []struct {
		name string
		item store.PendingItem
		kind string
	}{
		{"question at home", asked(f.conversation, store.PendingSourceQuestion, "home_q", false), "question"},
		{"question in a channel conversation", asked(f.session, store.PendingSourceQuestion, "chan_q", false), "question"},
		{"ask from home", asked(f.conversation, store.PendingSourceAssistantQuestion, "home_ask", false), "ask"},
		{"ask from a channel conversation", asked(f.session, store.PendingSourceAssistantQuestion, "chan_ask", false), "ask"},
		{"hand-over at home", asked(f.conversation, store.PendingSourceQuestion, "home_hand", true), "hand_over"},
		{"hand-over from a channel conversation", asked(f.session, store.PendingSourceQuestion, "chan_hand", true), "hand_over"},
	}
	for _, c := range cases {
		stored, _, err := f.server.store.RecordPendingItem(ctx, c.item)
		if err != nil {
			t.Fatalf("%s: record: %v", c.name, err)
		}
		f.server.queueItemNotice(ctx, stored, noticeItemsChat)
		notices, err := f.server.store.PersonNoticesOfItem(ctx, stored.ID)
		if err != nil || len(notices) != 1 {
			t.Fatalf("%s: notices = %+v (%v), want one", c.name, notices, err)
		}
		if notices[0].Kind != c.kind || !notices[0].AllowFreeText {
			t.Fatalf("%s: notice = %+v, want a %s notice with a reply", c.name, notices[0], c.kind)
		}
	}
}

// settledByReply reports whether a reply envelope was taken as an answer to the
// notice, the question the inbound path asks.
func settledByReply(s *Server, ctx context.Context, notice store.PersonNotice, envelope store.MessageEnvelope) bool {
	return s.settleNoticeReply(ctx, notice, envelope.Text, envelope.MessageID) != noticeNotSettled
}
