// Package feishuevents is the server's only way to receive Feishu events.
//
// Feishu pushes an app's events over long connections, at most 50 per app,
// and hands each event to one of them at random ("集群模式，不支持广播").
// So the server holds exactly one connection per Feishu app (Hub), keyed by
// the app, not by whoever needs its events. It acks each event within
// Feishu's 3 s, drops redeliveries by event id, and routes what it received:
// to the Workspace Bot route that owns the chat or thread (BotRoute), and to
// every agent subscription that asked for it (Subscribe/Poll, and the
// emulated event socket feishu-cli's `event consume` dials).
//
// Devices never hold an app secret for events: the Feishu gateway hands
// feishu-cli's event connection to GatewayEvents, fed from the server's
// connection.
package feishuevents

import (
	"encoding/json"
	"errors"
	"time"
)

// Event is one event Feishu pushed, as the router hands it on.
type Event struct {
	// AppID is the Feishu app (cli_…) whose connection received it.
	AppID string `json:"appId"`
	// ID is Feishu's event id (header.event_id, or uuid in schema 1.0);
	// redeliveries carry the same one.
	ID   string `json:"eventId"`
	Type string `json:"eventType"`
	// ChatID is the chat the event is about, when it is about one.
	ChatID string `json:"chatId,omitempty"`
	// CreateTime is Feishu's, in milliseconds since the epoch.
	CreateTime string `json:"createTime,omitempty"`
	// Payload is the event exactly as Feishu sent it.
	Payload  json.RawMessage `json:"payload"`
	Received time.Time       `json:"receivedAt"`
}

var errNotAnEvent = errors.New("payload is not a Feishu event")

// parseEvent reads what routing needs from an event payload (schema 2.0 or
// 1.0) and keeps the payload whole.
func parseEvent(appID string, payload []byte, received time.Time) (Event, error) {
	var envelope struct {
		Schema string `json:"schema"`
		UUID   string `json:"uuid"`
		Header *struct {
			EventID    string `json:"event_id"`
			EventType  string `json:"event_type"`
			CreateTime string `json:"create_time"`
			AppID      string `json:"app_id"`
		} `json:"header"`
		Event struct {
			Type    string `json:"type"`
			ChatID  string `json:"chat_id"`
			Message *struct {
				ChatID string `json:"chat_id"`
			} `json:"message"`
			Context *struct {
				OpenChatID string `json:"open_chat_id"`
			} `json:"context"`
		} `json:"event"`
	}
	if err := json.Unmarshal(payload, &envelope); err != nil {
		return Event{}, errors.Join(errNotAnEvent, err)
	}
	event := Event{AppID: appID, ID: envelope.UUID, Type: envelope.Event.Type, Payload: append(json.RawMessage(nil), payload...), Received: received}
	if header := envelope.Header; header != nil {
		event.ID, event.Type, event.CreateTime = header.EventID, header.EventType, header.CreateTime
	}
	switch {
	case envelope.Event.Message != nil && envelope.Event.Message.ChatID != "":
		event.ChatID = envelope.Event.Message.ChatID
	case envelope.Event.ChatID != "":
		event.ChatID = envelope.Event.ChatID
	case envelope.Event.Context != nil:
		event.ChatID = envelope.Event.Context.OpenChatID
	}
	if event.Type == "" {
		return Event{}, errNotAnEvent
	}
	return event, nil
}
