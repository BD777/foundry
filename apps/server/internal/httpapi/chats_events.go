package httpapi

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"log"
	"sync"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// chatsChangedEvent carries chats of a workspace's chat list (the chats
// field of GET /api/foundry-data) as that list shows them, and the ids of
// chats it no longer shows, so clients apply a change instead of reading
// the list. A device's chat sync runs every few seconds while a native chat
// grows; each used to cost every viewer a read of all of foundry-data.
const chatsChangedEvent = "chats_changed"

type chatsChange struct {
	WorkspaceID string             `json:"workspaceId"`
	Chats       []store.ChatThread `json:"chats"`
	Removed     []string           `json:"removed"`
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
func (p *chatPushes) changes(workspaceID string, ids []string, listed []store.ChatThread) *chatsChange {
	shown := make(map[string]store.ChatThread, len(listed))
	for _, chat := range listed {
		shown[chat.ID] = chat
	}
	change := chatsChange{WorkspaceID: workspaceID, Chats: []store.ChatThread{}, Removed: []string{}}
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

// pushChats sends the workspace's viewers the given chats as its chat list
// shows them, or their removal. False when the store cannot read them so;
// the caller announces a change to read instead.
func (h *browserEventHub) pushChats(ctx context.Context, db store.Store, workspaceID string, ids []string) bool {
	lister, ok := db.(chatsByIDStore)
	if !ok || workspaceID == "" {
		return false
	}
	ids = uniqueStrings(ids)
	if len(ids) == 0 {
		return true
	}
	h.chatPushes.publishing.Lock()
	defer h.chatPushes.publishing.Unlock()
	listed, err := lister.ListChatsByID(ctx, workspaceID, ids)
	if err != nil {
		log.Printf("read synced chats of %s: %v", workspaceID, err)
		return false
	}
	if change := h.chatPushes.changes(workspaceID, ids, listed); change != nil {
		h.Publish(chatsChangedEvent, *change)
	}
	return true
}

// pushSyncedChats sends what a device's chat sync changed in each
// workspace's chat list, announcing a read where it cannot.
func (h *browserEventHub) pushSyncedChats(ctx context.Context, db store.Store, input store.SyncChatsInput, changes store.DaemonChanges) {
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
			h.dataChanged(workspaceID, fieldChats)
		}
	}
	for workspaceID, ids := range byWorkspace {
		if !h.pushChats(ctx, db, workspaceID, ids) {
			h.dataChanged(workspaceID, fieldChats)
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
