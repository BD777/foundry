package store

type WorkspaceProjection struct {
	ID             string `json:"id"`
	Name           string `json:"name"`
	LocalPath      string `json:"localPath"`
	Baseline       string `json:"baseline"`
	ContextSummary string `json:"contextSummary"`
	AcceptedCount  int    `json:"acceptedCount"`
	ResolvedCount  int    `json:"resolvedCount"`
	DeviceID       string `json:"deviceId,omitempty"`
	DeviceLabel    string `json:"deviceLabel,omitempty"`
	// AccessRole is the caller's role in the workspace, set per request.
	AccessRole string `json:"accessRole,omitempty"`
}

type DeviceProjection struct {
	ID              string                `json:"id"`
	Label           string                `json:"label"`
	Status          string                `json:"status"`
	LastSeenLabel   string                `json:"lastSeenLabel"`
	RuntimeSettings *AgentRuntimeSettings `json:"runtimeSettings,omitempty"`
	// Owned reports whether the caller owns (and may manage) the device.
	Owned bool `json:"owned,omitempty"`
}

type AgentRuntimeSettings struct {
	ActiveRuntimeTtlMs int `json:"activeRuntimeTtlMs"`
	MaxConcurrentTasks int `json:"maxConcurrentTasks"`
}

type ProviderHealth struct {
	DeviceID     string `json:"deviceId,omitempty"`
	Provider     string `json:"provider"`
	Status       string `json:"status"`
	AuthMode     string `json:"authMode"`
	SecretStored string `json:"secretStored"`
	AccountLabel string `json:"accountLabel,omitempty"`
	StatusDetail string `json:"statusDetail,omitempty"`
}

type NativeAccountInspection struct {
	Runtime         string               `json:"runtime"`
	Source          string               `json:"source"`
	Sources         []string             `json:"sources"`
	ExecutionSource string               `json:"executionSource"`
	CheckedAt       string               `json:"checkedAt"`
	Status          string               `json:"status"`
	AccountLabel    string               `json:"accountLabel,omitempty"`
	Plan            string               `json:"plan,omitempty"`
	Message         string               `json:"message"`
	Usage           []NativeAccountUsage `json:"usage"`
}

type NativeAccountUsage struct {
	UsedPercent   float64  `json:"usedPercent"`
	WindowMinutes *float64 `json:"windowMinutes,omitempty"`
	ResetsAt      *float64 `json:"resetsAt,omitempty"`
}

type AgentProfileProjection struct {
	AccountLabel         string   `json:"accountLabel,omitempty"`
	ID                   string   `json:"id"`
	DeviceID             string   `json:"deviceId"`
	Runtime              string   `json:"runtime"`
	Label                string   `json:"label"`
	Fingerprint          string   `json:"fingerprint,omitempty"`
	Status               string   `json:"status"`
	AuthMode             string   `json:"authMode"`
	SecretStored         string   `json:"secretStored"`
	ServerCredential     bool     `json:"serverCredential,omitempty"`
	ConfigScope          string   `json:"configScope"`
	ConfigLabel          string   `json:"configLabel"`
	ConnectionType       string   `json:"connectionType"`
	Model                string   `json:"model,omitempty"`
	Models               []string `json:"models,omitempty"`
	PromptPrefix         string   `json:"promptPrefix,omitempty"`
	ClaudeEffort         string   `json:"claudeEffort,omitempty"`
	ClaudePermissionMode string   `json:"claudePermissionMode,omitempty"`
	CodexReasoningEffort string   `json:"codexReasoningEffort,omitempty"`
	CodexSandboxMode     string   `json:"codexSandboxMode,omitempty"`
	CodexApprovalPolicy  string   `json:"codexApprovalPolicy,omitempty"`
	CodexSpeed           string   `json:"codexSpeed,omitempty"`
	BaseURL              string   `json:"baseUrl,omitempty"`
	CommandLabel         string   `json:"commandLabel,omitempty"`
	Origin               string   `json:"origin"`
	PromotedProfileID    string   `json:"promotedProfileId,omitempty"`
	LastSeenLabel        string   `json:"lastSeenLabel"`
	StatusDetail         string   `json:"statusDetail,omitempty"`
}

// ProfileDefinition is a control-plane owned profile. It carries no DeviceID
// and no status: reachability belongs to the device that runs it.
type ProfileDefinition struct {
	ID                   string   `json:"id"`
	Runtime              string   `json:"runtime"`
	Label                string   `json:"label"`
	AuthMode             string   `json:"authMode"`
	ConnectionType       string   `json:"connectionType"`
	BaseURL              string   `json:"baseUrl,omitempty"`
	Model                string   `json:"model,omitempty"`
	Models               []string `json:"models,omitempty"`
	PromptPrefix         string   `json:"promptPrefix,omitempty"`
	ClaudeEffort         string   `json:"claudeEffort,omitempty"`
	ClaudePermissionMode string   `json:"claudePermissionMode,omitempty"`
	CodexReasoningEffort string   `json:"codexReasoningEffort,omitempty"`
	CodexSandboxMode     string   `json:"codexSandboxMode,omitempty"`
	CodexApprovalPolicy  string   `json:"codexApprovalPolicy,omitempty"`
	CodexSpeed           string   `json:"codexSpeed,omitempty"`
	HasCredential        bool     `json:"hasCredential"`
	OwnerUserID          string   `json:"ownerUserId,omitempty"`
	UpdatedAtLabel       string   `json:"updatedAtLabel"`
}

// DeviceProfileBinding records which server profiles a device may run.
type DeviceProfileBinding struct {
	DeviceID  string `json:"deviceId"`
	ProfileID string `json:"profileId"`
	Enabled   bool   `json:"enabled"`
}

// SaveProfileInput creates or updates a server profile. APIKey is write-only:
// sealed on arrival, never read back. Omitting it keeps the stored credential.
type SaveProfileInput struct {
	ID                   string   `json:"id,omitempty"`
	Runtime              string   `json:"runtime"`
	Label                string   `json:"label"`
	AuthMode             string   `json:"authMode"`
	ConnectionType       string   `json:"connectionType"`
	BaseURL              string   `json:"baseUrl,omitempty"`
	Model                string   `json:"model,omitempty"`
	Models               []string `json:"models,omitempty"`
	PromptPrefix         string   `json:"promptPrefix,omitempty"`
	ClaudeEffort         string   `json:"claudeEffort,omitempty"`
	ClaudePermissionMode string   `json:"claudePermissionMode,omitempty"`
	CodexReasoningEffort string   `json:"codexReasoningEffort,omitempty"`
	CodexSandboxMode     string   `json:"codexSandboxMode,omitempty"`
	CodexApprovalPolicy  string   `json:"codexApprovalPolicy,omitempty"`
	CodexSpeed           string   `json:"codexSpeed,omitempty"`
	APIKey               string   `json:"apiKey,omitempty"`
	// OwnerUserID is set by the server from the caller on create and never
	// changed by an update; clients cannot supply it.
	OwnerUserID string `json:"-"`
}

// SetDeviceProfilesInput replaces the whole enabled set for one device.
type SetDeviceProfilesInput struct {
	DeviceID   string   `json:"deviceId"`
	ProfileIDs []string `json:"profileIds"`
}

// PromoteProfileInput lifts a daemon-discovered device profile into a server
// profile. The credential the device holds always moves with it: a promoted
// profile without a credential cannot authenticate anywhere, including on the
// device it came from, because a dispatched server definition never consults
// the local profiles file.
type PromoteProfileInput struct {
	DeviceID  string `json:"deviceId"`
	ProfileID string `json:"profileId"`
}

type ProfileAuthorization struct {
	ID        string `json:"id"`
	ProfileID string `json:"profileId"`
	Runtime   string `json:"runtime"`
	Status    string `json:"status"`
	URL       string `json:"url,omitempty"`
	Code      string `json:"code,omitempty"`
	Message   string `json:"message,omitempty"`
}

type StartProfileAuthorizationInput struct {
	DeviceID string `json:"deviceId"`
}

type CompleteProfileAuthorizationInput struct {
	AuthorizationResult string `json:"authorizationResult,omitempty"`
}

type AgentProjection struct {
	ID                 string `json:"id"`
	WorkspaceID        string `json:"workspaceId"`
	DeviceID           string `json:"deviceId"`
	DeviceLabel        string `json:"deviceLabel"`
	Provider           string `json:"provider"`
	ProfileID          string `json:"profileId,omitempty"`
	ProfileFingerprint string `json:"profileFingerprint,omitempty"`
	ProfileLabel       string `json:"profileLabel,omitempty"`
	ConnectionType     string `json:"connectionType,omitempty"`
	Status             string `json:"status"`
	AuthMode           string `json:"authMode"`
	SecretStored       string `json:"secretStored"`
	ConfigScope        string `json:"configScope"`
	ConfigLabel        string `json:"configLabel"`
	LastSeenLabel      string `json:"lastSeenLabel"`
	StatusDetail       string `json:"statusDetail,omitempty"`
}

type WorkspaceFileEntry struct {
	ID           string `json:"id"`
	WorkspaceID  string `json:"workspaceId"`
	Path         string `json:"path"`
	Name         string `json:"name"`
	Kind         string `json:"kind"`
	SizeLabel    string `json:"sizeLabel"`
	UpdatedLabel string `json:"updatedLabel"`
}

type WorkspaceFileRead struct {
	WorkspaceID string `json:"workspaceId"`
	Path        string `json:"path"`
	Content     string `json:"content"`
	Truncated   bool   `json:"truncated"`
}

type WorkspaceDirectoryEntry struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Path string `json:"path"`
}

type WorkspaceTreeEntry struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Path        string `json:"path"`
	IsDirectory bool   `json:"isDirectory"`
	Size        int64  `json:"size,omitempty"`
	Extension   string `json:"extension,omitempty"`
}

type SkillPackRef struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Scope       string `json:"scope,omitempty"`
	Source      string `json:"source,omitempty"`
	Version     string `json:"version"`
	WorkspaceID string `json:"workspaceId,omitempty"`
}

// DeviceSkillRoot is one scan root configured for a device. Roots the server
// supplies as defaults are reported with IsDefault=true and have no row.
type DeviceSkillRoot struct {
	DeviceID  string `json:"deviceId"`
	Path      string `json:"path"`
	IsDefault bool   `json:"isDefault"`
}

// DeviceSkill is one local skill a device observed during a scan.
type SkillDependencyStrength string

const (
	SkillDependencyRequired SkillDependencyStrength = "required"
	SkillDependencyRelated  SkillDependencyStrength = "related"
)

type SkillDependency struct {
	SkillName     string                  `json:"skillName"`
	Strength      SkillDependencyStrength `json:"strength"`
	Evidence      string                  `json:"evidence,omitempty"`
	Status        string                  `json:"status,omitempty"`
	TargetRoot    string                  `json:"targetRoot,omitempty"`
	TargetDirName string                  `json:"targetDirName,omitempty"`
}

type DeviceSkill struct {
	Manifest                []SkillFileInfo   `json:"manifest,omitempty"`
	ServerState             string            `json:"serverState,omitempty"`
	ServerRevision          int               `json:"serverRevision,omitempty"`
	ServerCandidates        []PromotedSkill   `json:"serverCandidates,omitempty"`
	DeviceID                string            `json:"deviceId"`
	Root                    string            `json:"root"`
	DirName                 string            `json:"dirName"`
	Name                    string            `json:"name"`
	Description             string            `json:"description"`
	SizeBytes               int64             `json:"sizeBytes"`
	MtimeLabel              string            `json:"mtimeLabel"`
	PromotedSkillID         string            `json:"promotedSkillId,omitempty"`
	Dependencies            []SkillDependency `json:"dependencies,omitempty"`
	DependencyAnalysisError string            `json:"dependencyAnalysisError,omitempty"`
	DependenciesAnalyzed    bool              `json:"dependenciesAnalyzed"`
	SourceDigest            string            `json:"sourceDigest,omitempty"`
}

// PromotedSkill is a server catalog entry. Content lives in revisions.
type PromotedSkill struct {
	SourceDigest            string            `json:"sourceDigest,omitempty"`
	UsedByWorkspaces        []string          `json:"usedByWorkspaces,omitempty"`
	ID                      string            `json:"id"`
	Name                    string            `json:"name"`
	Description             string            `json:"description"`
	OriginDeviceID          string            `json:"originDeviceId"`
	OriginDeviceLabel       string            `json:"originDeviceLabel"`
	OriginRoot              string            `json:"originRoot"`
	OriginDirName           string            `json:"originDirName"`
	LatestRevision          int               `json:"latestRevision"`
	CreatedLabel            string            `json:"createdLabel"`
	UpdatedLabel            string            `json:"updatedLabel"`
	Dependencies            []SkillDependency `json:"dependencies,omitempty"`
	DependencyAnalysisError string            `json:"dependencyAnalysisError,omitempty"`
}

// SessionSkillRef is a resolved (skill, revision) pair attached to a
// dispatched session. Checksum/ByteSize let the worker verify its cache.
type SessionSkillRef struct {
	SkillID  string `json:"skillId"`
	Revision int    `json:"revision"`
	Name     string `json:"name"`
	Checksum string `json:"checksum"`
	ByteSize int64  `json:"byteSize"`
}

// WorkspaceSkillBinding is one selected catalog entry for a workspace.
type WorkspaceSkillBinding struct {
	WorkspaceID string `json:"workspaceId"`
	SkillID     string `json:"skillId"`
}

// SetDeviceSkillRootsInput replaces the custom scan roots for one device.
type SetDeviceSkillRootsInput struct {
	DeviceID string   `json:"deviceId"`
	Paths    []string `json:"paths"`
}

// ReplaceDeviceSkillsInput stores one scan snapshot for one device.
type ReplaceDeviceSkillsInput struct {
	DeviceID string        `json:"deviceId"`
	Skills   []DeviceSkill `json:"skills"`
}

// PromoteSkillInput lifts one device-local skill into the server catalog.
type PromoteSkillInput struct {
	TargetSkillID  string                     `json:"-"`
	ForceNew       bool                       `json:"-"`
	Resolutions    []SkillPromotionResolution `json:"resolutions,omitempty"`
	PlanDigest     string                     `json:"planDigest,omitempty"`
	IncludeRelated []string                   `json:"includeRelated,omitempty"`
	DeviceID       string                     `json:"deviceId"`
	Root           string                     `json:"root"`
	DirName        string                     `json:"dirName"`
}

// SetWorkspaceSkillsInput replaces the workspace's whole selection.
type SetWorkspaceSkillsInput struct {
	WorkspaceID string   `json:"workspaceId"`
	SkillIDs    []string `json:"skillIds"`
}

// SkillPackage is one immutable promoted revision's zip payload.
type SkillPackage struct {
	SkillID   string
	Revision  int
	Content   []byte
	Checksum  string
	ByteSize  int64
	FileCount int
}

type RunEvent struct {
	ID     string `json:"id"`
	RunID  string `json:"runId"`
	At     string `json:"at"`
	Label  string `json:"label"`
	Detail string `json:"detail"`
	Level  string `json:"level"`
}

type AcceptanceArtifact struct {
	ID         string `json:"id"`
	IssueID    string `json:"issueId"`
	Kind       string `json:"kind"`
	Title      string `json:"title"`
	Summary    string `json:"summary"`
	PrimaryURI string `json:"primaryUri,omitempty"`
}

type Run struct {
	EnvironmentID       string     `json:"environmentId,omitempty"`
	EnvironmentRevision int        `json:"environmentRevision,omitempty"`
	ExecutionCwd        string     `json:"executionCwd,omitempty"`
	Error               string     `json:"error,omitempty"`
	ID                  string     `json:"id"`
	IssueID             string     `json:"issueId"`
	WorkspaceID         string     `json:"workspaceId,omitempty"`
	Status              string     `json:"status"`
	Runtime             string     `json:"runtime"`
	StartedLabel        string     `json:"startedLabel"`
	StartedAt           string     `json:"startedAt,omitempty"`
	CompletedAt         string     `json:"completedAt,omitempty"`
	Events              []RunEvent `json:"events"`
}

// SessionTokenIdentity is the resolved actor behind a valid agent session
// bearer token. AccountID is reserved for the upcoming accounts system.
type SessionTokenIdentity struct {
	SessionID   string `json:"sessionId"`
	WorkspaceID string `json:"workspaceId"`
	DeviceID    string `json:"deviceId"`
	AccountID   string `json:"accountId,omitempty"`
}

type AgentSessionEvent struct {
	ID        string                     `json:"id"`
	SessionID string                     `json:"sessionId"`
	At        string                     `json:"at"`
	Label     string                     `json:"label"`
	Detail    string                     `json:"detail"`
	Level     string                     `json:"level"`
	Metadata  *AgentSessionEventMetadata `json:"metadata,omitempty"`
	Message   *TranscriptMessage         `json:"message,omitempty"`
}

type AgentScheduledTask struct {
	ID            string `json:"id"`
	Kind          string `json:"kind"`
	Schedule      string `json:"schedule"`
	HumanSchedule string `json:"humanSchedule"`
	Recurring     bool   `json:"recurring"`
	Prompt        string `json:"prompt"`
	NextFireAt    string `json:"nextFireAt,omitempty"`
}

type AgentSessionTimerFire struct {
	ID          string `json:"id,omitempty"`
	Origin      string `json:"origin"`
	Prompt      string `json:"prompt"`
	Response    string `json:"response,omitempty"`
	StartedAt   string `json:"startedAt,omitempty"`
	CompletedAt string `json:"completedAt"`
}

type AgentSessionEventMetadata struct {
	OutputFile    string                 `json:"outputFile,omitempty"`
	Prompt        string                 `json:"prompt,omitempty"`
	SubagentType  string                 `json:"subagentType,omitempty"`
	TaskID        string                 `json:"taskId,omitempty"`
	TaskType      string                 `json:"taskType,omitempty"`
	ToolUseID     string                 `json:"toolUseId,omitempty"`
	TimerSnapshot []AgentScheduledTask   `json:"timerSnapshot,omitempty"`
	TimerFire     *AgentSessionTimerFire `json:"timerFire,omitempty"`
}

type AgentSubagentTranscriptMessage struct {
	Content string `json:"content"`
	ID      string `json:"id"`
	Role    string `json:"role"`
	Title   string `json:"title,omitempty"`
	Kind    string `json:"kind,omitempty"`
	CallID  string `json:"callId,omitempty"`
	Status  string `json:"status,omitempty"`
}

type AgentSubagentTranscript struct {
	Messages     []AgentSubagentTranscriptMessage `json:"messages"`
	Prompt       string                           `json:"prompt,omitempty"`
	SessionID    string                           `json:"sessionId"`
	Status       string                           `json:"status"`
	SubagentType string                           `json:"subagentType,omitempty"`
	TaskID       string                           `json:"taskId"`
	Title        string                           `json:"title"`
	ToolUseID    string                           `json:"toolUseId"`
}

type AgentSubagentSummary struct {
	Prompt        string   `json:"prompt,omitempty"`
	ResponseTexts []string `json:"responseTexts"`
	SessionID     string   `json:"sessionId"`
	Status        string   `json:"status"`
	SubagentType  string   `json:"subagentType,omitempty"`
	TaskID        string   `json:"taskId"`
	Title         string   `json:"title"`
	ToolUseID     string   `json:"toolUseId"`
}

type ChatAttachment struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Path     string `json:"path"`
	MIMEType string `json:"mimeType"`
	Size     int64  `json:"size"`
	Kind     string `json:"kind"`
}

type AgentSession struct {
	// CreatedByUserID is the account that started it; agent-created sessions
	// inherit their parent's. Set by the server, never by clients.
	CreatedByUserID    string `json:"createdByUserId,omitempty"`
	ID                 string `json:"id"`
	ThreadID           string `json:"threadId,omitempty"`
	NativeSessionID    string `json:"nativeSessionId,omitempty"`
	WorkspaceID        string `json:"workspaceId"`
	AgentID            string `json:"agentId"`
	DeviceID           string `json:"deviceId"`
	Provider           string `json:"provider"`
	ProfileID          string `json:"profileId,omitempty"`
	ProfileFingerprint string `json:"profileFingerprint,omitempty"`
	ProfileLabel       string `json:"profileLabel,omitempty"`
	Source             string `json:"source,omitempty"`
	// ParentSessionID records orchestration lineage: the agent session that
	// created this one. Empty for human/browser chats. It is orthogonal to
	// ThreadID, which links turns of one continued conversation.
	ParentSessionID string `json:"parentSessionId,omitempty"`
	// SupervisorSessionID is a human-confirmed takeover of control: set via an
	// explicit adopt action, never transferred implicitly. Birth lineage in
	// ParentSessionID never changes.
	SupervisorSessionID string `json:"supervisorSessionId,omitempty"`
	// IssueID runs the session inside an existing Issue candidate worktree
	// instead of the workspace root, enabling safe parallel writes.
	IssueID string `json:"issueId,omitempty"`
	// GroupNameTarget marks a source=naming utility session whose response
	// should rename the auto-created orchestration group with this id.
	GroupNameTarget string `json:"groupNameTarget,omitempty"`
	// CreatedGroupID is populated on a session that caused a new orchestration
	// group to be created, so the HTTP layer can trigger async naming.
	CreatedGroupID        string              `json:"createdGroupId,omitempty"`
	Model                 string              `json:"model,omitempty"`
	ClaudeEffort          string              `json:"claudeEffort,omitempty"`
	ClaudePermissionMode  string              `json:"claudePermissionMode,omitempty"`
	CodexReasoningEffort  string              `json:"codexReasoningEffort,omitempty"`
	CodexSandboxMode      string              `json:"codexSandboxMode,omitempty"`
	CodexApprovalPolicy   string              `json:"codexApprovalPolicy,omitempty"`
	CodexSpeed            string              `json:"codexSpeed,omitempty"`
	Status                string              `json:"status"`
	BlockedReason         string              `json:"blockedReason,omitempty"`
	Title                 string              `json:"title"`
	Prompt                string              `json:"prompt"`
	Attachments           []ChatAttachment    `json:"attachments,omitempty"`
	SkillRefs             []SessionSkillRef   `json:"skillRefs,omitempty"`
	ProfileTransitionNote string              `json:"profileTransitionNote,omitempty"`
	ImportedContext       string              `json:"importedContext,omitempty"`
	Response              string              `json:"response,omitempty"`
	Error                 string              `json:"error,omitempty"`
	StartedAt             string              `json:"startedAt,omitempty"`
	LastActivityAt        string              `json:"lastActivityAt,omitempty"`
	CompletedAt           string              `json:"completedAt,omitempty"`
	AnswerRevision        string              `json:"answerRevision,omitempty"`
	CreatedLabel          string              `json:"createdLabel"`
	UpdatedLabel          string              `json:"updatedLabel"`
	Events                []AgentSessionEvent `json:"events,omitempty"`
}

type IssueConversationMessage struct {
	ID        string `json:"id"`
	Role      string `json:"role"`
	Text      string `json:"text"`
	RunID     string `json:"runId,omitempty"`
	CreatedAt string `json:"createdAt"`
}

type IssueBlockedReason struct {
	Kind    string `json:"kind"`
	Message string `json:"message"`
}

type Issue struct {
	// CreatedByUserID is the account that started it; agent-created sessions
	// inherit their parent's. Set by the server, never by clients.
	CreatedByUserID            string                     `json:"createdByUserId,omitempty"`
	ExecutionContract          *IssueContract             `json:"executionContract,omitempty"`
	ContractState              string                     `json:"contractState,omitempty"`
	CurrentContractRevision    *int                       `json:"currentContractRevision,omitempty"`
	DraftContractRevision      *int                       `json:"draftContractRevision,omitempty"`
	CurrentCandidateSnapshotID *string                    `json:"currentCandidateSnapshotId,omitempty"`
	CurrentReviewSnapshotID    *string                    `json:"currentReviewSnapshotId,omitempty"`
	VerificationSummary        *VerificationSummary       `json:"verificationSummary,omitempty"`
	BlockedReason              *IssueBlockedReason        `json:"blockedReason,omitempty"`
	CodexSpeed                 string                     `json:"codexSpeed,omitempty"`
	Model                      string                     `json:"model,omitempty"`
	ProfileID                  string                     `json:"profileId,omitempty"`
	ClaudeEffort               string                     `json:"claudeEffort,omitempty"`
	CodexReasoningEffort       string                     `json:"codexReasoningEffort,omitempty"`
	Messages                   []IssueConversationMessage `json:"messages,omitempty"`
	ID                         string                     `json:"id"`
	WorkspaceID                string                     `json:"workspaceId,omitempty"`
	ShortID                    string                     `json:"shortId"`
	Title                      string                     `json:"title"`
	Status                     string                     `json:"status"`
	Priority                   string                     `json:"priority"`
	Readiness                  string                     `json:"readiness,omitempty"`
	SourceInput                string                     `json:"sourceInput"`
	InferredTask               string                     `json:"inferredTask"`
	Runtime                    string                     `json:"runtime"`
	Skills                     []SkillPackRef             `json:"skills"`
	AcceptanceCriteria         []string                   `json:"acceptanceCriteria"`
	Checks                     []string                   `json:"checks"`
	Artifact                   *AcceptanceArtifact        `json:"artifact,omitempty"`
	Run                        *Run                       `json:"run,omitempty"`
	UpdatedLabel               string                     `json:"updatedLabel"`
}

type ChatThread struct {
	UpdatedAt          string              `json:"updatedAt,omitempty"`
	ID                 string              `json:"id"`
	WorkspaceID        string              `json:"workspaceId,omitempty"`
	Provider           string              `json:"provider,omitempty"`
	ProfileID          string              `json:"profileId,omitempty"`
	ProfileFingerprint string              `json:"profileFingerprint,omitempty"`
	ProfileLabel       string              `json:"profileLabel,omitempty"`
	NativeSessionID    string              `json:"nativeSessionId,omitempty"`
	Title              string              `json:"title"`
	Preview            string              `json:"preview"`
	HandoffContext     string              `json:"handoffContext,omitempty"`
	Transcript         []TranscriptMessage `json:"transcript,omitempty"`
	AnswerRevision     string              `json:"answerRevision,omitempty"`
	RecentMessages     []ChatRecapMessage  `json:"recentMessages,omitempty"`
	Status             string              `json:"status,omitempty"`
	Readonly           bool                `json:"readonly"`
	UpdatedLabel       string              `json:"updatedLabel"`
}

type ChatRecapMessage struct {
	Role string `json:"role"`
	Text string `json:"text"`
}

type TranscriptMessage struct {
	At     string `json:"at,omitempty"`
	ID     string `json:"id"`
	Kind   string `json:"kind"`
	Text   string `json:"text"`
	Title  string `json:"title,omitempty"`
	CallID string `json:"callId,omitempty"`
	Status string `json:"status,omitempty"`
}

type ChatLayoutGroup struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type ChatPlacement struct {
	ChatID  string `json:"chatId"`
	GroupID string `json:"groupId"`
}

type ChatLayout struct {
	Revision  int64             `json:"revision"`
	Groups    []ChatLayoutGroup `json:"groups"`
	Positions []ChatPlacement   `json:"positions"`
}

type SaveChatLayoutInput struct {
	WorkspaceID      string     `json:"workspaceId"`
	ExpectedRevision *int64     `json:"expectedRevision"`
	Layout           ChatLayout `json:"layout"`
}

type DeleteChatGroupInput struct {
	WorkspaceID      string `json:"workspaceId"`
	GroupID          string `json:"groupId"`
	ExpectedRevision *int64 `json:"expectedRevision"`
}

type ChatTitle struct {
	ChatID              string `json:"chatId"`
	Title               string `json:"title"`
	Version             string `json:"version"`
	GenerationSessionID string `json:"generationSessionId,omitempty"`
	GenerationStatus    string `json:"generationStatus,omitempty"`
	GenerationError     string `json:"generationError,omitempty"`
}

type RenameChatInput struct {
	WorkspaceID     string  `json:"workspaceId"`
	Title           string  `json:"title"`
	ExpectedVersion *string `json:"expectedVersion,omitempty"`
}

type AssetProjection struct {
	ID          string `json:"id"`
	WorkspaceID string `json:"workspaceId,omitempty"`
	Name        string `json:"name"`
	Kind        string `json:"kind"`
	Status      string `json:"status"`
	Detail      string `json:"detail"`
}

type CreateIssueInput struct {
	CreatedByUserID      string `json:"-"`
	CodexSpeed           string `json:"codexSpeed,omitempty"`
	Model                string `json:"model,omitempty"`
	ProfileID            string `json:"profileId,omitempty"`
	ClaudeEffort         string `json:"claudeEffort,omitempty"`
	CodexReasoningEffort string `json:"codexReasoningEffort,omitempty"`
	WorkspaceID          string `json:"workspaceId,omitempty"`
	Title                string `json:"title"`
	SourceInput          string `json:"sourceInput"`
	Runtime              string `json:"runtime"`
}

type CreateWorkspaceInput struct {
	DeviceID string `json:"deviceId"`
	Path     string `json:"path"`
}

type CreateAgentProfileInput struct {
	ID                   string            `json:"id,omitempty"`
	DeviceID             string            `json:"deviceId,omitempty"`
	WorkspaceID          string            `json:"workspaceId,omitempty"`
	Runtime              string            `json:"runtime"`
	Label                string            `json:"label"`
	ConfigScope          string            `json:"configScope"`
	ConnectionType       string            `json:"connectionType"`
	BaseURL              string            `json:"baseUrl,omitempty"`
	Model                string            `json:"model,omitempty"`
	Models               []string          `json:"models,omitempty"`
	PromptPrefix         string            `json:"promptPrefix,omitempty"`
	ClaudeEffort         string            `json:"claudeEffort,omitempty"`
	ClaudePermissionMode string            `json:"claudePermissionMode,omitempty"`
	CodexReasoningEffort string            `json:"codexReasoningEffort,omitempty"`
	CodexSandboxMode     string            `json:"codexSandboxMode,omitempty"`
	CodexApprovalPolicy  string            `json:"codexApprovalPolicy,omitempty"`
	CodexSpeed           string            `json:"codexSpeed,omitempty"`
	APIKey               string            `json:"apiKey,omitempty"`
	Command              string            `json:"command,omitempty"`
	Env                  map[string]string `json:"env,omitempty"`
}

type CreateAgentSessionInput struct {
	CreatedByUserID       string           `json:"-"`
	WorkspaceID           string           `json:"workspaceId"`
	ThreadID              string           `json:"threadId"`
	NativeSessionID       string           `json:"nativeSessionId,omitempty"`
	AgentID               string           `json:"agentId"`
	Provider              string           `json:"provider"`
	ProfileID             string           `json:"profileId,omitempty"`
	Model                 string           `json:"model,omitempty"`
	ClaudeEffort          string           `json:"claudeEffort,omitempty"`
	ClaudePermissionMode  string           `json:"claudePermissionMode,omitempty"`
	CodexReasoningEffort  string           `json:"codexReasoningEffort,omitempty"`
	CodexSandboxMode      string           `json:"codexSandboxMode,omitempty"`
	CodexApprovalPolicy   string           `json:"codexApprovalPolicy,omitempty"`
	CodexSpeed            string           `json:"codexSpeed,omitempty"`
	Prompt                string           `json:"prompt"`
	Attachments           []ChatAttachment `json:"attachments,omitempty"`
	ProfileTransitionNote string           `json:"profileTransitionNote,omitempty"`
	ImportedContext       string           `json:"importedContext,omitempty"`
	ParentSessionID       string           `json:"parentSessionId,omitempty"`
	SupervisorSessionID   string           `json:"supervisorSessionId,omitempty"`
	IssueID               string           `json:"issueId,omitempty"`
	// ForkSessionID resumes another session's native transcript in a brand
	// new thread without continuing its Foundry thread.
	ForkSessionID string `json:"forkSessionId,omitempty"`
	// Verification requests a read-only utility verifier session.
	Verification bool   `json:"verification,omitempty"`
	Source       string `json:"source"`
}

type AgentModelOption struct {
	ID    string `json:"id"`
	Label string `json:"label,omitempty"`
}

type ListAgentModelsInput struct {
	Profile CreateAgentProfileInput `json:"profile"`
}

type UpsertAgentRuntimeSettingsInput struct {
	DeviceID string               `json:"deviceId,omitempty"`
	Settings AgentRuntimeSettings `json:"settings"`
}

type DaemonRegistration struct {
	// ActiveSessionIDs are execution claims owned by this daemon process. An
	// empty, present list means the process owns no sessions; a missing list is
	// retained for compatibility with workers predating session-level claims.
	ActiveSessionIDs []string                 `json:"activeSessionIds"`
	Device           DeviceProjection         `json:"device"`
	Workspace        WorkspaceProjection      `json:"workspace"`
	ProviderHealth   []ProviderHealth         `json:"providerHealth"`
	AgentProfiles    []AgentProfileProjection `json:"agentProfiles,omitempty"`
	Chats            []ChatThread             `json:"chats,omitempty"`
	Assets           []AssetProjection        `json:"assets"`
	Agents           []AgentProjection        `json:"agents"`
	Skills           []SkillPackRef           `json:"skills"`
	WorkspaceFiles   []WorkspaceFileEntry     `json:"workspaceFiles"`
}

type FoundryDataProjection struct {
	Runs                   []Run                    `json:"runs,omitempty"`
	Workspace              WorkspaceProjection      `json:"workspace"`
	Workspaces             []WorkspaceProjection    `json:"workspaces"`
	Devices                []DeviceProjection       `json:"devices"`
	ProviderHealth         []ProviderHealth         `json:"providerHealth"`
	AgentProfiles          []AgentProfileProjection `json:"agentProfiles"`
	Profiles               []ProfileDefinition      `json:"profiles"`
	DeviceProfiles         []DeviceProfileBinding   `json:"deviceProfiles"`
	DeviceSkillRoots       []DeviceSkillRoot        `json:"deviceSkillRoots"`
	DeviceSkills           []DeviceSkill            `json:"deviceSkills"`
	PromotedSkills         []PromotedSkill          `json:"promotedSkills"`
	WorkspaceSkillBindings []WorkspaceSkillBinding  `json:"workspaceSkillBindings"`
	Agents                 []AgentProjection        `json:"agents"`
	WorkspaceFiles         []WorkspaceFileEntry     `json:"workspaceFiles"`
	AgentSessions          []AgentSession           `json:"agentSessions"`
	Skills                 []SkillPackRef           `json:"skills"`
	Issues                 []Issue                  `json:"issues"`
	Chats                  []ChatThread             `json:"chats"`
	Assets                 []AssetProjection        `json:"assets"`
}

type SyncChatsInput struct {
	WorkspaceID string       `json:"workspaceId"`
	Chats       []ChatThread `json:"chats"`
}

type StartRunInput struct {
	Run Run `json:"run"`
}

type AppendRunEventInput struct {
	Event RunEvent `json:"event"`
}

type CompleteIssueInput struct {
	Canceled            bool               `json:"canceled,omitempty"`
	Response            string             `json:"response,omitempty"`
	EnvironmentID       string             `json:"environmentId,omitempty"`
	EnvironmentRevision int                `json:"environmentRevision,omitempty"`
	ExecutionCwd        string             `json:"executionCwd,omitempty"`
	Error               string             `json:"error,omitempty"`
	RunID               string             `json:"runId"`
	Artifact            AcceptanceArtifact `json:"artifact"`
	Checks              []string           `json:"checks"`
}

// SkillPromotionPlan is reviewed before publishing the complete required closure.
type SkillPromotionPlan struct {
	Digest   string            `json:"digest"`
	Skills   []DeviceSkill     `json:"skills"`
	Problems []string          `json:"problems"`
	Related  []SkillDependency `json:"related"`
}
type SkillPromotionPackage struct {
	Resolution SkillPromotionResolution
	Source     DeviceSkill
	Content    []byte
	FileCount  int
}

// SkillFileInfo is cached metadata; file contents are loaded on demand.
type SkillFileInfo struct {
	Path      string `json:"path"`
	Digest    string `json:"digest"`
	SizeBytes int64  `json:"sizeBytes"`
	Binary    bool   `json:"binary"`
}
type SkillRevisionIndex struct {
	SourceDigest string          `json:"sourceDigest"`
	Files        []SkillFileInfo `json:"files"`
}
type SkillFileChange struct {
	Path   string         `json:"path"`
	Kind   string         `json:"kind"`
	Before *SkillFileInfo `json:"before,omitempty"`
	After  *SkillFileInfo `json:"after,omitempty"`
}
type SkillComparison struct {
	Files     []SkillFileChange `json:"files"`
	Unchanged int               `json:"unchanged"`
	Revision  int               `json:"revision"`
}
type SkillFileComparison struct {
	Before      string `json:"before"`
	After       string `json:"after"`
	Unavailable string `json:"unavailable,omitempty"`
}
type SkillPromotionResolution struct {
	Root             string `json:"root"`
	DirName          string `json:"dirName"`
	Action           string `json:"action"`
	TargetSkillID    string `json:"targetSkillId,omitempty"`
	ExpectedRevision int    `json:"expectedRevision,omitempty"`
	Name             string `json:"name,omitempty"`
}
type SkillComparisonInput struct {
	DeviceID     string `json:"deviceId"`
	Root         string `json:"root"`
	DirName      string `json:"dirName"`
	SkillID      string `json:"skillId"`
	Revision     int    `json:"revision"`
	SourceDigest string `json:"sourceDigest"`
	Path         string `json:"path,omitempty"`
	Side         string `json:"side,omitempty"`
}
