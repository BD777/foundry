package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func (f channelSessionFixture) asAlice(t *testing.T, method, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	if body != "" {
		request.Header.Set("Content-Type", "application/json")
	}
	recorder := httptest.NewRecorder()
	f.server.testActor = &Actor{Kind: ActorAccount, Account: &store.User{ID: f.aliceID}}
	defer func() { f.server.testActor = nil }()
	f.server.Routes().ServeHTTP(recorder, request)
	return recorder
}

// One channel's conversations page by newest activity, its deliveries
// filter by conversation and session, a session's turns carry their origin,
// and a person cannot write into the channel's session (DEV-234).
func TestMessageChannelReadEndpoints(t *testing.T) {
	f := newChannelSessionFixture(t)
	ctx := context.Background()
	second, err := f.db.CreateAgentSession(ctx, store.CreateAgentSessionInput{
		CreatedByUserID: f.aliceID, WorkspaceID: f.agent.WorkspaceID, AgentID: "agent_pa", Prompt: "second", Source: "chat",
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := f.db.RecordMessageChannelSession(ctx, store.MessageChannelSession{
		SessionID: second.ID, ChannelID: f.channel.ID, AssistantID: f.agent.ID, SessionKey: "c:oc_1", Segment: 1,
	}); err != nil {
		t.Fatal(err)
	}
	record := func(id, at, sessionKey, sessionID, inboxID, text string, segment int, new bool, reason string, sender store.MessageEnvelopeSender, status string) store.MessageChannelDeliveryRecord {
		item := store.MessageChannelDeliveryRecord{UserID: f.aliceID, AssistantID: f.agent.ID}
		item.ID, item.ChannelID, item.Status, item.CreatedAt = id, f.channel.ID, status, at
		item.SessionKey, item.SessionID, item.InboxID, item.Segment = sessionKey, sessionID, inboxID, segment
		item.SessionNew, item.NewReason, item.Rule = new, reason, "group"
		item.Envelope = store.MessageEnvelope{
			ID: "env_" + id, Kind: "message", Op: "new", MessageID: id, Text: text, OccurredAt: at,
			Conversation: store.MessageEnvelopeConversation{ID: "oc_1", Kind: "group", Name: "Ops"},
			Thread:       store.MessageEnvelopeThread{ID: "omt_1", IsReply: true},
			Sender:       sender,
		}
		return item
	}
	third := record("dlv_3", "2026-11-16T07:00:00Z", "c:oc_1", second.ID, "inbox_2", "second", 1, true, "idle",
		store.MessageEnvelopeSender{ID: "ou_2", Name: "李四"}, store.MessageDeliveryDone)
	fourth := record("dlv_4", "2026-11-16T05:00:00Z", "c:oc_2", "", "inbox_3", "", 0, false, "",
		store.MessageEnvelopeSender{ID: "ou_3"}, store.MessageDeliveryDropped)
	fourth.Envelope.Conversation = store.MessageEnvelopeConversation{ID: "oc_2", Kind: "direct", Name: "Design"}
	first := record("dlv_2", "2026-11-16T06:00:00Z", "c:oc_1", f.session.ID, "inbox_1", "first", 0, true, "first",
		store.MessageEnvelopeSender{ID: "ou_1", Name: "张三"}, store.MessageDeliveryDone)
	if _, err := f.db.RecordMessageChannelBatch(ctx, f.channel.ID, []store.MessageChannelDeliveryRecord{first, third, fourth}, "cursor-2"); err != nil {
		t.Fatal(err)
	}

	conversations := f.asAlice(t, http.MethodGet, "/api/personal-agent/channels/"+f.channel.ID+"/conversations", "")
	if conversations.Code != http.StatusOK {
		t.Fatalf("conversations: %d %s", conversations.Code, conversations.Body)
	}
	var list store.MessageChannelConversationList
	if err := json.Unmarshal(conversations.Body.Bytes(), &list); err != nil {
		t.Fatal(err)
	}
	if len(list.Conversations) != 2 || list.Conversations[0].SessionKey != "c:oc_1" {
		t.Fatalf("conversations = %+v", list.Conversations)
	}
	ops := list.Conversations[0]
	if ops.Conversation.Name != "Ops" || ops.MessageCount != 3 || ops.MatchedCount != 3 || ops.SessionCount != 2 ||
		ops.Sessions[0].SessionID != second.ID || ops.Sessions[0].Reason != "idle" || ops.Sessions[1].SessionID != f.session.ID {
		t.Fatalf("Ops conversation = %+v", ops)
	}
	if list.Conversations[1].SessionKey != "c:oc_2" || list.Conversations[1].MatchedCount != 0 {
		t.Fatalf("Design conversation = %+v", list.Conversations[1])
	}

	deliveries := f.asAlice(t, http.MethodGet,
		"/api/personal-agent/channels/"+f.channel.ID+"/deliveries?conversation=c:oc_1&sessionId="+f.session.ID, "")
	if deliveries.Code != http.StatusOK {
		t.Fatalf("deliveries: %d %s", deliveries.Code, deliveries.Body)
	}
	var page store.MessageChannelDeliveryList
	if err := json.Unmarshal(deliveries.Body.Bytes(), &page); err != nil {
		t.Fatal(err)
	}
	if len(page.Deliveries) != 2 || page.Deliveries[0].ID != "dlv_2" || page.Deliveries[1].ID != "dlv_1" {
		t.Fatalf("session deliveries = %+v", page.Deliveries)
	}

	turns := f.asAlice(t, http.MethodGet, "/api/personal-agent/sessions/"+f.session.ID+"/channel", "")
	if turns.Code != http.StatusOK {
		t.Fatalf("session channel: %d %s", turns.Code, turns.Body)
	}
	var channel store.SessionChannel
	if err := json.Unmarshal(turns.Body.Bytes(), &channel); err != nil {
		t.Fatal(err)
	}
	if len(channel.Turns) != 2 || channel.Turns[1].Conversation.Name != "Ops" || !channel.Turns[1].SessionNew ||
		channel.Turns[1].Messages[0].Text != "first" || channel.Turns[1].Messages[0].Sender.Name != "张三" {
		t.Fatalf("turns = %+v", channel.Turns)
	}

	queued := f.asAlice(t, http.MethodPost, "/api/chats/"+f.session.ID+"/queue", `{"text":"hello"}`)
	if queued.Code != http.StatusConflict || !strings.Contains(queued.Body.String(), "takes input only from the openlark channel") {
		t.Fatalf("person input into a channel session: %d %s", queued.Code, queued.Body)
	}
	sent := f.asAlice(t, http.MethodPost, "/api/agent-sessions/"+f.session.ID+"/messages", `{"prompt":"hello"}`)
	if sent.Code != http.StatusConflict || !strings.Contains(sent.Body.String(), "takes input only from the openlark channel") {
		t.Fatalf("person message into a channel session: %d %s", sent.Code, sent.Body)
	}
}
