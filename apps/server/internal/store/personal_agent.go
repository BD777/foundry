package store

import (
	"context"
	"encoding/json"
	"errors"
)

// The Personal Agent's records (docs/personal-agent.md), one Go struct per
// interface of packages/protocol/src/personal-agent.ts with the same JSON
// names (scripts/audit-contract.mjs). Fields tagged json:"-" are kept by the
// server and never sent. Times are RFC 3339 strings. Defaults and hard caps
// are in internal/personalagent/defaults.go.

// Workspace kinds (WorkspaceProjection.Kind).
const (
	WorkspaceKindProject       = "project"
	WorkspaceKindPersonalAgent = "personal_agent"
)

// AgentSessionRolePersonalAgent is the person's assistant: a session the
// person started in their Personal Agent Workspace. Only it lists the
// Personal Agent tools.
const AgentSessionRolePersonalAgent = "personal_agent"

// DigestSessionSource is the source of a digest summary session: read-only,
// without Foundry tools.
const DigestSessionSource = "digest"

// DaemonCapabilityWorkspaceCreate: the worker takes setup_workspace's
// create and reports its managed roots (DeviceProjection.ManagedRoots).
const DaemonCapabilityWorkspaceCreate = "workspace_create"

// PersonalAgent.State.
const (
	PersonalAgentActive  = "active"
	PersonalAgentStopped = "stopped"
)

// Policy decisions.
const (
	PersonalAgentAuto = "auto"
	PersonalAgentAsk  = "ask"
	PersonalAgentDeny = "deny"
)

// The managed actions, the keys of PersonalAgentPolicy. Actions never
// allowed have no key, so no setting can allow them.
const (
	PersonalAgentActionCreateWorkspace = "create_workspace"
	// PersonalAgentActionRegisterFolder registers an existing folder outside
	// the managed roots.
	PersonalAgentActionRegisterFolder = "register_folder"
	// PersonalAgentActionRenameWorkspace covers name and purpose.
	PersonalAgentActionRenameWorkspace = "rename_workspace"
	PersonalAgentActionAddSkill        = "add_skill"
	// PersonalAgentActionRemoveSkillCreated removes a skill from a project
	// the assistant created; PersonalAgentActionRemoveSkill from any other.
	PersonalAgentActionRemoveSkillCreated = "remove_skill_created"
	PersonalAgentActionRemoveSkill        = "remove_skill"
	// PersonalAgentActionBindConnector is decided for the first binding of
	// an account to a project; later ones of the same pair are auto.
	PersonalAgentActionBindConnector   = "bind_connector"
	PersonalAgentActionUnbindConnector = "unbind_connector"
	PersonalAgentActionArchive         = "archive_workspace"
	PersonalAgentActionRestore         = "restore_workspace"
)

// PersonalAgentActions are the managed actions in the panel's order.
var PersonalAgentActions = []string{
	PersonalAgentActionCreateWorkspace,
	PersonalAgentActionRegisterFolder,
	PersonalAgentActionRenameWorkspace,
	PersonalAgentActionAddSkill,
	PersonalAgentActionRemoveSkillCreated,
	PersonalAgentActionRemoveSkill,
	PersonalAgentActionBindConnector,
	PersonalAgentActionUnbindConnector,
	PersonalAgentActionArchive,
	PersonalAgentActionRestore,
}

// PersonalAgentProposalRelaxRules is the proposal kind of loosening rules.
const PersonalAgentProposalRelaxRules = "relax_rules"

// PersonalAgentPolicy maps each managed action to its decision.
type PersonalAgentPolicy map[string]string

// PersonalAgent is a person's assistant (table personal_agents).
type PersonalAgent struct {
	UserID        string                `json:"userId"`
	WorkspaceID   string                `json:"workspaceId"`
	HomeDeviceID  string                `json:"homeDeviceId"`
	State         string                `json:"state"`
	Settings      PersonalAgentSettings `json:"settings"`
	PromptVersion string                `json:"promptVersion"`
	CreatedAt     string                `json:"createdAt"`
	UpdatedAt     string                `json:"updatedAt"`
	StoppedAt     string                `json:"stoppedAt,omitempty"`
	// FormerWorkspaceIDs are the workspaces the assistant lived in before it
	// moved (archived projects of the person's now), oldest first: its
	// earlier conversations are there.
	FormerWorkspaceIDs []string `json:"formerWorkspaceIds,omitempty"`
}

// PersonalAgentSettings is what the settings panel edits (settings_json).
// An empty string means the default named in the protocol.
type PersonalAgentSettings struct {
	AssistantName      string                        `json:"assistantName"`
	Language           string                        `json:"language"`
	Timezone           string                        `json:"timezone"`
	SpeakingStyle      string                        `json:"speakingStyle"`
	Verbosity          string                        `json:"verbosity"`
	ExtraInstructions  string                        `json:"extraInstructions"`
	Policy             PersonalAgentPolicy           `json:"policy"`
	Devices            []PersonalAgentDeviceSettings `json:"devices"`
	PreferredDeviceID  string                        `json:"preferredDeviceId"`
	AssistantProfileID string                        `json:"assistantProfileId"`
	AssistantModel     string                        `json:"assistantModel"`
	DelegateModel      string                        `json:"delegateModel"`
	HomePage           bool                          `json:"homePage"`
	SimpleInterface    bool                          `json:"simpleInterface"`
	FeishuDirectChat   bool                          `json:"feishuDirectChat"`
	FeishuAppID        string                        `json:"feishuAppId"`
	DailyDigest        bool                          `json:"dailyDigest"`
	DailyDigestTime    string                        `json:"dailyDigestTime"`
	ActiveHoursStart   string                        `json:"activeHoursStart"`
	ActiveHoursEnd     string                        `json:"activeHoursEnd"`
	UrgentAnytime      bool                          `json:"urgentAnytime"`
	Limits             PersonalAgentLimits           `json:"limits"`
}

// PersonalAgentDeviceSettings is what the assistant may do on one device.
type PersonalAgentDeviceSettings struct {
	DeviceID    string `json:"deviceId"`
	AllowWork   bool   `json:"allowWork"`
	AllowCreate bool   `json:"allowCreate"`
}

// PersonalAgentLimits are the §9 limits, each at most its hard cap.
type PersonalAgentLimits struct {
	ConcurrentSessions  int   `json:"concurrentSessions"`
	DailySessions       int   `json:"dailySessions"`
	DailyWorkspaces     int   `json:"dailyWorkspaces"`
	WeeklyWorkspaces    int   `json:"weeklyWorkspaces"`
	HourlyTurns         int   `json:"hourlyTurns"`
	DailyDigestSessions int   `json:"dailyDigestSessions"`
	StuckAfterMinutes   int   `json:"stuckAfterMinutes"`
	MonthlyTokenBudget  int64 `json:"monthlyTokenBudget"`
}

// PersonalAgentUsage are the counters the limits apply to.
type PersonalAgentUsage struct {
	ActiveSessions      int   `json:"activeSessions"`
	SessionsToday       int   `json:"sessionsToday"`
	WorkspacesToday     int   `json:"workspacesToday"`
	WorkspacesThisWeek  int   `json:"workspacesThisWeek"`
	TurnsThisHour       int   `json:"turnsThisHour"`
	DigestSessionsToday int   `json:"digestSessionsToday"`
	TokensThisMonth     int64 `json:"tokensThisMonth"`
}

// PersonalAgentOverview answers GET /api/personal-agent.
type PersonalAgentOverview struct {
	Agent                 *PersonalAgent      `json:"agent,omitempty"`
	HomeDeviceOnline      bool                `json:"homeDeviceOnline"`
	SuggestedHomeDeviceID string              `json:"suggestedHomeDeviceId,omitempty"`
	Usage                 *PersonalAgentUsage `json:"usage,omitempty"`
}

// PersonalAgentSetupInput is POST /api/personal-agent's body.
type PersonalAgentSetupInput struct {
	DeviceID string `json:"deviceId"`
	// Timezone is the browser's IANA time zone: the setting's first value.
	Timezone string `json:"timezone,omitempty"`
}

// PersonalAgentTimezoneInput is POST /api/personal-agent/timezone's body:
// the browser's IANA time zone.
type PersonalAgentTimezoneInput struct {
	Timezone string `json:"timezone"`
}

// Memory origins.
const (
	PersonalAgentMemoryStated   = "stated"
	PersonalAgentMemoryEdited   = "edited"
	PersonalAgentMemoryInferred = "inferred"
	PersonalAgentMemoryExternal = "external"
)

// Memory statuses.
const (
	PersonalAgentMemoryActive     = "active"
	PersonalAgentMemoryPending    = "pending"
	PersonalAgentMemorySuperseded = "superseded"
	PersonalAgentMemoryForgotten  = "forgotten"
)

// remember's ops.
const (
	PersonalAgentMemoryAdd    = "add"
	PersonalAgentMemoryUpdate = "update"
	PersonalAgentMemoryForget = "forget"
)

// PersonalAgentMemoryItem is one fact about the person (table pa_memory).
// Forgetting erases Content.
type PersonalAgentMemoryItem struct {
	ID              string `json:"id"`
	UserID          string `json:"-"`
	Content         string `json:"content"`
	Origin          string `json:"origin"`
	Status          string `json:"status"`
	SourceSessionID string `json:"sourceSessionId,omitempty"`
	SourceInputID   string `json:"sourceInputId,omitempty"`
	Supersedes      string `json:"supersedes,omitempty"`
	CreatedAt       string `json:"createdAt"`
	UpdatedAt       string `json:"updatedAt"`
	VerifiedAt      string `json:"verifiedAt,omitempty"`
}

// PersonalAgentMemoryInput is remember's item and the panel's add and edit.
type PersonalAgentMemoryInput struct {
	ID       string `json:"id,omitempty"`
	Content  string `json:"content,omitempty"`
	Inferred bool   `json:"inferred,omitempty"`
}

// Proposal statuses.
const (
	PersonalAgentProposalPending  = "pending"
	PersonalAgentProposalAccepted = "accepted"
	PersonalAgentProposalDeclined = "declined"
	PersonalAgentProposalExpired  = "expired"
	PersonalAgentProposalApplied  = "applied"
	PersonalAgentProposalFailed   = "failed"
)

// Where a proposal was answered.
const (
	PersonalAgentViaWeb    = "web"
	PersonalAgentViaFeishu = "feishu"
	PersonalAgentViaReply  = "reply"
)

// PersonalAgentProposal is an action waiting for the person's yes (table
// pa_proposals). Spec is the tool's arguments, applied exactly as approved.
type PersonalAgentProposal struct {
	ID          string          `json:"id"`
	UserID      string          `json:"-"`
	SessionID   string          `json:"sessionId"`
	Kind        string          `json:"kind"`
	WorkspaceID string          `json:"workspaceId,omitempty"`
	Spec        json.RawMessage `json:"spec"`
	Summary     string          `json:"summary"`
	Status      string          `json:"status"`
	CreatedAt   string          `json:"createdAt"`
	ExpiresAt   string          `json:"expiresAt"`
	DecidedAt   string          `json:"decidedAt,omitempty"`
	DecidedVia  string          `json:"decidedVia,omitempty"`
	Error       string          `json:"error,omitempty"`
}

// PersonalAgentNeedsConfirmation is a write tool's answer when the policy
// says ask; Status is always "needs_confirmation".
type PersonalAgentNeedsConfirmation struct {
	Status     string `json:"status"`
	ProposalID string `json:"proposalId"`
	Summary    string `json:"summary"`
	ExpiresAt  string `json:"expiresAt"`
}

// PersonalAgentNeedsConfirmationStatus is PersonalAgentNeedsConfirmation's
// Status.
const PersonalAgentNeedsConfirmationStatus = "needs_confirmation"

// PersonalAgentRuleChange is update_rules' change.
type PersonalAgentRuleChange struct {
	Action   string `json:"action"`
	Decision string `json:"decision"`
}

// Task statuses.
const (
	PersonalAgentTaskQueued    = "queued"
	PersonalAgentTaskRunning   = "running"
	PersonalAgentTaskAsking    = "asking"
	PersonalAgentTaskDone      = "done"
	PersonalAgentTaskFailed    = "failed"
	PersonalAgentTaskCancelled = "cancelled"
)

// PersonalAgentTask is work the assistant handed off and follows up (table
// pa_tasks).
type PersonalAgentTask struct {
	ID                    string `json:"id"`
	UserID                string `json:"-"`
	ConversationSessionID string `json:"conversationSessionId"`
	SessionID             string `json:"sessionId,omitempty"`
	WorkspaceID           string `json:"workspaceId"`
	Title                 string `json:"title"`
	Status                string `json:"status"`
	ReadOnly              bool   `json:"readOnly"`
	CreatedAt             string `json:"createdAt"`
	UpdatedAt             string `json:"updatedAt"`
	LastEventAt           string `json:"lastEventAt,omitempty"`
	EndedAt               string `json:"endedAt,omitempty"`
	StuckSince            string `json:"stuckSince,omitempty"`
	// WaitingFor, set when listed, is the name of the offline computer its
	// session is queued for; not stored.
	WaitingFor string `json:"waitingFor,omitempty"`
}

// Task event kinds.
const (
	PersonalAgentTaskEventFinished = "finished"
	PersonalAgentTaskEventFailed   = "failed"
	PersonalAgentTaskEventAsked    = "asked"
	PersonalAgentTaskEventSilent   = "silent"
)

// PersonalAgentTaskEvent is one event sent to the conversation following a
// task.
type PersonalAgentTaskEvent struct {
	TaskID      string `json:"taskId"`
	SessionID   string `json:"sessionId"`
	WorkspaceID string `json:"workspaceId"`
	Kind        string `json:"kind"`
	At          string `json:"at"`
}

// WorkspaceDigest is what the server knows of one project for one person
// (table workspace_digests): the deterministic part and the summary.
type WorkspaceDigest struct {
	UserID         string                   `json:"-"`
	WorkspaceID    string                   `json:"workspaceId"`
	Name           string                   `json:"name"`
	Kind           string                   `json:"kind"`
	Purpose        string                   `json:"purpose"`
	DeviceID       string                   `json:"deviceId"`
	DeviceLabel    string                   `json:"deviceLabel"`
	DeviceOnline   bool                     `json:"deviceOnline"`
	AccessRole     string                   `json:"accessRole"`
	Archived       bool                     `json:"archived"`
	Unavailable    bool                     `json:"unavailable"`
	Intro          string                   `json:"intro"`
	RecentSessions []WorkspaceDigestSession `json:"recentSessions"`
	OpenIssues     []WorkspaceDigestIssue   `json:"openIssues"`
	Skills         []string                 `json:"skills"`
	Connectors     []string                 `json:"connectors"`
	GitBranch      string                   `json:"gitBranch,omitempty"`
	GitDirty       *bool                    `json:"gitDirty,omitempty"`
	LastActivityAt string                   `json:"lastActivityAt,omitempty"`
	CompiledAt     string                   `json:"compiledAt"`
	SourceRev      string                   `json:"sourceRev"`
	Dirty          bool                     `json:"dirty"`
	L0             string                   `json:"l0"`
	Summary        string                   `json:"summary"`
	RouteWhen      []string                 `json:"routeWhen"`
	NotWhen        []string                 `json:"notWhen"`
	SummarizedAt   string                   `json:"summarizedAt,omitempty"`
}

type WorkspaceDigestSession struct {
	ID        string `json:"id"`
	Title     string `json:"title"`
	Status    string `json:"status"`
	UpdatedAt string `json:"updatedAt"`
}

type WorkspaceDigestIssue struct {
	ID     string `json:"id"`
	Title  string `json:"title"`
	Status string `json:"status"`
}

// WorkspaceDigestRecord is a stored digest with what the summary loop
// keeps beside it (internal/workspacedigest).
type WorkspaceDigestRecord struct {
	Digest WorkspaceDigest
	// ContentRev is what a summary reads (purpose, sessions, Issues,
	// skills, connectors, instruction files); the digest is dirty while it
	// differs from SummaryRev.
	ContentRev string
	// FilesRev is the instruction files' signature now; IntroRev the one
	// Intro was read from.
	FilesRev string
	IntroRev string
	// SummaryRev is the ContentRev the summary was written from.
	SummaryRev string
	// SummaryDueAt is when a summary is due ("" when none is).
	SummaryDueAt string
	// SummarySessionID is the summary session running, PendingRev the
	// ContentRev it was given.
	SummarySessionID string
	PendingRev       string
	// History is what the person asked there lately, in their own words:
	// the titles and first messages of its latest sessions and chats,
	// newest first. Files are its top-level entries. Both are ranking
	// evidence beyond the digest, so a project ranks by its history before
	// any summary was written.
	History []string
	Files   []string
}

// NeedsIntro reports whether the record's intro predates its instruction
// files: they changed, or none was read yet.
func (r WorkspaceDigestRecord) NeedsIntro() bool {
	return r.FilesRev != "" && r.FilesRev != r.IntroRev
}

// WorkspaceDigestStore keeps the digests (table workspace_digests): one row
// per person × workspace they can read, gone with their membership.
type WorkspaceDigestStore interface {
	// ListWorkspaceDigests lists userID's digests.
	ListWorkspaceDigests(ctx context.Context, userID string) ([]WorkspaceDigestRecord, error)
	// ListWorkspaceDigestsOf lists everyone's digests of workspaceID.
	ListWorkspaceDigestsOf(ctx context.Context, workspaceID string) ([]WorkspaceDigestRecord, error)
	// SaveWorkspaceDigest stores the deterministic part of a record and,
	// when its ContentRev is new, its SummaryDueAt. The summary, the intro
	// and a running summary session are kept (FinishWorkspaceDigestSummary,
	// SaveWorkspaceDigestIntro write them), except an intro whose files
	// are gone.
	SaveWorkspaceDigest(ctx context.Context, record WorkspaceDigestRecord) error
	// DeleteWorkspaceDigests deletes userID's digests of every workspace
	// but keep.
	DeleteWorkspaceDigests(ctx context.Context, userID string, keep []string) error
	DeleteWorkspaceDigest(ctx context.Context, userID, workspaceID string) error
	// SaveWorkspaceDigestIntro sets the intro of workspaceID's digests whose
	// instruction files are still filesRev.
	SaveWorkspaceDigestIntro(ctx context.Context, workspaceID, filesRev, intro string) error
	// DueWorkspaceDigests lists digests whose summary is due by now and not
	// running, most recently active first.
	DueWorkspaceDigests(ctx context.Context, now string, limit int) ([]WorkspaceDigestRecord, error)
	// ScheduleWorkspaceDigestSummary sets when the summary is due; "" for
	// never, unless it changes.
	ScheduleWorkspaceDigestSummary(ctx context.Context, userID, workspaceID, dueAt string) error
	// ClaimWorkspaceDigestSummary marks sessionID the summary session of a
	// digest none runs for, given its ContentRev rev; false when one runs.
	ClaimWorkspaceDigestSummary(ctx context.Context, userID, workspaceID, sessionID, rev string) (bool, error)
	// WorkspaceDigestForSummarySession is the digest sessionID summarizes,
	// ErrNotFound for none.
	WorkspaceDigestForSummarySession(ctx context.Context, sessionID string) (WorkspaceDigestRecord, error)
	// FinishWorkspaceDigestSummary ends sessionID's summary: with summary,
	// it is the digest's now, written from rev at at; without, the
	// previous one stays. A digest still dirty afterwards is due at
	// dueIfDirty.
	FinishWorkspaceDigestSummary(ctx context.Context, userID, workspaceID, sessionID string, summary *WorkspaceDigestSummary, rev, at, dueIfDirty string) error
	// CountDigestSessionsSince counts the summary sessions userID's
	// digests started since then.
	CountDigestSessionsSince(ctx context.Context, userID, since string) (int, error)
}

// WorkspaceDigestSummary is the JSON a digest session must answer.
type WorkspaceDigestSummary struct {
	L0        string   `json:"l0"`
	Summary   string   `json:"summary"`
	RouteWhen []string `json:"routeWhen"`
	NotWhen   []string `json:"notWhen"`
}

// DeviceDigest is what the server knows of one of the person's devices.
type DeviceDigest struct {
	DeviceID       string   `json:"deviceId"`
	Label          string   `json:"label"`
	System         string   `json:"system"`
	Online         bool     `json:"online"`
	Runtimes       []string `json:"runtimes"`
	ModelServices  []string `json:"modelServices"`
	Resources      []string `json:"resources"`
	WorkspaceCount int      `json:"workspaceCount"`
	CompiledAt     string   `json:"compiledAt"`
}

// WorkspaceCandidate is one find_workspace answer.
type WorkspaceCandidate struct {
	WorkspaceID string  `json:"workspaceId"`
	Name        string  `json:"name"`
	Reason      string  `json:"reason"`
	Score       float64 `json:"score"`
	CompiledAt  string  `json:"compiledAt"`
	Stale       bool    `json:"stale"`
}

// PersonalAgentRoutingDecision is one routing choice (table
// pa_routing_decisions). RequestClass, Target and Confidence take the
// values of the protocol's PersonalAgentRequestClass, RouteTarget and
// RouteConfidence.
type PersonalAgentRoutingDecision struct {
	ID                   string   `json:"id"`
	UserID               string   `json:"-"`
	SessionID            string   `json:"sessionId"`
	InputID              string   `json:"inputId,omitempty"`
	Request              string   `json:"request"`
	RequestClass         string   `json:"requestClass"`
	Target               string   `json:"target"`
	WorkspaceID          string   `json:"workspaceId,omitempty"`
	Confidence           string   `json:"confidence"`
	Candidates           []string `json:"candidates"`
	Corrected            bool     `json:"corrected"`
	CorrectedWorkspaceID string   `json:"correctedWorkspaceId,omitempty"`
	CreatedAt            string   `json:"createdAt"`
}

// Action outcomes.
const (
	PersonalAgentOutcomeApplied  = "applied"
	PersonalAgentOutcomeProposed = "proposed"
	PersonalAgentOutcomeRefused  = "refused"
	PersonalAgentOutcomeFailed   = "failed"
)

// Refusals.
const (
	PersonalAgentRefusalNotAllowed = "not_allowed"
	PersonalAgentRefusalNotOwner   = "not_owner"
	PersonalAgentRefusalLimit      = "limit"
	PersonalAgentRefusalStopped    = "stopped"
	PersonalAgentRefusalInvalid    = "invalid"
	// PersonalAgentRefusalNoPlace: no computer the assistant may use has
	// what a new project needs (PersonalAgentNoPlace).
	PersonalAgentRefusalNoPlace = "no_place"
)

// PersonalAgentActionRecord is one write tool call, refused ones included,
// or one approved proposal applied (table pa_actions).
type PersonalAgentActionRecord struct {
	ID           string `json:"id"`
	UserID       string `json:"-"`
	SessionID    string `json:"sessionId"`
	Tool         string `json:"tool"`
	ArgsSummary  string `json:"argsSummary"`
	WorkspaceID  string `json:"workspaceId,omitempty"`
	Decision     string `json:"decision,omitempty"`
	Outcome      string `json:"outcome"`
	Refusal      string `json:"refusal,omitempty"`
	ProposalID   string `json:"proposalId,omitempty"`
	ConfirmedVia string `json:"confirmedVia,omitempty"`
	Error        string `json:"error,omitempty"`
	CreatedAt    string `json:"createdAt"`
}

// PersonalAgentWindows are the starts of the windows §9's limits count in,
// in the person's time zone.
type PersonalAgentWindows struct {
	HourAgo    string
	DayStart   string
	WeekStart  string
	MonthStart string
}

// PersonalAgentStore keeps the Personal Agent's records. Every read and
// write is scoped to one person (userID); another person's id answers
// ErrNotFound.
type PersonalAgentStore interface {
	// GetPersonalAgent is the person's assistant, ErrNotFound before setup.
	GetPersonalAgent(ctx context.Context, userID string) (PersonalAgent, error)
	// PersonalAgentForWorkspace is the assistant whose workspace this is.
	PersonalAgentForWorkspace(ctx context.Context, workspaceID string) (PersonalAgent, error)
	// CreatePersonalAgent stores a new assistant; ErrPersonalAgentExists
	// when the person or the workspace already has one.
	CreatePersonalAgent(ctx context.Context, agent PersonalAgent) (PersonalAgent, error)
	SavePersonalAgentSettings(ctx context.Context, userID string, settings PersonalAgentSettings) (PersonalAgent, error)
	// FillPersonalAgentTimezone sets the assistant's time zone to timezone
	// only while it has none: a zone the person chose is never replaced.
	FillPersonalAgentTimezone(ctx context.Context, userID, timezone string) (PersonalAgent, error)
	// SetPersonalAgentState switches active and stopped.
	SetPersonalAgentState(ctx context.Context, userID, state string) (PersonalAgent, error)
	// MovePersonalAgentHome makes workspaceID on deviceID the assistant's
	// workspace and home device.
	MovePersonalAgentHome(ctx context.Context, userID, workspaceID, deviceID string) (PersonalAgent, error)
	// PersonalAgentChatIntroduced reports whether the person's Feishu
	// direct chat on Connectors app appID was told that the assistant took
	// it over; ClaimPersonalAgentChatIntroduction records it, false when it
	// already was.
	PersonalAgentChatIntroduced(ctx context.Context, userID, appID string) (bool, error)
	ClaimPersonalAgentChatIntroduction(ctx context.Context, userID, appID string) (bool, error)

	// ListPersonalAgentMemory lists every item, forgotten ones without
	// content, newest first.
	ListPersonalAgentMemory(ctx context.Context, userID string) ([]PersonalAgentMemoryItem, error)
	GetPersonalAgentMemory(ctx context.Context, userID, id string) (PersonalAgentMemoryItem, error)
	AddPersonalAgentMemory(ctx context.Context, item PersonalAgentMemoryItem) (PersonalAgentMemoryItem, error)
	// SupersedePersonalAgentMemory marks oldID superseded and stores next,
	// which points back to it, in one transaction.
	SupersedePersonalAgentMemory(ctx context.Context, userID, oldID string, next PersonalAgentMemoryItem) (PersonalAgentMemoryItem, error)
	// ConfirmPersonalAgentMemory makes a pending or inferred item the
	// person's: active, origin edited, verified now.
	ConfirmPersonalAgentMemory(ctx context.Context, userID, id string) (PersonalAgentMemoryItem, error)
	// ForgetPersonalAgentMemory erases an item and every item it replaced.
	ForgetPersonalAgentMemory(ctx context.Context, userID, id string) error
	// ForgetAllPersonalAgentMemory erases every item; it answers how many.
	ForgetAllPersonalAgentMemory(ctx context.Context, userID string) (int, error)

	CreatePersonalAgentProposal(ctx context.Context, proposal PersonalAgentProposal) (PersonalAgentProposal, error)
	GetPersonalAgentProposal(ctx context.Context, userID, id string) (PersonalAgentProposal, error)
	// ListPersonalAgentProposals lists the person's proposals in these
	// statuses (all when none), newest first.
	ListPersonalAgentProposals(ctx context.Context, userID string, statuses []string) ([]PersonalAgentProposal, error)
	// SetPersonalAgentProposalStatus moves a proposal from one of from to
	// status; ErrPersonalAgentProposalSettled when it is in none of them.
	SetPersonalAgentProposalStatus(ctx context.Context, userID, id string, from []string, status, via, errText string) (PersonalAgentProposal, error)
	// ExpirePersonalAgentProposals expires the pending proposals that
	// expired before now, or every pending one when now is empty.
	ExpirePersonalAgentProposals(ctx context.Context, userID, now string) (int, error)

	CreatePersonalAgentTask(ctx context.Context, task PersonalAgentTask) (PersonalAgentTask, error)
	// ListPersonalAgentTasks lists tasks in these statuses (all when none),
	// newest first.
	ListPersonalAgentTasks(ctx context.Context, userID string, statuses []string) ([]PersonalAgentTask, error)
	// UpdatePersonalAgentTask saves a task's status and times, and the
	// conversation it reports to.
	UpdatePersonalAgentTask(ctx context.Context, task PersonalAgentTask) error

	// RecordPersonalAgentAction appends an audit row with the call's
	// arguments (kept for the server, never sent) and drops rows older than
	// the retention.
	RecordPersonalAgentAction(ctx context.Context, record PersonalAgentActionRecord, args json.RawMessage) (PersonalAgentActionRecord, error)
	ListPersonalAgentActions(ctx context.Context, userID string, limit int) ([]PersonalAgentActionRecord, error)
	// PersonalAgentCreatedWorkspace reports whether the assistant created
	// the workspace.
	PersonalAgentCreatedWorkspace(ctx context.Context, userID, workspaceID string) (bool, error)
	// PersonalAgentConnectorBoundBefore reports whether the assistant bound
	// the account to the workspace before.
	PersonalAgentConnectorBoundBefore(ctx context.Context, userID, workspaceID, accountID string) (bool, error)

	RecordPersonalAgentRoutingDecision(ctx context.Context, decision PersonalAgentRoutingDecision) (PersonalAgentRoutingDecision, error)
	ListPersonalAgentRoutingDecisions(ctx context.Context, userID string, limit int) ([]PersonalAgentRoutingDecision, error)

	// PersonalAgentUsage counts what §9's limits apply to.
	PersonalAgentUsage(ctx context.Context, agent PersonalAgent, windows PersonalAgentWindows) (PersonalAgentUsage, error)
	// PersonalAgentActiveSessions are the sessions the stop switch cancels:
	// the assistant's own conversations and its tasks' sessions still
	// queued, running or blocked.
	PersonalAgentActiveSessions(ctx context.Context, agent PersonalAgent) ([]string, error)
}

// Personal Agent store refusals.
var (
	ErrPersonalAgentExists          = errors.New("this person already has an assistant")
	ErrPersonalAgentProposalSettled = errors.New("this proposal was already answered or has expired")
)
