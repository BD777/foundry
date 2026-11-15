package httpapi

import (
	"context"
	"net/http"
	"sort"
	"strconv"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// Message channel read endpoints (DEV-234): a channel's source
// conversations and their sessions, the deliveries of one conversation or
// session, and one session's channel turns. The person's own API only.

// handleMessageChannelConversations lists a channel's source conversations,
// newest activity first, each with its sessions.
func (s *Server) handleMessageChannelConversations(w http.ResponseWriter, r *http.Request) {
	_, record, st, ok := s.messageChannelOf(w, r)
	if !ok {
		return
	}
	ctx := r.Context()
	summaries, next, err := st.MessageChannelConversations(ctx, record.ID, r.URL.Query().Get("cursor"), 20)
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	list := store.MessageChannelConversationList{
		Conversations: []store.MessageChannelConversation{}, NextCursor: next,
	}
	for _, summary := range summaries {
		records, err := st.MessageChannelConversationDeliveries(ctx, record.ID, summary.SessionKey)
		if err != nil {
			writeResult(w, nil, err)
			return
		}
		list.Conversations = append(list.Conversations, s.messageChannelConversation(ctx, summary, records))
	}
	writeJSON(w, http.StatusOK, list)
}

// messageChannelConversation is one conversation's latest message, counts
// and sessions, newest first.
func (s *Server) messageChannelConversation(ctx context.Context, summary store.MessageChannelConversationSummary, records []store.MessageChannelDeliveryRecord) store.MessageChannelConversation {
	conversation := store.MessageChannelConversation{
		SessionKey: summary.SessionKey, LastAt: summary.LastAt,
		MessageCount: len(records), Sessions: []store.MessageChannelConversationSession{},
	}
	if len(records) == 0 {
		return conversation
	}
	last := records[len(records)-1]
	// The newest message names the conversation; an older one may predate
	// the source giving it a name.
	conversation.Conversation = last.Envelope.Conversation
	if conversation.Conversation.Name == "" {
		for index := len(records) - 2; index >= 0; index-- {
			if name := records[index].Envelope.Conversation.Name; name != "" {
				conversation.Conversation.Name = name
				break
			}
		}
	}
	conversation.LastSender = last.Envelope.Sender
	if lastAt := last.Envelope.OccurredAt; lastAt != "" {
		conversation.LastAt = lastAt
	}
	if conversation.LastAt == "" {
		conversation.LastAt = last.CreatedAt
	}
	for _, record := range records {
		if record.Status != store.MessageDeliveryDropped {
			conversation.MatchedCount++
		}
	}
	type segment struct {
		session store.MessageChannelConversationSession
		key     string
	}
	segments := map[string]*segment{}
	for _, record := range records {
		key := record.SessionID
		if key == "" {
			key = "segment:" + strconv.Itoa(record.Segment)
		}
		item := segments[key]
		if item == nil {
			item = &segment{key: key, session: store.MessageChannelConversationSession{
				SessionID: record.SessionID, Segment: record.Segment, StartedAt: record.CreatedAt,
			}}
			segments[key] = item
		}
		item.session.MessageCount++
		if at := record.Envelope.OccurredAt; at != "" {
			item.session.LastAt = at
		} else {
			item.session.LastAt = record.CreatedAt
		}
		if record.SessionNew {
			item.session.New, item.session.Reason = true, record.NewReason
		}
	}
	for _, item := range segments {
		if item.session.SessionID != "" {
			if session, err := s.store.GetAgentSessionSummary(ctx, item.session.SessionID); err == nil {
				item.session.Status, item.session.Title = session.Status, session.Title
			}
		}
		conversation.Sessions = append(conversation.Sessions, item.session)
	}
	sort.SliceStable(conversation.Sessions, func(i, j int) bool {
		return conversation.Sessions[i].StartedAt > conversation.Sessions[j].StartedAt
	})
	conversation.SessionCount = len(conversation.Sessions)
	return conversation
}

// handleSessionChannel is one session's message channel turns, oldest
// first, for the chat's origin headers.
func (s *Server) handleSessionChannel(w http.ResponseWriter, r *http.Request) {
	person := s.personFrom(r)
	st, err := s.messageChannelStore()
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	ctx := r.Context()
	sessionID := r.PathValue("session")
	session, err := s.store.GetAgentSessionSummary(ctx, sessionID)
	if err != nil || person == nil || session.CreatedByUserID != person.ID {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	records, err := st.MessageChannelSessionDeliveries(ctx, sessionID)
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	if len(records) == 0 {
		writeError(w, http.StatusNotFound, "not a message channel session")
		return
	}
	channel, err := st.GetMessageChannel(ctx, records[0].ChannelID)
	if err != nil || channel.UserID != person.ID {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	writeJSON(w, http.StatusOK, store.SessionChannel{SessionID: sessionID, Turns: s.messageChannelTurns(ctx, channel, records)})
}

// messageChannelTurns groups a session's records by the hand-over that made
// them, oldest first.
func (s *Server) messageChannelTurns(ctx context.Context, channel store.MessageChannelRecord, records []store.MessageChannelDeliveryRecord) []store.MessageChannelOrigin {
	turns := []store.MessageChannelOrigin{}
	byInbox := map[string]int{}
	for _, record := range records {
		key := record.InboxID
		if key == "" {
			key = "record:" + record.ID
		}
		index, seen := byInbox[key]
		if !seen {
			index = len(turns)
			byInbox[key] = index
			first := record
			turns = append(turns, store.MessageChannelOrigin{
				ChannelID: channel.ID, ChannelName: channel.Name, Source: channel.Source.Kind,
				Conversation: first.Envelope.Conversation, Thread: first.Envelope.Thread,
				Segment: first.Segment, SessionNew: first.SessionNew, NewReason: first.NewReason,
				At: first.CreatedAt, Messages: []store.MessageChannelOriginMessage{},
			})
			if record.InboxID != "" {
				if entry, err := s.store.GetPersonalAgentInbox(ctx, channel.AssistantID, record.InboxID); err == nil {
					turns[index].At = entry.CreatedAt
				}
			}
		}
		id := record.Envelope.MessageID
		if id == "" {
			id = record.Envelope.ID
		}
		turns[index].Messages = append(turns[index].Messages, store.MessageChannelOriginMessage{
			ID: id, At: record.Envelope.OccurredAt, Sender: record.Envelope.Sender,
			Text: record.Envelope.Text, TextTruncated: record.Envelope.TextTruncated,
			Status: record.Status, Rule: record.Rule,
		})
	}
	return turns
}

// messageChannelSessionOf reports the channel a session belongs to, if any.
func (s *Server) messageChannelSessionOf(ctx context.Context, sessionID string) (store.MessageChannelRecord, bool) {
	st, ok := s.store.(store.MessageChannelStore)
	if !ok || sessionID == "" {
		return store.MessageChannelRecord{}, false
	}
	channel, err := st.MessageChannelOfSession(ctx, sessionID)
	if err != nil {
		return store.MessageChannelRecord{}, false
	}
	return channel, true
}

// refusePersonChannelInput rejects a person's message to a channel session:
// its input comes only from the channel (DEV-234). Foundry's own hand-overs
// (the channel inbox) never take this path; a helper report names the session
// that sent it.
func (s *Server) refusePersonChannelInput(w http.ResponseWriter, r *http.Request, sessionID, sentBySessionID string) bool {
	if sentBySessionID != "" {
		return false
	}
	channel, ok := s.messageChannelSessionOf(r.Context(), sessionID)
	if !ok {
		return false
	}
	source := channel.Source.Kind
	if source == "" {
		source = channel.Name
	}
	writeError(w, http.StatusConflict, "this conversation takes input only from the "+source+" channel")
	return true
}
