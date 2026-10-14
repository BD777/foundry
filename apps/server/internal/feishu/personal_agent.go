package feishu

import (
	"context"
	"log"
	"strings"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// The person's assistant in their Feishu direct chat (docs/personal-agent.md
// §4, §8, §10, §14).
//
// A direct chat's stored route is never rewritten. While the person's
// assistant takes their direct chats, the chat goes to the assistant's
// workspace; when they turn that off it goes where its route always pointed,
// which is also the prior the assistant routes by (§14). Groups never reach
// the assistant.
//
// Before a message of the assistant's chat reaches the model, its fixed
// words (PersonalAgentDesk.Word) stop or resume the assistant and answer
// its pending proposal, and only when the paired person sends them. Proposal cards
// carry buttons whose callbacks do the same for the paired person only
// (personal_agent_cards.go).

// PersonalAgentDesk is the person's assistant as their direct chat reaches
// it. userID is always the account the chat is bound to; the desk checks
// that what it is asked about (a proposal) is that person's.
type PersonalAgentDesk interface {
	// Word is which of the assistant's fixed words text is, the whole
	// message trimmed and case-folded (personalagent.StopWords, ResumeWords,
	// AcceptWords, DeclineWords): a PersonalAgentWord, or "" for any other
	// text.
	Word(text string) string
	// Route is the person's assistant as their direct chat on Connectors app
	// appID (xapp_…) sees it; ok is false when they have none.
	// routeWorkspaceID is where the chat's own route points: when it is not
	// the assistant's workspace, the strong prior for routing (§14).
	Route(ctx context.Context, userID, appID, routeWorkspaceID string) (route PersonalAgentRoute, ok bool, err error)
	// ClaimIntroduction records that the person's direct chat on appID is
	// being told the assistant took it over (PersonalAgentRoute.Introduce);
	// false when it already was, and nothing more is said.
	ClaimIntroduction(ctx context.Context, userID, appID string) bool
	// Language is the language to answer the person in, "zh" or "en": the
	// one they chose for their assistant or account, else the one message
	// is written in ("" for none), else Chinese.
	Language(ctx context.Context, userID, message string) string
	// Stop is the stop switch (§8): stopped, every session the assistant
	// runs or started cancelled, pending proposals void.
	Stop(ctx context.Context, userID, via string) (PersonalAgentStopped, error)
	// Resume turns the assistant back on; nothing the stop cancelled
	// restarts.
	Resume(ctx context.Context, userID, via string) (PersonalAgentResumed, error)
	// PendingProposals are the person's proposals waiting for an answer.
	PendingProposals(ctx context.Context, userID string) ([]store.PersonalAgentProposal, error)
	// Accept and Decline answer the person's proposal and return it as it
	// is now; an error when it is not theirs or no longer pending. Via is
	// store.PersonalAgentViaFeishu (a card button) or ViaReply (a fixed word).
	Accept(ctx context.Context, userID, proposalID, via string) (store.PersonalAgentProposal, error)
	Decline(ctx context.Context, userID, proposalID, via string) (store.PersonalAgentProposal, error)
}

// The fixed words' meanings (PersonalAgentDesk.Word).
const (
	PersonalAgentWordStop    = "stop"
	PersonalAgentWordResume  = "resume"
	PersonalAgentWordAccept  = "accept"
	PersonalAgentWordDecline = "decline"
)

// PersonalAgentRoute is what a direct chat needs to know of the person's
// assistant.
type PersonalAgentRoute struct {
	// WorkspaceID is the person's Personal Agent Workspace.
	WorkspaceID string
	// TakesDirectChats: the person's direct chats on this app go to the
	// assistant (settings feishuDirectChat and feishuAppId). A chat paired
	// with the assistant's workspace itself goes there regardless.
	TakesDirectChats bool
	// Stopped: the stop switch is on; only resuming gets through.
	Stopped bool
	// HomeOffline: the assistant's computer is offline; new messages get a
	// fixed answer and SettingsURL, where another one can be chosen.
	HomeOffline bool
	SettingsURL string
	// Introduce: the chat has not been told yet that the assistant took it
	// over; the channel claims the telling (ClaimIntroduction) before it
	// says so.
	Introduce bool
}

// PersonalAgentStopped is what the stop switch did.
type PersonalAgentStopped struct {
	// Cancelled counts the things it stopped that were running.
	Cancelled int
}

// PersonalAgentResumed is what resuming found.
type PersonalAgentResumed struct {
	// Stopped are the titles of what the last stop cancelled, for the
	// person to pick up again.
	Stopped []string
}

// assistantChat is a direct chat the person's assistant takes.
type assistantChat struct {
	userID string
	route  PersonalAgentRoute
	// previousWorkspaceID is where the chat's own route points, when that
	// is not the assistant's workspace.
	previousWorkspaceID string
}

// chatRoute is where a chat's messages go: its stored route, with the
// assistant's workspace in place of the route's own while the assistant
// takes the chat.
type chatRoute struct {
	store.FeishuBotRoute
	stored    store.FeishuBotRoute
	assistant *assistantChat
}

func (m *WSManager) chatRoute(ctx context.Context, app *botApp, chatID string) (chatRoute, error) {
	stored, err := m.store.FindFeishuChatRoute(ctx, app.clientID, chatID)
	if err != nil {
		return chatRoute{}, err
	}
	chat := chatRoute{FeishuBotRoute: stored, stored: stored, assistant: m.assistantFor(ctx, stored)}
	if chat.assistant != nil {
		chat.WorkspaceID = chat.assistant.route.WorkspaceID
	}
	return chat, nil
}

// assistantFor is the person's assistant when it takes the direct chat;
// nil for groups, and for a direct chat it does not take.
func (m *WSManager) assistantFor(ctx context.Context, route store.FeishuBotRoute) *assistantChat {
	desk := m.PersonalAgents
	if desk == nil || route.Kind != store.FeishuRouteP2P || route.BoundUserID == "" {
		return nil
	}
	assistant, ok, err := desk.Route(ctx, route.BoundUserID, route.AppID, route.WorkspaceID)
	if err != nil {
		log.Printf("[feishu] read the assistant of direct chat %s: %v; the chat keeps its own route", route.ChatID, err)
		return nil
	}
	if !ok || assistant.WorkspaceID == "" {
		return nil
	}
	chat := &assistantChat{userID: route.BoundUserID, route: assistant}
	if route.WorkspaceID != assistant.WorkspaceID {
		if !assistant.TakesDirectChats {
			return nil
		}
		chat.previousWorkspaceID = route.WorkspaceID
	}
	return chat
}

// pairedSender reports whether sender is the person the direct chat is
// paired with. A chat paired before Foundry recorded the peer takes its
// first sender as the peer (notePeer); a direct chat has no other.
func pairedSender(route store.FeishuBotRoute, sender string) bool {
	return sender != "" && (route.PeerOpenID == "" || route.PeerOpenID == sender)
}

// handleAssistantWords is what the server answers in the assistant's chat
// before the model: the stop switch, resuming, a yes or no to the pending
// proposal, and fixed answers while the assistant is stopped or its
// computer offline. It reports whether the message was handled; when not,
// it goes to the assistant. threadSessionID is the session of the topic the
// message replies in, "" at the chat's top level.
func (m *WSManager) handleAssistantWords(ctx context.Context, app *botApp, chat chatRoute, messageID, threadSessionID, sender, text string) bool {
	assistant := chat.assistant
	if _, refusal := m.boundUser(ctx, chat.FeishuBotRoute); refusal != "" {
		return false
	}
	word := ""
	if pairedSender(chat.stored, sender) {
		word = m.PersonalAgents.Word(text)
	}
	language := m.PersonalAgents.Language(ctx, assistant.userID, text)
	switch {
	case word == PersonalAgentWordStop:
		m.stopAssistant(ctx, app.client, messageID, assistant.userID, language)
		return true
	case assistant.route.Stopped:
		if word == PersonalAgentWordResume {
			card := m.resumeAssistant(ctx, assistant.userID, language)
			m.replyCard(ctx, app.client, messageID, card)
			return true
		}
		m.replyCard(ctx, app.client, messageID, BuildAssistantStoppedCard(assistantText(language, "stoppedTitle"), assistantText(language, "stopped"), language))
		return true
	case word == PersonalAgentWordAccept || word == PersonalAgentWordDecline:
		if m.answerProposalByWord(ctx, app.client, chat, messageID, threadSessionID, word == PersonalAgentWordAccept, language) {
			return true
		}
	}
	if assistant.route.HomeOffline {
		body := assistantText(language, "offline")
		if assistant.route.SettingsURL != "" {
			body += assistantText(language, "offlineMove", assistant.route.SettingsURL)
		}
		m.replyCard(ctx, app.client, messageID, BuildAssistantCard(assistantText(language, "offlineTitle"), body, "grey"))
		return true
	}
	if assistant.route.Introduce && assistant.previousWorkspaceID != "" && m.PersonalAgents.ClaimIntroduction(ctx, assistant.userID, chat.stored.AppID) {
		m.replyCard(ctx, app.client, messageID, BuildAssistantCard(assistantText(language, "introTitle"), m.introduction(ctx, assistant.previousWorkspaceID, language), "blue"))
	}
	return false
}

// introduction is the one-time note of a direct chat the assistant took
// over from a project (§14).
func (m *WSManager) introduction(ctx context.Context, previousWorkspaceID, language string) string {
	name := assistantText(language, "introNoProject")
	if workspace, err := m.store.GetWorkspace(ctx, previousWorkspaceID); err == nil && workspace.Name != "" {
		name = assistantText(language, "introProject", workspace.Name)
	}
	return assistantText(language, "intro", name)
}

func (m *WSManager) replyCard(ctx context.Context, client botClient, messageID, card string) {
	if _, err := client.ReplyCard(ctx, messageID, card); err != nil {
		log.Printf("[feishu] failed to reply card: %v", err)
	}
}

// stopAssistant presses the stop switch and says so in the server's words.
func (m *WSManager) stopAssistant(ctx context.Context, client botClient, messageID, userID, language string) {
	stopped, err := m.PersonalAgents.Stop(ctx, userID, store.PersonalAgentViaFeishu)
	if err != nil {
		log.Printf("[feishu] stop the assistant of %s: %v", userID, err)
		m.replyCard(ctx, client, messageID, BuildAssistantCard(assistantText(language, "stopFailedTitle"), assistantText(language, "stopFailed", err.Error()), "red"))
		return
	}
	m.replyCard(ctx, client, messageID, BuildAssistantStoppedCard(assistantText(language, "stoppedAllTitle"), stoppedText(language, stopped.Cancelled), language))
}

func stoppedText(language string, cancelled int) string {
	if cancelled == 0 {
		return assistantText(language, "stoppedNone")
	}
	return assistantText(language, "stoppedSome", cancelled)
}

// resumeAssistant turns the assistant back on; the card it answers lists
// what the stop cancelled, which does not restart by itself.
func (m *WSManager) resumeAssistant(ctx context.Context, userID, language string) string {
	resumed, err := m.PersonalAgents.Resume(ctx, userID, store.PersonalAgentViaFeishu)
	if err != nil {
		log.Printf("[feishu] resume the assistant of %s: %v", userID, err)
		return BuildAssistantCard(assistantText(language, "resumeFailedTitle"), assistantText(language, "resumeFailed", err.Error()), "red")
	}
	title := assistantText(language, "resumedTitle")
	if len(resumed.Stopped) == 0 {
		return BuildAssistantCard(title, assistantText(language, "resumed"), "green")
	}
	var body strings.Builder
	body.WriteString(assistantText(language, "resumedList"))
	for _, stopped := range resumed.Stopped {
		body.WriteString("\n- " + stopped)
	}
	body.WriteString(assistantText(language, "resumedPick"))
	return BuildAssistantCard(title, body.String(), "green")
}

// answerProposalByWord answers the pending proposal of this conversation
// with a fixed yes or no: in a topic, the proposal its session made; at the
// chat's top level, the proposal whose card is in the chat. With none it
// reports false and the words go to the assistant; with several it asks
// for the buttons.
func (m *WSManager) answerProposalByWord(ctx context.Context, client botClient, chat chatRoute, messageID, threadSessionID string, accept bool, language string) bool {
	userID := chat.assistant.userID
	pending, err := m.PersonalAgents.PendingProposals(ctx, userID)
	if err != nil {
		log.Printf("[feishu] read the pending proposals of %s: %v", userID, err)
		return false
	}
	var matches []store.PersonalAgentProposal
	for _, proposal := range pending {
		if proposal.Status != "" && proposal.Status != store.PersonalAgentProposalPending {
			continue
		}
		if threadSessionID != "" {
			if proposal.SessionID == threadSessionID {
				matches = append(matches, proposal)
			}
			continue
		}
		if card, ok := m.proposalCard(proposal.ID); ok && card.chatID == chat.ChatID {
			matches = append(matches, proposal)
		}
	}
	switch len(matches) {
	case 0:
		return false
	case 1:
		m.decideProposal(ctx, client, userID, matches[0].ID, accept, store.PersonalAgentViaReply, messageID, "", language)
	default:
		m.replyCard(ctx, client, messageID, BuildAssistantCard(assistantText(language, "severalTitle"), assistantText(language, "several", len(matches)), "orange"))
	}
	return true
}

// decideProposal answers the proposal and shows the answer on its card:
// cardMessageID when the card's own button was pressed, else the card
// posted for it, else a reply to messageID. language is the failure's; the
// card is in the proposal's own (proposalLanguage).
func (m *WSManager) decideProposal(ctx context.Context, client botClient, userID, proposalID string, accept bool, via, messageID, cardMessageID, language string) {
	desk := m.PersonalAgents
	var (
		decided store.PersonalAgentProposal
		err     error
	)
	if accept {
		decided, err = desk.Accept(ctx, userID, proposalID, via)
	} else {
		decided, err = desk.Decline(ctx, userID, proposalID, via)
	}
	if err != nil {
		log.Printf("[feishu] answer proposal %s of %s: %v", proposalID, userID, err)
		failure := BuildAssistantCard(assistantText(language, "decideFailedTitle"), assistantText(language, "decideFailed", err.Error()), "red")
		if messageID != "" {
			m.replyCard(ctx, client, messageID, failure)
		} else if cardMessageID != "" {
			_ = client.PatchCard(ctx, cardMessageID, failure)
		}
		return
	}
	if decided.ID == "" {
		decided.ID = proposalID
	}
	if cardMessageID == "" {
		if card, ok := m.proposalCard(proposalID); ok {
			cardMessageID = card.cardMessageID
		}
	}
	card := BuildProposalCard(decided, m.proposalLanguage(ctx, userID))
	if cardMessageID != "" {
		if err := client.PatchCard(ctx, cardMessageID, card); err != nil {
			log.Printf("[feishu] update the card of proposal %s: %v", proposalID, err)
		}
		return
	}
	m.replyCard(ctx, client, messageID, card)
}
