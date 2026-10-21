package feishu

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"strings"

	"github.com/foundry-dev/foundry/apps/server/internal/feishuevents"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
	larkcallback "github.com/larksuite/oapi-sdk-go/v3/event/dispatcher/callback"
)

// The assistant's cards in Feishu: its proposals with their buttons, the
// stop switch's answer with a resume button, and the turns of its
// conversation that Feishu did not start. A button's callback reaches the
// bot as a card.action.trigger event on the app's long connection (the
// app subscribes to that callback in long-connection mode) and counts only
// when the person the direct chat is paired with pressed it there.

const cardActionTriggered = "card.action.trigger"

// The callback value of the assistant's buttons.
const (
	cardActionMarker  = "personal_agent"
	cardActionAccept  = "accept"
	cardActionDecline = "decline"
	cardActionResume  = "resume"
)

// assistantTexts are what the server says in the assistant's chat,
// [Chinese, English] (assistantText).
var assistantTexts = map[string][2]string{
	"inboxTitle":       {"已收到", "Received"},
	"inboxAnswered":    {"助理回复", "Assistant reply"},
	"inboxInterrupted": {"处理未完成", "Processing interrupted"},
	"inboxFull":        {"[查看完整回复](%s)", "[Read the full reply](%s)"},
	"inboxReceived":    {"消息及附件引用已保存，无需重发。电脑或账号可用后处理；暂停期间只保存。", "Your message and attachment references are saved. No need to resend. Processing waits for the computer and account; paused work is only recorded."},
	"inboxFailedTitle": {"未能保存消息", "Message not saved"},
	"inboxFailed":      {"这次消息没有保存成功，请稍后重试或从助理页面查看。", "This message could not be saved. Try again later or check the assistant page."},
	"runningTitle":     {"助理在运行", "Your assistant is on"},
	"running":          {"助理没有停下，直接告诉我想做什么就行。", "I haven't stopped. Just tell me what you'd like to do."},
	"resumeButton":     {"继续", "Resume"},
	"proposalFallback": {"助理想做一件需要你同意的事。", "I'd like to do something that needs your OK."},
	"pendingTitle":     {"需要你确认", "Needs your OK"},
	"pendingHint":      {"也可以直接回复“好的”或“不用了”。", "You can also just reply \"yes\" or \"no\"."},
	"acceptButton":     {"好的", "Yes"},
	"declineButton":    {"不用了", "No thanks"},
	"acceptedTitle":    {"你已同意", "You said yes"},
	"accepted":         {"好的，这就去做。", "OK, I'm on it."},
	"appliedTitle":     {"已完成", "Done"},
	"declinedTitle":    {"你没有同意", "You said no"},
	"declined":         {"好的，不做了。", "OK, I won't do it."},
	"expiredTitle":     {"已过期", "Expired"},
	"expired":          {"这件事等太久没有回复，已经作废。需要的话再跟我说一次。", "This waited too long for an answer and was dropped. Ask me again if you still want it."},
	"failedTitle":      {"没能做成", "That didn't work"},
	"failed":           {"没能做成", "That didn't work"},
	"errorSep":         {"：", ": "},
	"end":              {"。", "."},
	"stoppedTitle":     {"助理已停下", "Your assistant is stopped"},
	"stopped":          {"现在不接新的事。说『继续』或点按钮恢复。", "I'm not taking anything new right now. Say \"resume\" or press the button to go on."},
	"offlineTitle":     {"助理暂时不在", "Your assistant is away"},
	"offline":          {"助理所在的电脑现在不在线，等它上线后再发给我。", "The computer I run on is offline right now. Send this again once it's back."},
	"offlineMove":      {"\n\n也可以[换一台电脑](%s)。", "\n\nYou can also [move me to another computer](%s)."},
	"introTitle":       {"这里现在由助理接手", "Your assistant answers here now"},
	"intro": {"从现在起，你在这里发的消息由助理接手，它会判断该放到哪里去做。以前这里的消息都进入%s，没有别的线索时助理仍会放到那里。\n\n想恢复原来的方式，在助理设置里关掉“单聊交给助理”。",
		"From now on, I take the messages you send here and decide where to work on them. They used to go to %s, and I'll still put them there when nothing else points elsewhere.\n\nTo go back to how it was, turn off \"Let the assistant answer my direct chats\" in my settings."},
	"introProject":      {"『%s』", "“%s”"},
	"introNoProject":    {"原来的项目", "your earlier project"},
	"stopFailedTitle":   {"没能停下", "Couldn't stop"},
	"stopFailed":        {"停止失败：%s\n\n请再发一次“停”，或在 Foundry 的助理页面点“停止助理工作”。", "Stopping failed: %s\n\nSend \"stop\" again, or press \"Stop assistant work\" on the assistant page in Foundry."},
	"stoppedAllTitle":   {"已暂停新工作", "New work paused"},
	"stoppedNone":       {"已暂停新工作。已有执行是否停止，以 Foundry 活动中的回执为准；独立服务需单独管理。说『继续』或点按钮恢复。", "New work is paused. Check Foundry Activity for execution stop receipts; manage independent services separately. Say \"resume\" or press the button to go on."},
	"stoppedSome":       {"已暂停新工作，并对 %d 项执行请求停止。以 Foundry 活动中的回执为准；独立服务需单独管理。说『继续』或点按钮恢复。", "New work is paused; stops requested for %d execution(s). Check Foundry Activity for receipts; manage independent services separately. Say \"resume\" or press the button to go on."},
	"resumeFailedTitle": {"没能恢复", "Couldn't resume"},
	"resumeFailed":      {"恢复失败：%s", "Resuming failed: %s"},
	"resumedTitle":      {"已恢复", "I'm back"},
	"resumed":           {"助理已恢复，有什么想做的直接告诉我。", "I'm back. Just tell me what you'd like to do."},
	"resumedList":       {"助理已恢复。之前停下的事不会自己重新开始：\n", "I'm back. What I stopped won't start again by itself:\n"},
	"resumedPick":       {"\n\n要接着做哪件，告诉我就行。", "\n\nTell me which ones to pick up again."},
	"severalTitle":      {"要确认的不止一件", "More than one thing needs your OK"},
	"several":           {"有 %d 件事在等你确认，请点对应卡片上的按钮。", "%d things are waiting for your OK. Please press the button on the right card."},
	"decideFailedTitle": {"没能确认", "Couldn't answer that"},
	"decideFailed":      {"这件事现在不能确认了：%s", "This can't be answered any more: %s"},
}

// assistantText is assistantTexts' key in language ("zh" or "en"), with
// args filled in when there are any.
func assistantText(language, key string, args ...any) string {
	index := 0
	if language == "en" {
		index = 1
	}
	text := assistantTexts[key][index]
	if len(args) > 0 {
		return fmt.Sprintf(text, args...)
	}
	return text
}

// proposalLanguage is the language of the person's proposal cards: the
// one they chose, else Chinese, as the proposals' own summaries are
// written in.
func (m *WSManager) proposalLanguage(ctx context.Context, userID string) string {
	if m.PersonalAgents == nil {
		return "zh"
	}
	return m.PersonalAgents.Language(ctx, userID, "")
}

// assistantTopic is the Feishu topic of an assistant conversation.
type assistantTopic struct {
	clientID      string
	chatID        string
	rootMessageID string
	title         string
}

// proposalCard is where a proposal's card was posted.
type proposalCard struct {
	clientID      string
	chatID        string
	cardMessageID string
}

func (m *WSManager) proposalCard(proposalID string) (proposalCard, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	card, ok := m.proposalCards[proposalID]
	return card, ok
}

// PersonalAgentProposalCreated shows a new proposal to the person in
// Feishu, with buttons: in the topic of the conversation that made it, or
// else in their direct chat with the assistant. Without either it is shown
// on the web only.
func (m *WSManager) PersonalAgentProposalCreated(proposal store.PersonalAgentProposal) {
	go m.postProposal(context.Background(), proposal)
}

func (m *WSManager) postProposal(ctx context.Context, proposal store.PersonalAgentProposal) {
	if proposal.Status != "" && proposal.Status != store.PersonalAgentProposalPending {
		return
	}
	card := BuildProposalCard(proposal, m.proposalLanguage(ctx, proposal.UserID))
	m.mu.RLock()
	topic, inTopic := m.assistantTopics[proposal.SessionID]
	m.mu.RUnlock()
	if inTopic {
		if app := m.app(topic.clientID); app != nil {
			cardMessageID, err := app.client.ReplyCard(ctx, topic.rootMessageID, card)
			if err == nil {
				m.rememberProposalCard(proposal.ID, proposalCard{clientID: topic.clientID, chatID: topic.chatID, cardMessageID: cardMessageID})
				return
			}
			log.Printf("[feishu] post proposal %s in its topic: %v", proposal.ID, err)
		}
	}
	app, chatID := m.assistantDirectChat(ctx, proposal.UserID)
	if app == nil {
		return
	}
	cardMessageID, err := app.client.SendCard(ctx, chatID, card)
	if err != nil {
		log.Printf("[feishu] post proposal %s in the direct chat: %v", proposal.ID, err)
		return
	}
	m.rememberProposalCard(proposal.ID, proposalCard{clientID: app.clientID, chatID: chatID, cardMessageID: cardMessageID})
}

func (m *WSManager) rememberProposalCard(proposalID string, card proposalCard) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.proposalCards[proposalID] = card
}

// PersonalAgentProposalChanged shows on a proposal's card what became of
// it, however it was answered (the web, a button, a word) or expired.
func (m *WSManager) PersonalAgentProposalChanged(proposal store.PersonalAgentProposal) {
	if proposal.Status == "" || proposal.Status == store.PersonalAgentProposalPending {
		return
	}
	card, ok := m.proposalCard(proposal.ID)
	if !ok {
		return
	}
	if proposal.Status != store.PersonalAgentProposalAccepted {
		m.mu.Lock()
		delete(m.proposalCards, proposal.ID)
		m.mu.Unlock()
	}
	app := m.app(card.clientID)
	if app == nil {
		return
	}
	go func() {
		ctx := context.Background()
		if err := app.client.PatchCard(ctx, card.cardMessageID, BuildProposalCard(proposal, m.proposalLanguage(ctx, proposal.UserID))); err != nil {
			log.Printf("[feishu] update the card of proposal %s: %v", proposal.ID, err)
		}
	}()
}

// assistantDirectChat is a running app and direct chat of the person's
// that their assistant takes; nil when there is none.
func (m *WSManager) assistantDirectChat(ctx context.Context, userID string) (*botApp, string) {
	accounts, ok := m.accounts()
	if userID == "" || !ok {
		return nil, ""
	}
	routes, err := m.store.ListFeishuBotRoutes(ctx, store.FeishuBotRouteFilter{})
	if err != nil {
		log.Printf("[feishu] read the routes: %v", err)
		return nil, ""
	}
	for _, route := range routes {
		if route.Kind != store.FeishuRouteP2P || route.BoundUserID != userID {
			continue
		}
		providerApp, err := accounts.GetExternalProviderApp(ctx, route.AppID)
		if err != nil {
			continue
		}
		app := m.app(providerApp.ClientID)
		if app == nil || m.assistantFor(ctx, route) == nil {
			continue
		}
		return app, route.ChatID
	}
	return nil, ""
}

// tellAssistantTurn posts the answer of an assistant turn that Feishu did
// not start in the conversation's topic.
func (m *WSManager) tellAssistantTurn(ctx context.Context, topic assistantTopic, session store.AgentSession) {
	if session.Status != "completed" || strings.TrimSpace(session.Response) == "" {
		return
	}
	app := m.app(topic.clientID)
	if app == nil {
		return
	}
	m.replyCard(ctx, app.client, topic.rootMessageID, BuildAssistantCard(topic.title, session.Response, "turquoise"))
}

// handleCardAction takes a press of an assistant button: only in the
// direct chat the assistant takes, only by the person it is paired with.
func (m *WSManager) handleCardAction(ctx context.Context, event feishuevents.Event) {
	app := m.app(event.AppID)
	if app == nil || m.PersonalAgents == nil {
		return
	}
	var trigger larkcallback.CardActionTriggerEvent
	if err := json.Unmarshal(event.Payload, &trigger); err != nil {
		log.Printf("[feishu] unreadable card action %s: %v", event.ID, err)
		return
	}
	data := trigger.Event
	if data == nil || data.Action == nil || data.Operator == nil || data.Context == nil {
		return
	}
	if marker, _ := data.Action.Value["foundry"].(string); marker != cardActionMarker {
		return
	}
	op, _ := data.Action.Value["op"].(string)
	proposalID, _ := data.Action.Value["proposalId"].(string)
	chatID, cardMessageID := data.Context.OpenChatID, data.Context.OpenMessageID
	chat, err := m.chatRoute(ctx, app, chatID)
	if err != nil || chat.assistant == nil {
		log.Printf("[feishu] card action %s refused: chat %s is not a direct chat the assistant takes", event.ID, chatID)
		return
	}
	if chat.stored.PeerOpenID == "" || data.Operator.OpenID != chat.stored.PeerOpenID {
		log.Printf("[feishu] card action %s refused: pressed by someone other than the paired person", event.ID)
		return
	}
	if _, refusal := m.boundUser(ctx, chat.FeishuBotRoute); refusal != "" {
		log.Printf("[feishu] card action %s refused: %s", event.ID, refusal)
		return
	}
	userID := chat.assistant.userID
	language := m.PersonalAgents.Language(ctx, userID, "")
	switch op {
	case cardActionAccept, cardActionDecline:
		if proposalID == "" {
			return
		}
		m.decideProposal(ctx, app.client, userID, proposalID, op == cardActionAccept, store.PersonalAgentViaFeishu, "", cardMessageID, language)
	case cardActionResume:
		card := BuildAssistantCard(assistantText(language, "runningTitle"), assistantText(language, "running"), "grey")
		if chat.assistant.route.Stopped {
			card = m.resumeAssistant(ctx, userID, language)
		}
		if err := app.client.PatchCard(ctx, cardMessageID, card); err != nil {
			log.Printf("[feishu] update the stop card: %v", err)
		}
	}
}

// BuildAssistantCard is a card the assistant's chat gets from the server.
func BuildAssistantCard(title, markdownContent, template string) string {
	return buildAssistantCard(title, markdownContent, template, nil)
}

// BuildAssistantStoppedCard answers the stop switch, with a button that
// resumes, in language ("zh" or "en").
func BuildAssistantStoppedCard(title, markdownContent, language string) string {
	return buildAssistantCard(title, markdownContent, "grey", []CardElement{
		cardButtons(cardButton(assistantText(language, "resumeButton"), "primary_filled", map[string]string{"op": cardActionResume})),
	})
}

// BuildProposalCard shows a proposal in language ("zh" or "en"): while
// pending, what the assistant wants to do with buttons to accept or
// decline; after, what became of it.
func BuildProposalCard(proposal store.PersonalAgentProposal, language string) string {
	say := func(key string) string { return assistantText(language, key) }
	summary := proposal.Summary
	if strings.TrimSpace(summary) == "" {
		summary = say("proposalFallback")
	}
	switch proposal.Status {
	case "", store.PersonalAgentProposalPending:
		return buildAssistantCard(say("pendingTitle"), summary+"\n\n<font color='grey'>"+say("pendingHint")+"</font>", "orange", []CardElement{
			cardButtons(
				cardButton(say("acceptButton"), "primary_filled", map[string]string{"op": cardActionAccept, "proposalId": proposal.ID}),
				cardButton(say("declineButton"), "default", map[string]string{"op": cardActionDecline, "proposalId": proposal.ID}),
			),
		})
	case store.PersonalAgentProposalAccepted:
		return BuildAssistantCard(say("acceptedTitle"), summary+"\n\n"+say("accepted"), "green")
	case store.PersonalAgentProposalApplied:
		return BuildAssistantCard(say("appliedTitle"), summary, "green")
	case store.PersonalAgentProposalDeclined:
		return BuildAssistantCard(say("declinedTitle"), summary+"\n\n"+say("declined"), "grey")
	case store.PersonalAgentProposalExpired:
		return BuildAssistantCard(say("expiredTitle"), summary+"\n\n"+say("expired"), "grey")
	default:
		body := summary + "\n\n" + say("failed")
		if proposal.Error != "" {
			body += say("errorSep") + proposal.Error
		}
		return BuildAssistantCard(say("failedTitle"), body+say("end"), "red")
	}
}

func buildAssistantCard(title, markdownContent, template string, extra []CardElement) string {
	elements := []CardElement{MarkdownElement{Tag: "markdown", Content: NormalizeFeishuMarkdown(truncateRunes(markdownContent, 3000))}}
	card := FeishuCard{
		Schema: "2.0",
		Config: CardConfig{WideScreenMode: true, UpdateMulti: true},
		Header: CardHeader{Title: CardTitle{Tag: "plain_text", Content: title}, Template: template},
		Body:   CardBody{Elements: append(elements, extra...)},
	}
	data, _ := json.Marshal(card)
	return string(data)
}

// cardButton is a Card JSON 2.0 button whose press calls back with value
// and the assistant's marker.
func cardButton(text, kind string, value map[string]string) CardElement {
	callback := map[string]string{"foundry": cardActionMarker}
	for key, item := range value {
		callback[key] = item
	}
	return map[string]any{
		"tag":       "button",
		"text":      map[string]string{"tag": "plain_text", "content": text},
		"type":      kind,
		"behaviors": []map[string]any{{"type": "callback", "value": callback}},
	}
}

// cardButtons lays buttons out in one row.
func cardButtons(buttons ...CardElement) CardElement {
	columns := make([]map[string]any, 0, len(buttons))
	for _, button := range buttons {
		columns = append(columns, map[string]any{"tag": "column", "width": "auto", "elements": []CardElement{button}})
	}
	return map[string]any{"tag": "column_set", "flex_mode": "none", "horizontal_spacing": "8px", "columns": columns}
}
