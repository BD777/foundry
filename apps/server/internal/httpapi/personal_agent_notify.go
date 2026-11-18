package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/foundry-dev/foundry/apps/server/internal/feishu"
	"github.com/foundry-dev/foundry/apps/server/internal/jsonempty"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// The person's notice setting (DEV-294 slice 5): which connector instance
// receives notices and which kinds it gets. Its self chat is found on the
// instance through the descriptor's read routes and stored in the instance's
// notify field, so nothing here names a connector.

// personNotifyKinds are the notice kinds a sink may receive. A new kind is
// added here and in the Web setting together.
var personNotifyKinds = []string{"question", "approval", "hand_over", "ask"}

// Reasons a self-chat discovery did not fill the notice chat. The Web maps
// each to its own copy.
const (
	notifyReasonSelfChatNotFound = "self_chat_not_found"
	notifyReasonChatNotFound     = "chat_not_found"
	notifyReasonChatNotSelf      = "chat_not_self"
	notifyReasonUnreachable      = "connector_unreachable"
	notifyReasonNoDevice         = "waiting_device"
	notifyReasonNotNotifiable    = "connector_not_notifiable"
	notifyReasonInstance         = "instance_unavailable"
	notifyReasonFeishuNotPaired  = feishu.NoticeReasonNotPaired
)

// feishuNoticeReasonMessage says, for the save refusal, why the Foundry bot cannot
// take the person's notices yet. A refused open_id is not a pairing task.
func feishuNoticeReasonMessage(reason string) string {
	if reason == feishu.NoticeReasonNotPaired {
		return "send the pairing code once in a Feishu direct chat with the Foundry bot"
	}
	return "the Foundry bot cannot message you in Feishu: you are outside its availability range"
}

// notifyDiscoveryPages bounds the conversation list read for the self chat.
const (
	notifyDiscoveryPages     = 10
	notifyDiscoveryPageSize  = 100
	notifyResponseLimitBytes = 4 << 20
)

// PersonalAgentNotifyChat is a conversation the person can receive notices in.
type PersonalAgentNotifyChat struct {
	FeedID string `json:"feedId"`
	Name   string `json:"name"`
}

// PersonalAgentNotifyChatResult answers discovery: the chat that was filled
// into the instance, or the reason it was not.
type PersonalAgentNotifyChatResult struct {
	ConnectorInstanceID string                   `json:"connectorInstanceId"`
	Chat                *PersonalAgentNotifyChat `json:"chat,omitempty"`
	Reason              string                   `json:"reason,omitempty"`
}

// PersonalAgentNotifyTestResult answers the test notice.
type PersonalAgentNotifyTestResult struct {
	Status    string `json:"status"`
	MessageID string `json:"messageId,omitempty"`
	Reason    string `json:"reason,omitempty"`
}

// PersonalAgentNotifyInstance is one of the person's extension instances. Reason
// is empty when the instance can carry notices now; otherwise it says what
// stops it, and the setting shows it instead of hiding the instance.
type PersonalAgentNotifyInstance struct {
	ConnectorInstanceID string `json:"connectorInstanceId"`
	Label               string `json:"label"`
	Reason              string `json:"reason,omitempty"`
	// Recommended marks the sink the person is best served by: the built-in
	// bot, once it is paired with the assistant (DEV-300).
	Recommended bool `json:"recommended,omitempty"`
}

// notifyFeishuBotLabel names the built-in bot as a notice sink.
const notifyFeishuBotLabel = "Foundry 飞书机器人"

// PersonalAgentNotifyInstancesResult lists the person's extension instances.
type PersonalAgentNotifyInstancesResult struct {
	Instances []PersonalAgentNotifyInstance `json:"instances"`
}

// notifyError is a reason a notice setting cannot be used, with its code for
// the Web and a message for the logs and the save error.
type notifyError struct {
	reason string
	err    error
}

func (e notifyError) Error() string { return e.err.Error() }

func notifyFailure(reason, format string, args ...any) error {
	return notifyError{reason: reason, err: fmt.Errorf(format, args...)}
}

// normalizePersonalAgentNotify checks the kinds of each sink and fills the
// default: every kind that needs an answer. One sink is supported for now.
func normalizePersonalAgentNotify(settings store.PersonalAgentNotifySettings) (store.PersonalAgentNotifySettings, error) {
	if len(settings.Sinks) > 1 {
		return store.PersonalAgentNotifySettings{}, errors.New("one notice connector is supported for now")
	}
	sinks := make([]store.PersonalAgentNotifySink, 0, len(settings.Sinks))
	for _, sink := range settings.Sinks {
		instanceID := strings.TrimSpace(sink.ConnectorInstanceID)
		if instanceID == "" {
			return store.PersonalAgentNotifySettings{}, errors.New("a notice connector needs an instance")
		}
		kinds := make([]string, 0, len(personNotifyKinds))
		for _, kind := range sink.Kinds {
			if !slices.Contains(personNotifyKinds, kind) {
				return store.PersonalAgentNotifySettings{}, fmt.Errorf("unknown notice kind %q", kind)
			}
			if !slices.Contains(kinds, kind) {
				kinds = append(kinds, kind)
			}
		}
		if len(kinds) == 0 {
			kinds = slices.Clone(personNotifyKinds)
		}
		sinks = append(sinks, store.PersonalAgentNotifySink{ConnectorInstanceID: instanceID, Kinds: kinds})
	}
	return store.PersonalAgentNotifySettings{Sinks: sinks}, nil
}

// notifyUpstream is one connector instance's agent API, read through the
// server-held extension path. Every call is a read the descriptor's route
// directory lists.
type notifyUpstream struct {
	s       *Server
	app     store.ExternalProviderApp
	data    store.ExtensionInstanceData
	request notifyRequester
}

// notifyRequester sends one request to the instance's upstream.
type notifyRequester func(ctx context.Context, method, path string, query url.Values) (*http.Response, error)

func (s *Server) openNotifyUpstream(ctx context.Context, userID, instanceID string) (notifyUpstream, error) {
	app, err := s.store.GetExternalProviderApp(ctx, instanceID)
	if err != nil || app.OwnerUserID != userID || app.CreatedVia != "extension" {
		return notifyUpstream{}, notifyFailure(notifyReasonInstance, "the connector instance is not one of your extension instances")
	}
	data, err := s.connectors.ServerHeld.ExtensionData(ctx, app)
	if err != nil {
		return notifyUpstream{}, notifyFailure(notifyReasonInstance, "the connector instance could not be read: %w", err)
	}
	if data.Descriptor.ServerHeld == nil || data.Descriptor.ServerHeld.Notify == nil {
		return notifyUpstream{}, notifyFailure(notifyReasonNotNotifiable, "the connector does not take notices")
	}
	deviceID, err := s.messageChannelDevice(data)
	if err != nil {
		return notifyUpstream{}, notifyFailure(notifyReasonNoDevice, "no device that reaches this connector is online")
	}
	request := func(ctx context.Context, method, path string, query url.Values) (*http.Response, error) {
		return s.connectors.ServerHeld.DoExtensionRequest(ctx, app, deviceID, method, path, query, nil, nil)
	}
	return notifyUpstream{s: s, app: app, data: data, request: request}, nil
}

func (u notifyUpstream) get(ctx context.Context, path string, query url.Values, into any) error {
	if !extensionReadAllowed(u.data, path) {
		return notifyFailure(notifyReasonNotNotifiable, "the connector's route directory does not list GET %s as read; check the instance again", path)
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	response, err := u.request(ctx, http.MethodGet, path, query)
	if err != nil {
		return notifyFailure(notifyReasonUnreachable, "the connector could not be reached: %w", err)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, notifyResponseLimitBytes+1))
	if err != nil {
		return notifyFailure(notifyReasonUnreachable, "read the connector's answer: %w", err)
	}
	if len(body) > notifyResponseLimitBytes {
		return notifyFailure(notifyReasonUnreachable, "the connector's answer is larger than 4 MiB")
	}
	switch {
	case response.StatusCode == http.StatusNotFound:
		return notifyFailure(notifyReasonChatNotFound, "the connector has no %s", path)
	case response.StatusCode != http.StatusOK:
		return notifyFailure(notifyReasonUnreachable, "the connector answered %d to GET %s", response.StatusCode, path)
	}
	if err := json.Unmarshal(body, into); err != nil {
		return notifyFailure(notifyReasonUnreachable, "the connector's answer to GET %s is not the expected JSON: %w", path, err)
	}
	return nil
}

// notifyMe is the account the instance is signed in as.
type notifyMe struct {
	UserID string `json:"userId"`
}

// notifyConversation is the part of an OpenLark conversation the self chat
// check reads: its feed id, name, chat mode and the other side's user id.
type notifyConversation struct {
	FeedID     string `json:"feedId"`
	Name       string `json:"name"`
	ChatMode   string `json:"chatMode"`
	PeerUserID string `json:"peerUserId"`
}

type notifyConversationPage struct {
	HasMore    bool                 `json:"hasMore"`
	Items      []notifyConversation `json:"items"`
	NextCursor string               `json:"nextCursor"`
}

// me reads the signed-in account's user id from the instance's /me route.
func (u notifyUpstream) me(ctx context.Context) (string, error) {
	var account notifyMe
	if err := u.get(ctx, "/agent/v1/me", nil, &account); err != nil {
		return "", err
	}
	if account.UserID == "" {
		return "", notifyFailure(notifyReasonUnreachable, "the connector did not say which account it is signed in as")
	}
	return account.UserID, nil
}

// isSelfChat is a direct chat with the signed-in account itself.
func isSelfChat(conversation notifyConversation, meID string) bool {
	return conversation.ChatMode == "direct" && conversation.PeerUserID != "" && conversation.PeerUserID == meID
}

// findSelfChat pages through the direct conversations and returns the one
// with the signed-in account. Nil means none was found.
func (u notifyUpstream) findSelfChat(ctx context.Context, meID string) (*PersonalAgentNotifyChat, error) {
	cursor := ""
	for range notifyDiscoveryPages {
		query := url.Values{"scope": {"p2p"}, "limit": {fmt.Sprint(notifyDiscoveryPageSize)}}
		if cursor != "" {
			query.Set("cursor", cursor)
		}
		var page notifyConversationPage
		if err := u.get(ctx, "/agent/v1/conversations", query, &page); err != nil {
			return nil, err
		}
		for _, conversation := range page.Items {
			if isSelfChat(conversation, meID) {
				return &PersonalAgentNotifyChat{FeedID: conversation.FeedID, Name: conversation.Name}, nil
			}
		}
		if !page.HasMore || page.NextCursor == "" {
			return nil, nil
		}
		cursor = page.NextCursor
	}
	return nil, nil
}

// readSelfChat checks a chat id the person typed, or the one the instance
// already holds: it exists, is a direct chat and is with the account itself.
func (u notifyUpstream) readSelfChat(ctx context.Context, meID, feedID string) (*PersonalAgentNotifyChat, error) {
	var conversation notifyConversation
	path := "/agent/v1/conversations/" + url.PathEscape(feedID)
	if err := u.get(ctx, path, nil, &conversation); err != nil {
		return nil, err
	}
	if !isSelfChat(conversation, meID) {
		return nil, notifyFailure(notifyReasonChatNotSelf, "the chat %s is not your chat with yourself", feedID)
	}
	return &PersonalAgentNotifyChat{FeedID: feedID, Name: conversation.Name}, nil
}

// fillNotifyChat writes the chat into the instance's notify field. Its other
// fields and sealed secrets are kept as they are.
func (u notifyUpstream) fillNotifyChat(ctx context.Context, ownerUserID string, feedID string) error {
	fields := jsonempty.Map[string]{}
	for key, value := range u.data.Values {
		fields[key] = value
	}
	fields[u.data.Descriptor.ServerHeld.Notify.Target.Field] = feedID
	input := store.ConnectorServerHeldInstanceInput{
		Label:    u.app.Label,
		Fields:   fields,
		Network:  u.data.Network,
		DeviceID: u.data.ProbeDeviceID,
	}
	_, err := u.s.connectors.ServerHeld.ReplaceExtensionInstance(ctx, ownerUserID, u.data.Descriptor.Kind, u.app.ID, u.data.Descriptor, input)
	if err != nil {
		return fmt.Errorf("save the notice chat on the connector: %w", err)
	}
	return nil
}

// notifyChatOf is the chat the instance already holds for notices.
func (u notifyUpstream) notifyChatOf() string {
	return strings.TrimSpace(u.data.Values[u.data.Descriptor.ServerHeld.Notify.Target.Field])
}

// checkPersonalAgentNotify checks a changed sink before it is saved: the
// instance takes notices and its notice chat is still the person's self chat.
// An unchanged sink is not read again, so saving other settings never waits
// on the connector.
func (s *Server) checkPersonalAgentNotify(ctx context.Context, agent store.PersonalAgent, previous, next store.PersonalAgentNotifySettings) error {
	for _, sink := range next.Sinks {
		if slices.ContainsFunc(previous.Sinks, func(old store.PersonalAgentNotifySink) bool {
			return old.ConnectorInstanceID == sink.ConnectorInstanceID
		}) {
			continue
		}
		if sink.ConnectorInstanceID == feishu.NoticeSinkID {
			if reason := s.feishu.NoticeChatReason(ctx, agent.UserID, agent.ID); reason != "" {
				return notifyFailure(reason, "%s", feishuNoticeReasonMessage(reason))
			}
			continue
		}
		upstream, err := s.openNotifyUpstream(ctx, agent.UserID, sink.ConnectorInstanceID)
		if err != nil {
			return err
		}
		chat := upstream.notifyChatOf()
		if chat == "" {
			return notifyFailure(notifyReasonSelfChatNotFound, "find your chat with yourself on this connector first")
		}
		meID, err := upstream.me(ctx)
		if err != nil {
			return err
		}
		if _, err := upstream.readSelfChat(ctx, meID, chat); err != nil {
			return err
		}
	}
	return nil
}

// handleFindPersonalAgentNotifyChat finds the person's self chat on the
// instance and fills it in, or checks the chat id the person typed as a
// fallback. A miss is an answer with a reason, not an error.
func (s *Server) handleFindPersonalAgentNotifyChat(w http.ResponseWriter, r *http.Request) {
	agent, ok := s.personalAgentOf(w, r)
	if !ok {
		return
	}
	var input struct {
		ConnectorInstanceID string `json:"connectorInstanceId"`
		ChatID              string `json:"chatId"`
	}
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	result, err := s.findPersonalAgentNotifyChat(r.Context(), agent.UserID, strings.TrimSpace(input.ConnectorInstanceID), strings.TrimSpace(input.ChatID))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "the notice chat could not be saved")
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, result)
}

// findPersonalAgentNotifyChat is the self-chat discovery both the Settings
// route and assistant_settings run. A miss is an answer with a reason; an
// error is a failure that is not a reason.
func (s *Server) findPersonalAgentNotifyChat(ctx context.Context, userID, instanceID, typedChatID string) (PersonalAgentNotifyChatResult, error) {
	result := PersonalAgentNotifyChatResult{ConnectorInstanceID: instanceID}
	chat, err := s.discoverNotifyChat(ctx, userID, instanceID, typedChatID)
	if err != nil {
		var failure notifyError
		if !errors.As(err, &failure) {
			return result, err
		}
		result.Reason = failure.reason
		return result, nil
	}
	result.Chat = chat
	return result, nil
}

func (s *Server) discoverNotifyChat(ctx context.Context, userID, instanceID, typedChatID string) (*PersonalAgentNotifyChat, error) {
	upstream, err := s.openNotifyUpstream(ctx, userID, instanceID)
	if err != nil {
		return nil, err
	}
	meID, err := upstream.me(ctx)
	if err != nil {
		return nil, err
	}
	var chat *PersonalAgentNotifyChat
	if typedChatID != "" {
		chat, err = upstream.readSelfChat(ctx, meID, typedChatID)
	} else {
		chat, err = upstream.findSelfChat(ctx, meID)
		if err == nil && chat == nil {
			return nil, notifyFailure(notifyReasonSelfChatNotFound, "no chat with yourself was found on this connector")
		}
	}
	if err != nil {
		return nil, err
	}
	if err := upstream.fillNotifyChat(ctx, userID, chat.FeedID); err != nil {
		return nil, err
	}
	return chat, nil
}

// notifyInstanceReason explains why an instance cannot carry notices, "" when it
// can: its descriptor declares a notify section and a device that reaches it is
// online. The Web shows the reason next to the instance.
func notifyInstanceReason(data store.ExtensionInstanceData, deviceErr error) string {
	if data.Descriptor.ServerHeld == nil || data.Descriptor.ServerHeld.Notify == nil {
		return notifyReasonNotNotifiable
	}
	if deviceErr != nil {
		return notifyReasonNoDevice
	}
	return ""
}

// handleListPersonalAgentNotifyInstances lists the person's extension instances
// with whether each can carry notices.
func (s *Server) handleListPersonalAgentNotifyInstances(w http.ResponseWriter, r *http.Request) {
	agent, ok := s.personalAgentOf(w, r)
	if !ok {
		return
	}
	instances, err := s.listPersonalAgentNotifyInstances(r.Context(), agent)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "the connectors could not be listed")
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, PersonalAgentNotifyInstancesResult{Instances: instances})
}

// listPersonalAgentNotifyInstances lists the Foundry bot first, then every extension
// instance the owner has. An instance that cannot carry notices yet is listed
// with its reason, not left out: the Web offers the connector kinds from these
// instances, not from the apps list, which leaves extension instances out. The
// bot without a paired direct chat is listed with notifyReasonFeishuNotPaired.
func (s *Server) listPersonalAgentNotifyInstances(ctx context.Context, agent store.PersonalAgent) ([]PersonalAgentNotifyInstance, error) {
	apps, err := s.store.ListExternalProviderApps(ctx, agent.UserID)
	if err != nil {
		return nil, err
	}
	reason := s.feishu.NoticeChatReason(ctx, agent.UserID, agent.ID)
	feishuBot := PersonalAgentNotifyInstance{ConnectorInstanceID: feishu.NoticeSinkID, Label: notifyFeishuBotLabel, Reason: reason, Recommended: reason == ""}
	instances := []PersonalAgentNotifyInstance{feishuBot}
	for _, app := range apps {
		if app.CreatedVia != "extension" || app.OwnerUserID != agent.UserID {
			continue
		}
		instances = append(instances, s.notifyInstanceOf(ctx, app))
	}
	return instances, nil
}

// notifyInstanceOf reads one extension instance the way a notice would. Reading
// it also brings its descriptor snapshot up to the installed extension.
func (s *Server) notifyInstanceOf(ctx context.Context, app store.ExternalProviderApp) PersonalAgentNotifyInstance {
	instance := PersonalAgentNotifyInstance{ConnectorInstanceID: app.ID, Label: app.Label}
	data, err := s.connectors.ServerHeld.ExtensionData(ctx, app)
	if err != nil {
		log.Printf("notice connector %s cannot be read: %v", app.ID, err)
		instance.Reason = notifyReasonInstance
		return instance
	}
	_, deviceErr := s.messageChannelDevice(data)
	instance.Reason = notifyInstanceReason(data, deviceErr)
	return instance
}

// handleSendPersonalAgentTestNotice sends one test notice to the chosen
// connector instance and reports the send's result. It goes straight to the
// sink, not the queue, so it is not stored as a notice that could be answered.
func (s *Server) handleSendPersonalAgentTestNotice(w http.ResponseWriter, r *http.Request) {
	agent, ok := s.personalAgentOf(w, r)
	if !ok {
		return
	}
	var input struct {
		ConnectorInstanceID string `json:"connectorInstanceId"`
	}
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	result := s.sendPersonalAgentTestNotice(r.Context(), agent, strings.TrimSpace(input.ConnectorInstanceID))
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, result)
}

// sendPersonalAgentTestNotice sends the test notice that the Settings route
// and assistant_settings both send. It goes straight to the sink, not the
// queue, so it is not stored as a notice that could be answered.
func (s *Server) sendPersonalAgentTestNotice(ctx context.Context, agent store.PersonalAgent, instanceID string) PersonalAgentNotifyTestResult {
	notice := store.PersonNotice{
		ID:          uuid.NewString(),
		UserID:      agent.UserID,
		AssistantID: agent.ID,
		Kind:        "question",
		Title:       "[测试] Foundry 通知联调",
		Text:        "这是一条测试通知，用于确认 Foundry 能把通知发到你的自聊。无需处理。",
		SinkID:      noticeSinkID(instanceID),
		CreatedAt:   time.Now().UTC(),
	}
	result := PersonalAgentNotifyTestResult{Status: "failed"}
	sink, ok := s.resolveNoticeSink(notice.SinkID)
	if !ok {
		result.Reason = "the connector instance id is empty"
		return result
	}
	sent, err := sink.Send(ctx, notice)
	if err != nil {
		result.Reason = err.Error()
	} else {
		result.Status = "sent"
		result.MessageID = sent.ProviderMessageID
	}
	return result
}
