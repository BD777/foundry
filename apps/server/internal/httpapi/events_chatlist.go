package httpapi

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"log"
	"strings"
	"sync"

	"github.com/foundry-dev/foundry/apps/server/internal/browserevent"
	"github.com/foundry-dev/foundry/apps/server/internal/eventstream"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// The chat lists' messages.
var (
	chatsChangedEvent      = browserevent.Define[browserevent.ChatsChangedPayload](browserevent.ChatsChanged, eventstream.Options{})
	chatTitlesChangedEvent = browserevent.Define[browserevent.ChatTitlesChangedPayload](browserevent.ChatTitlesChanged, eventstream.Options{})
	chatLayoutChangedEvent = browserevent.Define[browserevent.ChatLayoutChangedPayload](browserevent.ChatLayoutChanged, eventstream.Options{})
	chatQueueChangedEvent  = browserevent.Define[store.ChatQueue](browserevent.ChatQueueChanged, eventstream.Options{})
)

// chatListEvents keeps the chat lists browsers hold current without reading
// them again: a workspace's chats (the chats field of GET
// /api/foundry-data), chat titles (GET /api/chat-titles), chat layout (GET
// /api/chat-layout) and each chat's queue (GET /api/chats/{id}/queue).
// Each event carries what changed when it is known; one that carries only
// the workspace says the list changed and is read again. Every event names
// its workspace, which routes it through each stream's access filter, and
// each list answers the same to everyone who may view the workspace.
type chatListEvents struct {
	stream eventstream.Publisher
	store  Backend
	data   *dataChanges
	// pushes remembers how each chat was last sent (see chatPushes).
	pushes chatPushes
	// announcing orders chat_titles_changed: each reads the titles it
	// carries and publishes them under it (see announcePickedTitles).
	announcing sync.Mutex
}

func newChatListEvents(stream eventstream.Publisher, db Backend, data *dataChanges) *chatListEvents {
	return &chatListEvents{stream: stream, store: db, data: data}
}

type chatsByIDStore interface {
	ListChatsByID(ctx context.Context, workspaceID string, ids []string) ([]store.ChatThread, error)
}

// chatPushes remembers how each chat was last sent (a digest of it as the
// list shows it, or that it was removed), so a sync that changed only what
// the list leaves out (a transcript, recent messages) or reports a chat
// already removed sends nothing.
type chatPushes struct {
	mu   sync.Mutex
	sent map[string][sha256.Size]byte
	// publishing orders pushes: each reads the chats after the change it
	// follows and publishes before the next one reads, so a chat's last
	// push is never older than an earlier one (an adoption racing a sync).
	publishing sync.Mutex
}

// chatPushEntries bounds chatPushes; past it, chats are sent once more.
const chatPushEntries = 8192

var removedChatDigest = sha256.Sum256([]byte("removed"))

// changes is what sending chats ids of workspaceID as listed (the ones the
// list shows) adds to what was sent before; nil when nothing.
func (p *chatPushes) changes(workspaceID string, ids []string, listed []store.ChatThread) *browserevent.ChatsChangedPayload {
	shown := make(map[string]store.ChatThread, len(listed))
	for _, chat := range listed {
		shown[chat.ID] = chat
	}
	change := browserevent.ChatsChangedPayload{WorkspaceID: workspaceID, Chats: []store.ChatThread{}, Removed: []string{}}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.sent == nil || len(p.sent) >= chatPushEntries {
		p.sent = make(map[string][sha256.Size]byte)
	}
	for _, id := range ids {
		key := workspaceID + "\n" + id
		chat, ok := shown[id]
		digest := removedChatDigest
		if ok {
			encoded, err := json.Marshal(chat)
			if err != nil {
				continue
			}
			digest = sha256.Sum256(encoded)
		}
		if previous, found := p.sent[key]; found && previous == digest {
			continue
		}
		p.sent[key] = digest
		if ok {
			change.Chats = append(change.Chats, chat)
		} else {
			change.Removed = append(change.Removed, id)
		}
	}
	if len(change.Chats) == 0 && len(change.Removed) == 0 {
		return nil
	}
	return &change
}

// chatsChanged sends the workspace's viewers the given chats as its chat
// list shows them, or their removal (chats_changed), so they apply the
// change instead of reading the list: a device's chat sync runs every few
// seconds while a native chat grows, and each used to cost every viewer a
// read of all of foundry-data. False when they could not be read so; the
// caller announces a change to read instead.
func (e *chatListEvents) chatsChanged(ctx context.Context, workspaceID string, ids []string) bool {
	if workspaceID == "" {
		return false
	}
	ids = uniqueStrings(ids)
	if len(ids) == 0 {
		return true
	}
	e.pushes.publishing.Lock()
	defer e.pushes.publishing.Unlock()
	listed, err := e.store.ListChatsByID(ctx, workspaceID, ids)
	if err != nil {
		log.Printf("read synced chats of %s: %v", workspaceID, err)
		return false
	}
	if change := e.pushes.changes(workspaceID, ids, listed); change != nil {
		chatsChangedEvent.Publish(e.stream, eventstream.Route{Workspace: workspaceID}, *change)
	}
	return true
}

// chatsSynced sends what a device's chat sync changed in each workspace's
// chat list, announcing a read where it cannot.
func (e *chatListEvents) chatsSynced(ctx context.Context, input store.SyncChatsInput, changes store.DaemonChanges) {
	byWorkspace := map[string][]string{}
	for _, chat := range input.Chats {
		if chat.ID == "" {
			continue
		}
		workspaceID := chat.WorkspaceID
		if workspaceID == "" {
			workspaceID = input.WorkspaceID
		}
		byWorkspace[workspaceID] = append(byWorkspace[workspaceID], chat.ID)
	}
	for _, workspaceID := range changes.Workspaces {
		if _, synced := byWorkspace[workspaceID]; !synced && workspaceID != "" {
			e.data.changed(workspaceID, fieldChats)
		}
	}
	for workspaceID, ids := range byWorkspace {
		if !e.chatsChanged(ctx, workspaceID, ids) {
			e.data.changed(workspaceID, fieldChats)
		}
	}
}

func uniqueStrings(values []string) []string {
	seen := make(map[string]bool, len(values))
	unique := values[:0:0]
	for _, value := range values {
		if value != "" && !seen[value] {
			seen[value] = true
			unique = append(unique, value)
		}
	}
	return unique
}

// titlesChanged carries the entries of the changed chats as GET
// /api/chat-titles lists them, and the changed chats it no longer lists.
func (e *chatListEvents) titlesChanged(workspaceID string, titles []store.ChatTitle, removed []string) {
	chatTitlesChangedEvent.Publish(e.stream, eventstream.Route{Workspace: workspaceID}, browserevent.ChatTitlesChangedPayload{WorkspaceID: workspaceID, Titles: titles, Removed: removed})
}

// titlesStale says the workspace's titles changed: they are read again.
func (e *chatListEvents) titlesStale(workspaceID string) {
	e.titlesChanged(workspaceID, nil, nil)
}

// announceTitles announces the titles of chatIDs as listed now; only that
// the workspace's titles changed when there are none or they cannot be
// read.
func (e *chatListEvents) announceTitles(workspaceID string, chatIDs ...string) {
	if workspaceID = strings.TrimSpace(workspaceID); workspaceID == "" {
		return
	}
	if len(chatIDs) == 0 {
		e.announcing.Lock()
		defer e.announcing.Unlock()
		e.titlesStale(workspaceID)
		return
	}
	e.announcePickedTitles(workspaceID, func([]store.ChatTitle) []string { return chatIDs })
}

// announcePickedTitles announces the titles of the chats pick chooses from
// the workspace's titles as listed now; only that they changed when it
// chooses none or they cannot be read. Each announcement reads after the
// change it follows and publishes before the next one reads, so a chat's
// last announced entry is current.
func (e *chatListEvents) announcePickedTitles(workspaceID string, pick func(titles []store.ChatTitle) []string) {
	e.announcing.Lock()
	defer e.announcing.Unlock()
	titles, err := e.store.ListChatTitles(context.Background(), workspaceID)
	if err != nil {
		e.titlesStale(workspaceID)
		return
	}
	chatIDs := pick(titles)
	if len(chatIDs) == 0 {
		e.titlesStale(workspaceID)
		return
	}
	picked, removed := pickTitles(titles, chatIDs)
	e.titlesChanged(workspaceID, picked, removed)
}

// pickTitles picks chatIDs' entries from the workspace's titles, and the
// chats among them it does not list.
func pickTitles(titles []store.ChatTitle, chatIDs []string) ([]store.ChatTitle, []string) {
	listed := make(map[string]store.ChatTitle, len(titles))
	for _, title := range titles {
		listed[title.ChatID] = title
	}
	var picked []store.ChatTitle
	var removed []string
	seen := map[string]bool{}
	for _, chatID := range chatIDs {
		if chatID == "" || seen[chatID] {
			continue
		}
		seen[chatID] = true
		if title, ok := listed[chatID]; ok {
			picked = append(picked, title)
		} else {
			removed = append(removed, chatID)
		}
	}
	return picked, removed
}

// layoutChanged carries the workspace's chat layout as saved; a later
// revision supersedes it.
func (e *chatListEvents) layoutChanged(workspaceID string, layout store.ChatLayout) {
	if workspaceID = strings.TrimSpace(workspaceID); workspaceID != "" {
		chatLayoutChangedEvent.Publish(e.stream, eventstream.Route{Workspace: workspaceID}, browserevent.ChatLayoutChangedPayload{WorkspaceID: workspaceID, Layout: &layout})
	}
}

// layoutStale says the workspace's chat layout changed: it is read again.
func (e *chatListEvents) layoutStale(workspaceID string) {
	if workspaceID = strings.TrimSpace(workspaceID); workspaceID != "" {
		chatLayoutChangedEvent.Publish(e.stream, eventstream.Route{Workspace: workspaceID}, browserevent.ChatLayoutChangedPayload{WorkspaceID: workspaceID})
	}
}

// queueChanged carries a chat's queue as it is now.
func (e *chatListEvents) queueChanged(queue store.ChatQueue) {
	chatQueueChangedEvent.Publish(e.stream, eventstream.Route{Workspace: queue.WorkspaceID}, queue)
}

// announceQueue carries a chat's queue as it reads now.
func (e *chatListEvents) announceQueue(ctx context.Context, workspaceID, chatID string) {
	queue, err := e.store.ChatQueue(ctx, workspaceID, chatID)
	if err != nil {
		log.Printf("read chat queue %s: %v", chatID, err)
		return
	}
	e.queueChanged(queue)
}

// sessionCreated announces what creating a session changed in its
// workspace's chat list besides the session itself: a session that
// continues a device's native chat (named by chat id or native session id)
// takes over the chat's title and layout position, and a child of another
// chat is placed in that chat's group.
func (e *chatListEvents) sessionCreated(session store.AgentSession) {
	adopted := session.AdoptedChatID != ""
	if adopted {
		e.announceTitles(session.WorkspaceID, session.ID, session.AdoptedChatID)
	}
	if adopted || (strings.TrimSpace(session.ParentSessionID) != "" && session.IssueID == "") {
		// A later change announces a later revision, which supersedes this.
		if layout, err := e.store.GetChatLayout(context.Background(), session.WorkspaceID); err == nil {
			e.layoutChanged(session.WorkspaceID, layout)
		} else {
			e.layoutStale(session.WorkspaceID)
		}
	}
	if adopted {
		// The chat list stops showing the native chat the session took over.
		e.chatsChanged(context.Background(), session.WorkspaceID, []string{session.AdoptedChatID})
	}
}
