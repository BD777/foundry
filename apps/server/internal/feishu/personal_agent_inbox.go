package feishu

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// Optional during rolling upgrades: older desk implementations keep their
// existing routing. The server desk implements this persistent-input path.
type PersonalAgentInboxDesk interface {
	CaptureInbox(context.Context, string, string, store.PersonalAgentInboxOrigin) (store.PersonalAgentInboxEntry, error)
}

type inboxAttachmentDispatcher interface {
	SaveInboxAttachments(context.Context, string, string, []MessageFile) ([]store.ChatAttachment, error)
}

func (m *WSManager) captureAssistantInput(ctx context.Context, app *botApp, chat chatRoute, messageID, sessionID, sender string, message incomingMessage, rootID, language string) bool {
	desk, ok := m.PersonalAgents.(PersonalAgentInboxDesk)
	if !ok || !pairedSender(chat.stored, sender) {
		return false
	}
	origin := store.PersonalAgentInboxOrigin{AppID: app.clientID, ChatID: chat.ChatID, MessageID: messageID, RootMessageID: rootID, ThreadSessionID: sessionID}
	for _, r := range message.resources {
		origin.Resources = append(origin.Resources, store.PersonalAgentInboxResource{Key: r.key, Type: r.resourceType, Name: r.name, Label: r.label})
	}
	entry, err := desk.CaptureInbox(ctx, chat.assistant.userID, message.text, origin)
	if err != nil {
		m.replyCard(ctx, app.client, messageID, BuildAssistantCard(assistantText(language, "inboxFailedTitle"), assistantText(language, "inboxFailed"), "red"))
		return true
	}
	// Saving is complete before any reply. If the transport is unavailable,
	// the dispatcher will recover the same card/thread when it can run.
	_, _ = m.inboxThread(ctx, app, entry, chat.WorkspaceID, language)
	return true
}

func (m *WSManager) inboxApp(ctx context.Context, entry store.PersonalAgentInboxEntry, workspaceID string) (*botApp, error) {
	if entry.Origin == nil {
		return nil, errors.New("channel origin missing")
	}
	app := m.app(entry.Origin.AppID)
	if app == nil {
		return nil, errors.New("channel unavailable")
	}
	chat, err := m.chatRoute(ctx, app, entry.Origin.ChatID)
	if err != nil {
		return nil, err
	}
	userID, refusal := m.boundUser(ctx, chat.FeishuBotRoute)
	if refusal != "" || userID != entry.UserID || chat.WorkspaceID != workspaceID || chat.assistant == nil {
		return nil, errors.New("channel binding changed")
	}
	return app, nil
}

func (m *WSManager) inboxThread(ctx context.Context, app *botApp, entry store.PersonalAgentInboxEntry, workspaceID, language string) (store.FeishuChatThread, error) {
	origin := entry.Origin
	thread, err := m.store.GetFeishuChatThread(ctx, origin.MessageID)
	if err == nil && thread.CardMessageID != "" {
		if thread.ChatID != origin.ChatID || thread.WorkspaceID != workspaceID {
			return thread, errors.New("inbox reply scope changed")
		}
		return thread, nil
	}
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		return thread, err
	}
	card := BuildAssistantCard(assistantText(language, "inboxTitle"), assistantText(language, "inboxReceived"), "blue")
	var cardID string
	if client, ok := app.client.(interface {
		ReplyCardWithKey(context.Context, string, string, string) (string, error)
	}); ok {
		cardID, err = client.ReplyCardWithKey(ctx, origin.MessageID, card, entry.ID)
	} else {
		cardID, err = app.client.ReplyCard(ctx, origin.MessageID, card)
	}
	if err != nil {
		return thread, err
	}
	thread = store.FeishuChatThread{RootMessageID: origin.MessageID, WorkspaceID: workspaceID, ChatID: origin.ChatID, CardMessageID: cardID}
	return thread, m.store.SaveFeishuChatThread(ctx, thread)
}

// PrepareAssistantInbox refuses partial attachments. All resources are
// downloaded first; deterministic target paths make a retry overwrite only
// this input's own generated attachment, never create another growing batch.
func (m *WSManager) PrepareAssistantInbox(ctx context.Context, entry store.PersonalAgentInboxEntry, workspaceID string) (string, []store.ChatAttachment, error) {
	app, err := m.inboxApp(ctx, entry, workspaceID)
	if err != nil {
		return "", nil, err
	}
	if len(entry.Origin.Resources) > 10 {
		return "", nil, errors.New("at most ten attachments can be prepared per message")
	}
	files := []MessageFile{}
	for _, r := range entry.Origin.Resources {
		file, err := app.client.MessageResource(ctx, entry.Origin.MessageID, r.Key, r.Type)
		if err != nil {
			return "", nil, fmt.Errorf("attachment unavailable: %w", err)
		}
		resource := messageResource{key: r.Key, resourceType: r.Type, name: r.Name, label: r.Label}
		if resource.name != "" || file.Name == "" {
			file.Name = resource.fileName()
		}
		files = append(files, file)
	}
	if len(files) == 0 {
		return entry.Text, nil, nil
	}
	dispatcher, ok := m.dispatcher.(inboxAttachmentDispatcher)
	if !ok {
		return "", nil, errors.New("durable attachment adapter unavailable")
	}
	attachments, err := dispatcher.SaveInboxAttachments(ctx, workspaceID, entry.ID, files)
	return entry.Text, attachments, err
}

// FollowAssistantInbox attaches the persisted source card before dispatch.
// Reattaching after a restart is safe; no new model work is started here.
func (m *WSManager) FollowAssistantInbox(ctx context.Context, entry store.PersonalAgentInboxEntry, workspaceID, sessionID string) error {
	app, err := m.inboxApp(ctx, entry, workspaceID)
	if err != nil {
		return err
	}
	language := m.PersonalAgents.Language(ctx, entry.UserID, entry.Text)
	thread, err := m.inboxThread(ctx, app, entry, workspaceID, language)
	if err != nil {
		return err
	}
	thread.LatestSessionID = sessionID
	if err := m.store.SaveFeishuChatThread(ctx, thread); err != nil {
		return err
	}
	root := entry.Origin.RootMessageID
	if root == "" {
		root = entry.Origin.MessageID
	}
	if root != thread.RootMessageID {
		rootThread := thread
		rootThread.RootMessageID = root
		if err := m.store.SaveFeishuChatThread(ctx, rootThread); err != nil {
			return err
		}
	}
	m.follow(sessionID, &sessionMetadata{workspaceID: workspaceID, clientID: app.clientID, cardMessageID: thread.CardMessageID, title: topicTitle(entry.Text), startTime: time.Now()}, true, entry.Origin.ChatID, root)
	return nil
}

// Patching the existing per-input card is retryable, including after restart.
// Feishu's one-hour send dedupe is not treated as indefinite exactly-once.
func (m *WSManager) DeliverAssistantInboxResult(ctx context.Context, entry store.PersonalAgentInboxEntry, workspaceID, sessionURL string) error {
	app, err := m.inboxApp(ctx, entry, workspaceID)
	if err != nil {
		return err
	}
	language := m.PersonalAgents.Language(ctx, entry.UserID, entry.Text)
	thread, err := m.inboxThread(ctx, app, entry, workspaceID, language)
	if err != nil {
		return err
	}
	thread.LatestSessionID = entry.SessionID
	if err := m.store.SaveFeishuChatThread(ctx, thread); err != nil {
		return err
	}
	body := entry.ResultText
	if entry.ResultTruncated {
		body += "\n\n" + assistantText(language, "inboxFull", sessionURL)
	}
	card := BuildAssistantCard(assistantText(language, "inboxAnswered"), body, "green")
	if entry.ResultStatus != "completed" {
		card = BuildFailedCard(assistantText(language, "inboxInterrupted"), body, entry.ResultError)
	}
	return app.client.PatchCard(ctx, thread.CardMessageID, card)
}
