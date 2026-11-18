package feishu

import (
	"context"
	"encoding/json"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/feishuevents"
	"github.com/foundry-dev/foundry/apps/server/internal/feishuevents/feishueventstest"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// noticeTestCard is a notice card as the tests read it: the JSON as a tree.
func noticeTestCard(t *testing.T, card string) map[string]any {
	t.Helper()
	var tree map[string]any
	if err := json.Unmarshal([]byte(card), &tree); err != nil {
		t.Fatalf("the card is not JSON: %v\n%s", err, card)
	}
	return tree
}

func openNotice(kind string, options ...string) store.PersonNotice {
	notice := store.PersonNotice{
		ID: "pn_1", UserID: "user_1", AssistantID: "asst_person", ItemID: "pi_1", Kind: kind,
		Title: "要不要把旧博客收起来？", State: store.NoticeSending, AllowFreeText: true,
		Link: "https://foundry.example/pending?item=pi_1",
	}
	for index, label := range options {
		notice.Options = append(notice.Options, store.PersonNoticeOption{ID: string(rune('0' + index)), Label: label})
	}
	return notice
}

// Each kind's card: a question carries its options and note box, an approval
// its command as code and a note box, an ask a note box alone; each opens the
// item in Foundry.
func TestNoticeCardsCarryEachKind(t *testing.T) {
	facts := NoticeFacts{Assistant: "默认助理", Project: "博客", Context: "上次提到要收起来\n第二行\n第三行\n第四行不显示"}

	question := BuildNoticeCard(openNotice("question", "收起来", "保留"), facts, NoticeView{}, "zh")
	for _, want := range []string{
		`"title":{"tag":"plain_text","content":"需要你决定 · 默认助理 · 博客"}`,
		`"content":"收起来"`, `"op":"notice_answer"`, `"noticeId":"pn_1"`, `"option":"1"`,
		`"name":"reply"`, `"tag":"input"`, `"form_action_type":"submit"`,
		`"default_url":"https://foundry.example/pending?item=pi_1"`,
		"上次提到要收起来\\n第二行\\n第三行",
	} {
		if !strings.Contains(question, want) {
			t.Fatalf("question card lacks %s:\n%s", want, question)
		}
	}
	if strings.Contains(question, "第四行不显示") {
		t.Fatalf("the context is not limited to three lines:\n%s", question)
	}

	approval := openNotice("approval", "同意", "拒绝")
	approval.Title = "需要你批准一次写入：归档旧文章"
	approvalCard := BuildNoticeCard(approval, NoticeFacts{Assistant: "默认助理", Context: "改动 3 个文件", Command: "PUT /blog/archive?id=42"}, NoticeView{Note: "先别动图片"}, "zh")
	for _, want := range []string{
		`"template":"orange"`, "需要你批准 · 默认助理", "```\\nPUT /blog/archive?id=42\\n```",
		`"content":"同意"`, `"content":"拒绝"`, "已记为补充说明：先别动图片",
	} {
		if !strings.Contains(approvalCard, want) {
			t.Fatalf("approval card lacks %s:\n%s", want, approvalCard)
		}
	}

	ask := openNotice("ask")
	ask.Options = nil
	askCard := BuildNoticeCard(ask, NoticeFacts{Assistant: "默认助理"}, NoticeView{}, "zh")
	if !strings.Contains(askCard, "助理问你 · 默认助理") || strings.Contains(askCard, `"option":"0"`) || !strings.Contains(askCard, `"name":"reply"`) {
		t.Fatalf("ask card = %s, want a note box and no options", askCard)
	}

	english := BuildNoticeCard(openNotice("question", "Hide", "Keep"), NoticeFacts{Assistant: "Default", Project: "Blog"}, NoticeView{}, "en")
	if !strings.Contains(english, "Needs your decision · Default · Blog") || !strings.Contains(english, "Open in Foundry") {
		t.Fatalf("english card = %s", english)
	}
}

// Once answered the card shows the choice and offers no buttons; a free text
// answer is shown as written; a superseded notice says it was handled elsewhere.
func TestAnsweredNoticeCardShowsTheAnswer(t *testing.T) {
	answered := openNotice("question", "收起来", "保留")
	answered.State = store.NoticeAnswered
	answered.AnswerText = "收起来"
	chosen := BuildNoticeCard(answered, NoticeFacts{}, NoticeView{}, "zh")
	if !strings.Contains(chosen, "已处理：你选了 收起来") || strings.Contains(chosen, `"op":"notice_answer"`) || !strings.Contains(chosen, `"template":"green"`) {
		t.Fatalf("answered card = %s", chosen)
	}

	answered.AnswerText = "先看看第二段"
	typed := BuildNoticeCard(answered, NoticeFacts{}, NoticeView{}, "zh")
	if !strings.Contains(typed, "已处理：先看看第二段") || strings.Contains(typed, "你选了") {
		t.Fatalf("typed answer card = %s", typed)
	}

	superseded := openNotice("question", "收起来", "保留")
	superseded.State = store.NoticeSuperseded
	closed := BuildNoticeCard(superseded, NoticeFacts{}, NoticeView{}, "zh")
	if !strings.Contains(closed, "已在别处处理") || strings.Contains(closed, `"op":"notice_answer"`) {
		t.Fatalf("superseded card = %s", closed)
	}
}

// A notice that is not a real one (a test notice) carries no answer controls.
func TestNoticeWithoutItemHasNoAnswerControls(t *testing.T) {
	test := store.PersonNotice{ID: "pn_test", Kind: "question", Title: "[测试] Foundry 通知联调", Text: "无需处理"}
	card := BuildNoticeCard(test, NoticeFacts{}, NoticeView{}, "zh")
	if strings.Contains(card, "notice_answer") || strings.Contains(card, `"tag":"input"`) {
		t.Fatalf("the test card answers: %s", card)
	}
}

// fakeNoticeDesk settles presses the way Foundry does for the tests: the first
// press answers a sent notice, later ones find it answered.
type fakeNoticeDesk struct {
	mu      sync.Mutex
	notice  store.PersonNotice
	presses []NoticePress
	outcome NoticeOutcome
}

func (d *fakeNoticeDesk) NoticeFacts(context.Context, store.PersonNotice) (NoticeFacts, error) {
	return NoticeFacts{Assistant: "默认助理", Project: "博客"}, nil
}

func (d *fakeNoticeDesk) AnswerNotice(_ context.Context, press NoticePress) (NoticeAnswer, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.presses = append(d.presses, press)
	if d.notice.State == store.NoticeSent {
		answer := press.Text
		if press.Option != "" {
			answer = d.notice.Options[0].Label
		}
		d.notice.State, d.notice.AnswerText = store.NoticeAnswered, answer
	}
	return NoticeAnswer{Notice: d.notice, Outcome: NoticeAnswered}, nil
}

func (d *fakeNoticeDesk) pressCount() int {
	d.mu.Lock()
	defer d.mu.Unlock()
	return len(d.presses)
}

func (f assistantFixture) notice(t *testing.T, desk *fakeNoticeDesk, notice store.PersonNotice) {
	t.Helper()
	desk.mu.Lock()
	desk.notice = notice
	desk.mu.Unlock()
	f.manager.Notices = desk
}

// pressNotice is a press on the notice card, by operator in chat, as a card callback.
func (f assistantFixture) pressNotice(eventID, operator, chatID, cardID string, value map[string]string, form map[string]string) {
	action := map[string]any{"tag": "button", "value": value}
	if form != nil {
		action["form_value"] = form
	}
	payload := feishueventstest.EventPayload("cli_x", eventID, cardActionTriggered, map[string]any{
		"operator": map[string]string{"open_id": operator},
		"action":   action,
		"context":  map[string]string{"open_message_id": cardID, "open_chat_id": chatID},
	})
	f.manager.HandleEvent(context.Background(), feishuevents.Event{AppID: "cli_x", ID: eventID, Type: cardActionTriggered, Payload: json.RawMessage(payload)})
}

// waitForPatches collects card patches until n arrive or the test times out.
func waitForPatches(t *testing.T, bot *fakeBot, n int) []struct{ to, card string } {
	t.Helper()
	var patches []struct{ to, card string }
	deadline := time.Now().Add(5 * time.Second)
	for len(patches) < n && time.Now().Before(deadline) {
		patches = append(patches, bot.takePatches()...)
		time.Sleep(5 * time.Millisecond)
	}
	if len(patches) < n {
		t.Fatalf("got %d card patches, want %d", len(patches), n)
	}
	return patches
}

// A press by the paired person settles the notice through Foundry and updates
// the card in place. A second press (a double click) is settled by Foundry as a
// no-op, and the card still shows the first answer. Anyone else's press, and a
// press in a group, settle nothing.
func TestNoticePressSettlesOnceAndUpdatesTheCard(t *testing.T) {
	f := newAssistantFixture(t)
	desk := &fakeNoticeDesk{outcome: NoticeAnswered}
	notice := openNotice("question", "收起来", "保留")
	notice.State, notice.ProviderMessageID = store.NoticeSent, "card_notice"
	f.notice(t, desk, notice)

	press := map[string]string{"foundry": "personal_agent", "op": "notice_answer", "noticeId": "pn_1", "option": "0"}
	f.pressNotice("ev_stranger", "ou_stranger", "oc_dm", "card_notice", press, nil)
	f.pressNotice("ev_group", "ou_person", "oc_1", "card_notice", press, nil)
	if desk.pressCount() != 0 {
		t.Fatalf("a press by someone else, or in a group, settled the notice: %+v", desk.presses)
	}

	f.pressNotice("ev_first", "ou_person", "oc_dm", "card_notice", press, nil)
	f.pressNotice("ev_second", "ou_person", "oc_dm", "card_notice", press, nil)
	patches := waitForPatches(t, f.bot, 2)
	for _, patch := range patches {
		if patch.to != "card_notice" || !strings.Contains(patch.card, "已处理：你选了 收起来") || strings.Contains(patch.card, `"op":"notice_answer"`) {
			t.Fatalf("the card became %+v, want the answer and no buttons", patch)
		}
	}
	if desk.pressCount() != 2 {
		t.Fatalf("the desk saw %d presses, want both to reach it (it settles once)", desk.pressCount())
	}
}

// A typed note reaches the desk as text, not as an option.
func TestNoticeNoteBoxSendsTheTypedText(t *testing.T) {
	f := newAssistantFixture(t)
	desk := &fakeNoticeDesk{outcome: NoticeAnswered}
	notice := openNotice("ask")
	notice.Options = nil
	notice.State, notice.ProviderMessageID = store.NoticeSent, "card_ask"
	f.notice(t, desk, notice)

	f.pressNotice("ev_empty", "ou_person", "oc_dm", "card_ask", map[string]string{"foundry": "personal_agent", "op": "notice_answer", "noticeId": "pn_1", "option": ""}, map[string]string{"reply": "  "})
	f.pressNotice("ev_text", "ou_person", "oc_dm", "card_ask", map[string]string{"foundry": "personal_agent", "op": "notice_answer", "noticeId": "pn_1", "option": ""}, map[string]string{"reply": "先看看第二段"})
	patches := waitForPatches(t, f.bot, 1)
	if desk.pressCount() != 1 || desk.presses[0].Text != "先看看第二段" || desk.presses[0].Option != "" {
		t.Fatalf("presses = %+v, want the one typed text", desk.presses)
	}
	if !strings.Contains(patches[0].card, "已处理：先看看第二段") {
		t.Fatalf("the card = %s, want the typed answer", patches[0].card)
	}
}

// The bot's sink posts the card in the assistant's direct chat and records the
// card's id; without a running chat it fails transiently, and a refresh of a
// superseded notice patches that card.
func TestNoticeSinkPostsAndRefreshesItsCard(t *testing.T) {
	f := newAssistantFixture(t)

	notice := openNotice("question", "收起来", "保留")
	notice.UserID, notice.State = f.person.ID, store.NoticeSending
	messageID, err := f.manager.SendNotice(context.Background(), notice)
	if err != nil || messageID == "" {
		t.Fatalf("send = %q, %v; want a card id", messageID, err)
	}
	f.bot.mu.Lock()
	posted := f.bot.sent
	f.bot.sent = nil
	f.bot.mu.Unlock()
	if len(posted) != 1 || posted[0].to != "oc_dm" || !strings.Contains(posted[0].card, `"noticeId":"pn_1"`) {
		t.Fatalf("posted %+v, want one notice card in the direct chat", posted)
	}

	notice.ProviderMessageID, notice.State = messageID, store.NoticeSuperseded
	if err := f.manager.RefreshNotice(context.Background(), notice); err != nil {
		t.Fatal(err)
	}
	patches := f.bot.takePatches()
	if len(patches) != 1 || patches[0].to != messageID || !strings.Contains(patches[0].card, "已在别处处理") {
		t.Fatalf("refresh patched %+v, want the superseded card", patches)
	}

	stranger := openNotice("question", "收起来")
	stranger.UserID = "user_nobody"
	stranger.State = store.NoticeSending
	if _, err := f.manager.SendNotice(context.Background(), stranger); err == nil {
		t.Fatal("a notice with no paired chat was sent")
	}
}

// The bot carries a person's notices only while they pair it with the assistant.
func TestHasNoticeChatFollowsThePairing(t *testing.T) {
	f := newAssistantFixture(t)
	if !f.manager.HasNoticeChat(context.Background(), f.person.ID, "asst_person") {
		t.Fatal("the paired person's assistant does not count as having a notice chat")
	}
	if f.manager.HasNoticeChat(context.Background(), "user_nobody", "asst_person") {
		t.Fatal("another person's assistant counts as paired")
	}
}
