package feishu

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/browserevent"
	"github.com/foundry-dev/foundry/apps/server/internal/eventstream"
	"github.com/foundry-dev/foundry/apps/server/internal/externalaccounts"
	"github.com/foundry-dev/foundry/apps/server/internal/feishuevents"
	"github.com/foundry-dev/foundry/apps/server/internal/integrations"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
	larkim "github.com/larksuite/oapi-sdk-go/v3/service/im/v1"
)

// A Workspace Feishu Bot is a Connectors Feishu app plus routes
// (store.FeishuBotRoute): the server holds the app's secret and its one
// long connection, and dispatches each message to the workspace its chat
// or thread routes to. One app may serve many workspaces, a chat each.

type SessionDispatcher interface {
	CreateSessionAndDispatch(ctx context.Context, input store.CreateAgentSessionInput) (store.AgentSession, error)
	SendSessionMessage(ctx context.Context, sessionID, message string, attachments []store.ChatAttachment) error
	// SaveAttachments stores the files a message brought in the workspace's
	// attachments, as a person's upload is and within its limit.
	SaveAttachments(ctx context.Context, workspaceID string, files []MessageFile) ([]store.ChatAttachment, error)
}

// botUpdated tells a workspace's viewers what its bot is now: its app, how
// the app's connection stands, its chats.
var botUpdated = browserevent.Define[store.WorkspaceFeishuBot](browserevent.FeishuBotUpdated, eventstream.Options{})

// SecretProvider tells which apps hold a sealed secret.
type SecretProvider interface {
	HasSecret(ctx context.Context, id string) (bool, error)
}

// EventSource is the server's one long connection per Feishu app
// (feishuevents.Hub). The bots hold the connection of every app a workspace
// routes from; the source hands every event to HandleEvent and says how a
// connection stands through ConnectionChanged.
type EventSource interface {
	Hold(appID, holder string) error
	Release(appID, holder string)
	Status(appID string) feishuevents.Status
}

// botsHolder is the name the bots hold their apps' connections under.
const botsHolder = "workspace-bots"

// botApp is a Feishu app that at least one workspace's bot runs on.
type botApp struct {
	// clientID is Feishu's id of the app (cli_…).
	clientID string
	client   botClient
}

type sessionMetadata struct {
	workspaceID   string
	clientID      string
	cardMessageID string
	title         string
	startTime     time.Time
	currentText   string
	lastTip       string
}

// rotationList reads which Connectors apps should have their secret rotated
// (store.FeishuGatewayStore).
type rotationList interface {
	FeishuAppsToRotate(ctx context.Context) (map[string]string, error)
}

// Store is what the bots read and keep in the server's database.
type Store interface {
	store.Store
	store.AccountStore
	store.OwnershipStore
	store.ExternalAccountStore
	store.FeishuIssueThreads
	store.SessionRecordStore
	rotationList
}

type WSManager struct {
	mu           sync.RWMutex
	store        Store
	secrets      SecretProvider
	dispatcher   SessionDispatcher
	events       eventstream.Publisher
	streamBuffer *StreamBuffer
	// apps are the running bot apps by Feishu app id; failed says why a
	// wanted one does not run.
	apps     map[string]*botApp
	failed   map[string]string
	sessions map[string]*sessionMetadata
	// naming are the chat routes whose name is being refreshed.
	naming map[string]bool
	// syncing runs one Sync at a time.
	syncing sync.Mutex
	// reporting serializes Issue reports, so one update is posted once.
	reporting sync.Mutex
	// Integrations off: no bot connects; each records why. Nil is on.
	Integrations *integrations.Switch
	// Events receives the bots' apps' events: one connection per app,
	// however many workspaces use it.
	Events EventSource
	// Credentials reads a bot app's secret where the server holds it (its
	// Connectors app).
	Credentials feishuevents.CredentialSource
	// PersonalAgents is the person's assistant as their direct chat reaches
	// it (personal_agent.go); nil: direct chats go where their route points.
	PersonalAgents PersonalAgentDesk
	// assistantTopics are the assistant conversations started or continued
	// in Feishu, by session; proposalCards the proposal cards posted, by
	// proposal. Both live in memory only, as the cards a topic follows do.
	assistantTopics map[string]assistantTopic
	proposalCards   map[string]proposalCard
	// newClient builds the client a bot replies with; tests swap it.
	newClient func(appID, appSecret, baseURL string) botClient
}

// NewWSManager runs the workspaces' bots; what changes about a bot is
// published to events.
func NewWSManager(s Store, secrets SecretProvider, disp SessionDispatcher, events eventstream.Publisher) *WSManager {
	return &WSManager{
		store:        s,
		secrets:      secrets,
		dispatcher:   disp,
		events:       events,
		streamBuffer: NewStreamBuffer(800 * time.Millisecond),
		apps:         make(map[string]*botApp),
		failed:       make(map[string]string),
		sessions:     make(map[string]*sessionMetadata),
		newClient:    func(appID, appSecret, baseURL string) botClient { return NewClient(appID, appSecret, baseURL) },

		assistantTopics: make(map[string]assistantTopic),
		proposalCards:   make(map[string]proposalCard),
	}
}

// routedApps reads which Feishu apps the bots run on: Feishu app id → the
// workspaces whose bot runs on it.
func (m *WSManager) routedApps(ctx context.Context) (map[string][]string, error) {
	routes, err := m.store.ListFeishuBotRoutes(ctx, store.FeishuBotRouteFilter{})
	if err != nil {
		return nil, err
	}
	clientIDs := map[string]string{}
	wanted := map[string][]string{}
	for _, route := range routes {
		if route.Kind != store.FeishuRoutePairing {
			continue
		}
		clientID, known := clientIDs[route.AppID]
		if !known {
			app, err := m.store.GetExternalProviderApp(ctx, route.AppID)
			if err != nil {
				return nil, err
			}
			clientID, clientIDs[route.AppID] = app.ClientID, app.ClientID
		}
		wanted[clientID] = append(wanted[clientID], route.WorkspaceID)
	}
	return wanted, nil
}

// Sync runs exactly the apps some workspace's bot runs on, each with the
// secret its Connectors app holds now, and tells every workspace concerned
// how its bot stands. Call it after any change to the routes or to a bot
// app's secret; it is cheap.
func (m *WSManager) Sync(ctx context.Context) {
	if m == nil || m.store == nil {
		return
	}
	defer func() {
		if recovered := recover(); recovered != nil {
			log.Printf("[feishu] recovered in Sync: %v", recovered)
		}
	}()
	m.syncing.Lock()
	defer m.syncing.Unlock()
	wanted, err := m.routedApps(ctx)
	if err != nil {
		log.Printf("[feishu] read the bots' apps: %v", err)
		return
	}
	m.mu.Lock()
	var stale []string
	for clientID := range m.apps {
		if _, ok := wanted[clientID]; !ok {
			stale = append(stale, clientID)
			delete(m.apps, clientID)
		}
	}
	for clientID := range m.failed {
		if _, ok := wanted[clientID]; !ok {
			delete(m.failed, clientID)
		}
	}
	m.mu.Unlock()
	for _, clientID := range stale {
		if m.Events != nil {
			m.Events.Release(clientID, botsHolder)
		}
	}
	clientIDs := make([]string, 0, len(wanted))
	for clientID := range wanted {
		clientIDs = append(clientIDs, clientID)
	}
	sort.Strings(clientIDs)
	for _, clientID := range clientIDs {
		if err := m.startApp(ctx, clientID); err != nil {
			log.Printf("[feishu] bot app %s does not run: %v", clientID, err)
		}
		for _, workspaceID := range wanted[clientID] {
			m.Publish(ctx, workspaceID)
		}
	}
}

// startApp (re)builds the app's reply client from the secret held now and
// holds its connection; a failure is recorded for the workspaces' status.
func (m *WSManager) startApp(ctx context.Context, clientID string) error {
	fail := func(err error) error {
		m.mu.Lock()
		delete(m.apps, clientID)
		m.failed[clientID] = err.Error()
		m.mu.Unlock()
		if m.Events != nil {
			m.Events.Release(clientID, botsHolder)
		}
		return err
	}
	if err := m.Integrations.Err(); err != nil {
		return fail(err)
	}
	if m.Events == nil || m.Credentials == nil {
		return fail(errors.New("the server has no Feishu event connection"))
	}
	credentials, err := m.Credentials.AppCredentials(ctx, clientID)
	if err != nil {
		return fail(err)
	}
	m.mu.Lock()
	m.apps[clientID] = &botApp{clientID: clientID, client: m.newClient(clientID, credentials.AppSecret, credentials.BaseURL)}
	delete(m.failed, clientID)
	m.mu.Unlock()
	if err := m.Events.Hold(clientID, botsHolder); err != nil {
		return fail(err)
	}
	return nil
}

// StartAllConfiguredBots runs the bots at server start.
func (m *WSManager) StartAllConfiguredBots(ctx context.Context) { m.Sync(ctx) }

func (m *WSManager) StopAll() {
	m.mu.Lock()
	apps := m.apps
	m.apps = make(map[string]*botApp)
	m.mu.Unlock()
	if m.Events == nil {
		return
	}
	for clientID := range apps {
		m.Events.Release(clientID, botsHolder)
	}
}

func (m *WSManager) app(clientID string) *botApp {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.apps[clientID]
}

// AppStatus is how the bots' use of Feishu app clientID stands: whether
// its connection is up, why not, and when it last delivered an event.
func (m *WSManager) AppStatus(clientID string) (store.FeishuBotStatus, string, string) {
	if err := m.Integrations.Err(); err != nil {
		return store.FeishuBotStatusError, err.Error(), ""
	}
	m.mu.RLock()
	failed := m.failed[clientID]
	_, running := m.apps[clientID]
	m.mu.RUnlock()
	if failed != "" {
		return store.FeishuBotStatusError, failed, ""
	}
	if !running || m.Events == nil {
		return store.FeishuBotStatusConnecting, "", ""
	}
	status := m.Events.Status(clientID)
	lastEvent := ""
	if !status.LastEventAt.IsZero() {
		lastEvent = status.LastEventAt.UTC().Format(time.RFC3339)
	}
	switch {
	case status.Connected:
		return store.FeishuBotStatusConnected, "", lastEvent
	case status.Detail == "" || status.Detail == "connecting":
		return store.FeishuBotStatusConnecting, "", lastEvent
	default:
		return store.FeishuBotStatusError, status.Detail, lastEvent
	}
}

// WorkspaceBot is the workspace's bot as its page shows it.
func (m *WSManager) WorkspaceBot(ctx context.Context, workspaceID string) (store.WorkspaceFeishuBot, error) {
	view := store.WorkspaceFeishuBot{WorkspaceID: workspaceID, Status: store.FeishuBotStatusUnconfigured, Chats: []store.FeishuBotRoute{}}
	routes, err := m.store.ListFeishuBotRoutes(ctx, store.FeishuBotRouteFilter{WorkspaceID: workspaceID})
	if err != nil {
		return view, err
	}
	var pairing *store.FeishuBotRoute
	for index := range routes {
		if routes[index].Kind == store.FeishuRoutePairing {
			pairing = &routes[index]
		} else {
			view.Chats = append(view.Chats, m.withAssistant(ctx, routes[index]))
		}
	}
	assistantChats, err := m.assistantChatsOf(ctx, workspaceID)
	if err != nil {
		return view, err
	}
	view.Chats = append(view.Chats, assistantChats...)
	if pairing == nil {
		return view, nil
	}
	if pairing.PairingCode != "" && !pairingExpired(pairing.PairingCodeExpiresAt) {
		view.PairingCodeExpiresAt = pairing.PairingCodeExpiresAt
	}
	app, err := m.store.GetExternalProviderApp(ctx, pairing.AppID)
	if err != nil {
		return view, err
	}
	m.describeApp(ctx, &app)
	view.App = &app
	view.Status, view.StatusDetail, view.LastEventAt = m.AppStatus(app.ClientID)
	if !app.HasSecret {
		view.Status, view.StatusDetail = store.FeishuBotStatusError, "the app has no secret on this server: paste it in Connectors"
	}
	return view, nil
}

// withAssistant marks a direct chat its person's assistant takes.
func (m *WSManager) withAssistant(ctx context.Context, route store.FeishuBotRoute) store.FeishuBotRoute {
	if assistant := m.assistantFor(ctx, route); assistant != nil {
		route.AssistantWorkspaceID = assistant.route.WorkspaceID
	}
	return route
}

// assistantChatsOf are the direct chats paired with other workspaces that
// go to workspaceID because it is their person's assistant's.
func (m *WSManager) assistantChatsOf(ctx context.Context, workspaceID string) ([]store.FeishuBotRoute, error) {
	if m.PersonalAgents == nil {
		return nil, nil
	}
	routes, err := m.store.ListFeishuBotRoutes(ctx, store.FeishuBotRouteFilter{})
	if err != nil {
		return nil, err
	}
	chats := []store.FeishuBotRoute{}
	for _, route := range routes {
		if route.Kind != store.FeishuRouteP2P || route.WorkspaceID == workspaceID {
			continue
		}
		if route = m.withAssistant(ctx, route); route.AssistantWorkspaceID == workspaceID {
			chats = append(chats, route)
		}
	}
	return chats, nil
}

// describeApp fills what a Connectors app's record does not hold: whether
// its secret is sealed here and whether it should be rotated.
func (m *WSManager) describeApp(ctx context.Context, app *store.ExternalProviderApp) {
	if m.secrets != nil {
		app.HasSecret, _ = m.secrets.HasSecret(ctx, externalaccounts.AppSecretID(app.ID))
	}
	if rotate, err := m.store.FeishuAppsToRotate(ctx); err == nil {
		_, app.RotateSecret = rotate[app.ID]
	}
}

func pairingExpired(expiresAt string) bool {
	at, err := time.Parse(time.RFC3339, expiresAt)
	return err == nil && time.Now().After(at)
}

// Publish tells the workspace's viewers what its bot is now.
func (m *WSManager) Publish(ctx context.Context, workspaceID string) {
	view, err := m.WorkspaceBot(ctx, workspaceID)
	if err != nil {
		log.Printf("[feishu] read the bot of %s: %v", workspaceID, err)
		return
	}
	botUpdated.Publish(m.events, eventstream.Route{Workspace: workspaceID}, view)
}

// ConnectionChanged tells every workspace whose bot runs on the app how its
// connection stands now.
func (m *WSManager) ConnectionChanged(appID string, status feishuevents.Status) {
	if status.Connected {
		log.Printf("[feishu] bot app %s connected", appID)
	} else {
		log.Printf("[feishu] bot app %s: %s", appID, status.Detail)
	}
	ctx := context.Background()
	wanted, err := m.routedApps(ctx)
	if err != nil {
		return
	}
	for _, workspaceID := range wanted[appID] {
		m.Publish(ctx, workspaceID)
	}
}

// HandleEvent is the Workspace Bot route: a message event of a bot app goes
// to the workspace its thread or chat routes to, and is dropped otherwise.
func (m *WSManager) HandleEvent(ctx context.Context, event feishuevents.Event) {
	if event.Type == chatUpdated {
		m.handleChatUpdated(ctx, event)
		return
	}
	if event.Type == cardActionTriggered {
		m.handleCardAction(ctx, event)
		return
	}
	if event.Type != messageReceived {
		return
	}
	app := m.app(event.AppID)
	if app == nil {
		return
	}
	var message larkim.P2MessageReceiveV1
	if err := json.Unmarshal(event.Payload, &message); err != nil {
		log.Printf("[feishu] unreadable message event %s: %v", event.ID, err)
		return
	}
	if err := m.handleMessage(ctx, app, &message); err != nil {
		log.Printf("[feishu] message event %s of app %s: %v", event.ID, event.AppID, err)
	}
}

const messageReceived = "im.message.receive_v1"

// handleMessage routes one message, first match wins: a reply in a
// Foundry topic thread steers that topic's session in its workspace; "/pair
// <code>" binds the chat to the code's workspace; a message in a routed chat
// (mentioning the bot in a group; any in a direct chat) starts a topic in
// the chat's workspace. Everything else is dropped. A direct chat the
// person's assistant takes goes to the assistant's workspace, and its fixed
// words are handled before any of that reaches the model.
func (m *WSManager) handleMessage(ctx context.Context, app *botApp, event *larkim.P2MessageReceiveV1) error {
	if event == nil || event.Event == nil || event.Event.Message == nil {
		return nil
	}
	// Ignore messages sent by bots to avoid self-reply loops.
	if event.Event.Sender != nil && event.Event.Sender.SenderType != nil && *event.Event.Sender.SenderType == "bot" {
		return nil
	}
	msg := event.Event.Message
	if msg.MessageId == nil || msg.ChatId == nil || msg.Content == nil {
		return nil
	}
	messageID, chatID, rawContent := *msg.MessageId, *msg.ChatId, *msg.Content
	chatType, rootID, messageType := "", "", ""
	if msg.ChatType != nil {
		chatType = *msg.ChatType
	}
	if msg.RootId != nil {
		rootID = *msg.RootId
	}
	if msg.MessageType != nil {
		messageType = *msg.MessageType
	}
	incoming := parseMessage(messageType, rawContent)
	cleanText := cleanLeadingMentions(incoming.text)
	if cleanText == "" {
		return nil
	}
	incoming.text = cleanText
	if strings.HasPrefix(cleanText, "/pair") {
		return m.handlePairCommand(ctx, app, messageID, chatID, chatType, senderOpenID(event), cleanText)
	}
	inThread := rootID != "" && rootID != messageID
	sender := senderOpenID(event)
	chat, routeErr := m.chatRoute(ctx, app, chatID)
	route := chat.FeishuBotRoute
	if inThread && routeErr == nil {
		if thread, err := m.store.GetFeishuChatThread(ctx, rootID); err == nil && thread.ChatID == chatID && route.WorkspaceID == thread.WorkspaceID {
			if chat.assistant != nil && m.handleAssistantWords(ctx, app, chat, messageID, thread.LatestSessionID, sender, incoming, rootID) {
				return nil
			}
			if thread.IssueID != "" {
				return m.handleIssueReply(ctx, route, app.client, messageID, thread, cleanText)
			}
			return m.handleTopicFollowUp(ctx, route, app, messageID, thread, incoming, chat.assistant != nil)
		}
	}
	if routeErr != nil {
		log.Printf("[feishu] message in chat %s of app %s dropped: the chat is not paired with a workspace", chatID, app.clientID)
		return nil
	}
	m.notePeer(ctx, chat.stored, sender)
	hasMention := len(msg.Mentions) > 0 || strings.Contains(rawContent, "@_user_")
	if !hasMention && route.Kind != store.FeishuRouteP2P {
		return nil
	}
	if chat.assistant != nil && m.handleAssistantWords(ctx, app, chat, messageID, "", sender, incoming, rootID) {
		return nil
	}
	if goal, isIssue := strings.CutPrefix(cleanText, issueCommand); !inThread && isIssue && m.issueDesk() != nil {
		return m.handleNewIssue(ctx, route, app.client, messageID, chatID, strings.TrimSpace(goal))
	}
	return m.handleNewTopic(ctx, route, app, messageID, chatID, incoming, chat.assistant != nil)
}

func (m *WSManager) replyFailure(ctx context.Context, client botClient, messageID, title, detail, reason string) {
	if _, err := client.ReplyCard(ctx, messageID, BuildFailedCard(title, detail, reason)); err != nil {
		log.Printf("[feishu] failed to reply card: %v", err)
	}
}

// handlePairCommand binds the chat to the workspace whose pairing code it
// sends, on this app; the chat acts as the account that generated the code.
func (m *WSManager) handlePairCommand(ctx context.Context, app *botApp, messageID, chatID, chatType, sender, text string) error {
	fields := strings.Fields(text)
	if len(fields) < 2 {
		m.replyFailure(ctx, app.client, messageID, "配对失败", "请输入有效的配对码，例如：`@机器人 /pair FND-1234`", "参数缺失")
		return nil
	}
	code := strings.TrimSpace(fields[1])
	pairing, err := m.store.FindFeishuPairingRoute(ctx, app.clientID, HashPairingCode(code))
	if err != nil {
		log.Printf("[feishu] pairing code not found on app %s: %v", app.clientID, err)
		m.replyFailure(ctx, app.client, messageID, "配对失败", fmt.Sprintf("未找到配对码 `%s` 或与当前机器人不匹配，请在 Foundry 页面重试。", code), "配对码无效")
		return nil
	}
	if pairingExpired(pairing.PairingCodeExpiresAt) {
		m.replyFailure(ctx, app.client, messageID, "配对失败", "该配对码已过期，请在 Foundry 重新生成后重试。", "配对码已过期")
		return nil
	}
	wsName := pairing.WorkspaceID
	workspace, err := m.store.GetWorkspace(ctx, pairing.WorkspaceID)
	if err == nil && workspace.Name != "" {
		wsName = workspace.Name
	}
	// The assistant answers only its person's direct chat: no group context
	// reaches it, and what it knows about the person reaches no group.
	if err == nil && workspace.Kind == store.WorkspaceKindPersonalAgent && chatType != "p2p" {
		m.replyFailure(ctx, app.client, messageID, "配对失败", "助理只在单聊里回答，不能绑定到群。请在和机器人的单聊里发送这个配对码。", "不支持群聊")
		return nil
	}
	chat := store.FeishuBotRoute{Kind: store.FeishuRouteChat, ChatID: chatID, BoundUserID: pairing.PairingCodeCreatedBy}
	var nameErr error
	if chatType == "p2p" {
		chat.Kind, chat.PeerOpenID = store.FeishuRouteP2P, sender
		if sender != "" {
			chat.ChatName, nameErr = app.client.UserName(ctx, sender)
		}
	} else {
		chat.ChatName, nameErr = app.client.ChatName(ctx, chatID)
	}
	chat.ChatNameCheckedAt = time.Now().UTC().Format(time.RFC3339)
	if nameErr != nil {
		chat.ChatNameError = nameErr.Error()
	}
	previous, _ := m.store.FindFeishuChatRoute(ctx, app.clientID, chatID)
	if _, err := m.store.BindFeishuChat(ctx, pairing, chat); err != nil {
		log.Printf("[feishu] failed to bind chat %s to %s: %v", chatID, pairing.WorkspaceID, err)
		detail := "保存绑定信息失败，请稍后重试。"
		if errors.Is(err, store.ErrNotFound) {
			detail = "该配对码已被使用或已更换，请在 Foundry 重新生成后重试。"
		}
		m.replyFailure(ctx, app.client, messageID, "配对失败", detail, "配对失败")
		return nil
	}
	log.Printf("[feishu] paired workspace %s (%s) with %s chat %s on app %s", pairing.WorkspaceID, wsName, chat.Kind, chatID, app.clientID)
	if _, err := app.client.ReplyCard(ctx, messageID, BuildPairingSuccessCard(wsName)); err != nil {
		log.Printf("[feishu] failed to send pairing success card: %v", err)
	}
	m.Publish(ctx, pairing.WorkspaceID)
	if previous.WorkspaceID != "" && previous.WorkspaceID != pairing.WorkspaceID {
		m.Publish(ctx, previous.WorkspaceID)
	}
	return nil
}

func topicTitle(prompt string) string {
	if len([]rune(prompt)) > 28 {
		return string([]rune(prompt)[:28]) + "..."
	}
	return prompt
}

// handleNewTopic starts a session for the message, in a topic of its own;
// assistant marks the person's assistant's conversation.
func (m *WSManager) handleNewTopic(ctx context.Context, route store.FeishuBotRoute, app *botApp, messageID, chatID string, message incomingMessage, assistant bool) error {
	title := topicTitle(message.text)
	cardMessageID, err := app.client.ReplyCard(ctx, messageID, BuildRunningCard(title, "正在理解任务并启动智能体会话...", "启动中"))
	if err != nil {
		log.Printf("[feishu] failed to reply card: %v", err)
		return nil
	}
	userID, refusal := m.boundUser(ctx, route)
	if refusal != "" {
		_ = app.client.PatchCard(ctx, cardMessageID, BuildFailedCard(title, refusal, "无权执行"))
		return nil
	}
	prompt, attachments := m.bringFiles(ctx, app.client, route.WorkspaceID, messageID, message)
	session, err := m.dispatcher.CreateSessionAndDispatch(ctx, store.CreateAgentSessionInput{
		WorkspaceID:     route.WorkspaceID,
		Prompt:          prompt,
		Attachments:     attachments,
		Source:          "chat",
		CreatedByUserID: userID,
		// The chat's and the bot's default agents apply.
		FeishuRouteID: route.ID,
	})
	if err != nil {
		_ = app.client.PatchCard(ctx, cardMessageID, BuildFailedCard(title, "创建智能体执行会话失败", err.Error()))
		return nil
	}
	// A configured default agent that could not be used is said here too,
	// not only in the session's transcript.
	if note := session.Input.ProfileTransitionNote; note != "" {
		if _, err := app.client.ReplyCard(ctx, messageID, BuildIssueCard("默认智能体未能使用", note, "orange")); err != nil {
			log.Printf("[feishu] failed to reply the default agent note: %v", err)
		}
	}
	_ = m.store.SaveFeishuChatThread(ctx, store.FeishuChatThread{
		RootMessageID:   messageID,
		WorkspaceID:     route.WorkspaceID,
		ChatID:          chatID,
		LatestSessionID: session.ID,
		CardMessageID:   cardMessageID,
	})
	m.follow(session.ID, &sessionMetadata{
		workspaceID: route.WorkspaceID, clientID: app.clientID, cardMessageID: cardMessageID, title: title, startTime: time.Now(),
	}, assistant, chatID, messageID)
	return nil
}

// follow has the card follow the session's turn; the assistant's
// conversation is remembered with its topic, for the turns that follow.
func (m *WSManager) follow(sessionID string, meta *sessionMetadata, assistant bool, chatID, rootMessageID string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.sessions[sessionID] = meta
	if assistant {
		m.assistantTopics[sessionID] = assistantTopic{clientID: meta.clientID, chatID: chatID, rootMessageID: rootMessageID, title: meta.title}
	}
}

func (m *WSManager) handleTopicFollowUp(ctx context.Context, route store.FeishuBotRoute, app *botApp, messageID string, thread store.FeishuChatThread, message incomingMessage, assistant bool) error {
	if _, refusal := m.boundUser(ctx, route); refusal != "" {
		m.replyFailure(ctx, app.client, messageID, "无法继续", refusal, "无权执行")
		return nil
	}
	// The topic is one session: a running one is steered, an idle one takes
	// the message as its next input.
	session, err := m.store.GetAgentSessionRecord(ctx, thread.LatestSessionID)
	if err != nil {
		m.replyFailure(ctx, app.client, messageID, "无法继续", "找不到该话题的智能体会话", err.Error())
		return nil
	}
	prompt, attachments := m.bringFiles(ctx, app.client, route.WorkspaceID, messageID, message)
	if session.Status == "running" || session.Status == "queued" || session.Status == "blocked" {
		if err := m.dispatcher.SendSessionMessage(ctx, session.ID, prompt, attachments); err != nil {
			log.Printf("[feishu] failed to steer session %s: %v", session.ID, err)
		}
		m.streamBuffer.Update(session.ID, app.client, thread.CardMessageID, session.Title, session.Response, "收到补充指令: "+message.text)
		return nil
	}
	title := topicTitle(message.text)
	cardMessageID, err := app.client.ReplyCard(ctx, messageID, BuildRunningCard(title, "继续话题执行中...", "连续执行"))
	if err != nil {
		log.Printf("[feishu] failed to reply follow-up card: %v", err)
		return nil
	}
	if err := m.dispatcher.SendSessionMessage(ctx, session.ID, prompt, attachments); err != nil {
		_ = app.client.PatchCard(ctx, cardMessageID, BuildFailedCard(title, "继续会话失败", err.Error()))
		return nil
	}
	thread.CardMessageID = cardMessageID
	_ = m.store.SaveFeishuChatThread(ctx, thread)
	m.follow(session.ID, &sessionMetadata{
		workspaceID: route.WorkspaceID, clientID: app.clientID, cardMessageID: cardMessageID, title: title, startTime: time.Now(),
	}, assistant, thread.ChatID, thread.RootMessageID)
	return nil
}

// threadApp is the running app whose chat the thread is in, while the chat
// still routes to the thread's workspace.
func (m *WSManager) threadApp(ctx context.Context, thread store.FeishuChatThread) *botApp {
	m.mu.RLock()
	apps := make([]*botApp, 0, len(m.apps))
	for _, app := range m.apps {
		apps = append(apps, app)
	}
	m.mu.RUnlock()
	for _, app := range apps {
		if chat, err := m.chatRoute(ctx, app, thread.ChatID); err == nil && chat.WorkspaceID == thread.WorkspaceID {
			return app
		}
	}
	return nil
}

// IssueUpdated tells the thread following the Issue, if any, what changed
// since it was last told. It reads the Issue again, so a report never runs
// behind; reports go out one at a time.
func (m *WSManager) IssueUpdated(issue store.Issue) {
	go func() {
		m.reporting.Lock()
		defer m.reporting.Unlock()
		m.reportIssue(context.Background(), issue.ID)
	}()
}

// SessionEventRecorded shows a session's answer as it streams, and what it
// is doing, on the card of the topic that started it.
func (m *WSManager) SessionEventRecorded(event store.AgentSessionEvent) {
	m.mu.Lock()
	defer m.mu.Unlock()
	meta, ok := m.sessions[event.SessionID]
	if !ok {
		return
	}
	app, running := m.apps[meta.clientID]
	if !running {
		return
	}
	switch {
	case event.Label == "Response stream" && event.Detail != "":
		meta.currentText = event.Detail
		tip := meta.lastTip
		if tip == "" {
			tip = "正在生成回答..."
		}
		m.streamBuffer.Update(event.SessionID, app.client, meta.cardMessageID, meta.title, meta.currentText, tip)
	case event.Message != nil && event.Message.Kind == "assistant":
		if event.Message.Text != "" {
			meta.currentText = event.Message.Text
		}
		m.streamBuffer.Update(event.SessionID, app.client, meta.cardMessageID, meta.title, meta.currentText, "正在生成回答...")
	case event.Message != nil && event.Message.Kind == "tool":
		tip := "执行工具"
		if event.Message.Title != "" {
			tip += ": " + cardProcessLabel(event.Message.Title)
		}
		meta.lastTip = tip
		m.streamBuffer.Update(event.SessionID, app.client, meta.cardMessageID, meta.title, meta.currentText, tip)
	case event.Message == nil && isThinkingLabel(event.Label):
		meta.lastTip = "正在思考..."
		m.streamBuffer.Update(event.SessionID, app.client, meta.cardMessageID, meta.title, meta.currentText, meta.lastTip)
	}
}

// SessionEnded settles the card of the topic that started the session with
// its answer, or why it failed; the topic's card follows it no longer. A
// turn of the assistant's conversation that Feishu did not start (the
// answer to a task's event or to an accepted proposal) is told in its
// topic's thread.
func (m *WSManager) SessionEnded(session store.AgentSession) {
	m.mu.Lock()
	meta, ok := m.sessions[session.ID]
	if !ok {
		topic, isAssistant := m.assistantTopics[session.ID]
		m.mu.Unlock()
		if isAssistant {
			m.tellAssistantTurn(context.Background(), topic, session)
		}
		return
	}
	delete(m.sessions, session.ID)
	app, running := m.apps[meta.clientID]
	m.mu.Unlock()
	if !running {
		return
	}
	duration := time.Since(meta.startTime)
	if session.Status == "completed" {
		m.streamBuffer.Complete(session.ID, app.client, meta.cardMessageID, meta.title, session.Response, duration)
	} else {
		m.streamBuffer.Fail(session.ID, app.client, meta.cardMessageID, meta.title, session.Response, session.Error)
	}
}
