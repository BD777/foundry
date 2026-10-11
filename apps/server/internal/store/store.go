package store

import (
	"context"
	"time"
)

// SessionRecordStore loads a session without its transcript: what a status
// change or a reply needs. A long chat has thousands of events.
type SessionRecordStore interface {
	GetAgentSessionRecord(ctx context.Context, id string) (AgentSession, error)
}

// SessionEventWindowStore reads a transcript a window at a time: a reader
// shows a chat's newest events first and pages back on request.
type SessionEventWindowStore interface {
	// ListAgentSessionThreadRecords is ListAgentSessionThread without events.
	ListAgentSessionThreadRecords(ctx context.Context, workspaceID string, id string) ([]AgentSession, error)
	// AgentSessionEventWindow returns at most limit of the session's events
	// before the cursor (the newest without one), oldest first, and the
	// cursor of the events older than those ("" when there are none). A
	// cursor it cannot read is ErrInvalidEventsCursor.
	AgentSessionEventWindow(ctx context.Context, sessionID string, before string, limit int) ([]AgentSessionEvent, string, error)
}

// AgentSessionRecord is the session with its answer and input but no
// events, read without them where the store can.
func AgentSessionRecord(ctx context.Context, st Store, id string) (AgentSession, error) {
	if records, ok := st.(SessionRecordStore); ok {
		return records.GetAgentSessionRecord(ctx, id)
	}
	session, err := st.GetAgentSession(ctx, id)
	session.Events = nil
	return session, err
}

// DaemonChanges is what a device's report changed in what clients read,
// so the server announces real changes only. A device resends its picture
// on every connect and its chats every minute; most reports change nothing.
type DaemonChanges struct {
	// Global: what every workspace's view shows changed (the device's
	// provider health or agent profiles), or a workspace appeared.
	Global bool
	// Workspaces whose own data (the workspace, its agents, assets, skills,
	// files or chats) changed.
	Workspaces []string
	// Parts says which of those changed, when the store can tell.
	Parts DaemonChangedParts
	// DeletedWorkspace is the workspace the report named that the person
	// deleted from this device; nothing of it was stored.
	DeletedWorkspace string
	// RefusedChats are the chats a sync named that this server never keeps
	// (deleted, or a Foundry session owns them): there is no need to send
	// them again.
	RefusedChats []string
}

// DaemonChangedParts names what a device report changed. Unless Known, any
// part DaemonChanges covers may have.
type DaemonChangedParts struct {
	Known bool
	// Of the device: its row, provider health and agent profiles; and a
	// workspace that appeared.
	Device, ProviderHealth, AgentProfiles, NewWorkspace bool
	// Of the workspace: its row, agents, assets, skills, files and chats.
	Workspace, Agents, Assets, Skills, WorkspaceFiles, Chats bool
}

// DaemonChangeStore records device reports and says what they changed.
type DaemonChangeStore interface {
	RegisterDaemonChanges(ctx context.Context, input DaemonRegistration) (DaemonChanges, error)
	SyncChatsChanges(ctx context.Context, input SyncChatsInput) (DaemonChanges, error)
}

// WorkspaceDeletionStore remembers the workspaces a person deleted from a
// device, whose later reports by that device change nothing (see
// DaemonChanges.DeletedWorkspace). Adding the folder again is the way back.
type WorkspaceDeletionStore interface {
	WorkspaceDeletedFromDevice(ctx context.Context, workspaceID, deviceID string) (bool, error)
	// ClearWorkspaceDeletion takes back the deletion of the device's
	// workspace at folder: the person is adding that folder again.
	ClearWorkspaceDeletion(ctx context.Context, deviceID, folder string) error
}

// DeviceSessionStore lists what a device still owes: every queued, running or
// blocked session on it, across all of its workspaces and without a page limit.
type DeviceSessionStore interface {
	UnsettledAgentSessionsOnDevice(ctx context.Context, deviceID string) ([]AgentSession, error)
}

// ActiveAgentSessionStore lists every running or blocked session, in every
// workspace: the ones a device that stopped reporting can leave stale.
type ActiveAgentSessionStore interface {
	ActiveAgentSessions(ctx context.Context) ([]AgentSession, error)
}

// SessionEventRecorder appends a device's session event like
// AppendAgentSessionEvent and reports false, changing nothing, for one the
// session already holds unchanged (the device sent it again) or one that
// would replace a person's input.
type SessionEventRecorder interface {
	RecordAgentSessionEvent(ctx context.Context, event AgentSessionEvent) (bool, error)
}

// QueuedAgentSessionStore lists every session waiting for its device to
// start it, and records notices on them that change nothing else.
type QueuedAgentSessionStore interface {
	QueuedAgentSessions(ctx context.Context) ([]AgentSession, error)
	// AddQueuedSessionNotice stores event while its session is still
	// queued on inputID and holds no event with its id; the session's
	// status and activity stay as they are. It reports whether the event
	// was added.
	AddQueuedSessionNotice(ctx context.Context, event AgentSessionEvent, inputID string) (bool, error)
}

// WorkspaceAvailabilityStore records which of a device's workspaces its
// worker serves: the others are marked unavailable on the device, never
// deleted. It reports whether any workspace changed.
type WorkspaceAvailabilityStore interface {
	SetDeviceServedWorkspaces(ctx context.Context, deviceID string, served []string) (bool, error)
}

// SessionTimerStore lists the timers of a device's sessions.
type SessionTimerStore interface {
	// DeviceSessionTimers returns the live timers of the device's Claude
	// chat sessions that are not deleted, with the prompts of their latest
	// timer snapshot; expired recurring timers are left out.
	DeviceSessionTimers(ctx context.Context, deviceID string, now time.Time) ([]SessionTimers, error)
}

// IssueExecutionStore runs an Issue as the session that implements it.
type IssueExecutionStore interface {
	// ClaimIssueExecution claims the next ready Issue and creates the session
	// that implements it (role issue_execution), atomically.
	ClaimIssueExecution(ctx context.Context, deviceID string, workspaceID string) (Issue, AgentSession, error)
	// ExecutionIssue returns an Issue with the confirmed contract it executes under.
	ExecutionIssue(ctx context.Context, issueID string) (Issue, error)
	// AskIssueQuestion records what the Issue's running execution asks the
	// person; the Issue blocks on it when the execution's turn ends.
	AskIssueQuestion(ctx context.Context, sessionID string, question IssueQuestion) (Issue, error)
	// AnswerIssueQuestion records the person's answer and queues the Issue to
	// continue in its candidate. Answering an answered question changes nothing.
	AnswerIssueQuestion(ctx context.Context, issueID string, questionID string, answer string, via string) (Issue, error)
}

type Store interface {
	Close() error

	ListWorkspaces(ctx context.Context) ([]WorkspaceProjection, error)
	RenameWorkspace(ctx context.Context, id string, name string) (WorkspaceProjection, error)
	GetWorkspace(ctx context.Context, id string) (WorkspaceProjection, error)
	DeleteWorkspace(ctx context.Context, id string) (WorkspaceProjection, error)

	ListDevices(ctx context.Context) ([]DeviceProjection, error)
	// SoftRemoveDevice tombstones a device so it disappears from the available
	// device list and can never re-register, without deleting any history.
	SoftRemoveDevice(ctx context.Context, id string) (DeviceProjection, error)
	// DeviceRemoved reports whether the device is tombstoned. Hub code uses it
	// inside the connection-map critical section to close registrations that
	// raced a removal.
	DeviceRemoved(ctx context.Context, id string) (bool, error)
	ListProviderHealth(ctx context.Context, deviceID string) ([]ProviderHealth, error)
	ListAgentProfiles(ctx context.Context, deviceID string) ([]AgentProfileProjection, error)

	ListProfiles(ctx context.Context) ([]ProfileDefinition, error)
	GetProfile(ctx context.Context, id string) (ProfileDefinition, error)
	SaveProfile(ctx context.Context, input SaveProfileInput) (ProfileDefinition, error)
	DeleteProfile(ctx context.Context, id string) error
	ListDeviceProfiles(ctx context.Context, deviceID string) ([]DeviceProfileBinding, error)
	SetDeviceProfiles(ctx context.Context, input SetDeviceProfilesInput) error

	ListDeviceSkillRoots(ctx context.Context, deviceID string) ([]DeviceSkillRoot, error)
	SetDeviceSkillRoots(ctx context.Context, input SetDeviceSkillRootsInput) error
	// ReplaceDeviceSkills stores a scan and reports whether it changed anything.
	ReplaceDeviceSkills(ctx context.Context, input ReplaceDeviceSkillsInput) (bool, error)
	ListDeviceSkills(ctx context.Context, deviceID string) ([]DeviceSkill, error)
	ListPromotedSkills(ctx context.Context) ([]PromotedSkill, error)
	GetPromotedSkill(ctx context.Context, id string) (PromotedSkill, error)
	PromoteSkillPackages(ctx context.Context, packages []SkillPromotionPackage) ([]PromotedSkill, error)
	AddPromotedSkillRevision(ctx context.Context, input PromoteSkillInput, name string, description string, content []byte, fileCount int) (PromotedSkill, bool, error)
	GetSkillRevisionIndex(ctx context.Context, skillID string, revision int) (SkillRevisionIndex, error)
	GetDeviceSkillIndex(ctx context.Context, deviceID, root, dirName string) (SkillRevisionIndex, error)
	GetSkillPackage(ctx context.Context, skillID string, revision int) (SkillPackage, error)
	DeletePromotedSkill(ctx context.Context, id string) error
	ListWorkspaceSkillBindings(ctx context.Context, workspaceID string) ([]WorkspaceSkillBinding, error)
	SetWorkspaceSkills(ctx context.Context, input SetWorkspaceSkillsInput) error
	ResolveSessionSkills(ctx context.Context, workspaceID string) ([]SessionSkillRef, error)
	AttachSessionSkills(ctx context.Context, sessionID string, refs []SessionSkillRef) error

	ListAgents(ctx context.Context, workspaceID string, deviceID string) ([]AgentProjection, error)
	ListWorkspaceFiles(ctx context.Context, workspaceID string) ([]WorkspaceFileEntry, error)
	ListAssets(ctx context.Context, workspaceID string) ([]AssetProjection, error)
	ListSkills(ctx context.Context, workspaceID string) ([]SkillPackRef, error)
	ListChats(ctx context.Context, workspaceID string) ([]ChatThread, error)
	GetChat(ctx context.Context, id string) (ChatThread, error)
	GetChatLayout(ctx context.Context, workspaceID string) (ChatLayout, error)
	SaveChatLayout(ctx context.Context, input SaveChatLayoutInput) (ChatLayout, error)
	DeleteChatGroup(ctx context.Context, input DeleteChatGroupInput) (ChatLayout, error)
	ListChatTitles(ctx context.Context, workspaceID string) ([]ChatTitle, error)
	RenameChat(ctx context.Context, id string, input RenameChatInput) (ChatTitle, error)
	CreateChatTitleJob(ctx context.Context, chatID string, input CreateAgentSessionInput, automatic bool) (AgentSession, error)

	ListIssues(ctx context.Context, workspaceID string) ([]Issue, error)
	GetIssue(ctx context.Context, id string) (Issue, error)
	CreateIssue(ctx context.Context, input CreateIssueInput) (Issue, error)
	UpdateIssueStatus(ctx context.Context, id string, status string) (Issue, error)
	RequestIssueChanges(ctx context.Context, id string, message string, expectedRunID string, via string) (Issue, error)
	AbandonIssue(ctx context.Context, id string, expectedRunID string) (Issue, error)

	ListRuns(ctx context.Context, workspaceID string) ([]Run, error)
	ListRunEvents(ctx context.Context, workspaceID string) ([]RunEvent, error)
	ListAgentSessionSummaries(ctx context.Context, workspaceID string) ([]AgentSession, error)
	ListAgentSessionThread(ctx context.Context, workspaceID string, id string) ([]AgentSession, error)
	ListAgentSessionChildren(ctx context.Context, workspaceID string, parentID string) ([]AgentSession, error)
	GetAgentSession(ctx context.Context, id string) (AgentSession, error)
	GetAgentSessionSummary(ctx context.Context, id string) (AgentSession, error)
	CreateAgentSession(ctx context.Context, input CreateAgentSessionInput) (AgentSession, error)
	// SendAgentSessionInput queues an idle session's next input.
	SendAgentSessionInput(ctx context.Context, sessionID string, input SendAgentSessionInput) (AgentSession, error)
	// ValidateParentSession resolves a create request's lineage parent; an
	// empty parent id returns a zero session and no error. crossWorkspace
	// admits a parent in another workspace.
	ValidateParentSession(ctx context.Context, workspaceID string, parentID string, crossWorkspace bool) (AgentSession, error)
	// PlaceChildWithParent applies the CHAT-01 automatic group placement
	// inside the caller's transaction.
	PlaceChildWithParent(ctx context.Context, parent AgentSession, childID string) (groupID string, created bool, err error)
	SessionLineageDepth(ctx context.Context, sessionID string) (int, error)
	CountActiveAgentChildren(ctx context.Context, parentID string) (int, error)
	RenameLayoutGroup(ctx context.Context, workspaceID string, groupID string, name string) (ChatLayout, error)
	CreateGroupNameJob(ctx context.Context, input CreateAgentSessionInput, groupID string) (AgentSession, error)
	SessionsInGroup(ctx context.Context, workspaceID string, groupID string) ([]string, error)
	// MintAgentSessionToken returns a one-time plaintext bearer token.
	MintAgentSessionToken(ctx context.Context, sessionID string) (string, error)
	ResolveSessionToken(ctx context.Context, plaintext string) (SessionTokenIdentity, error)
	// ResolveSessionAgent identifies the agent (persisted daemon row or
	// trusted server-profile projection for one workspace) without creating
	// anything. Session creation re-resolves inside its write transaction.
	ResolveSessionAgent(ctx context.Context, input CreateAgentSessionInput) (AgentProjection, error)
	StartAgentSession(ctx context.Context, id string) (AgentSession, error)
	BlockAgentSession(ctx context.Context, id string, reason string) (AgentSession, error)
	ResumeAgentSession(ctx context.Context, id string) (AgentSession, error)
	AppendAgentSessionEvent(ctx context.Context, event AgentSessionEvent) error
	SetAgentSessionNativeSessionID(ctx context.Context, sessionID string, nativeSessionID string) (AgentSession, error)
	CompleteAgentSession(ctx context.Context, id string, response string, nativeSessionID string) (AgentSession, error)
	FailAgentSession(ctx context.Context, id string, message string) (AgentSession, error)
	CancelAgentSession(ctx context.Context, id string, message string) (AgentSession, error)

	RegisterDaemon(ctx context.Context, input DaemonRegistration) error
	ClaimNextIssue(ctx context.Context, deviceID string, workspaceID string) (Issue, error)
	SyncChats(ctx context.Context, input SyncChatsInput) error
	StartIssueRun(ctx context.Context, issueID string, run Run) (Issue, error)
	AppendRunEvent(ctx context.Context, event RunEvent) error
	CompleteIssue(ctx context.Context, issueID string, input CompleteIssueInput) (Issue, error)

	GetWorkspaceFeishuBot(ctx context.Context, workspaceID string) (WorkspaceFeishuBot, error)
	SaveWorkspaceFeishuBot(ctx context.Context, bot WorkspaceFeishuBot) (WorkspaceFeishuBot, error)
	DeleteWorkspaceFeishuBot(ctx context.Context, workspaceID string) error
	ListAllConfiguredFeishuBots(ctx context.Context) ([]WorkspaceFeishuBot, error)
	FindWorkspaceByPairingCode(ctx context.Context, code string) (WorkspaceFeishuBot, error)
	FindWorkspaceByChatID(ctx context.Context, chatID string) (WorkspaceFeishuBot, error)
	GetFeishuChatThread(ctx context.Context, rootMessageID string) (FeishuChatThread, error)
	SaveFeishuChatThread(ctx context.Context, thread FeishuChatThread) error
}
