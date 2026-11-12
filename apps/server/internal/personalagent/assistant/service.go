// Package assistant is the person's assistant at work
// (docs/personal-agent.md): who it is and the limits it is held to
// (conversation admission, the stop switch, proposals), what its runs are
// given (its prompt and each turn's context), where it lives (setup,
// moving home), the writes its tools make (one propose-or-apply pipeline,
// RunTool, audited in pa_actions), and its work loops: the durable inbox,
// dispatched operations, maintenance reviews and the context patches they
// propose, supervision of the sessions it handed work to, the person's
// list with its reminders and daily digest, run controls, and what waited
// for a computer that comes back. Its rules and prompts are personalagent's;
// its knowledge is personalagent/knowledge; how its runs execute is
// personalagent/run.
//
// It does not know HTTP, MCP or the device wire: httpapi resolves who asks
// (Scope from the caller's session), decodes and encodes, and implements
// the ports (Ports) over its device hub, Feishu, the workspace lifecycle,
// accounts and digests. A refusal is a personalagent.Refusal, which httpapi
// answers with its status.
//
//	svc := assistant.New(st, events, assistant.Ports{…}) // one per server
//	svc.Jobs()                                       // its background loops, for the server to run
//	svc.Observers()                                  // its reactions to sessions
//	svc.ScopeFor(ctx, agent, sessionID, turn)        // what one conversation may manage
//	svc.RunTool(ctx, scope, tool, args)              // a write tool: refused, proposed or applied
//	svc.AdmitSession(ctx, input); svc.AdmitTurn(ctx, session) // the limits
//	svc.RunFor(ctx, session)                         // a run's instructions and turn context
//	svc.Stop(ctx, agent); svc.Resume(ctx, agent)     // one assistant's stop switch
//	svc.DecideProposal(ctx, agent, id, accept, via) // the person's answer
//
// Dependencies: store, sessions, workspacedigest, redact, personalagent and
// its flow, run and knowledge packages. It must not import httpapi.
package assistant

import (
	"bytes"
	"context"
	"encoding/json"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/personalagent"
	"github.com/foundry-dev/foundry/apps/server/internal/personalagent/knowledge"
	"github.com/foundry-dev/foundry/apps/server/internal/personalagent/run"
	"github.com/foundry-dev/foundry/apps/server/internal/sessions"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// Store is what the assistant keeps and reads.
type Store interface {
	store.Store
	store.PendingItemStore
	store.AccountStore
	store.OwnershipStore
	store.WorkspaceLifecycleStore
	store.ExternalAccountStore
	store.DeviceSharingStore
	store.DeviceRemovalStore
	store.DeviceSessionStore
	store.ActiveAgentSessionStore
	store.SessionEventWindowStore
	store.SessionRecordStore
	store.WorkStore
	store.PersonalAgentStore
	store.PermissionPackageStore
	store.PersonalAgentListStore
	store.PersonalAgentInboxStore
	store.PersonalAgentRuntimeStore
	store.PersonalAgentRunControlStore
	store.PersonalAgentOperationStore
	store.PersonalAgentMaintenanceStore
	store.PersonalAgentContextPatchStore
	store.WorkspaceDigestStore
	store.KnowledgeVaultStore
	store.KnowledgeEntryStore
	store.KnowledgeLegacyTransferStore
	store.KnowledgePublicationStore
	store.FeishuIssueThreads
}

// Sessions is the session lifecycle the assistant starts, messages and
// dispatches through; *sessions.Service implements it.
type Sessions interface {
	Send(ctx context.Context, sessionID string, input store.SendAgentSessionInput, beforeDelivery func(context.Context, store.AgentSession) error) (store.AgentSession, error)
	ResolveDevice(ctx context.Context, input *store.CreateAgentSessionInput) error
	PickDevice(ctx context.Context, input *store.CreateAgentSessionInput, anyAgent bool) error
	CreateAndDispatch(ctx context.Context, input store.CreateAgentSessionInput, opts sessions.StartOptions) (store.AgentSession, error)
	DispatchOrFail(ctx context.Context, session store.AgentSession, failure func(error) string) (store.AgentSession, error)
	WaitsForDevice(session store.AgentSession) bool
}

// Connection is a device's registered connection as the hub holds it
// (possibly closing).
type Connection interface {
	HasCapability(capability string) bool
}

// Devices is what the assistant reaches on the person's devices and knows
// of them; httpapi implements it over its device hub.
type Devices interface {
	// Connected reports whether the device is connected now.
	Connected(deviceID string) bool
	// RemoveDevice removes it and everything it owned through the same server
	// path as DELETE /api/devices/{deviceId}.
	RemoveDevice(ctx context.Context, deviceID string, stopRunningTurns bool) (store.DeviceProjection, error)
	// Connection is the device's registered connection, nil without one.
	Connection(deviceID string) Connection
	// Label is the device's name as people know it; Labels by device id.
	Label(ctx context.Context, deviceID string) string
	Labels(ctx context.Context) map[string]string
	// SharedAccounts lists, by device id, who else uses its system account.
	SharedAccounts(ctx context.Context) map[string][]string
	// Placements are the devices' labels and detected facts.
	Placements(ctx context.Context, devices []store.DeviceProjection, now time.Time) (map[string]store.DevicePlacement, error)
	// ManagedRootFolders names the folders in the device's first managed
	// root; none while it is offline.
	ManagedRootFolders(ctx context.Context, deviceID string) []string
	ReadWorkspaceFile(ctx context.Context, workspace store.WorkspaceProjection, path string) (store.WorkspaceFileRead, error)
	ListWorkspaceTree(ctx context.Context, workspace store.WorkspaceProjection, path string) ([]store.WorkspaceTreeEntry, error)
	// WorkspaceGit is the git state the workspace's device inspects, when
	// it answers.
	WorkspaceGit(ctx context.Context, workspace store.WorkspaceProjection) (json.RawMessage, bool)
	// ContextPatch reads or applies a context patch on the workspace's
	// device.
	ContextPatch(ctx context.Context, workspace store.WorkspaceProjection, command store.ContextPatchCommand) (store.ContextPatchReply, error)
	// CancelExactInput stops the session's run of its current input only;
	// stopped says the device confirmed it for inputID.
	CancelExactInput(ctx context.Context, session store.AgentSession) (inputID string, stopped bool, err error)
	// AwayFor is how long the device was away before its current
	// connection; dropID tells one absence from another.
	AwayFor(deviceID string, now time.Time) (away time.Duration, dropID string, ok bool)
	// InputTokens are the tokens the session's current turn used, as its
	// device's native logs report them.
	InputTokens(ctx context.Context, session store.AgentSession) (int64, bool, error)
}

// Channel is the person's Feishu direct chat as the assistant uses it:
// proposal cards and inbox messages that came from it.
type Channel interface {
	// PersonalAgentProposalCreated posts the proposal's card in the
	// background, which shutdown waits for.
	PersonalAgentProposalCreated(proposal store.PersonalAgentProposal)
	PersonalAgentProposalChanged(proposal store.PersonalAgentProposal)
	PrepareAssistantInbox(ctx context.Context, entry store.PersonalAgentInboxEntry, workspaceID string) (string, []store.ChatAttachment, error)
	FollowAssistantInbox(ctx context.Context, entry store.PersonalAgentInboxEntry, workspaceID, sessionID string) error
	DeliverAssistantInboxResult(ctx context.Context, entry store.PersonalAgentInboxEntry, workspaceID, sessionURL string) error
}

// Accounts are the accounts a workspace offers.
type Accounts interface {
	run.Accounts
	// Answer is the accounts of the workspace as a tool answers them.
	Answer(ctx context.Context, workspace store.WorkspaceProjection, userID string) map[string]any
}

// Digests are the person's workspace and device digests
// (workspacedigest.Service, built per call).
type Digests interface {
	Sync(ctx context.Context, userID string) ([]store.WorkspaceDigestRecord, error)
	Devices(ctx context.Context, userID string) ([]store.DeviceDigest, error)
	Digest(ctx context.Context, userID, workspaceID string) (store.WorkspaceDigest, error)
	// Refresh recomputes the digests of a workspace whose content changed.
	Refresh(ctx context.Context, workspaceID string)
	// Prime starts computing, in the background, which shutdown waits
	// for, the digests of every project the person can read.
	Prime(userID string)
}

// Server is the rest of the server the assistant asks: access rules,
// built-in skills and the workspace viewers.
type Server interface {
	CanReadSession(ctx context.Context, user store.User, session store.AgentSession) bool
	CanControlSession(ctx context.Context, user store.User, session store.AgentSession) bool
	// BuiltinSkills names Foundry's built-in skills.
	BuiltinSkills() []string
	// WorkspacesChanged tells the viewers the workspace list changed.
	WorkspacesChanged()
}

// Ports are what the assistant reaches outside its domain.
type Ports struct {
	Sessions   Sessions
	Devices    Devices
	Channel    Channel
	Workspaces personalagent.Workspaces
	Accounts   Accounts
	Digests    Digests
	Server     Server
	Runs       *run.Resolver
	Knowledge  *knowledge.Service
	// ArchiveSessions plans archive_session for the assistant: archiving
	// chats is the chat list's, not the assistant's.
	ArchiveSessions Planner
	// Origin is the web app's origin, for the links the assistant passes
	// on; FileTimeout bounds one device file read.
	Origin      string
	FileTimeout time.Duration
}

// Service is the person's assistant at work. Its state is what it gathers
// in memory for its conversations: task notices being coalesced and what
// waited for an offline computer (lost on restart).
type Service struct {
	store           Store
	events          sessions.ChangeNotifier
	sessions        Sessions
	devices         Devices
	channel         Channel
	workspaces      personalagent.Workspaces
	accounts        Accounts
	digests         Digests
	server          Server
	runs            *run.Resolver
	knowledge       *knowledge.Service
	archiveSessions Planner
	origin          string
	fileTimeout     time.Duration

	// notices gathers the events of the assistant's tasks for its
	// conversations (supervision.go).
	notices notices
	// deviceWaits keeps what the assistant could not do while a computer
	// was offline, for when it is back (device_back.go).
	deviceWaits deviceWaits
}

// New is the assistant over st, telling events what it changes of sessions.
func New(st Store, events sessions.ChangeNotifier, ports Ports) *Service {
	return &Service{
		store: st, events: events, sessions: ports.Sessions, devices: ports.Devices, channel: ports.Channel,
		workspaces: ports.Workspaces, accounts: ports.Accounts, digests: ports.Digests, server: ports.Server,
		runs: ports.Runs, knowledge: ports.Knowledge, archiveSessions: ports.ArchiveSessions,
		origin: ports.Origin, fileTimeout: ports.FileTimeout,
	}
}

// Job is background work the server runs for the assistant: Run every
// Interval, the first time at once when AtStart.
type Job struct {
	Name     string
	Interval time.Duration
	AtStart  bool
	Run      func(ctx context.Context)
}

// Jobs are the assistant's background loops, in the order the server
// starts them; each drains its durable queue or looks for what is due.
func (s *Service) Jobs() []Job {
	return []Job{
		{"personal-agent-inbox", 2 * time.Second, true, s.DrainInbox},
		{"personal-agent-operations", 2 * time.Second, true, s.drainOperations},
		{"personal-agent-run-controls", 5 * time.Second, true, s.drainRunControls},
		{"personal-agent-maintenance", 30 * time.Second, true, s.drainMaintenance},
		{"personal-agent-supervision", supervisionInterval, false, s.superviseNow},
		{"personal-agent-reminders", reminderInterval, false, s.sendDueReminders},
		{"knowledge-operations", 3 * time.Second, true, s.knowledge.Drain},
	}
}

// Observers are the assistant's reactions to sessions, in order: it
// follows the tasks it handed off, records its inbox's answers and keeps
// its runs' controls.
func (s *Service) Observers() []sessions.ChangeObserver {
	return []sessions.ChangeObserver{taskReactions{s}, inboxReactions{s}, runControlReactions{s}}
}

func invalid(format string, args ...any) error { return personalagent.Invalid(format, args...) }

func refuse(kind string, status int, format string, args ...any) error {
	return personalagent.Refuse(kind, status, format, args...)
}

// WebURL is path in the web app.
func (s *Service) WebURL(path string) string {
	return strings.TrimRight(s.origin, "/") + path
}

// DefaultAccount is the account the person chose for this assistant;
// "" without one.
func (s *Service) DefaultAccount(ctx context.Context, assistantID string) string {
	if assistantID == "" {
		return ""
	}
	agent, err := s.store.GetAssistant(ctx, assistantID)
	if err != nil {
		return ""
	}
	return agent.Settings.AssistantProfileID
}

func formatPATime(value time.Time) string { return value.UTC().Format(time.RFC3339Nano) }

func parsePATime(value string) (time.Time, bool) {
	parsed, err := time.Parse(time.RFC3339Nano, value)
	return parsed, err == nil
}

// encodeJSON is a tool's answer: indented, and with <, > and & as they are
// (an agent reads it, not a browser).
func encodeJSON(value any) (string, error) {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	encoder.SetIndent("", "  ")
	if err := encoder.Encode(value); err != nil {
		return "", err
	}
	return strings.TrimSuffix(buffer.String(), "\n"), nil
}
