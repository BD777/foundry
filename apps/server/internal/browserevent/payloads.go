package browserevent

import "github.com/foundry-dev/foundry/apps/server/internal/store"

// The payloads below are the ones no store model carries. Whoever publishes
// a message routes it (eventstream.Route), mostly to its workspace's
// viewers; a WorkspaceID field tells clients that workspace.

// AgentSubagentUpdatedPayload carries one subagent of a session as the
// session's list (digests, as a chat reads it) shows it when it starts, so
// viewers read the list once and then apply these. Without a subagent it
// says only that the list may have changed (a task of unknown type, or
// subagents that ended): viewers holding the list read it again.
type AgentSubagentUpdatedPayload struct {
	WorkspaceID string                     `json:"workspaceId"`
	SessionID   string                     `json:"sessionId"`
	Subagent    *store.AgentSubagentDigest `json:"subagent,omitempty"`
}

// BackgroundTaskOutputChangedPayload tells a session's viewers that the log
// of one of its background tasks changed while a reader follows it: readers
// read what was added. It carries no output, which only members may read.
type BackgroundTaskOutputChangedPayload struct {
	WorkspaceID string `json:"workspaceId"`
	SessionID   string `json:"sessionId"`
	TaskID      string `json:"taskId"`
}

// IssueEnvironmentChangedPayload tells an Issue's viewers that what its
// environment status read returns changed on the device: they read it
// again. Without IssueID every Issue of the workspace may read differently
// (its repositories changed).
type IssueEnvironmentChangedPayload struct {
	WorkspaceID string `json:"workspaceId"`
	IssueID     string `json:"issueId,omitempty"`
}

// EvidenceUpdatedPayload tells an Issue's viewers that one of its evidence
// records (contract, verification, review, material…) changed: EntityID at
// Version now has Status.
type EvidenceUpdatedPayload struct {
	IssueID     string `json:"issueId"`
	WorkspaceID string `json:"workspaceId"`
	EntityID    string `json:"entityId"`
	Version     int    `json:"version"`
	Status      string `json:"status"`
}

// DeviceStatusChangedPayload tells browsers a device went online or
// offline, or otherwise changed (its worker update moved on), so device
// lists change at once instead of at their next read.
type DeviceStatusChangedPayload struct {
	WorkspaceID string `json:"workspaceId"`
	DeviceID    string `json:"deviceId"`
	Status      string `json:"status"`
	// Device is the device as workspace data lists it to a viewer who does
	// not own it (no runtimeSettings, no owned), so a client can replace
	// its copy and keep only those two fields of its own.
	Device *store.DeviceProjection `json:"device,omitempty"`
}

// WorkspaceMembersUpdatedPayload says who may use the workspace changed.
type WorkspaceMembersUpdatedPayload struct {
	WorkspaceID string `json:"workspaceId"`
}

// FoundryDataChangedPayload tells clients that what GET /api/foundry-data
// returns changed in a way no other message carries, so they read it again.
// An empty WorkspaceID stands for what every workspace's view shows
// (devices, provider health and agent profiles, connections, the skill
// catalog); it reaches every stream, as it carries no data. Resources names
// the foundry-data fields the change touched (clients read only those);
// without it the change may touch any.
type FoundryDataChangedPayload struct {
	WorkspaceID string   `json:"workspaceId"`
	Resources   []string `json:"resources,omitempty"`
}

// ChatsChangedPayload carries chats of a workspace's chat list (the chats
// field of GET /api/foundry-data) as that list shows them, and the ids of
// chats it no longer shows, so clients apply a change instead of reading
// the list.
type ChatsChangedPayload struct {
	WorkspaceID string             `json:"workspaceId"`
	Chats       []store.ChatThread `json:"chats"`
	Removed     []string           `json:"removed"`
}

// ChatTitlesChangedPayload carries the changed chats' entries as GET
// /api/chat-titles lists them (Titles), and the changed chats it no longer
// lists (Removed). With neither, the workspace's titles changed: they are
// read again.
type ChatTitlesChangedPayload struct {
	WorkspaceID string            `json:"workspaceId"`
	Titles      []store.ChatTitle `json:"titles,omitempty"`
	Removed     []string          `json:"removed,omitempty"`
}

// ChatLayoutChangedPayload carries the workspace's chat layout as GET
// /api/chat-layout answers it; a later revision supersedes it. Without a
// layout, the layout changed: it is read again.
type ChatLayoutChangedPayload struct {
	WorkspaceID string            `json:"workspaceId"`
	Layout      *store.ChatLayout `json:"layout,omitempty"`
}

// StreamReadyPayload is empty: a stream_ready message says only where the
// stream resumes from (its id).
type StreamReadyPayload struct{}

// ResyncReason says why a stream missed events.
type ResyncReason string

const (
	// ResyncOverflow: the stream fell behind and its buffer overflowed.
	ResyncOverflow ResyncReason = "overflow"
	// ResyncExpired: the events it missed are no longer kept for replay.
	ResyncExpired ResyncReason = "expired"
	// ResyncRestarted: the server restarted since the stream's last event,
	// or the stream resumed from an id it did not send.
	ResyncRestarted ResyncReason = "restarted"
	// ResyncReauthorized: the account's access changed after the stream's
	// last event, so what it may see changed too.
	ResyncReauthorized ResyncReason = "reauthorized"
)

// ResyncPayload says why the stream missed events.
type ResyncPayload struct {
	Reason ResyncReason `json:"reason"`
}
