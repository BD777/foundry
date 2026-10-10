package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// Browsers read a workspace's chat titles (GET /api/chat-titles) and chat
// layout (GET /api/chat-layout) once, then keep them from these events,
// which carry what changed when the publisher knows it. An event with only
// the workspace says the list changed: it is read again. The workspace also
// routes each event through every stream's access filter, and both lists
// answer the same to everyone who may view the workspace.
const (
	chatTitlesChangedEvent = "chat_titles_changed"
	chatLayoutChangedEvent = "chat_layout_changed"
)

type chatListChange struct {
	WorkspaceID string `json:"workspaceId"`
}

// chatTitlesChange is chat_titles_changed: the changed chats' entries as
// GET /api/chat-titles lists them (Titles), and the changed chats it no
// longer lists (Removed).
type chatTitlesChange struct {
	WorkspaceID string            `json:"workspaceId"`
	Titles      []store.ChatTitle `json:"titles,omitempty"`
	Removed     []string          `json:"removed,omitempty"`
}

// chatLayoutChange is chat_layout_changed: the layout as GET
// /api/chat-layout answers it; a later revision supersedes it.
type chatLayoutChange struct {
	WorkspaceID string            `json:"workspaceId"`
	Layout      *store.ChatLayout `json:"layout,omitempty"`
}

// publishChatTitlesChanged announces the titles of chatIDs, or, without
// any, that the workspace's titles changed.
func (s *Server) publishChatTitlesChanged(workspaceID string, chatIDs ...string) {
	if workspaceID = strings.TrimSpace(workspaceID); workspaceID != "" {
		s.titles.publishTitles(workspaceID, chatIDs)
	}
}

// publishChatLayoutChanged announces the workspace's layout as saved, or,
// with nil, that it changed.
func (s *Server) publishChatLayoutChanged(workspaceID string, layout *store.ChatLayout) {
	if workspaceID = strings.TrimSpace(workspaceID); workspaceID != "" {
		s.events.Publish(chatLayoutChangedEvent, chatLayoutChange{WorkspaceID: workspaceID, Layout: layout})
	}
}

// publishTitles announces the titles of chatIDs as listed now (only that
// the workspace's titles changed when there are none or they cannot be
// read). Each announcement reads after the change it follows and publishes
// before the next one reads, so a chat's last announced entry is current.
func (t *chatTitleService) publishTitles(workspaceID string, chatIDs []string) {
	t.announcing.Lock()
	defer t.announcing.Unlock()
	change := chatTitlesChange{WorkspaceID: workspaceID}
	if len(chatIDs) > 0 {
		if titles, err := t.store.ListChatTitles(context.Background(), workspaceID); err == nil {
			change = titlesChange(workspaceID, titles, chatIDs)
		}
	}
	t.publish(chatTitlesChangedEvent, change)
}

// publishJobTitle announces the title of the chat a naming job names. A
// job's events do not name its chat: while it runs, the chat's title names
// the job; once it completed, jobChats remembers the chat.
func (t *chatTitleService) publishJobTitle(job store.AgentSession) {
	t.announcing.Lock()
	defer t.announcing.Unlock()
	change := chatTitlesChange{WorkspaceID: job.WorkspaceID}
	if titles, err := t.store.ListChatTitles(context.Background(), job.WorkspaceID); err == nil {
		chatID := t.jobChats[job.ID]
		for _, title := range titles {
			if title.GenerationSessionID == job.ID {
				chatID = title.ChatID
				break
			}
		}
		switch job.Status {
		case "completed", "failed", "canceled":
			delete(t.jobChats, job.ID)
		default:
			if chatID != "" {
				if t.jobChats == nil {
					t.jobChats = map[string]string{}
				}
				t.jobChats[job.ID] = chatID
			}
		}
		if chatID != "" {
			change = titlesChange(job.WorkspaceID, titles, []string{chatID})
		}
	}
	t.publish(chatTitlesChangedEvent, change)
}

// titlesChange picks chatIDs' entries from the workspace's titles.
func titlesChange(workspaceID string, titles []store.ChatTitle, chatIDs []string) chatTitlesChange {
	change := chatTitlesChange{WorkspaceID: workspaceID}
	listed := make(map[string]store.ChatTitle, len(titles))
	for _, title := range titles {
		listed[title.ChatID] = title
	}
	seen := map[string]bool{}
	for _, chatID := range chatIDs {
		if chatID == "" || seen[chatID] {
			continue
		}
		seen[chatID] = true
		if title, ok := listed[chatID]; ok {
			change.Titles = append(change.Titles, title)
		} else {
			change.Removed = append(change.Removed, chatID)
		}
	}
	return change
}

// writeCacheableResult answers a list the browser keeps current from
// events with an ETag: reading it again unchanged costs no body.
func writeCacheableResult(w http.ResponseWriter, r *http.Request, payload any, err error) {
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	body, err := json.Marshal(payload)
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	writeCacheableJSON(w, r, body)
}

// onChatTitleJobEvent follows a chat-naming job's session events: the title
// list shows the job's state (queued, running, failed) and, once it
// completes, the title it wrote.
func (s *Server) onChatTitleJobEvent(eventType string, payload any) {
	if !strings.HasPrefix(eventType, "agent_session_") || eventType == sessionEventStreamType {
		return
	}
	session, ok := payload.(store.AgentSession)
	if pointer, isPointer := payload.(*store.AgentSession); isPointer && pointer != nil {
		session, ok = *pointer, true
	}
	if !ok || session.Source != "naming" || strings.TrimSpace(session.GroupNameTarget) != "" || strings.TrimSpace(session.WorkspaceID) == "" {
		return
	}
	s.titles.publishJobTitle(session)
}

// publishCreatedSessionChatList announces what creating a session changed
// in its workspace's chat list besides the session itself: a session that
// continues a device's native chat (named by chat id or native session id)
// takes over the chat's title and layout position, and a child of another
// chat is placed in that chat's group.
func (s *Server) publishCreatedSessionChatList(session store.AgentSession) {
	adopted := session.AdoptedChatID != ""
	if adopted {
		s.publishChatTitlesChanged(session.WorkspaceID, session.ID, session.AdoptedChatID)
	}
	if adopted || (strings.TrimSpace(session.ParentSessionID) != "" && session.IssueID == "") {
		// A later change announces a later revision, which supersedes this.
		var layout *store.ChatLayout
		if saved, err := s.store.GetChatLayout(context.Background(), session.WorkspaceID); err == nil {
			layout = &saved
		}
		s.publishChatLayoutChanged(session.WorkspaceID, layout)
	}
	if adopted {
		// The chat list stops showing the native chat the session took over.
		s.events.pushChats(context.Background(), s.store, session.WorkspaceID, []string{session.AdoptedChatID})
	}
}

// deviceForEvent is the device as foundry-data lists it to a viewer who does
// not own it: a device event reaches every viewer of the device's workspace,
// so what only its owner sees (runtimeSettings) and what depends on the
// viewer (owned) stay out.
func (s *Server) deviceForEvent(ctx context.Context, deviceID string) (store.DeviceProjection, bool) {
	devices, err := s.store.ListDevices(ctx)
	if err != nil {
		return store.DeviceProjection{}, false
	}
	for _, device := range devices {
		if device.ID != deviceID {
			continue
		}
		listed := s.hub.withDisconnects(s.withWorkerUpdates([]store.DeviceProjection{device}))[0]
		listed.RuntimeSettings = nil
		listed.Owned = false
		return listed, true
	}
	return store.DeviceProjection{}, false
}
