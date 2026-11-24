package httpapi

import (
	"cmp"
	"context"
	"encoding/json"
	"strings"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"github.com/foundry-dev/foundry/apps/server/internal/textcut"
)

// pendingOriginView is where an item began: the person's own words that set
// its work going, where and when they said them. It lets the person recall
// what an item is about without reading the conversation. Read from what
// the sessions recorded; nothing here is written by a model.
type pendingOriginView struct {
	// SessionID is the conversation the words were said in.
	SessionID string `json:"sessionId"`
	At        string `json:"at"`
	Text      string `json:"text"`
	// Channel and Conversation name a message channel's chat (source, and
	// the chat's name and kind); both empty for a message typed in Foundry.
	Channel          string `json:"channel,omitempty"`
	Conversation     string `json:"conversation,omitempty"`
	ConversationKind string `json:"conversationKind,omitempty"`
}

// pendingOriginTextLimit bounds the words shown: enough to recall the ask.
const pendingOriginTextLimit = 300

// pendingOrigin is the person's last words before the item, in the
// conversation that started its session (a helper's dispatcher) or in the
// item's own conversation.
func (s *Server) pendingOrigin(ctx context.Context, item store.PendingItem, session store.AgentSession) *pendingOriginView {
	where := session.ID
	if session.ParentSessionID != "" {
		where = session.ParentSessionID
	}
	events, err := s.store.SessionUserMessagesBefore(ctx, where, item.CreatedAt, 40)
	if err != nil {
		return nil
	}
	for _, event := range events {
		if origin, ok := personWordsOf(event.Detail); ok {
			origin.SessionID = where
			if origin.At == "" {
				origin.At = event.At
			}
			return origin
		}
	}
	return nil
}

// personWordsOf reads one "User message" event: the person's own message in
// a channel turn (the newest they sent in it), or a message the person typed
// in Foundry. A message another session or Foundry sent is not theirs.
func personWordsOf(payload string) (*pendingOriginView, bool) {
	var event struct {
		Metadata struct {
			SentBySessionID string `json:"sentBySessionId"`
			InputSource     *struct {
				Kind string `json:"kind"`
			} `json:"inputSource"`
			ChannelOrigin *struct {
				ChannelName  string `json:"channelName"`
				Source       string `json:"source"`
				Conversation struct {
					Kind string `json:"kind"`
					Name string `json:"name"`
				} `json:"conversation"`
				Messages []struct {
					At     string `json:"at"`
					Text   string `json:"text"`
					Sender struct {
						IsSelf bool `json:"isSelf"`
					} `json:"sender"`
				} `json:"messages"`
			} `json:"channelOrigin"`
		} `json:"metadata"`
		Message struct {
			At   string `json:"at"`
			Text string `json:"text"`
		} `json:"message"`
	}
	if json.Unmarshal([]byte(payload), &event) != nil {
		return nil, false
	}
	meta := event.Metadata
	if channel := meta.ChannelOrigin; channel != nil {
		for i := len(channel.Messages) - 1; i >= 0; i-- {
			message := channel.Messages[i]
			text := strings.TrimSpace(message.Text)
			if !message.Sender.IsSelf || text == "" {
				continue
			}
			return &pendingOriginView{
				At: message.At, Text: textcut.Excerpt(text, pendingOriginTextLimit),
				Channel:      strings.TrimSpace(cmp.Or(channel.Source, channel.ChannelName)),
				Conversation: strings.TrimSpace(channel.Conversation.Name), ConversationKind: channel.Conversation.Kind,
			}, true
		}
		return nil, false
	}
	if meta.SentBySessionID != "" || (meta.InputSource != nil && meta.InputSource.Kind != "person") {
		return nil, false
	}
	text := strings.TrimSpace(event.Message.Text)
	if text == "" {
		return nil, false
	}
	return &pendingOriginView{At: event.Message.At, Text: textcut.Excerpt(text, pendingOriginTextLimit)}, true
}
