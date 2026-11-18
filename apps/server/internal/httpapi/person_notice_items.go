package httpapi

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/foundry-dev/foundry/apps/server/internal/feishu"
	"github.com/foundry-dev/foundry/apps/server/internal/personnotice"
	"github.com/foundry-dev/foundry/apps/server/internal/sessions"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// A pending item that waits for the person is also a notice to them through
// the sinks the assistant's settings name (DEV-294, slice 4). The notice is
// how the person hears of it; the item stays the record. An item earns a
// notice only when the person can answer it from the notice: a question in a
// conversation, the assistant's own question, or a connector write to allow
// or refuse. Other items (failures, reminders, account sign-ins) stay on the
// Web page.

// approvalNoticeOptions are the choices an approval notice offers, by index:
// index 0 approves and index 1 refuses. The reply aliases are in personnotice.
var approvalNoticeOptions = []string{"同意", "拒绝"}

// personNoticeKind is the notice kind an item earns, the kind the settings
// name ("question", "approval", "hand_over", "ask"); false when it earns none.
func personNoticeKind(item store.PendingItem) (string, bool) {
	switch {
	case item.Source == store.PendingSourceAssistantQuestion:
		return "ask", true
	case item.Source == store.PendingSourceConnectorWrite && item.ConnectorWrite != nil:
	case item.Source == store.PendingSourceQuestion && item.MessageID != "" && item.Title != "":
	default:
		return "", false
	}
	if item.HandedAt != "" {
		return "hand_over", true
	}
	if itemIsApproval(item) {
		return "approval", true
	}
	return "question", true
}

// itemIsApproval reports whether the person's answer decides the item only
// as an approve or a refusal: a connector write, or a question that asks for
// approval. Anything else the person writes about it is more information.
func itemIsApproval(item store.PendingItem) bool {
	return item.Source == store.PendingSourceConnectorWrite || item.Approval
}

// noticeWords is what a notice says of its item: the question, the note the
// assistant gave with a hand-over, or the summary of a connector write.
func noticeWords(item store.PendingItem, kind string) (title, text string) {
	title, text = item.Title, item.Excerpt
	if kind == "hand_over" && strings.TrimSpace(item.Note) != "" {
		text = item.Note
	}
	if item.ConnectorWrite != nil {
		title = "需要你批准一次写入：" + item.Title
		text = strings.TrimSpace(item.ConnectorWrite.Operation + "\n\n" + item.Excerpt)
	}
	return title, text
}

// recordPendingItem is the store's RecordPendingItem, and it notifies the
// person when the item opens for them. Items that earn no notice are ignored
// by the notice check, so every site that records an item may use it.
func (s *Server) recordPendingItem(ctx context.Context, item store.PendingItem) (store.PendingItem, bool, error) {
	stored, changed, err := s.store.RecordPendingItem(ctx, item)
	if err == nil && changed {
		s.noticeAboutItem(ctx, stored)
	}
	return stored, changed, err
}

// handPendingItem is the store's HandPendingItem; a hand-over to the person
// notifies them of the item.
func (s *Server) handPendingItem(ctx context.Context, userID, id, handler, note, reason, outcome, inputID string) (store.PendingItem, error) {
	item, err := s.store.HandPendingItem(ctx, userID, id, handler, note, reason, outcome, inputID)
	if err == nil && handler == store.PendingHandlerPerson {
		s.noticeAboutItem(ctx, item)
	}
	return item, err
}

// noticeAboutItem queues the person's notice about an item that now waits for
// them, through the first notice sink whose kinds include the item's kind. An
// item has at most one notice: once it has one, a notice that failed or was
// answered is not repeated, and a reopened item is a new item with its own.
func (s *Server) noticeAboutItem(ctx context.Context, item store.PendingItem) {
	s.queueItemNotice(ctx, item, s.noticeChatOf)
}

// noticeChatLookup reads the notice chat of a connector instance of a person.
type noticeChatLookup func(ctx context.Context, userID, instanceID string) (string, error)

// queueItemNotice is noticeAboutItem with the notice chat lookup given.
func (s *Server) queueItemNotice(ctx context.Context, item store.PendingItem, chatOf noticeChatLookup) {
	kind, ok := personNoticeKind(item)
	if !ok || item.State != store.PendingOpen || store.PendingHandledBy(item) != store.PendingHandlerPerson || item.AssistantID == "" {
		return
	}
	agent, err := s.store.GetAssistant(ctx, item.AssistantID)
	if err != nil || agent.UserID != item.UserID {
		return
	}
	sinks := agent.Settings.Notify.Sinks
	if len(sinks) == 0 {
		return
	}
	earlier, err := s.store.PersonNoticesOfItem(ctx, item.ID)
	if err != nil {
		log.Printf("person notices of item %s: %v", item.ID, err)
		return
	}
	if len(earlier) > 0 {
		return
	}
	origin := strings.TrimRight(strings.TrimSpace(s.options.AllowedOrigin), "/")
	if origin == "" {
		log.Printf("person notice for item %s: the server has no allowed origin, so the notice has no Web address", item.ID)
		return
	}
	title, text := noticeWords(item, kind)
	route := personnotice.Route{
		Kind: kind, AllowFreeText: true, Title: title, Text: text,
		Link: origin + "/pending?item=" + url.QueryEscape(item.ID),
	}
	if itemIsApproval(item) {
		route.Options = approvalNoticeOptions
	}
	for _, sink := range sinks {
		if !slices.Contains(sink.Kinds, kind) {
			continue
		}
		target, ok := s.noticeTargetOf(ctx, item, sink.ConnectorInstanceID, chatOf)
		if !ok {
			continue
		}
		route.SinkID, route.Target = noticeSinkID(sink.ConnectorInstanceID), target
		if _, _, err := s.personNotices.EnqueueNotice(ctx, item, route); err != nil {
			log.Printf("person notice for item %s: %v", item.ID, err)
		}
		return
	}
}

// noticeTargetOf is where a sink sends the notice: the chat of a connector
// instance, or nothing for the built-in bot, which posts to the person's direct
// chat when it sends. ok is false when the sink cannot carry the notice now.
func (s *Server) noticeTargetOf(ctx context.Context, item store.PendingItem, instanceID string, chatOf noticeChatLookup) (string, bool) {
	if instanceID == feishu.NoticeSinkID {
		if !s.feishu.HasNoticeChat(ctx, item.UserID, item.AssistantID) {
			log.Printf("person notice for item %s: the Foundry bot has no direct chat with the assistant", item.ID)
			return "", false
		}
		return "", true
	}
	chat, err := chatOf(ctx, item.UserID, instanceID)
	if err != nil {
		log.Printf("person notice for item %s: %v", item.ID, err)
		return "", false
	}
	if chat == "" {
		log.Printf("person notice for item %s: connector %s has no notice chat", item.ID, instanceID)
		return "", false
	}
	return chat, true
}

// noticeChatOf is the chat a connector instance sends the person's notices to:
// the descriptor's notify target field. Empty when the instance has none.
func (s *Server) noticeChatOf(ctx context.Context, userID, instanceID string) (string, error) {
	app, err := s.store.GetExternalProviderApp(ctx, instanceID)
	if err != nil {
		return "", fmt.Errorf("connector instance %s: %w", instanceID, err)
	}
	if app.OwnerUserID != userID || app.CreatedVia != "extension" {
		return "", nil
	}
	data, err := s.connectors.ServerHeld.ExtensionData(ctx, app)
	if err != nil {
		return "", fmt.Errorf("connector instance %s: %w", instanceID, err)
	}
	serverHeld := data.Descriptor.ServerHeld
	if serverHeld == nil || serverHeld.Notify == nil {
		return "", nil
	}
	return strings.TrimSpace(data.Values[serverHeld.Notify.Target.Field]), nil
}

// messageChannelNoticeReply settles the person's reply to a notice and reports
// whether it did (DEV-294). It settles only a reply that quotes a notice the
// channel's connector sent, from the person's own account, in the notice's
// chat, while the notice still waits for an answer. Anything else, and a reply
// that cannot be settled, is not consumed: it goes to the assistant's inbox as
// it did before.
func (s *Server) messageChannelNoticeReply(ctx context.Context, channel store.MessageChannelRecord, envelope store.MessageEnvelope) bool {
	if len(envelope.Attributes) == 0 {
		return false
	}
	account, err := s.messageChannelAccount(ctx, channel.UserID, channel.Source.AccountID)
	if err != nil {
		return false
	}
	_, data, err := s.messageChannelInstance(ctx, channel.UserID, account)
	if err != nil {
		return false
	}
	serverHeld := data.Descriptor.ServerHeld
	if serverHeld == nil || serverHeld.Notify == nil || serverHeld.Notify.ReplyTo == "" {
		return false
	}
	replyTo := envelope.Attributes[strings.TrimPrefix(serverHeld.Notify.ReplyTo, "attributes.")]
	if replyTo == "" {
		return false
	}
	notice, found, err := s.store.PersonNoticeByMessage(ctx, noticeSinkID(account.AppID), replyTo)
	if err != nil {
		log.Printf("person notice of reply %s: %v", envelope.MessageID, err)
		return false
	}
	if !found || !noticeAnswersFrom(notice, channel.UserID, envelope) {
		return false
	}
	if s.settleNoticeReply(ctx, notice, envelope.Text, envelope.MessageID) == noticeNotSettled {
		return false
	}
	if err := s.messageChannelAck(ctx, channel, true, []string{envelope.MessageID}); err != nil {
		log.Printf("acknowledge the reply to notice %s: %v", notice.ID, err)
	}
	return true
}

// noticeAnswersFrom reports whether a message is the person's own reply in the
// chat a notice was sent to. Another sender, another chat, or another person's
// notice is not an answer.
func noticeAnswersFrom(notice store.PersonNotice, userID string, envelope store.MessageEnvelope) bool {
	return notice.State == store.NoticeSent && notice.UserID == userID &&
		envelope.Sender.IsSelf && !envelope.Sender.IsOwnWrite &&
		envelope.Conversation.ID != "" && envelope.Conversation.ID == notice.Target
}

// noticeSettlement says how a reply or a press was taken for a notice.
type noticeSettlement int

const (
	// noticeNotSettled: the reply is not an answer; it goes on to the assistant's inbox.
	noticeNotSettled noticeSettlement = iota
	// noticeAnswered: the notice is answered, by this reply or an earlier one.
	noticeAnswered
	// noticeNoted: the reply is more information on an approval; the notice stays open.
	noticeNoted
)

// settleNoticeReply answers the notice's item with the reply, through the
// answer path the web uses for the item's kind. It is the one settlement for a
// reply in the notice's chat and for a press on the notice's card. sourceID
// names the reply or press. A reply to an approval that is not one of its
// options is information, not a decision: it goes to the approval's conversation
// and the item stays open.
func (s *Server) settleNoticeReply(ctx context.Context, notice store.PersonNotice, reply, sourceID string) noticeSettlement {
	reply = strings.TrimSpace(reply)
	if reply == "" {
		return noticeNotSettled
	}
	item, err := s.store.GetPendingItem(ctx, notice.UserID, notice.ItemID)
	if err != nil {
		log.Printf("notice %s item: %v", notice.ID, err)
		return noticeNotSettled
	}
	if item.State != store.PendingOpen {
		// Answered or withdrawn elsewhere: the notice is over, and the reply
		// is no longer an answer.
		if _, err := s.store.SupersedePersonNotices(ctx, item.ID, time.Now().UTC()); err != nil {
			log.Printf("supersede notice %s: %v", notice.ID, err)
		}
		return noticeNotSettled
	}
	index, named := personnotice.MatchOption(notice, reply)
	if !named {
		if !notice.AllowFreeText {
			return noticeNotSettled
		}
		if itemIsApproval(item) {
			if err := s.addDecisionNote(ctx, item, sourceID, reply); err != nil {
				log.Printf("decision note for notice %s: %v", notice.ID, err)
				return noticeNotSettled
			}
			return noticeNoted
		}
	}
	answer := reply
	if named {
		answer = notice.Options[index].Label
		if itemIsApproval(item) && item.Source == store.PendingSourceQuestion && index < len(item.Options) {
			// An approval question answers with its own option, Approve or Deny.
			answer = item.Options[index]
		}
	}
	answer = truncateRunes(answer, store.PendingAnswerLimit)
	// The notice is taken before the item is answered, so only the first
	// reply settles it, and the item's supersede cannot race it.
	won, err := s.store.AnswerPersonNotice(ctx, notice.ID, store.PendingAnsweredByPerson, answer, time.Now().UTC())
	if err != nil {
		log.Printf("answer notice %s: %v", notice.ID, err)
		return noticeNotSettled
	}
	if !won {
		// Another reply answered it first: this one is a repeat, not an answer.
		return noticeAnswered
	}
	if err := s.settleItemByReply(ctx, item, index, named, answer); err != nil {
		log.Printf("settle item %s from notice %s: %v", item.ID, notice.ID, err)
		if _, err := s.store.ReopenPersonNotice(ctx, notice.ID, time.Now().UTC()); err != nil {
			log.Printf("reopen notice %s: %v", notice.ID, err)
		}
		return noticeNotSettled
	}
	return noticeAnswered
}

// settleItemByReply gives the item the person's answer through the path its
// kind uses on the web: an assistant's question into its conversation, a
// connector write allowed or refused, and any other question as its answer
// envelope in the asking chat.
func (s *Server) settleItemByReply(ctx context.Context, item store.PendingItem, index int, named bool, answer string) error {
	switch {
	case item.Source == store.PendingSourceAssistantQuestion:
		_, err := s.answerAssistantQuestion(ctx, item, answer)
		return err
	case item.Source == store.PendingSourceConnectorWrite && item.ConnectorWrite != nil:
		agent, err := s.store.GetAssistant(ctx, item.AssistantID)
		if err != nil {
			return err
		}
		if _, err := s.assistant.DecideProposal(ctx, agent, item.ConnectorWrite.ProposalID, index == 0, store.PersonalAgentViaReply); err != nil {
			return err
		}
		_, err = s.store.ResolvePendingItem(ctx, item.UserID, item.ID, store.PendingDone, store.PendingOutcomePersonAnswered,
			store.PendingAnswer{Text: answer, By: store.PendingAnsweredByPerson})
		return err
	default:
		return s.answerQuestionInChat(ctx, item, answer)
	}
}

// answerQuestionInChat answers a question the way the web's answer does: the
// answer envelope for that question, steered into the chat's running turn, or
// queued as the chat's next message when nothing runs. The item is closed by
// the chat's events, as it is for the web's answer.
func (s *Server) answerQuestionInChat(ctx context.Context, item store.PendingItem, answer string) error {
	if item.MessageID == "" {
		return errors.New("the question has no message to answer")
	}
	if _, channelChat := s.messageChannelSessionOf(ctx, item.SessionID); channelChat {
		return errors.New("the chat takes input only from its channel")
	}
	queue, err := s.store.EnqueueChatMessage(ctx, item.WorkspaceID, item.SessionID, item.UserID, store.EnqueueChatMessageInput{
		Text: agentQuestionReplyText(item.MessageID, item.Title, answer), Steer: true,
	})
	if err != nil {
		return err
	}
	// As the chat's own steer: a refused steer leaves the message queued.
	_, _ = s.steerChatQueueItem(ctx, item.WorkspaceID, item.SessionID, newestChatQueueItem(queue), store.DeliveryBoundary)
	ref := store.ChatQueueRef{WorkspaceID: item.WorkspaceID, ChatID: item.SessionID}
	s.kickChatQueue(item.WorkspaceID, item.SessionID)
	s.chatSteers.arm(ref)
	s.kickChatSteers(ref, chatSteerChanged, false)
	return nil
}

// addDecisionNote gives an approval's conversation the person's reply as more
// information. It is not an answer: the item stays open, and the notice stays
// sent so the person can still decide by answering it. The inbox id follows
// the reply's message, so a repeated delivery adds nothing.
func (s *Server) addDecisionNote(ctx context.Context, item store.PendingItem, messageID, reply string) error {
	admission, err := s.store.AdmitSessionInboxItem(ctx, store.SessionInboxItem{
		SessionID:         item.SessionID,
		SenderSessionID:   item.SessionID,
		InputID:           uuid.NewSHA1(assistantQuestionSpace, []byte("decision-note:"+messageID)).String(),
		Prompt:            fmt.Sprintf("[Foundry] the person sent more information about %q; they have not decided it, so it stays open.\nTheir message:\n%s", item.Title, reply),
		RequestedDelivery: store.DeliveryBoundary,
		InputSource:       &store.AgentSessionInputSource{Kind: "foundry_notice", NoticeKind: store.NoticeKindDecisionNote},
	}, store.SessionInboxRules{Now: time.Now().UTC(), DedupWindow: sessions.InboxDedupWindow})
	if err != nil {
		return fmt.Errorf("deliver the decision note to session %s: %w", item.SessionID, err)
	}
	if !admission.Duplicate {
		s.sessionService.WakeInbox()
	}
	return nil
}

// feishuNoticeSink delivers a notice as a card through the built-in bot. The
// feishu package posts the card and knows nothing of the dispatcher, so this
// adapter names every failure transient: the chat may come back, and a notice
// that cannot be sent ends after its attempts.
type feishuNoticeSink struct {
	ws *feishu.WSManager
}

func (k feishuNoticeSink) Send(ctx context.Context, notice store.PersonNotice) (personnotice.SendResult, error) {
	messageID, err := k.ws.SendNotice(ctx, notice)
	if errors.Is(err, feishu.ErrUserNotReachable) {
		return personnotice.SendResult{}, personnotice.Permanent(err)
	}
	if err != nil {
		return personnotice.SendResult{}, personnotice.Transient(err)
	}
	return personnotice.SendResult{ProviderMessageID: messageID}, nil
}

func (k feishuNoticeSink) Refresh(ctx context.Context, notice store.PersonNotice) error {
	if err := k.ws.RefreshNotice(ctx, notice); err != nil {
		return personnotice.Transient(err)
	}
	return nil
}

// feishuNoticeDesk is Foundry's side of the built-in bot's notice cards
// (feishu.NoticeDesk): what a card shows about its notice, and the settlement of
// a press on it.
type feishuNoticeDesk struct {
	s *Server
}

func (d feishuNoticeDesk) NoticeFacts(ctx context.Context, notice store.PersonNotice) (feishu.NoticeFacts, error) {
	var facts feishu.NoticeFacts
	if notice.AssistantID != "" {
		agent, err := d.s.store.GetAssistant(ctx, notice.AssistantID)
		if err != nil {
			return facts, fmt.Errorf("notice assistant: %w", err)
		}
		facts.Assistant = agent.Name
	}
	if notice.ItemID == "" {
		return facts, nil
	}
	item, err := d.s.store.GetPendingItem(ctx, notice.UserID, notice.ItemID)
	if err != nil {
		return facts, fmt.Errorf("notice item: %w", err)
	}
	if item.WorkspaceID != "" {
		workspace, err := d.s.store.GetWorkspace(ctx, item.WorkspaceID)
		if err != nil {
			log.Printf("notice %s project: %v", notice.ID, err)
		} else {
			facts.Project = workspace.Name
		}
	}
	facts.Context = item.Excerpt
	if notice.Kind == "hand_over" && strings.TrimSpace(item.Note) != "" {
		facts.Context = item.Note
	}
	if item.ConnectorWrite != nil {
		facts.Command = item.ConnectorWrite.Operation
	}
	return facts, nil
}

// AnswerNotice settles a press on a sent notice. A notice that is not sent (still
// being sent, or already answered or superseded) is not settled again; the card
// shows the notice as it is.
func (d feishuNoticeDesk) AnswerNotice(ctx context.Context, press feishu.NoticePress) (feishu.NoticeAnswer, error) {
	notice, err := d.noticeOfPress(ctx, press)
	if err != nil {
		return feishu.NoticeAnswer{}, err
	}
	outcome := feishu.NoticeUnsettled
	if notice.State == store.NoticeSent {
		reply := strings.TrimSpace(press.Text)
		if press.Option != "" {
			index, err := strconv.Atoi(press.Option)
			if err != nil || index < 0 || index >= len(notice.Options) {
				return feishu.NoticeAnswer{}, fmt.Errorf("notice %s has no option %q", notice.ID, press.Option)
			}
			reply = notice.Options[index].Label
		}
		switch d.s.settleNoticeReply(ctx, notice, reply, press.PressID) {
		case noticeAnswered:
			outcome = feishu.NoticeAnswered
		case noticeNoted:
			outcome = feishu.NoticeNoted
		}
	}
	latest, err := d.noticeOfPress(ctx, press)
	if err != nil {
		return feishu.NoticeAnswer{}, err
	}
	return feishu.NoticeAnswer{Notice: latest, Outcome: outcome}, nil
}

// noticeOfPress reads the notice whose card the press came from, and refuses
// a press that does not match the notice's person and assistant.
func (d feishuNoticeDesk) noticeOfPress(ctx context.Context, press feishu.NoticePress) (store.PersonNotice, error) {
	notice, found, err := d.s.store.PersonNoticeByMessage(ctx, feishu.NoticeSinkID, press.CardMessageID)
	if err != nil {
		return store.PersonNotice{}, fmt.Errorf("read the notice of card %s: %w", press.CardMessageID, err)
	}
	if !found || notice.ID != press.NoticeID || notice.UserID != press.UserID || notice.AssistantID != press.AssistantID {
		return store.PersonNotice{}, fmt.Errorf("card %s is not a notice of this person", press.CardMessageID)
	}
	return notice, nil
}

func truncateRunes(text string, limit int) string {
	if runes := []rune(text); len(runes) > limit {
		return string(runes[:limit])
	}
	return text
}
