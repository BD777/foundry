package feishu

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"github.com/larksuite/oapi-sdk-go/v3/event/dispatcher"
	larkim "github.com/larksuite/oapi-sdk-go/v3/service/im/v1"
	"github.com/larksuite/oapi-sdk-go/v3/ws"
)

type SessionDispatcher interface {
	CreateSessionAndDispatch(ctx context.Context, input store.CreateAgentSessionInput) (store.AgentSession, error)
	SteerSessionAndDispatch(ctx context.Context, sessionID, message string) error
	PublishEvent(eventType string, payload any)
}

type SecretProvider interface {
	GetSecret(ctx context.Context, id string) ([]byte, error)
	PutSecret(ctx context.Context, id string, plaintext []byte, additionalData string) error
	DeleteSecret(ctx context.Context, id string) error
	HasSecret(ctx context.Context, id string) (bool, error)
}

type activeBot struct {
	workspaceID string
	appID       string
	client      *Client
	cancel      context.CancelFunc
}

type sessionMetadata struct {
	workspaceID   string
	cardMessageID string
	title         string
	startTime     time.Time
	currentText   string
	lastTip       string
}

type WSManager struct {
	mu           sync.RWMutex
	store        store.Store
	secrets      SecretProvider
	dispatcher   SessionDispatcher
	streamBuffer *StreamBuffer
	activeBots   map[string]*activeBot
	sessions     map[string]*sessionMetadata
}

func NewWSManager(s store.Store, secrets SecretProvider, disp SessionDispatcher) *WSManager {
	return &WSManager{
		store:        s,
		secrets:      secrets,
		dispatcher:   disp,
		streamBuffer: NewStreamBuffer(800 * time.Millisecond),
		activeBots:   make(map[string]*activeBot),
		sessions:     make(map[string]*sessionMetadata),
	}
}

func (m *WSManager) StartAllConfiguredBots(ctx context.Context) {
	if m == nil || m.store == nil || m.secrets == nil {
		return
	}
	defer func() {
		if r := recover(); r != nil {
			log.Printf("[feishu] recovered in StartAllConfiguredBots: %v", r)
		}
	}()
	bots, err := m.store.ListAllConfiguredFeishuBots(ctx)
	if err != nil {
		log.Printf("[feishu] failed to list configured bots: %v", err)
		return
	}
	for _, bot := range bots {
		if bot.AppID == "" || !bot.HasAppSecret {
			continue
		}
		secretBytes, err := m.secrets.GetSecret(ctx, "feishu:app_secret:"+bot.WorkspaceID)
		if err != nil {
			log.Printf("[feishu] failed to read secret for workspace %s: %v", bot.WorkspaceID, err)
			continue
		}
		appSecret := string(secretBytes)
		if err := m.StartBot(bot.WorkspaceID, bot.AppID, appSecret); err != nil {
			log.Printf("[feishu] failed to start bot for workspace %s: %v", bot.WorkspaceID, err)
		}
	}
}

func (m *WSManager) StartBot(workspaceID, appID, appSecret string) error {
	m.mu.Lock()
	if existing, ok := m.activeBots[workspaceID]; ok {
		existing.cancel()
		delete(m.activeBots, workspaceID)
	}

	botCtx, cancel := context.WithCancel(context.Background())
	client := NewClient(appID, appSecret)

	eventDispatcher := dispatcher.NewEventDispatcher("", "").
		OnP2MessageReceiveV1(func(ctx context.Context, event *larkim.P2MessageReceiveV1) error {
			return m.handleMessage(ctx, workspaceID, client, event)
		})

	wsClient := ws.NewClient(
		appID,
		appSecret,
		ws.WithEventHandler(eventDispatcher),
		ws.WithAutoReconnect(true),
		ws.WithOnReady(func() {
			log.Printf("[feishu] bot connected for workspace %s", workspaceID)
			bot, err := m.store.GetWorkspaceFeishuBot(context.Background(), workspaceID)
			if err == nil {
				bot.Status = store.FeishuBotStatusConnected
				bot.StatusDetail = ""
				_, _ = m.store.SaveWorkspaceFeishuBot(context.Background(), bot)
				m.dispatcher.PublishEvent("feishu_bot_updated", bot)
			}
		}),
		ws.WithOnError(func(err error) {
			log.Printf("[feishu] bot error for workspace %s: %v", workspaceID, err)
			bot, storeErr := m.store.GetWorkspaceFeishuBot(context.Background(), workspaceID)
			if storeErr == nil {
				bot.Status = store.FeishuBotStatusError
				bot.StatusDetail = err.Error()
				_, _ = m.store.SaveWorkspaceFeishuBot(context.Background(), bot)
				m.dispatcher.PublishEvent("feishu_bot_updated", bot)
			}
		}),
	)

	m.activeBots[workspaceID] = &activeBot{
		workspaceID: workspaceID,
		appID:       appID,
		client:      client,
		cancel:      cancel,
	}
	m.mu.Unlock()

	go func() {
		if err := wsClient.Start(botCtx); err != nil && botCtx.Err() == nil {
			log.Printf("[feishu] ws client terminated with error: %v", err)
		}
	}()

	return nil
}

func (m *WSManager) StopBot(workspaceID string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if bot, ok := m.activeBots[workspaceID]; ok {
		bot.cancel()
		delete(m.activeBots, workspaceID)
	}
}

func (m *WSManager) StopAll() {
	m.mu.Lock()
	defer m.mu.Unlock()
	for id, bot := range m.activeBots {
		bot.cancel()
		delete(m.activeBots, id)
	}
}

func (m *WSManager) handleMessage(ctx context.Context, workspaceID string, client *Client, event *larkim.P2MessageReceiveV1) error {
	if event == nil || event.Event == nil || event.Event.Message == nil {
		return nil
	}
	// 1. Ignore messages sent by bots to avoid self-reply loops
	if event.Event.Sender != nil && event.Event.Sender.SenderType != nil && *event.Event.Sender.SenderType == "bot" {
		return nil
	}

	msg := event.Event.Message
	if msg.MessageId == nil || msg.ChatId == nil || msg.Content == nil {
		return nil
	}

	msgID := *msg.MessageId
	chatID := *msg.ChatId
	msgType := ""
	if msg.MessageType != nil {
		msgType = *msg.MessageType
	}
	rawContent := *msg.Content
	log.Printf("[feishu] message received: id=%s, chat=%s, type=%s, content=%s", msgID, chatID, msgType, rawContent)

	cleanText := extractMessageText(rawContent)
	cleanText = cleanLeadingMentions(cleanText)
	log.Printf("[feishu] extracted text: %q", cleanText)

	if cleanText == "" {
		log.Printf("[feishu] empty extracted text, ignoring message %s", msgID)
		return nil
	}

	messageID := msgID
	rootID := ""
	if msg.RootId != nil {
		rootID = *msg.RootId
	}

	// 2. Check for /pair pairing command
	if strings.HasPrefix(cleanText, "/pair") {
		return m.handlePairCommand(ctx, workspaceID, client, messageID, chatID, cleanText)
	}

	// 3. Validate that chat is bound to this workspace
	bot, err := m.store.GetWorkspaceFeishuBot(ctx, workspaceID)
	if err != nil || bot.ChatID != chatID {
		log.Printf("[feishu] message in chat %s ignored: bot not bound to this chat (bound chat: %q)", chatID, bot.ChatID)
		return nil
	}

	hasMention := (msg.Mentions != nil && len(msg.Mentions) > 0) || strings.Contains(rawContent, "@_user_")

	// 4. Thread follow-up message: if rootID exists and matches an active Foundry thread, process without requiring @
	if rootID != "" && rootID != messageID {
		thread, threadErr := m.store.GetFeishuChatThread(ctx, rootID)
		if threadErr == nil && thread.WorkspaceID == workspaceID {
			log.Printf("[feishu] found active Foundry thread for root %s, processing follow-up", rootID)
			return m.handleTopicFollowUp(ctx, workspaceID, client, messageID, chatID, thread, cleanText)
		}
		// In a non-Foundry thread, only trigger if explicitly mentioned
		if !hasMention {
			log.Printf("[feishu] thread %s is not a Foundry thread and bot was not mentioned, ignoring", rootID)
			return nil
		}
		return m.handleNewTopic(ctx, workspaceID, client, messageID, chatID, cleanText)
	}

	// 5. New topic in chat: only trigger if bot was mentioned
	if !hasMention {
		log.Printf("[feishu] new message in chat %s did not mention bot, ignoring", chatID)
		return nil
	}

	return m.handleNewTopic(ctx, workspaceID, client, messageID, chatID, cleanText)
}

func (m *WSManager) handlePairCommand(ctx context.Context, workspaceID string, client *Client, messageID, chatID, text string) error {
	log.Printf("[feishu] handling pair command in chat %s for workspace %s, text: %q", chatID, workspaceID, text)
	fields := strings.Fields(text)
	if len(fields) < 2 {
		log.Printf("[feishu] pairing failed: missing code parameter in %q", text)
		if _, err := client.ReplyCard(ctx, messageID, BuildFailedCard("配对失败", "请输入有效的配对码，例如：`@机器人 /pair FND-1234`", "参数缺失")); err != nil {
			log.Printf("[feishu] failed to reply card: %v", err)
		}
		return nil
	}
	code := strings.TrimSpace(fields[1])

	bot, err := m.store.FindWorkspaceByPairingCode(ctx, HashPairingCode(code))
	if err != nil || bot.WorkspaceID != workspaceID {
		log.Printf("[feishu] pairing code %q not found or workspace mismatch (found ws: %q, current ws: %q, err: %v)", code, bot.WorkspaceID, workspaceID, err)
		if _, err := client.ReplyCard(ctx, messageID, BuildFailedCard("配对失败", fmt.Sprintf("未找到配对码 `%s` 或与当前机器人不匹配，请在 Foundry 页面重试。", code), "配对码无效")); err != nil {
			log.Printf("[feishu] failed to reply card: %v", err)
		}
		return nil
	}

	if bot.PairingCodeExpiresAt != "" {
		if expiresAt, parseErr := time.Parse(time.RFC3339, bot.PairingCodeExpiresAt); parseErr == nil {
			if time.Now().After(expiresAt) {
				log.Printf("[feishu] pairing code %q has expired at %s", code, bot.PairingCodeExpiresAt)
				if _, err := client.ReplyCard(ctx, messageID, BuildFailedCard("配对失败", "该配对码已过期，请在 Foundry 重新生成后重试。", "配对码已过期")); err != nil {
					log.Printf("[feishu] failed to reply card: %v", err)
				}
				return nil
			}
		}
	}

	workspace, wsErr := m.store.GetWorkspace(ctx, bot.WorkspaceID)
	wsName := bot.WorkspaceID
	if wsErr == nil && workspace.Name != "" {
		wsName = workspace.Name
	}

	chatName, _ := client.GetChatInfo(ctx, chatID)
	if chatName == "" {
		chatName = "飞书群聊"
	}

	bot.ChatID = chatID
	bot.ChatName = chatName
	bot.Status = store.FeishuBotStatusConnected
	bot.StatusDetail = ""
	bot.PairingCode = ""
	bot.PairingCodeExpiresAt = ""
	// From now on the group acts as the account that generated the code.
	bot.BoundUserID = bot.PairingCodeCreatedBy
	bot.PairingCodeCreatedBy = ""

	if _, err := m.store.SaveWorkspaceFeishuBot(ctx, bot); err != nil {
		log.Printf("[feishu] failed to save bound workspace bot: %v", err)
		if _, err := client.ReplyCard(ctx, messageID, BuildFailedCard("配对失败", "保存绑定信息失败，请稍后重试。", err.Error())); err != nil {
			log.Printf("[feishu] failed to reply card: %v", err)
		}
		return nil
	}

	log.Printf("[feishu] paired workspace %s (%s) with chat %s (%s)", bot.WorkspaceID, wsName, chatID, chatName)

	// Send success confirmation card in thread
	successCard := BuildPairingSuccessCard(wsName)
	if _, err := client.ReplyCard(ctx, messageID, successCard); err != nil {
		log.Printf("[feishu] failed to send pairing success card: %v", err)
	}

	// Publish update to Web UI
	m.dispatcher.PublishEvent("feishu_bot_updated", bot)
	return nil
}

func (m *WSManager) handleNewTopic(ctx context.Context, workspaceID string, client *Client, messageID, chatID, prompt string) error {
	title := prompt
	if len([]rune(title)) > 28 {
		title = string([]rune(title)[:28]) + "..."
	}

	// Send initial running card
	cardJSON := BuildRunningCard(title, "正在理解任务并启动智能体会话...", "启动中")
	cardMessageID, err := client.ReplyCard(ctx, messageID, cardJSON)
	if err != nil {
		log.Printf("[feishu] failed to reply card: %v", err)
		return nil
	}

	userID, refusal := m.boundUser(ctx, workspaceID)
	if refusal != "" {
		_ = client.PatchCard(ctx, cardMessageID, BuildFailedCard(title, refusal, "无权执行"))
		return nil
	}

	// Create AgentSession in Foundry
	session, err := m.dispatcher.CreateSessionAndDispatch(ctx, store.CreateAgentSessionInput{
		WorkspaceID:     workspaceID,
		ThreadID:        messageID,
		Prompt:          prompt,
		Source:          "chat",
		CreatedByUserID: userID,
	})
	if err != nil {
		_ = client.PatchCard(ctx, cardMessageID, BuildFailedCard(title, "创建智能体执行会话失败", err.Error()))
		return nil
	}

	// Save thread mapping
	_ = m.store.SaveFeishuChatThread(ctx, store.FeishuChatThread{
		RootMessageID:   messageID,
		WorkspaceID:     workspaceID,
		ChatID:          chatID,
		LatestSessionID: session.ID,
		CardMessageID:   cardMessageID,
	})

	m.mu.Lock()
	m.sessions[session.ID] = &sessionMetadata{
		workspaceID:   workspaceID,
		cardMessageID: cardMessageID,
		title:         title,
		startTime:     time.Now(),
	}
	m.mu.Unlock()

	return nil
}

func (m *WSManager) handleTopicFollowUp(ctx context.Context, workspaceID string, client *Client, messageID, chatID string, thread store.FeishuChatThread, prompt string) error {
	userID, refusal := m.boundUser(ctx, workspaceID)
	if refusal != "" {
		if _, err := client.ReplyCard(ctx, messageID, BuildFailedCard("无法继续", refusal, "无权执行")); err != nil {
			log.Printf("[feishu] failed to reply card: %v", err)
		}
		return nil
	}
	latestSession, sessionErr := m.store.GetAgentSession(ctx, thread.LatestSessionID)
	if sessionErr == nil && (latestSession.Status == "running" || latestSession.Status == "queued") {
		// Session is still active: steer it
		_ = m.dispatcher.SteerSessionAndDispatch(ctx, latestSession.ID, prompt)
		m.streamBuffer.Update(latestSession.ID, client, thread.CardMessageID, latestSession.Title, latestSession.Response, "收到补充指令: "+prompt)
		return nil
	}

	// Previous session finished: start new turn in the same thread
	title := prompt
	if len([]rune(title)) > 28 {
		title = string([]rune(title)[:28]) + "..."
	}

	cardJSON := BuildRunningCard(title, "继续话题执行中...", "连续执行")
	cardMessageID, err := client.ReplyCard(ctx, messageID, cardJSON)
	if err != nil {
		log.Printf("[feishu] failed to reply follow-up card: %v", err)
		return nil
	}

	session, err := m.dispatcher.CreateSessionAndDispatch(ctx, store.CreateAgentSessionInput{
		WorkspaceID:     workspaceID,
		ThreadID:        thread.RootMessageID,
		Prompt:          prompt,
		Source:          "chat",
		CreatedByUserID: userID,
	})
	if err != nil {
		_ = client.PatchCard(ctx, cardMessageID, BuildFailedCard(title, "创建连续执行会话失败", err.Error()))
		return nil
	}

	thread.LatestSessionID = session.ID
	thread.CardMessageID = cardMessageID
	_ = m.store.SaveFeishuChatThread(ctx, thread)

	m.mu.Lock()
	m.sessions[session.ID] = &sessionMetadata{
		workspaceID:   workspaceID,
		cardMessageID: cardMessageID,
		title:         title,
		startTime:     time.Now(),
	}
	m.mu.Unlock()

	return nil
}

func (m *WSManager) HandleInternalEvent(eventType string, payload any) {
	dataBytes, err := json.Marshal(payload)
	if err != nil {
		return
	}

	switch eventType {
	case "agent_session_event":
		var event store.AgentSessionEvent
		if err := json.Unmarshal(dataBytes, &event); err != nil {
			return
		}
		m.mu.Lock()
		meta, ok := m.sessions[event.SessionID]
		if !ok {
			m.mu.Unlock()
			return
		}
		bot, botOk := m.activeBots[meta.workspaceID]
		if !botOk {
			m.mu.Unlock()
			return
		}

		if event.Label == "Response stream" && event.Detail != "" {
			meta.currentText = event.Detail
			tip := meta.lastTip
			if tip == "" {
				tip = "正在生成回答..."
			}
			m.streamBuffer.Update(event.SessionID, bot.client, meta.cardMessageID, meta.title, meta.currentText, tip)
		} else if event.Message != nil {
			if event.Message.Kind == "assistant" {
				if event.Message.Text != "" {
					meta.currentText = event.Message.Text
				}
				m.streamBuffer.Update(event.SessionID, bot.client, meta.cardMessageID, meta.title, meta.currentText, "正在生成回答...")
			} else if event.Message.Kind == "tool" {
				tip := "执行工具"
				if event.Message.Title != "" {
					tip += ": " + event.Message.Title
				}
				meta.lastTip = tip
				m.streamBuffer.Update(event.SessionID, bot.client, meta.cardMessageID, meta.title, meta.currentText, tip)
			}
		} else if strings.Contains(event.Label, "思考") {
			meta.lastTip = "正在思考..."
			m.streamBuffer.Update(event.SessionID, bot.client, meta.cardMessageID, meta.title, meta.currentText, meta.lastTip)
		}
		m.mu.Unlock()
	case "agent_session_completed":
		var session store.AgentSession
		if err := json.Unmarshal(dataBytes, &session); err != nil {
			return
		}
		m.mu.Lock()
		meta, ok := m.sessions[session.ID]
		if !ok {
			m.mu.Unlock()
			return
		}
		delete(m.sessions, session.ID)
		bot, botOk := m.activeBots[meta.workspaceID]
		m.mu.Unlock()
		if !botOk {
			return
		}

		duration := time.Since(meta.startTime)
		if session.Status == "completed" {
			m.streamBuffer.Complete(session.ID, bot.client, meta.cardMessageID, meta.title, session.Response, duration)
		} else {
			m.streamBuffer.Fail(session.ID, bot.client, meta.cardMessageID, meta.title, session.Response, session.Error)
		}
	}
}

type postElement struct {
	Tag      string `json:"tag"`
	Text     string `json:"text"`
	Href     string `json:"href"`
	UserID   string `json:"user_id"`
	UserName string `json:"user_name"`
}

type postBody struct {
	Title   string          `json:"title"`
	Content [][]postElement `json:"content"`
}

func extractPostContent(post postBody) string {
	var lines []string
	if post.Title != "" {
		lines = append(lines, post.Title)
	}
	for _, paragraph := range post.Content {
		var line strings.Builder
		for _, el := range paragraph {
			switch el.Tag {
			case "text", "a", "code_block":
				line.WriteString(el.Text)
			case "at":
				// Skip mention elements (e.g. @bot)
				continue
			}
		}
		trimmed := strings.TrimSpace(line.String())
		if trimmed != "" {
			lines = append(lines, trimmed)
		}
	}
	return strings.TrimSpace(strings.Join(lines, "\n"))
}

func cleanLeadingMentions(text string) string {
	text = strings.TrimSpace(text)
	for strings.HasPrefix(text, "@") {
		idx := strings.IndexAny(text, " \t\n\r")
		if idx == -1 {
			return ""
		}
		text = strings.TrimSpace(text[idx:])
	}
	return text
}

func extractMessageText(contentJSON string) string {
	// 1. Try plain text message format: {"text": "..."}
	var textBody struct {
		Text string `json:"text"`
	}
	if err := json.Unmarshal([]byte(contentJSON), &textBody); err == nil && textBody.Text != "" {
		re := regexp.MustCompile(`@_user_\d+|@_all`)
		cleaned := re.ReplaceAllString(textBody.Text, "")
		return strings.TrimSpace(cleaned)
	}

	// 2. Try direct post format: {"title": "...", "content": [[...]]}
	var directPost postBody
	if err := json.Unmarshal([]byte(contentJSON), &directPost); err == nil && (directPost.Title != "" || len(directPost.Content) > 0) {
		extracted := extractPostContent(directPost)
		if extracted != "" {
			return extracted
		}
	}

	// 3. Try localized post format: {"zh_cn": {"title": "...", "content": [[...]]}}
	var localizedPost map[string]postBody
	if err := json.Unmarshal([]byte(contentJSON), &localizedPost); err == nil {
		for _, post := range localizedPost {
			extracted := extractPostContent(post)
			if extracted != "" {
				return extracted
			}
		}
	}

	return strings.TrimSpace(contentJSON)
}
