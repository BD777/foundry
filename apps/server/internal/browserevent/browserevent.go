// Package browserevent is the vocabulary of the browser event stream
// (GET /api/events): the name of every message, the payload it carries and
// which messages are notices. Each message is an envelope {"type": name,
// "payload": payload}. The code that owns a message defines its kind here
// (Define), which ties the name to its payload, and publishes only through
// that kind.
//
// packages/protocol/src/browser-events.ts declares the same for clients.
// scripts/audit-contract.mjs keeps the names, each name's payload type, the
// notices and the payloads' fields of both sides in step, and
// packages/protocol/test/browser-event-fixtures.json holds one example of
// each message that both sides' tests read.
package browserevent

import (
	"fmt"
	"reflect"
	"sort"

	"github.com/foundry-dev/foundry/apps/server/internal/eventstream"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// Type names a message of the stream: its envelope's "type".
type Type string

// Agent sessions. The session events carry the whole session without its
// transcript, which travels one entry at a time as AgentSessionEvent.
const (
	AgentSessionCreated         Type = "agent_session_created"
	AgentSessionStarted         Type = "agent_session_started"
	AgentSessionBlocked         Type = "agent_session_blocked"
	AgentSessionResumed         Type = "agent_session_resumed"
	AgentSessionNativeSessionID Type = "agent_session_native_session_id"
	AgentSessionCompleted       Type = "agent_session_completed"
	AgentSessionEvent           Type = "agent_session_event"
	AgentSubagentUpdated        Type = "agent_subagent_updated"
	BackgroundTaskOutputChanged Type = "background_task_output_changed"
)

// Issues and their evidence.
const (
	IssueCreated            Type = "issue_created"
	IssueUpdated            Type = "issue_updated"
	IssueRunEvent           Type = "issue_run_event"
	IssueEnvironmentChanged Type = "issue_environment_changed"
	EvidenceUpdated         Type = "evidence_updated"
)

// Devices and workspaces.
const (
	DeviceStatusChanged     Type = "device_status_changed"
	FeishuBotUpdated        Type = "feishu_bot_updated"
	WorkspaceMembersUpdated Type = "workspace_members_updated"
	FoundryDataChanged      Type = "foundry_data_changed"
)

// The resource inventory (GET /api/resources).
const (
	ResourcesChanged Type = "resources_changed"
)

// A workspace's chat list.
const (
	ChatsChanged      Type = "chats_changed"
	ChatQueueChanged  Type = "chat_queue_changed"
	ChatTitlesChanged Type = "chat_titles_changed"
	ChatLayoutChanged Type = "chat_layout_changed"
)

// The stream itself: messages about delivery, not about data.
const (
	// StreamReady is the first message of a stream that resumes from
	// nowhere; it carries only its id, the newest event's.
	StreamReady Type = "stream_ready"
	// Resync tells a stream it missed events: what it derived from them is
	// read again.
	Resync Type = "resync"
)

// payloadTypes is the payload each message carries; browser-events.ts
// declares the same as BrowserEventPayloads and
// BrowserStreamControlPayloads.
var payloadTypes = map[Type]reflect.Type{
	AgentSessionCreated:         reflect.TypeFor[store.AgentSession](),
	AgentSessionStarted:         reflect.TypeFor[store.AgentSession](),
	AgentSessionBlocked:         reflect.TypeFor[store.AgentSession](),
	AgentSessionResumed:         reflect.TypeFor[store.AgentSession](),
	AgentSessionNativeSessionID: reflect.TypeFor[store.AgentSession](),
	AgentSessionCompleted:       reflect.TypeFor[store.AgentSession](),
	AgentSessionEvent:           reflect.TypeFor[store.AgentSessionEvent](),
	AgentSubagentUpdated:        reflect.TypeFor[AgentSubagentUpdatedPayload](),
	BackgroundTaskOutputChanged: reflect.TypeFor[BackgroundTaskOutputChangedPayload](),
	IssueCreated:                reflect.TypeFor[store.Issue](),
	IssueUpdated:                reflect.TypeFor[store.Issue](),
	IssueRunEvent:               reflect.TypeFor[store.RunEvent](),
	IssueEnvironmentChanged:     reflect.TypeFor[IssueEnvironmentChangedPayload](),
	EvidenceUpdated:             reflect.TypeFor[EvidenceUpdatedPayload](),
	DeviceStatusChanged:         reflect.TypeFor[DeviceStatusChangedPayload](),
	FeishuBotUpdated:            reflect.TypeFor[store.WorkspaceFeishuBot](),
	WorkspaceMembersUpdated:     reflect.TypeFor[WorkspaceMembersUpdatedPayload](),
	FoundryDataChanged:          reflect.TypeFor[FoundryDataChangedPayload](),
	ResourcesChanged:            reflect.TypeFor[ResourcesChangedPayload](),
	ChatsChanged:                reflect.TypeFor[ChatsChangedPayload](),
	ChatQueueChanged:            reflect.TypeFor[store.ChatQueue](),
	ChatTitlesChanged:           reflect.TypeFor[ChatTitlesChangedPayload](),
	ChatLayoutChanged:           reflect.TypeFor[ChatLayoutChangedPayload](),
	StreamReady:                 reflect.TypeFor[StreamReadyPayload](),
	Resync:                      reflect.TypeFor[ResyncPayload](),
}

// notices are the messages that change nothing GET /api/foundry-data
// serves: each tells the one feature reading what it names that a read is
// due. browser-events.ts declares the same as browserNoticeTypes.
var notices = map[Type]bool{
	IssueEnvironmentChanged:     true,
	BackgroundTaskOutputChanged: true,
	ResourcesChanged:            true,
}

// Notice reports whether t is a notice (see notices).
func (t Type) Notice() bool {
	return notices[t]
}

// Define is the kind of message t, which carries P. It panics, where kinds
// are defined (package initialization), when P is not the payload t
// carries, or when t is a notice whose kind would invalidate snapshots.
func Define[P any](t Type, options eventstream.Options) eventstream.Kind[P] {
	if want, got := PayloadType(t), reflect.TypeFor[P](); want != got {
		panic(fmt.Sprintf("browserevent: %q carries %v, not %v", t, want, got))
	}
	if t.Notice() && !options.KeepsSnapshot {
		panic(fmt.Sprintf("browserevent: %q is a notice, which keeps snapshots", t))
	}
	return eventstream.Define[P](t, options)
}

// PayloadType is the type of the payload a message of type t carries; nil
// for a name the stream does not use.
func PayloadType(t Type) reflect.Type {
	return payloadTypes[t]
}

// Types lists every message name, sorted.
func Types() []Type {
	types := make([]Type, 0, len(payloadTypes))
	for t := range payloadTypes {
		types = append(types, t)
	}
	sort.Slice(types, func(i, j int) bool { return types[i] < types[j] })
	return types
}
