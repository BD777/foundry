package feishu

import (
	"context"
	"errors"
	"log"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// NoticeSinkID names the built-in Foundry bot as a notice sink (DEV-300): the
// person's notices arrive as cards in their paired direct chat with the bot.
// Settings name it where a connector instance would go.
const NoticeSinkID = "builtin:feishu"

// cardActionNotice is the callback value of a notice card's presses.
const cardActionNotice = "notice_answer"

// noticeAnswerTimeout bounds one press's settlement, which runs after Feishu
// has been answered: the card callback has three seconds.
const noticeAnswerTimeout = 30 * time.Second

// NoticeDesk is Foundry's side of the notice cards: the facts a card shows and
// the settlement of a press. The card is built here; the answer is recorded
// where the items are.
type NoticeDesk interface {
	// NoticeFacts reads what the card shows about the notice's item.
	NoticeFacts(ctx context.Context, notice store.PersonNotice) (NoticeFacts, error)
	// AnswerNotice settles the notice with the press, through the same path as
	// a reply in the notice's chat, and returns the notice as it now is.
	AnswerNotice(ctx context.Context, press NoticePress) (NoticeAnswer, error)
}

// NoticePress is a press on a notice card: an option by its index, or the text
// typed into the card's note box.
type NoticePress struct {
	UserID      string
	AssistantID string
	NoticeID    string
	// CardMessageID is the card the press came from; a notice answers only
	// presses on the card it was sent as.
	CardMessageID string
	// Option is the index of the option pressed; empty for typed text.
	Option string
	Text   string
	// PressID is the callback's event, which keeps a note from being recorded twice.
	PressID string
}

// NoticeAnswer is the notice after a press and how the press went.
type NoticeAnswer struct {
	Notice  store.PersonNotice
	Outcome NoticeOutcome
}

// NoticeOutcome says what became of a press.
type NoticeOutcome string

const (
	// NoticeAnswered: the notice is answered, by this press or an earlier one.
	NoticeAnswered NoticeOutcome = "answered"
	// NoticeNoted: the text is more information on an approval; it is not a
	// decision, and the notice stays open.
	NoticeNoted NoticeOutcome = "noted"
	// NoticeUnsettled: the press was not recorded; the notice stays open.
	NoticeUnsettled NoticeOutcome = "unsettled"
)

// SendNotice posts the notice's card in the assistant's direct chat with the
// bot and returns the card's message id. With no direct chat yet, the bot writes
// to the person by their open_id first (noticeByOpenID). No running bot with
// that chat is an error: the chat may come back, and the caller decides how to
// retry.
func (m *WSManager) SendNotice(ctx context.Context, notice store.PersonNotice) (string, error) {
	card := m.noticeCard(ctx, notice, NoticeView{})
	if len(m.pairedDirectChats(ctx, notice.UserID, notice.AssistantID)) == 0 {
		return m.noticeByOpenID(ctx, notice, card)
	}
	app, chatID := m.assistantDirectChat(ctx, notice.UserID, notice.AssistantID)
	if app == nil {
		return "", errors.New("no direct chat with the Foundry bot is running for the assistant")
	}
	return app.client.SendCard(ctx, chatID, card)
}

// RefreshNotice shows the notice's state on the card it was sent as.
func (m *WSManager) RefreshNotice(ctx context.Context, notice store.PersonNotice) error {
	app, _ := m.assistantDirectChat(ctx, notice.UserID, notice.AssistantID)
	if app == nil {
		return errors.New("no direct chat with the Foundry bot is running for the assistant")
	}
	return app.client.PatchCard(ctx, notice.ProviderMessageID, m.noticeCard(ctx, notice, NoticeView{}))
}

// noticeCard is the card of a notice in its own state, in the person's language.
func (m *WSManager) noticeCard(ctx context.Context, notice store.PersonNotice, view NoticeView) string {
	return BuildNoticeCard(notice, m.noticeFactsOf(ctx, notice), view, m.proposalLanguage(ctx, notice.AssistantID, notice.UserID))
}

// noticeFactsOf reads what a card shows. A notice whose facts cannot be read
// still gets its card, with the notice's own words only.
func (m *WSManager) noticeFactsOf(ctx context.Context, notice store.PersonNotice) NoticeFacts {
	if m.Notices == nil {
		return NoticeFacts{}
	}
	facts, err := m.Notices.NoticeFacts(ctx, notice)
	if err != nil {
		log.Printf("[feishu] read the facts of notice %s: %v", notice.ID, err)
		return NoticeFacts{}
	}
	return facts
}

// Why a person cannot take an assistant's notices from the bot (NoticeChatReason).
const (
	NoticeReasonNotPaired    = "feishu_not_paired"
	NoticeReasonNotReachable = "feishu_not_reachable"
)

// ErrUserNotReachable is a notice Feishu will not deliver to the person: they
// are outside the app's availability range, which retrying cannot change.
var ErrUserNotReachable = errors.New(NoticeReasonNotReachable)

// HasNoticeChat reports whether a notice for the assistant can be queued for the
// person: NoticeChatReason is not NoticeReasonNotPaired. The app need not be
// running now: a notice that finds the bot restarting is sent once it is back,
// and skipping it here would drop the notice.
func (m *WSManager) HasNoticeChat(ctx context.Context, userID, assistantID string) bool {
	return m.NoticeChatReason(ctx, userID, assistantID) != NoticeReasonNotPaired
}

// NoticeChatReason says why the person cannot take the assistant's notices from
// the bot yet, "" when they can. A direct chat with the bot carries them. Without
// one, the bot writes to the person by their open_id, which a route bound to
// them records (the pairing sender of a group, or the other person of a direct
// chat). NoticeReasonNotReachable means every such open_id was refused by Feishu.
func (m *WSManager) NoticeChatReason(ctx context.Context, userID, assistantID string) string {
	if len(m.pairedDirectChats(ctx, userID, assistantID)) > 0 {
		return ""
	}
	targets := m.openIDTargets(ctx, userID, assistantID)
	if len(targets) == 0 {
		return NoticeReasonNotPaired
	}
	for _, target := range targets {
		if target.route.OpenIDError == "" {
			return ""
		}
	}
	return NoticeReasonNotReachable
}

// openIDTarget is a route carrying the person's open_id on an app whose
// assistant takes direct chats: where the bot writes to them, and the assistant's
// home workspace the chat it opens routes to.
type openIDTarget struct {
	route         store.FeishuBotRoute
	clientID      string
	openID        string
	homeWorkspace string
}

// openIDTargets lists the routes that carry the person's open_id for the
// assistant: bound to them, with PeerOpenID recorded and resolved to the
// assistant.
func (m *WSManager) openIDTargets(ctx context.Context, userID, assistantID string) []openIDTarget {
	if userID == "" || assistantID == "" {
		return nil
	}
	routes, err := m.store.ListFeishuBotRoutes(ctx, store.FeishuBotRouteFilter{})
	if err != nil {
		log.Printf("[feishu] read the routes: %v", err)
		return nil
	}
	var targets []openIDTarget
	for _, route := range routes {
		if route.Kind == store.FeishuRoutePairing || route.BoundUserID != userID || route.PeerOpenID == "" {
			continue
		}
		providerApp, err := m.store.GetExternalProviderApp(ctx, route.AppID)
		if err != nil {
			continue
		}
		assistant := m.routeAssistant(ctx, route)
		if assistant == nil || !assistant.route.TakesDirectChats || assistant.route.AssistantID != assistantID {
			continue
		}
		targets = append(targets, openIDTarget{
			route: route, clientID: providerApp.ClientID, openID: route.PeerOpenID, homeWorkspace: assistant.route.WorkspaceID,
		})
	}
	return targets
}

// noticeByOpenID sends the notice to the person by open_id, on a running app
// they have an identity on. Feishu opens the direct chat, and the chat is
// recorded as their route, so later notices and card updates use it as any
// paired chat. A person outside the app's availability range is
// ErrUserNotReachable, and the route keeps the refusal for the settings.
func (m *WSManager) noticeByOpenID(ctx context.Context, notice store.PersonNotice, card string) (string, error) {
	targets := m.openIDTargets(ctx, notice.UserID, notice.AssistantID)
	if len(targets) == 0 {
		return "", errors.New("the person has no Feishu identity for the Foundry bot yet")
	}
	refused := false
	for _, target := range targets {
		app := m.app(target.clientID)
		if app == nil {
			continue
		}
		messageID, chatID, err := app.client.SendCardToOpenID(ctx, target.openID, card)
		if errors.Is(err, ErrUserNotReachable) {
			refused = true
			if setErr := m.store.SetFeishuOpenIDError(ctx, target.route.ID, NoticeReasonNotReachable); setErr != nil {
				log.Printf("[feishu] record why route %s cannot reach the person: %v", target.route.ID, setErr)
			}
			continue
		}
		if err != nil {
			return "", err
		}
		m.routeOpenIDChat(ctx, target, chatID, notice.UserID)
		return messageID, nil
	}
	if refused {
		return "", ErrUserNotReachable
	}
	return "", errors.New("no Feishu app carrying the person's identity is running")
}

// routeOpenIDChat routes the direct chat Feishu opened for the target's person to
// the assistant's home, and clears a refusal the route kept before.
func (m *WSManager) routeOpenIDChat(ctx context.Context, target openIDTarget, chatID, userID string) {
	chat := store.FeishuBotRoute{ChatID: chatID, BoundUserID: userID, PeerOpenID: target.openID}
	if _, err := m.store.BindFeishuDirectChat(ctx, target.route.AppID, target.homeWorkspace, chat); err != nil {
		log.Printf("[feishu] route the direct chat %s opened by open_id: %v", chatID, err)
		return
	}
	if target.route.OpenIDError != "" {
		if err := m.store.SetFeishuOpenIDError(ctx, target.route.ID, ""); err != nil {
			log.Printf("[feishu] clear the open_id refusal of route %s: %v", target.route.ID, err)
		}
	}
}

// settleNoticeCard records a press on a notice card and shows the result on the
// card. The press is refused unless the person it is paired with pressed it,
// which handleCardAction checked already. An empty note box does nothing.
func (m *WSManager) settleNoticeCard(ctx context.Context, client botClient, press NoticePress, language string) error {
	if m.Notices == nil {
		return errors.New("notices are not connected")
	}
	if press.Option == "" && strings.TrimSpace(press.Text) == "" {
		return nil
	}
	answer, err := m.Notices.AnswerNotice(ctx, press)
	if err != nil {
		return err
	}
	var view NoticeView
	switch answer.Outcome {
	case NoticeNoted:
		view.Note = strings.TrimSpace(press.Text)
	case NoticeUnsettled:
		view.Unsettled = true
	}
	card := BuildNoticeCard(answer.Notice, m.noticeFactsOf(ctx, answer.Notice), view, language)
	return client.PatchCard(ctx, press.CardMessageID, card)
}

// settleNoticeCardInBackground settles a press after Feishu has been answered,
// so the callback is not held for the settlement.
func (m *WSManager) settleNoticeCardInBackground(client botClient, press NoticePress, language string) {
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), noticeAnswerTimeout)
		defer cancel()
		if err := m.settleNoticeCard(ctx, client, press, language); err != nil {
			log.Printf("[feishu] settle notice %s from card %s: %v", press.NoticeID, press.CardMessageID, err)
		}
	}()
}
