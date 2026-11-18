package httpapi

import (
	"context"
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

// settledByReply reports whether a reply envelope was taken as an answer to the
// notice, the question the inbound path asks.
func settledByReply(s *Server, ctx context.Context, notice store.PersonNotice, envelope store.MessageEnvelope) bool {
	return s.settleNoticeReply(ctx, notice, envelope.Text, envelope.MessageID) != noticeNotSettled
}
