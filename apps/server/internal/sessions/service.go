package sessions

import (
	"context"
	"sync"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// Store is what the service keeps of sessions, their inputs and inboxes.
type Store interface {
	store.Store
	store.SessionRecordStore
	store.SessionAdoptionStore
	store.QueuedAgentSessionStore
	store.SessionInputSenderStore
	store.SessionInboxStore
	store.SessionEventWindowStore
	store.ChildReportStore
	store.WorkStore
	store.SessionDelegationStore
}

// Steer is a message moved into a session's running turn. Its fields are
// the device's steer_session payload's.
type Steer struct {
	SentBySessionID string
	Message         string
	Attachments     []store.ChatAttachment
	SessionID       string
	// InputID is the message's id (a queued message's): a worker that
	// already applied a steer with it answers without applying it again,
	// and names its transcript event evt_<InputID>.
	InputID string
	// Delivery is when a message from another session enters the turn
	// (store.DeliveryInterrupt or DeliveryBoundary); empty is the
	// runtime's own way, a person's. BoundaryLimitMs bounds how long a
	// boundary message waits.
	Delivery        string
	BoundaryLimitMs int64
}

// DeviceLink is how a device is connected, as the start notices read it.
type DeviceLink struct {
	Connected   bool
	ConnectedAt time.Time
	// Lag is how late what the device sends reaches the server.
	Lag time.Duration
	// RunnerReported says the device reported its session runner:
	// RunnerState ("pending", "switching", …) and the turns it holds for
	// an updated one (HeldTurns).
	RunnerReported bool
	RunnerState    string
	HeldTurns      int
}

// Devices is the server's link to devices; httpapi's device hub
// implements it.
type Devices interface {
	// Connected reports whether the device is connected.
	Connected(deviceID string) bool
	// WaitConnected waits while the device is reconnecting and reports its
	// connection, immediate offline, cancellation, or reconnect timeout.
	WaitConnected(ctx context.Context, deviceID string) error
	// Link is how the device is connected now.
	Link(deviceID string) DeviceLink
	// Label is the device's name as people know it.
	Label(ctx context.Context, deviceID string) string
	// Dispatch hands the session's queued input to its device.
	Dispatch(session store.AgentSession) error
	// Steer moves a message into the session's running turn; a device
	// without one answers ErrNotSteerable.
	Steer(ctx context.Context, session store.AgentSession, steer Steer) error
	// Cancel stops the session on its device. answered reports that the
	// turn had already answered: the device completes it with that answer.
	Cancel(ctx context.Context, session store.AgentSession) (answered bool, err error)
	// NoAnswer reports whether err is the device not answering in time.
	NoAnswer(err error) bool
}

// Policy is what the server decides around a session's start and
// messages, outside the session domain: workspaces, the person's
// assistant, accounts, Issues; httpapi implements it.
type Policy interface {
	// Reconcile fails the session when its device stopped reporting it
	// (recovered), settling what follows from that.
	Reconcile(ctx context.Context, session store.AgentSession) (store.AgentSession, bool, error)
	// ArchivedWorkspace refuses work in an archived workspace.
	ArchivedWorkspace(ctx context.Context, workspaceID string) error
	// UnservedWorkspace says why the workspace's device does not serve it.
	UnservedWorkspace(ctx context.Context, workspaceID string) error
	// MovingWorkspace refuses work in a workspace moving to another device;
	// what waits for it keeps waiting.
	MovingWorkspace(ctx context.Context, workspaceID string) error
	// RequireVerifierDevice refuses a verifier its device cannot sandbox.
	RequireVerifierDevice(ctx context.Context, input store.CreateAgentSessionInput) error
	// AdmitAssistantSession is what a new session owes the person's
	// assistant; delegating: the assistant hands it off, and follows it
	// (RecordAssistantTask).
	AdmitAssistantSession(ctx context.Context, input store.CreateAgentSessionInput) (agent store.PersonalAgent, delegating bool, err error)
	RecordAssistantTask(ctx context.Context, agent store.PersonalAgent, conversationID string, session store.AgentSession)
	// AdmitAssistantTurn refuses a turn of the assistant past its limits.
	AdmitAssistantTurn(ctx context.Context, session store.AgentSession) error
	// ChooseSessionAccount pins the account a new session naming no
	// profile runs under: one that works on its device.
	ChooseSessionAccount(ctx context.Context, input *store.CreateAgentSessionInput) error
	// ChooseRuntimeSwitch pins the account of a message that names only
	// a runtime.
	ChooseRuntimeSwitch(ctx context.Context, session store.AgentSession, input *store.SendAgentSessionInput) error
}

// Chats is the chat list sessions appear in.
type Chats interface {
	// Created adds a new session to its workspace's chat list.
	Created(session store.AgentSession, adoptedChatID string)
	// AnnounceQueue tells the chat's viewers its queued messages.
	AnnounceQueue(ctx context.Context, workspaceID, chatID string)
	// NameGroup starts naming an orchestration group the session created,
	// in the background, which shutdown waits for; a failure keeps its
	// placeholder name.
	NameGroup(workspaceID, groupID, parentSessionID string)
}

// Ports are what the service reaches outside the session domain.
type Ports struct {
	Devices Devices
	Policy  Policy
	Chats   Chats
	// Work serializes a session that starts under a parent with automatic
	// work's dispatch and control: a completed stop cannot race a new fire.
	Work sync.Locker
}

// Service is the session lifecycle: sessions start and are handed to their
// devices (or wait for them), take messages, stop, and exchange messages
// through their inboxes. Whoever asks (REST, MCP, the chat queue, timers,
// Feishu, the assistant) goes through it. Its signatures carry no HTTP; a
// refusal is a Refusal.
type Service struct {
	store   Store
	events  Notifier
	devices Devices
	policy  Policy
	chats   Chats
	work    sync.Locker
	inbox   inboxRuntime
	starts  starts
	// inboxFailed hears of each message Foundry gave up delivering.
	inboxFailed func(context.Context, store.SessionInboxItem)
}

// New is the service over st, telling events what happens to sessions.
func New(st Store, events Notifier, ports Ports) *Service {
	return &Service{store: st, events: events, devices: ports.Devices, policy: ports.Policy, chats: ports.Chats, work: ports.Work}
}
