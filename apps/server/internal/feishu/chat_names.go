package feishu

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/feishuevents"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
	larkim "github.com/larksuite/oapi-sdk-go/v3/service/im/v1"
)

// A paired chat's name is copied from Feishu, which people rename freely.
// It is asked again when the chats are read and the copy is older than
// chatNameMaxAge, when Feishu says the chat changed (im.chat.updated_v1,
// if the app subscribes to it), and when someone asks to refresh it. A
// failed check keeps the name before and records why.

const chatNameMaxAge = time.Hour

const chatUpdated = "im.chat.updated_v1"

var errBotAppNotRunning = errors.New("the bot's Feishu app is not connected on this server")

func chatNameStale(chat store.FeishuBotRoute, now time.Time) bool {
	if chat.Kind == store.FeishuRoutePairing || chat.ChatID == "" {
		return false
	}
	checked, err := time.Parse(time.RFC3339, chat.ChatNameCheckedAt)
	return err != nil || now.Sub(checked) > chatNameMaxAge
}

// RefreshStaleChatNames asks Feishu, in the background, for the names of
// the chats whose copy is stale, then tells the workspace's viewers.
func (m *WSManager) RefreshStaleChatNames(workspaceID string, chats []store.FeishuBotRoute) {
	if m == nil || m.Integrations.Err() != nil {
		return
	}
	now := time.Now()
	var stale []store.FeishuBotRoute
	for _, chat := range chats {
		if chatNameStale(chat, now) {
			stale = append(stale, chat)
		}
	}
	m.refreshInBackground(workspaceID, stale)
}

// refreshInBackground refreshes the chats' names, each at most once at a
// time, and publishes the workspace's bot when any was checked.
func (m *WSManager) refreshInBackground(workspaceID string, chats []store.FeishuBotRoute) {
	m.mu.Lock()
	if m.naming == nil {
		m.naming = map[string]bool{}
	}
	var claimed []store.FeishuBotRoute
	for _, chat := range chats {
		if !m.naming[chat.ID] {
			m.naming[chat.ID] = true
			claimed = append(claimed, chat)
		}
	}
	m.mu.Unlock()
	if len(claimed) == 0 {
		return
	}
	go func() {
		defer func() {
			if recovered := recover(); recovered != nil {
				log.Printf("[feishu] recovered refreshing chat names: %v", recovered)
			}
		}()
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		for _, chat := range claimed {
			if err := m.refreshChatName(ctx, chat); err != nil {
				log.Printf("[feishu] chat %s keeps its name: %v", chat.ChatID, err)
			}
		}
		m.mu.Lock()
		for _, chat := range claimed {
			delete(m.naming, chat.ID)
		}
		m.mu.Unlock()
		m.Publish(ctx, workspaceID)
	}()
}

// RefreshChatName asks Feishu for the name of one of the workspace's chats
// now; a failure is recorded on the chat (ChatNameError) and returned.
func (m *WSManager) RefreshChatName(ctx context.Context, workspaceID, routeID string) error {
	routes, err := m.store.ListFeishuBotRoutes(ctx, store.FeishuBotRouteFilter{WorkspaceID: workspaceID})
	if err != nil {
		return err
	}
	for _, route := range routes {
		if route.ID == routeID && route.Kind != store.FeishuRoutePairing {
			err := m.refreshChatName(ctx, route)
			m.Publish(context.WithoutCancel(ctx), workspaceID)
			return err
		}
	}
	return store.ErrNotFound
}

// refreshChatName reads the chat's name from Feishu with its bot app and
// records the check: a group's own name, or a direct chat's other person.
func (m *WSManager) refreshChatName(ctx context.Context, route store.FeishuBotRoute) error {
	name, err := m.lookUpChatName(ctx, route)
	failure := ""
	if err != nil {
		failure = err.Error()
	}
	if recordErr := m.store.RecordFeishuChatName(ctx, route.ID, name, failure, time.Now()); recordErr != nil {
		return recordErr
	}
	return err
}

func (m *WSManager) lookUpChatName(ctx context.Context, route store.FeishuBotRoute) (string, error) {
	if err := m.Integrations.Err(); err != nil {
		return "", err
	}
	accounts, ok := m.accounts()
	if !ok {
		return "", errors.New("feishu: the server keeps no Connectors apps")
	}
	record, err := accounts.GetExternalProviderApp(ctx, route.AppID)
	if err != nil {
		return "", err
	}
	app := m.app(record.ClientID)
	if app == nil {
		return "", errBotAppNotRunning
	}
	if route.Kind == store.FeishuRouteP2P {
		if route.PeerOpenID == "" {
			return "", nil
		}
		return app.client.UserName(ctx, route.PeerOpenID)
	}
	return app.client.ChatName(ctx, route.ChatID)
}

// handleChatUpdated takes a paired group's new name from Feishu's change
// event; other changes are ignored.
func (m *WSManager) handleChatUpdated(ctx context.Context, event feishuevents.Event) {
	app := m.app(event.AppID)
	if app == nil {
		return
	}
	var changed larkim.P2ChatUpdatedV1
	if err := json.Unmarshal(event.Payload, &changed); err != nil {
		log.Printf("[feishu] unreadable chat event %s: %v", event.ID, err)
		return
	}
	data := changed.Event
	if data == nil || data.ChatId == nil || data.AfterChange == nil || data.AfterChange.Name == nil {
		return
	}
	name := strings.TrimSpace(*data.AfterChange.Name)
	route, err := m.store.FindFeishuChatRoute(ctx, app.clientID, *data.ChatId)
	if err != nil || name == "" {
		return
	}
	if err := m.store.RecordFeishuChatName(ctx, route.ID, name, "", time.Now()); err != nil {
		log.Printf("[feishu] record the new name of chat %s: %v", *data.ChatId, err)
		return
	}
	m.Publish(ctx, route.WorkspaceID)
}

// notePeer records who a direct chat is with, the first time they write,
// and names the chat after them. A recorded peer is kept: it is the person
// the chat is paired with, whom the assistant's fixed words and buttons
// answer to.
func (m *WSManager) notePeer(ctx context.Context, route store.FeishuBotRoute, senderOpenID string) {
	if route.Kind != store.FeishuRouteP2P || senderOpenID == "" || route.PeerOpenID != "" {
		return
	}
	if err := m.store.SetFeishuChatPeer(ctx, route.ID, senderOpenID); err != nil {
		log.Printf("[feishu] %v", err)
		return
	}
	route.PeerOpenID = senderOpenID
	if m.Integrations.Err() == nil {
		m.refreshInBackground(route.WorkspaceID, []store.FeishuBotRoute{route})
	}
}

func senderOpenID(event *larkim.P2MessageReceiveV1) string {
	if event == nil || event.Event == nil || event.Event.Sender == nil || event.Event.Sender.SenderId == nil ||
		event.Event.Sender.SenderId.OpenId == nil {
		return ""
	}
	return *event.Event.Sender.SenderId.OpenId
}
