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

// cardNotice is a question's notice on the built-in bot, sent as the card
// cardID, so a press on that card reaches it.
func cardNotice(t *testing.T, f *pendingFixture, agent store.PersonalAgent, id, cardID string) store.PersonNotice {
	t.Helper()
	ctx := context.Background()
	stored, _, err := f.server.store.RecordPendingItem(ctx, f.questionItem(agent, id, false, "Left", "Right"))
	if err != nil {
		t.Fatal(err)
	}
	notice, created, err := f.server.personNotices.EnqueueNotice(ctx, stored, personnotice.Route{
		SinkID: feishu.NoticeSinkID, Kind: "question", AllowFreeText: true,
		Link: noticeItemsOrigin + "/pending?item=" + stored.ID,
	})
	if err != nil || !created {
		t.Fatalf("enqueue the card notice: created=%v err=%v", created, err)
	}
	if _, claimed, err := f.server.store.ClaimPersonNotice(ctx, notice.ID, time.Now().UTC()); err != nil || !claimed {
		t.Fatalf("claim the card notice: claimed=%v err=%v", claimed, err)
	}
	if _, err := f.server.store.SettlePersonNotice(ctx, notice.ID, store.PersonNoticeSettlement{
		State: store.NoticeSent, ProviderMessageID: cardID, At: time.Now().UTC(),
	}); err != nil {
		t.Fatal(err)
	}
	return f.reloadNotice(t, notice)
}

// A press on the notice's card settles the notice once through the reply path:
// the first press answers the item, and a second press (a double click) finds
// it answered and changes nothing. A press from another card, another person,
// or an option the notice does not have is refused.
func TestNoticeCardPressSettlesOnce(t *testing.T) {
	f, agent := itemNoticeFixture(t, "question")
	ctx := context.Background()
	notice := cardNotice(t, f, agent, "q_card", "card_q_card")
	desk := feishuNoticeDesk{s: f.server}
	press := feishu.NoticePress{
		UserID: notice.UserID, AssistantID: notice.AssistantID, NoticeID: notice.ID,
		CardMessageID: "card_q_card", Option: "1", PressID: "ev_first",
	}

	if _, err := desk.AnswerNotice(ctx, feishu.NoticePress{UserID: "someone_else", AssistantID: notice.AssistantID, NoticeID: notice.ID, CardMessageID: "card_q_card", Option: "1"}); err == nil {
		t.Fatal("a press by another person was settled")
	}
	if _, err := desk.AnswerNotice(ctx, feishu.NoticePress{UserID: notice.UserID, AssistantID: notice.AssistantID, NoticeID: notice.ID, CardMessageID: "card_other", Option: "1"}); err == nil {
		t.Fatal("a press on another card was settled")
	}
	if _, err := desk.AnswerNotice(ctx, feishu.NoticePress{UserID: notice.UserID, AssistantID: notice.AssistantID, NoticeID: notice.ID, CardMessageID: "card_q_card", Option: "7"}); err == nil {
		t.Fatal("an option the notice does not have was settled")
	}

	first, err := desk.AnswerNotice(ctx, press)
	if err != nil {
		t.Fatal(err)
	}
	if first.Outcome != feishu.NoticeAnswered || first.Notice.State != store.NoticeAnswered || first.Notice.AnswerText != "Right" {
		t.Fatalf("first press = %+v, want the notice answered with Right", first)
	}
	second, err := desk.AnswerNotice(ctx, feishu.NoticePress{UserID: notice.UserID, AssistantID: notice.AssistantID, NoticeID: notice.ID, CardMessageID: "card_q_card", Option: "0", PressID: "ev_second"})
	if err != nil {
		t.Fatal(err)
	}
	if second.Notice.AnswerText != "Right" || second.Notice.State != store.NoticeAnswered {
		t.Fatalf("second press = %+v, want the first answer kept", second.Notice)
	}
	queue, err := f.server.store.ChatQueue(ctx, "ws_pending", f.session.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(queue.Items) != 1 || !strings.Contains(queue.Items[0].Text, "Right") || !strings.Contains(queue.Items[0].Text, "call_q_card") {
		t.Fatalf("the chat queue = %+v, want the answer once, for the question", queue.Items)
	}
}

// The card's facts are the assistant's name, the item's project and its words.
func TestNoticeCardFactsReadTheItem(t *testing.T) {
	f, agent := itemNoticeFixture(t, "question")
	ctx := context.Background()
	notice := cardNotice(t, f, agent, "q_facts", "card_q_facts")
	facts, err := feishuNoticeDesk{s: f.server}.NoticeFacts(ctx, notice)
	if err != nil {
		t.Fatal(err)
	}
	if facts.Context != "Which way q_facts?" || facts.Command != "" {
		t.Fatalf("facts = %+v, want the item's words and no command", facts)
	}
}

// A sink named by the built-in bot is the bot's own id, not a connector's.
func TestNoticeSinkIDOfTheBotIsItsOwn(t *testing.T) {
	if got := noticeSinkID(feishu.NoticeSinkID); got != feishu.NoticeSinkID {
		t.Fatalf("sink id of the bot = %q, want %q", got, feishu.NoticeSinkID)
	}
	if got := noticeSinkID("app_notify"); got != "ext:app_notify" {
		t.Fatalf("sink id of a connector = %q", got)
	}
}
