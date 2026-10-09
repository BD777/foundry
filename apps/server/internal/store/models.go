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
	// UnavailableOnDevice is set while its device, connected, does not serve
	// the folder. Its sessions and history stay; adding the folder on the
	// device again clears it.
	UnavailableOnDevice *WorkspaceUnavailability `json:"unavailableOnDevice,omitempty"`
}

// WorkspaceUnavailability says why a workspace cannot run on its device.
type WorkspaceUnavailability struct {
	// Reason is WorkspaceNotServed: the device's worker, at its last
	// registration, did not list the folder among those it serves.
	Reason string `json:"reason"`
	Since  string `json:"since"`
}

// WorkspaceNotServed: the device no longer serves the folder.
const WorkspaceNotServed = "not_served"

type DeviceProjection struct {
	ID              string                `json:"id"`
	Label           string                `json:"label"`
	Status          string                `json:"status"`
	LastSeenLabel   string                `json:"lastSeenLabel"`
	RuntimeSettings *AgentRuntimeSettings `json:"runtimeSettings,omitempty"`
	// Owned reports whether the caller owns (and may manage) the device.
	Owned bool `json:"owned,omitempty"`
	// Resources is what the device offers sessions, reported by its worker.
	Resources []DeviceResource `json:"resources,omitempty"`
	// Capabilities are the protocol features its worker declared at its
	// last registration; an older worker declares none.
	Capabilities []string `json:"capabilities,omitempty"`
	// Worker is the build the device's worker runs and the command that
	// updates it there, reported at registration (0.5.7 and later).
	Worker *DeviceWorker `json:"worker,omitempty"`
	// System describes the machine, reported at registration (0.5.7 and later).
	System *DeviceSystem `json:"system,omitempty"`
	// WorkerUpdate is set while an update requested from Foundry runs; the
	// server adds it to projections, the worker never reports it.
	WorkerUpdate *DeviceWorkerUpdate `json:"workerUpdate,omitempty"`
	// LastDisconnect is the last time the device dropped; the server adds it
	// to projections.
	LastDisconnect *DeviceDisconnect `json:"lastDisconnect,omitempty"`
	// SkillsVersion changes when the device's scanned skills or the catalog
	// they are compared with change. Workspace data leaves the skill lists
	// out (hundreds of skills per device); clients load one device's list
	// from /api/device-skills and reload it when this changes. The server
	// adds it to projections.
	SkillsVersion string `json:"skillsVersion,omitempty"`
}

// DeviceWorkerUpdate is an update in progress: when it was asked for and the
// version it brings.
type DeviceWorkerUpdate struct {
	StartedAt string `json:"startedAt"`
	Version   string `json:"version,omitempty"`
	// FromVersion is the version the device ran when the update started.
	FromVersion string `json:"fromVersion,omitempty"`
	// Log is the file on the device the update writes to.
	Log string `json:"log,omitempty"`
	// Stalled: the device still runs FromVersion well after the update
	// started; it did not finish and may be started again.
	Stalled bool `json:"stalled,omitempty"`
	// Step is what the update is doing, from the server's status probes:
	// starting, checking, downloading, installing or restarting. After a
	// failure it is the last step seen.
	Step string `json:"step,omitempty"`
	// StepDetail is what the step waits on, such as a retry.
	StepDetail string `json:"stepDetail,omitempty"`
	// Failure says why the update failed; it may be started again.
	Failure string `json:"failure,omitempty"`
	// FailureCode: "exited" (the update command failed), "vanished" (it
	// ended without reporting) or "not_back" (the worker did not reconnect
	// after restarting).
	FailureCode string `json:"failureCode,omitempty"`
	// ExitCode is the failed update command's exit status.
	ExitCode *int `json:"exitCode,omitempty"`
	// LogTail is the end of the update's log on the device, redacted.
	LogTail []string `json:"logTail,omitempty"`
}

// DeviceSystem describes the machine, as its worker reports it.
type DeviceSystem struct {
	Hostname    string `json:"hostname"`
	OS          string `json:"os"`
	OSVersion   string `json:"osVersion,omitempty"`
	Kernel      string `json:"kernel,omitempty"`
	Arch        string `json:"arch"`
	CPUModel    string `json:"cpuModel,omitempty"`
	CPUCount    int    `json:"cpuCount,omitempty"`
	MemoryBytes int64  `json:"memoryBytes,omitempty"`
	User        string `json:"user,omitempty"`
	NodeVersion string `json:"nodeVersion,omitempty"`
}

type DeviceWorker struct {
	Version string `json:"version"`
	Command string `json:"command,omitempty"`
}

// DeviceResource is a capability already present on a device that sessions
// may use, such as an installed browser.
type DeviceResource struct {
	ID         string            `json:"id"`
	Kind       string            `json:"kind"`
	Name       string            `json:"name"`
	Available  bool              `json:"available"`
	Detail     string            `json:"detail,omitempty"`
	Attributes map[string]string `json:"attributes,omitempty"`
}

type AgentRuntimeSettings struct {
	ActiveRuntimeTtlMs int `json:"activeRuntimeTtlMs"`
	MaxConcurrentTasks int `json:"maxConcurrentTasks"`
}

type ProviderHealth struct {
	DeviceID     string     `json:"deviceId,omitempty"`
	Provider     string     `json:"provider"`
	Status       string     `json:"status"`
	AuthMode     string     `json:"authMode"`
	SecretStored string     `json:"secretStored"`
	AccountLabel string     `json:"accountLabel,omitempty"`
	StatusDetail string     `json:"statusDetail,omitempty"`
	Cli          *NativeCli `json:"cli,omitempty"`
	// OfficialSkills are the skills this agent ships itself; sessions on it
	// always have them, besides their workspace's selection.
	OfficialSkills []OfficialSkill `json:"officialSkills,omitempty"`
}

// OfficialSkill is a skill Claude Code or Codex ships itself.
type OfficialSkill struct {
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
}

// NativeCli is the device's own Claude Code / Codex program, which Foundry
// runs instead of shipping a copy.
type NativeCli struct {
	Installed      bool   `json:"installed"`
	Version        string `json:"version,omitempty"`
	MinimumVersion string `json:"minimumVersion,omitempty"`
	Outdated       bool   `json:"outdated,omitempty"`
	InstallCommand string `json:"installCommand,omitempty"`
	UpdateCommand  string `json:"updateCommand,omitempty"`
}

// NativeCliInstallResult is what running the official installer for a
// device's program produced.
type NativeCliInstallResult struct {
	Runtime string     `json:"runtime"`
	OK      bool       `json:"ok"`
	Command string     `json:"command"`
	Log     string     `json:"log"`
	Cli     *NativeCli `json:"cli,omitempty"`
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

type AgentProfileCheck struct {
	Status    string `json:"status"`
	CheckedAt string `json:"checkedAt,omitempty"`
	Message   string `json:"message,omitempty"`
}

type AgentProfileProjection struct {
	AccountLabel         string             `json:"accountLabel,omitempty"`
	ID                   string             `json:"id"`
	DeviceID             string             `json:"deviceId"`
	Runtime              string             `json:"runtime"`
	Label                string             `json:"label"`
	Fingerprint          string             `json:"fingerprint,omitempty"`
	Status               string             `json:"status"`
	AuthMode             string             `json:"authMode"`
	SecretStored         string             `json:"secretStored"`
	ServerCredential     bool               `json:"serverCredential,omitempty"`
	ConfigScope          string             `json:"configScope"`
	ConfigLabel          string             `json:"configLabel"`
	ConfigSection        string             `json:"configSection,omitempty"`
	Check                *AgentProfileCheck `json:"check,omitempty"`
	Shareable            bool               `json:"shareable,omitempty"`
	ConnectionType       string             `json:"connectionType"`
	Model                string             `json:"model,omitempty"`
	Models               []string           `json:"models,omitempty"`
	PromptPrefix         string             `json:"promptPrefix,omitempty"`
	ClaudeEffort         string             `json:"claudeEffort,omitempty"`
	ClaudePermissionMode string             `json:"claudePermissionMode,omitempty"`
	CodexReasoningEffort string             `json:"codexReasoningEffort,omitempty"`
	CodexSandboxMode     string             `json:"codexSandboxMode,omitempty"`
	CodexApprovalPolicy  string             `json:"codexApprovalPolicy,omitempty"`
	CodexSpeed           string             `json:"codexSpeed,omitempty"`
	BaseURL              string             `json:"baseUrl,omitempty"`
	CommandLabel         string             `json:"commandLabel,omitempty"`
	Origin               string             `json:"origin"`
	PromotedProfileID    string             `json:"promotedProfileId,omitempty"`
	LastSeenLabel        string             `json:"lastSeenLabel"`
	StatusDetail         string             `json:"statusDetail,omitempty"`
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

// SessionFileRecord is a file a session's own write tools changed, or its
// answer named, recorded once per turn by the worker.
type SessionFileRecord struct {
	Path          string `json:"path"`
	WorkspacePath string `json:"workspacePath,omitempty"`
	Origin        string `json:"origin"`
	Op            string `json:"op"`
	InGitRepo     bool   `json:"inGitRepo"`
	InputID       string `json:"inputId,omitempty"`
	Agent         string `json:"agent,omitempty"`
	Bytes         *int64 `json:"bytes,omitempty"`
	Added         *int   `json:"added,omitempty"`
	Removed       *int   `json:"removed,omitempty"`
	TotalAdded    *int   `json:"totalAdded,omitempty"`
	TotalRemoved  *int   `json:"totalRemoved,omitempty"`
}

// SessionFileReference is a path an answer names that its device verified.
type SessionFileReference struct {
	Text string `json:"text"`
	Path string `json:"path"`
	Kind string `json:"kind"`
}

// SessionFileRead is one of a session's recorded files, read from its device.
type SessionFileRead struct {
	SessionID            string `json:"sessionId"`
	Path                 string `json:"path"`
	WorkspacePath        string `json:"workspacePath,omitempty"`
	Origin               string `json:"origin"`
	InsideWorkspace      bool   `json:"insideWorkspace"`
	Kind                 string `json:"kind"`
	Content              string `json:"content,omitempty"`
	DataBase64           string `json:"dataBase64,omitempty"`
	MIMEType             string `json:"mimeType,omitempty"`
	Truncated            bool   `json:"truncated"`
	Bytes                *int64 `json:"bytes,omitempty"`
	Mtime                string `json:"mtime,omitempty"`
	ChangedSinceRecorded bool   `json:"changedSinceRecorded"`
}

// SessionFileDiff is what a session's own writes changed in one of its
// recorded files, read from its device: one turn's or the whole session's.
type SessionFileDiff struct {
	SessionID            string  `json:"sessionId"`
	Path                 string  `json:"path"`
	WorkspacePath        string  `json:"workspacePath,omitempty"`
	Origin               string  `json:"origin"`
	InsideWorkspace      bool    `json:"insideWorkspace"`
	InputID              string  `json:"inputId,omitempty"`
	Source               string  `json:"source"`
	Before               *string `json:"before,omitempty"`
	After                *string `json:"after,omitempty"`
	BeforeLabel          string  `json:"beforeLabel"`
	AfterLabel           string  `json:"afterLabel"`
	MayIncludeOtherEdits bool    `json:"mayIncludeOtherEdits"`
	ChangedSince         bool    `json:"changedSince"`
	Truncated            bool    `json:"truncated"`
	Binary               bool    `json:"binary"`
	TooLarge             bool    `json:"tooLarge"`
	Unavailable          string  `json:"unavailable,omitempty"`
	Added                *int    `json:"added,omitempty"`
	Removed              *int    `json:"removed,omitempty"`
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
	SourceDigest string `json:"sourceDigest,omitempty"`
	// UsedByWorkspaces: the store lists workspace ids; the API answers with
	// the names of the ones the caller can see.
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
	// Requires names the programs the latest revision runs.
	Requires []string `json:"requires,omitempty"`
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
	// PinnedRevision holds the workspace at one revision; 0 follows the latest.
	PinnedRevision int `json:"pinnedRevision,omitempty"`
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
	// OffSkillIDs, when sent, replaces the skills the workspace turns off
	// although its owner's defaults or its bundles give them.
	OffSkillIDs *[]string `json:"offSkillIds,omitempty"`
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

// AgentBackgroundTask is work a session's agent left running in the
// background (Claude only). Session events never carry its command line;
// members read it, redacted, with the task's output.
type AgentBackgroundTask struct {
	ID                  string `json:"id"`
	Provider            string `json:"provider"`
	Kind                string `json:"kind"`
	Description         string `json:"description"`
	Command             string `json:"command,omitempty"`
	Status              string `json:"status"`
	ExitCode            *int64 `json:"exitCode,omitempty"`
	StopReason          string `json:"stopReason,omitempty"`
	StartedAt           string `json:"startedAt"`
	EndedAt             string `json:"endedAt,omitempty"`
	TimeLimitMs         *int64 `json:"timeLimitMs,omitempty"`
	OwnerSubagentTaskID string `json:"ownerSubagentTaskId,omitempty"`
	ToolUseID           string `json:"toolUseId,omitempty"`
	Summary             string `json:"summary,omitempty"`
	HasOutput           bool   `json:"hasOutput"`
}

// AgentBackgroundTaskOutput is the end of a background task's output as
// its device read it: plain text, secrets redacted.
type AgentBackgroundTaskOutput struct {
	SessionID string `json:"sessionId"`
	TaskID    string `json:"taskId"`
	Command   string `json:"command,omitempty"`
	Content   string `json:"content"`
	Truncated bool   `json:"truncated"`
	Bytes     int64  `json:"bytes"`
	Kind      string `json:"kind"`
}

type AgentSessionEventMetadata struct {
	// TaskOutputFile is a Claude background task's own output log. Workers
	// before it sent that path, and every changed workspace file, as
	// outputFile; that key is no longer read, so those guesses stay hidden.
	TaskOutputFile string                 `json:"taskOutputFile,omitempty"`
	SessionFile    *SessionFileRecord     `json:"sessionFile,omitempty"`
	FileReferences []SessionFileReference `json:"fileReferences,omitempty"`
	Prompt         string                 `json:"prompt,omitempty"`
	SubagentType   string                 `json:"subagentType,omitempty"`
	TaskID         string                 `json:"taskId,omitempty"`
	TaskType       string                 `json:"taskType,omitempty"`
	ToolUseID      string                 `json:"toolUseId,omitempty"`
	// Snapshots replace earlier ones, so an empty one is kept: it says the
	// last timer or task is gone.
	TimerSnapshot          *[]AgentScheduledTask  `json:"timerSnapshot,omitempty"`
	BackgroundTaskSnapshot *[]AgentBackgroundTask `json:"backgroundTaskSnapshot,omitempty"`
	TimerFire              *AgentSessionTimerFire `json:"timerFire,omitempty"`
	TurnUsage              *AgentTurnUsage        `json:"turnUsage,omitempty"`
	// SubagentUsage is what a Claude subagent has used so far, on its
	// progress and completion events.
	SubagentUsage *SubagentUsage `json:"subagentUsage,omitempty"`
	// RequestUsage is a model request's final tokens (Claude), reported
	// when its stream ends; the event itself is not shown.
	RequestUsage *ModelRequestUsage `json:"requestUsage,omitempty"`
}

// SubagentUsage is a subagent's own work as Claude reports it: one token
// total, without an input/output split.
type SubagentUsage struct {
	TotalTokens int64 `json:"totalTokens"`
	ToolUses    int64 `json:"toolUses"`
	DurationMs  int64 `json:"durationMs"`
}

type AgentTurnUsage struct {
	DurationMs       int64  `json:"durationMs"`
	InputTokens      int64  `json:"inputTokens"`
	CacheReadTokens  int64  `json:"cacheReadTokens"`
	CacheWriteTokens int64  `json:"cacheWriteTokens"`
	OutputTokens     int64  `json:"outputTokens"`
	ReasoningTokens  *int64 `json:"reasoningTokens,omitempty"`
	ModelRequests    *int64 `json:"modelRequests,omitempty"`
}

type AgentSubagentTranscriptMessage struct {
	Content string `json:"content"`
	ID      string `json:"id"`
	Role    string `json:"role"`
	Title   string `json:"title,omitempty"`
	Kind    string `json:"kind,omitempty"`
	CallID  string `json:"callId,omitempty"`
	Status  string `json:"status,omitempty"`
	// RequestUsage is the tokens of the subagent's model request behind it.
	RequestUsage *ModelRequestUsage `json:"requestUsage,omitempty"`
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
	Usage        *SubagentUsage                   `json:"usage,omitempty"`
}

type AgentSubagentSummary struct {
	Prompt        string         `json:"prompt,omitempty"`
	ResponseTexts []string       `json:"responseTexts"`
	SessionID     string         `json:"sessionId"`
	Status        string         `json:"status"`
	SubagentType  string         `json:"subagentType,omitempty"`
	TaskID        string         `json:"taskId"`
	Title         string         `json:"title"`
	ToolUseID     string         `json:"toolUseId"`
	Usage         *SubagentUsage `json:"usage,omitempty"`
}

type ChatAttachment struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Path     string `json:"path"`
	MIMEType string `json:"mimeType"`
	Size     int64  `json:"size"`
	Kind     string `json:"kind"`
}

// SessionInputEventLabel marks the transcript event each session input
// writes; the transcript of a session is its events alone.
const SessionInputEventLabel = "User message"

// AgentSessionRoleIssueExecution is the session that implements an Issue.
const AgentSessionRoleIssueExecution = "issue_execution"

// AgentSessionRoleIssueClarification is the Issue's clarification
// conversation: one read-only session in the Issue's workspace whose every
// message from the person is a new input.
const AgentSessionRoleIssueClarification = "issue_clarification"

// DaemonCapabilityWorkspaceInventory: the worker's hello lists every
// workspace it serves (DaemonRegistration.ServedWorkspaceIDs).
const DaemonCapabilityWorkspaceInventory = "workspace_inventory"

// DaemonCapabilityIssueSessions: the worker runs Issue executions dispatched
// as run_session with the issue_execution role.
const DaemonCapabilityIssueSessions = "issue_sessions"

// DaemonCapabilityIssueClarification: the worker runs an Issue's
// clarification as a session with the issue_clarification role.
const DaemonCapabilityIssueClarification = "issue_clarification"

// SessionInput is one message delivered to a session: the unit of dispatch.
// It is not a session of its own; identity, permissions and lineage belong
// to the session it was sent to.
type SessionInput struct {
	ID                    string           `json:"id"`
	Prompt                string           `json:"prompt"`
	Attachments           []ChatAttachment `json:"attachments,omitempty"`
	ProfileTransitionNote string           `json:"profileTransitionNote,omitempty"`
	ImportedContext       string           `json:"importedContext,omitempty"`
	// When the server received the input; its transcript events carry it.
	At string `json:"at,omitempty"`
}

// NativeSessionRef names one native Claude Code or Codex session.
type NativeSessionRef struct {
	Provider        string `json:"provider"`
	NativeSessionID string `json:"nativeSessionId"`
}

// AgentSession is one native agent session (a Claude Code or Codex session)
// for its whole life. Conversation turns stay inside the native agent; the
// session carries its latest input and the status of handling it.
type AgentSession struct {
	// CreatedByUserID is the account that started it; agent-created sessions
	// inherit their parent's. Set by the server, never by clients.
	CreatedByUserID string `json:"createdByUserId,omitempty"`
	ID              string `json:"id"`
	// ThreadID equals ID; it remains so readers that grouped legacy
	// per-turn rows keep working.
	ThreadID string `json:"threadId,omitempty"`
	// NativeSessionID is the native session it resumes on the runtime it
	// runs on (its provider on its device); empty starts one there. The
	// store owns every native session a session ran (sqlitestore
	// native_sessions.go); this is that record's projection.
	NativeSessionID string `json:"nativeSessionId,omitempty"`
	// ForkNativeSessionID, set while a fork has not answered yet, is the
	// native session NativeSessionID starts as a copy of.
	ForkNativeSessionID string `json:"forkNativeSessionId,omitempty"`
	WorkspaceID         string `json:"workspaceId"`
	AgentID             string `json:"agentId"`
	DeviceID            string `json:"deviceId"`
	Provider            string `json:"provider"`
	ProfileID           string `json:"profileId,omitempty"`
	ProfileFingerprint  string `json:"profileFingerprint,omitempty"`
	ProfileLabel        string `json:"profileLabel,omitempty"`
	Source              string `json:"source,omitempty"`
	// Role is the job the session does for Foundry; empty for a chat.
	// AgentSessionRoleIssueExecution implements an Issue's confirmed contract
	// in its candidate workspace; AgentSessionRoleIssueClarification talks
	// the Issue through with the person, read-only.
	Role string `json:"role,omitempty"`
	// ParentSessionID records orchestration lineage: the agent session that
	// created this one. Empty for human/browser chats. It is a record for
	// display and limits, never a source of permission.
	ParentSessionID string `json:"parentSessionId,omitempty"`
	// IssueID runs the session inside an existing Issue candidate worktree
	// instead of the workspace root, enabling safe parallel writes.
	IssueID string `json:"issueId,omitempty"`
	// GroupNameTarget marks a source=naming utility session whose response
	// should rename the auto-created orchestration group with this id.
	GroupNameTarget string `json:"groupNameTarget,omitempty"`
	// CreatedGroupID is populated on a session that caused a new orchestration
	// group to be created, so the HTTP layer can trigger async naming.
	CreatedGroupID       string `json:"createdGroupId,omitempty"`
	Model                string `json:"model,omitempty"`
	ClaudeEffort         string `json:"claudeEffort,omitempty"`
	ClaudePermissionMode string `json:"claudePermissionMode,omitempty"`
	CodexReasoningEffort string `json:"codexReasoningEffort,omitempty"`
	CodexSandboxMode     string `json:"codexSandboxMode,omitempty"`
	CodexApprovalPolicy  string `json:"codexApprovalPolicy,omitempty"`
	CodexSpeed           string `json:"codexSpeed,omitempty"`
	Status               string `json:"status"`
	BlockedReason        string `json:"blockedReason,omitempty"`
	Title                string `json:"title"`
	// Prompt is the session's opening goal.
	Prompt string `json:"prompt"`
	// Input is the latest message sent to the session; Status describes it.
	Input     SessionInput      `json:"input"`
	SkillRefs []SessionSkillRef `json:"skillRefs,omitempty"`
	// Response is the answer to the latest input.
	Response       string `json:"response,omitempty"`
	Error          string `json:"error,omitempty"`
	StartedAt      string `json:"startedAt,omitempty"`
	LastActivityAt string `json:"lastActivityAt,omitempty"`
	// ActivityAt is its last conversation activity: the latest input, or
	// the answer that completed it. Chat lists order by it.
	ActivityAt     string              `json:"activityAt,omitempty"`
	CompletedAt    string              `json:"completedAt,omitempty"`
	AnswerRevision string              `json:"answerRevision,omitempty"`
	CreatedLabel   string              `json:"createdLabel"`
	UpdatedLabel   string              `json:"updatedLabel"`
	Events         []AgentSessionEvent `json:"events,omitempty"`
}

type IssueConversationMessage struct {
	ID        string `json:"id"`
	Role      string `json:"role"`
	Text      string `json:"text"`
	RunID     string `json:"runId,omitempty"`
	CreatedAt string `json:"createdAt"`
	// Via names where a person's message came from when not the web, such
	// as "feishu".
	Via string `json:"via,omitempty"`
}

// IssueClarification is the Issue's clarification session and the state of
// the person's latest message to it.
type IssueClarification struct {
	SessionID string `json:"sessionId"`
	// Status is "replying" while the Agent answers the latest message,
	// "failed" when it could not, and "answered" once its reply is recorded.
	Status string `json:"status"`
	Error  string `json:"error,omitempty"`
	// InputID is the session input carrying the latest message.
	InputID string `json:"inputId"`
	// MessageID is the person's latest message in the Issue conversation.
	MessageID string `json:"messageId"`
	// Revision and ContentDigest name the draft the message was about; a
	// proposal in the reply revises exactly that draft.
	Revision      int    `json:"revision"`
	ContentDigest string `json:"contentDigest"`
	ChangeReason  string `json:"changeReason"`
}

// ClarificationResponse is the clarification session's reply to one message.
type ClarificationResponse struct {
	Message         string           `json:"message"`
	ProposedContent *ContractContent `json:"proposedContent,omitempty"`
}

// ClarificationTurn travels with a clarification input: the draft the
// message is about and the conversation before it, for a session that has
// lost its native context.
type ClarificationTurn struct {
	Draft    IssueContract      `json:"draft"`
	Messages []ChatRecapMessage `json:"messages"`
	Message  string             `json:"message"`
}

// IssueQuestion is what an Issue's execution asked the person: something only
// they can decide (input) or allow (permission). The Issue is blocked on it
// once the execution's turn ends, and resumes in the same candidate with the
// answer.
type IssueQuestion struct {
	ID string `json:"id"`
	// Kind is "input" or "permission".
	Kind string `json:"kind"`
	Text string `json:"text"`
	// Options are choices the Agent offers; the person may answer otherwise.
	Options []string `json:"options,omitempty"`
	// RunID is the execution session that asked.
	RunID   string `json:"runId"`
	AskedAt string `json:"askedAt"`
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
	Clarification              *IssueClarification        `json:"clarification,omitempty"`
	Question                   *IssueQuestion             `json:"question,omitempty"`
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
	// Attachments travel with a user message.
	Attachments []ChatAttachment `json:"attachments,omitempty"`
	// RequestUsage is the tokens of the model request that produced this
	// step (Claude).
	RequestUsage *ModelRequestUsage `json:"requestUsage,omitempty"`
	// TurnUsage, on the answer that ended a turn, is the turn's usage read
	// from the agent's own log (imported chats).
	TurnUsage *AgentTurnUsage `json:"turnUsage,omitempty"`
}

// ModelRequestUsage is one model request's tokens; steps of one request
// share its id and its last report counts.
type ModelRequestUsage struct {
	RequestID        string `json:"requestId"`
	InputTokens      int64  `json:"inputTokens"`
	CacheReadTokens  int64  `json:"cacheReadTokens"`
	CacheWriteTokens int64  `json:"cacheWriteTokens"`
	OutputTokens     int64  `json:"outputTokens"`
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

// Chat queue states: a message waits (queued), is being handed to the
// chat's session (dispatching), went out (sent) or could not (failed; the
// queue waits for the person).
const (
	ChatQueueStateQueued      = "queued"
	ChatQueueStateDispatching = "dispatching"
	ChatQueueStateSent        = "sent"
	ChatQueueStateFailed      = "failed"
)

// ChatQueueRunSettings are the composer's choices when a message was queued;
// the message is sent with them.
type ChatQueueRunSettings struct {
	AgentID               string `json:"agentId,omitempty"`
	Provider              string `json:"provider,omitempty"`
	ProfileID             string `json:"profileId,omitempty"`
	Model                 string `json:"model,omitempty"`
	ClaudeEffort          string `json:"claudeEffort,omitempty"`
	ClaudePermissionMode  string `json:"claudePermissionMode,omitempty"`
	CodexReasoningEffort  string `json:"codexReasoningEffort,omitempty"`
	CodexSandboxMode      string `json:"codexSandboxMode,omitempty"`
	CodexApprovalPolicy   string `json:"codexApprovalPolicy,omitempty"`
	CodexSpeed            string `json:"codexSpeed,omitempty"`
	ProfileTransitionNote string `json:"profileTransitionNote,omitempty"`
}

// ChatQueueItem is a message a person queued in a chat. The server sends it
// as the chat's next input once the chat's session is idle; its id becomes
// that input's id.
type ChatQueueItem struct {
	ID            string               `json:"id"`
	ChatID        string               `json:"chatId"`
	Position      int64                `json:"position"`
	Text          string               `json:"text"`
	Attachments   []ChatAttachment     `json:"attachments,omitempty"`
	RunSettings   ChatQueueRunSettings `json:"runSettings"`
	CreatedBy     string               `json:"createdBy,omitempty"`
	CreatedAt     string               `json:"createdAt"`
	UpdatedAt     string               `json:"updatedAt"`
	Revision      int64                `json:"revision"`
	State         string               `json:"state"`
	Error         string               `json:"error,omitempty"`
	SentSessionID string               `json:"sentSessionId,omitempty"`
}

// ChatQueue lists a chat's unsent messages in sending order. Revision grows
// with every change to the queue, including sends.
type ChatQueue struct {
	WorkspaceID string          `json:"workspaceId"`
	ChatID      string          `json:"chatId"`
	Revision    int64           `json:"revision"`
	Items       []ChatQueueItem `json:"items"`
}

type EnqueueChatMessageInput struct {
	Text        string               `json:"text"`
	Attachments []ChatAttachment     `json:"attachments,omitempty"`
	RunSettings ChatQueueRunSettings `json:"runSettings"`
}

// EditChatQueueItemInput changes the fields it carries; ExpectedRevision is
// the message's revision the edit was made on.
type EditChatQueueItemInput struct {
	Text             *string               `json:"text,omitempty"`
	Attachments      *[]ChatAttachment     `json:"attachments,omitempty"`
	RunSettings      *ChatQueueRunSettings `json:"runSettings,omitempty"`
	ExpectedRevision *int64                `json:"expectedRevision"`
}

// ReorderChatQueueInput names every queued or failed message in the new
// order; ExpectedRevision is the queue's revision the order was made on.
type ReorderChatQueueInput struct {
	ItemIDs          []string `json:"itemIds"`
	ExpectedRevision *int64   `json:"expectedRevision"`
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

// SendAgentSessionInput is a new message for an idle session. Setting the
// agent, provider or profile switches the runtime the session continues on.
type SendAgentSessionInput struct {
	AgentID               string           `json:"agentId,omitempty"`
	Provider              string           `json:"provider,omitempty"`
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
	// ImportedContext is ignored: the server tells each native session the
	// turns it missed. Accepted so older clients that send it still work.
	ImportedContext string `json:"importedContext,omitempty"`
	// RequireIdle refuses (ErrAgentSessionActive) a message to a running
	// session instead of steering it: the sender meant the next turn.
	RequireIdle bool `json:"requireIdle,omitempty"`
	// InputID names the input (a queued message's id); empty generates one.
	InputID string `json:"-"`
}

type CreateAgentSessionInput struct {
	CreatedByUserID       string           `json:"-"`
	WorkspaceID           string           `json:"workspaceId"`
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
	IssueID               string           `json:"issueId,omitempty"`
	// ForkSessionID starts the session from a copy of another session's
	// native history; neither writes into the other's transcript.
	ForkSessionID string `json:"forkSessionId,omitempty"`
	// ChatID continues a device's native chat: the session adopts it.
	ChatID string `json:"chatId,omitempty"`
	// Verification requests a read-only utility verifier session.
	Verification bool   `json:"verification,omitempty"`
	Source       string `json:"source"`
	// InputID names the first input (a queued message's id); empty generates one.
	InputID string `json:"-"`
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
	// Capabilities name the protocol features this worker implements, so the
	// server never sends work an older worker would misread.
	Capabilities []string `json:"capabilities,omitempty"`
	// ActiveSessionIDs are execution claims owned by this daemon process. An
	// empty, present list means the process owns no sessions; a missing list is
	// retained for compatibility with workers predating session-level claims.
	ActiveSessionIDs []string `json:"activeSessionIds"`
	// ServedWorkspaceIDs, sent with hello by a worker declaring
	// DaemonCapabilityWorkspaceInventory, is every workspace it serves; its
	// other workspaces on the server are marked unavailable on the device.
	ServedWorkspaceIDs []string                 `json:"servedWorkspaceIds,omitempty"`
	Device             DeviceProjection         `json:"device"`
	Workspace          WorkspaceProjection      `json:"workspace"`
	ProviderHealth     []ProviderHealth         `json:"providerHealth"`
	AgentProfiles      []AgentProfileProjection `json:"agentProfiles,omitempty"`
	Chats              []ChatThread             `json:"chats,omitempty"`
	Assets             []AssetProjection        `json:"assets"`
	Agents             []AgentProjection        `json:"agents"`
	Skills             []SkillPackRef           `json:"skills"`
	WorkspaceFiles     []WorkspaceFileEntry     `json:"workspaceFiles"`
	// Stalls are stretches the worker's event loop was blocked since its
	// previous registration; the server logs them.
	Stalls []WorkerStall `json:"stalls,omitempty"`
	// Connections are the worker's own accounts of its previous connections;
	// the server logs them and keeps the latest for the device page.
	Connections []WorkerConnectionReport `json:"connections,omitempty"`
}

// WorkerConnectionReport is one connection to the server as the worker saw
// it: who ended it and how long the server had been silent.
type WorkerConnectionReport struct {
	OpenedAt          string `json:"openedAt"`
	ClosedAt          string `json:"closedAt"`
	DurationMs        int64  `json:"durationMs"`
	ClosedBy          string `json:"closedBy"`
	CloseCode         int    `json:"closeCode,omitempty"`
	CloseReason       string `json:"closeReason,omitempty"`
	Error             string `json:"error,omitempty"`
	SinceServerDataMs int64  `json:"sinceServerDataMs,omitempty"`
	SinceServerPingMs int64  `json:"sinceServerPingMs,omitempty"`
	BytesReceived     int64  `json:"bytesReceived,omitempty"`
	BytesSent         int64  `json:"bytesSent,omitempty"`
	Proxy             string `json:"proxy,omitempty"`
	MaxLagMs          int64  `json:"maxLagMs,omitempty"`
}

// DiagnosticCheck is one check a worker ran on itself; the web words it by
// id. Status is ok, info, warn or error.
type DiagnosticCheck struct {
	ID     string         `json:"id"`
	Status string         `json:"status"`
	Values map[string]any `json:"values,omitempty"`
}

// DeviceDiagnostics is a worker's report on itself.
type DeviceDiagnostics struct {
	GeneratedAt   string                   `json:"generatedAt"`
	WorkerVersion string                   `json:"workerVersion"`
	Checks        []DiagnosticCheck        `json:"checks"`
	Connections   []WorkerConnectionReport `json:"connections"`
	LogTail       []string                 `json:"logTail"`
}

// DeviceRepairResult is what a repair the person asked for changed.
type DeviceRepairResult struct {
	Action string         `json:"action"`
	Values map[string]any `json:"values,omitempty"`
}

// DeviceDisconnect is the last time a device dropped, from both ends.
type DeviceDisconnect struct {
	At           string                  `json:"at"`
	ServerReason string                  `json:"serverReason,omitempty"`
	Worker       *WorkerConnectionReport `json:"worker,omitempty"`
}

// WorkerStall is a stretch when a worker's event loop was blocked.
type WorkerStall struct {
	At         string   `json:"at"`
	LagMs      int64    `json:"lagMs"`
	Activities []string `json:"activities,omitempty"`
}

// BuiltinSkill is a skill Foundry itself gives an agent runtime, beside the
// skills the agent ships and the ones a workspace selects.
type BuiltinSkill struct {
	Runtime     string `json:"runtime"`
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
	Source      string `json:"source"`
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
	PromotedSkills         []PromotedSkill          `json:"promotedSkills"`
	BuiltinSkills          []BuiltinSkill           `json:"builtinSkills,omitempty"`
	WorkspaceSkillBindings []WorkspaceSkillBinding  `json:"workspaceSkillBindings"`
	// DefaultSkillIDs: the owner's default skills the workspace gets, those
	// not replaced by a selected skill of the same name.
	DefaultSkillIDs []string `json:"defaultSkillIds,omitempty"`
	// InheritedSkillIDs: skills the workspace gets without selecting them
	// (defaults and bundles), including ones it turned off; OffSkillIDs the
	// ones it turned off.
	InheritedSkillIDs []string `json:"inheritedSkillIds,omitempty"`
	OffSkillIDs       []string `json:"offSkillIds,omitempty"`
	// SkillBundles are the library's bundles; WorkspaceBundleIDs the ones
	// this workspace uses, selected or from its owner's defaults;
	// DefaultBundleIDs its owner's default bundles.
	SkillBundles       []SkillBundleSummary `json:"skillBundles,omitempty"`
	WorkspaceBundleIDs []string             `json:"workspaceBundleIds,omitempty"`
	DefaultBundleIDs   []string             `json:"defaultBundleIds,omitempty"`
	// DeviceTools: which programs library skills need the visible devices
	// have.
	DeviceTools    []DeviceTool         `json:"deviceTools,omitempty"`
	Agents         []AgentProjection    `json:"agents"`
	WorkspaceFiles []WorkspaceFileEntry `json:"workspaceFiles"`
	AgentSessions  []AgentSession       `json:"agentSessions"`
	Skills         []SkillPackRef       `json:"skills"`
	Issues         []Issue              `json:"issues"`
	Chats          []ChatThread         `json:"chats"`
	Assets         []AssetProjection    `json:"assets"`
}

type SyncChatsInput struct {
	WorkspaceID string       `json:"workspaceId"`
	Chats       []ChatThread `json:"chats"`
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

// SkillRepository is a git repository the skill library takes skills from.
type SkillRepository struct {
	ID string `json:"id"`
	// URL is the https remote; Label is its short form, e.g.
	// "github.com/anthropics/skills".
	URL   string `json:"url"`
	Label string `json:"label"`
	// Ref is the branch or tag followed; empty follows the default branch.
	Ref string `json:"ref,omitempty"`
	// Subpath is the folder within the repository holding the skills.
	Subpath string `json:"subpath,omitempty"`
	// Commit is the commit last seen at Ref.
	Commit    string                 `json:"commit,omitempty"`
	CheckedAt string                 `json:"checkedAt,omitempty"`
	Error     string                 `json:"error,omitempty"`
	CreatedAt string                 `json:"createdAt"`
	Skills    []SkillRepositorySkill `json:"skills"`
	// Mode is "pick" (chosen skills) or "bundle" (the whole repository as
	// one unit). Either way the skills move to the version the repository
	// follows by themselves.
	Mode string `json:"mode"`
	// Name is a bundle's name, e.g. "feishu-cli".
	Name string `json:"name,omitempty"`
	// Version is the release tag (or short commit) the repository's skills
	// are on.
	Version string `json:"version,omitempty"`
	// Paused: a rolled-back repository stays on its version until resumed.
	Paused bool `json:"paused,omitempty"`
	// Versions are the applied versions, newest first.
	Versions []SkillBundleVersion `json:"versions,omitempty"`
	// Tools are programs a bundle's skills run, with where to get them.
	Tools []SkillBundleTool `json:"tools,omitempty"`
	// DeclaredTools are programs named when the bundle was followed, which
	// its source does not publish itself (e.g. a Python CLI on PyPI).
	DeclaredTools []SkillToolDeclaration `json:"declaredTools,omitempty"`
	// FoundCount is how many skill folders the repository held when it was
	// last read; 0 when not known.
	FoundCount int `json:"foundCount,omitempty"`
	// Description is the repository's own description from its host.
	Description string `json:"description,omitempty"`
	// FetchDeviceID names the device that reads the repository, with its own
	// git and npm settings and credentials, for a source the server cannot
	// reach; empty means the server reads it.
	FetchDeviceID string `json:"fetchDeviceId,omitempty"`
	// FetchDeviceName is that device's name; FetchDeviceOnline says whether
	// it is connected now (filled in when the repository is served).
	FetchDeviceName   string `json:"fetchDeviceName,omitempty"`
	FetchDeviceOnline bool   `json:"fetchDeviceOnline,omitempty"`
	// Registry is the npm registry (an https URL) an npm source and the npm
	// tools it needs come from; empty is the public registry when the server
	// reads it, and the device's own npm settings when a device does.
	Registry string `json:"registry,omitempty"`
	// CheckWaiting: a check could not run because the fetch device was
	// offline; it runs when the device reconnects.
	CheckWaiting bool `json:"checkWaiting,omitempty"`
}

// SkillBundleSummary is a bundle as workspaces choose it.
type SkillBundleSummary struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Label   string `json:"label"`
	Version string `json:"version,omitempty"`
	// SkillIDs are the library skills it delivers now.
	SkillIDs []string `json:"skillIds"`
}

// SkillBundleVersion is one version a bundle was updated or rolled back to.
type SkillBundleVersion struct {
	Seq       int    `json:"seq"`
	Tag       string `json:"tag"`
	Commit    string `json:"commit"`
	AppliedAt string `json:"appliedAt"`
	// RolledBack marks a rollback to an earlier version's skills.
	RolledBack bool     `json:"rolledBack,omitempty"`
	Added      []string `json:"added,omitempty"`
	Changed    []string `json:"changed,omitempty"`
	Removed    []string `json:"removed,omitempty"`
	// Missing are picked skills whose folder left the repository with this
	// version; the library keeps them at their last revision.
	Missing []string `json:"missing,omitempty"`
	// Members are the skills and revisions this version consists of.
	Members []SkillBundleMember `json:"members,omitempty"`
	// Tools are the programs this version needs, at their versions; rolling
	// back to it restores them with its skills.
	Tools []SkillBundleTool `json:"tools,omitempty"`
}

// SkillBundleMember is one skill of a bundle version.
type SkillBundleMember struct {
	Dir      string `json:"dir"`
	SkillID  string `json:"skillId"`
	Name     string `json:"name"`
	Revision int    `json:"revision"`
}

// SkillBundleTool is a program a bundle needs, installable from the
// repository's GitHub release of the bundle's version.
type SkillBundleTool struct {
	Name    string `json:"name"`
	Version string `json:"version"`
	// Assets are the release downloads per platform.
	Assets []SkillToolAsset `json:"assets,omitempty"`
	// ChecksumsURL is the release's checksum list, when it publishes one.
	ChecksumsURL string `json:"checksumsUrl,omitempty"`
	// Source is where it installs from: "" (a GitHub release download),
	// "npm" (the npm package Package at Version) or "uv" (the Python
	// package Package at Version, through uv).
	Source  string `json:"source,omitempty"`
	Package string `json:"package,omitempty"`
	// Registry is where an npm tool installs from: "" the public registry,
	// an https URL that registry, or "device" each device's own npm
	// settings (its npmrc and scoped registries).
	Registry string `json:"registry,omitempty"`
	// Setup is a step the tool needs after installing (e.g. downloading its
	// browser), run only when the person asks.
	Setup *SkillToolSetup `json:"setup,omitempty"`
	// SignIn is the command a person runs once in a terminal on each device
	// after installing (e.g. "auth login"); Foundry only shows it.
	SignIn []string `json:"signIn,omitempty"`
}

// SkillToolDeclaration names a program a bundle needs that its source
// does not publish: Source "uv" installs the PyPI package Package and
// Source "npm" the npm package Package (from the repository's registry),
// which provides the command Command. Its version follows the bundle's when
// the package has that version, else the package's latest.
type SkillToolDeclaration struct {
	Source  string `json:"source"`
	Package string `json:"package"`
	Command string `json:"command"`
}

// SkillToolSetup runs one of the installed package's commands with fixed
// arguments.
type SkillToolSetup struct {
	// Command is a command the package installs; empty is the tool itself.
	Command string   `json:"command,omitempty"`
	Args    []string `json:"args"`
	// Description says what it does, e.g. "Downloads Chrome for Testing".
	Description string `json:"description"`
}

// SkillToolAsset is one platform's download of a tool.
type SkillToolAsset struct {
	OS   string `json:"os"`
	Arch string `json:"arch"`
	Name string `json:"name"`
	URL  string `json:"url"`
}

// SkillRepositorySkill is a library skill taken from a repository folder.
type SkillRepositorySkill struct {
	SkillID string `json:"skillId"`
	Dir     string `json:"dir"`
	// Commit is the repository commit the skill's latest revision came from.
	Commit string `json:"commit"`
	// Name is the skill's name in the library.
	Name string `json:"name,omitempty"`
	// Retired: the skill left its bundle; sessions no longer get it.
	Retired bool `json:"retired,omitempty"`
	// Missing: a picked skill's folder is gone from the repository; the
	// library keeps its last revision.
	Missing bool `json:"missing,omitempty"`
}

// RepositoryOrigin is the origin device id of library skills taken from a
// repository; their origin root is the repository label and their origin
// folder the skill's folder in it.
func RepositoryOrigin(repositoryID string) string { return "repo:" + repositoryID }

// DeviceTool says whether a device has a program some library skill needs,
// as its worker found on its PATH at the last skill scan.
type DeviceTool struct {
	DeviceID  string `json:"deviceId"`
	Tool      string `json:"tool"`
	Available bool   `json:"available"`
	CheckedAt string `json:"checkedAt"`
	// Version is the version Foundry installed on the device, if it did.
	Version string `json:"version,omitempty"`
}

// RepositorySkillFolder is a skill folder found in a repository.
type RepositorySkillFolder struct {
	// Dir is the folder relative to the repository root.
	Dir         string `json:"dir"`
	Name        string `json:"name"`
	Description string `json:"description"`
	License     string `json:"license,omitempty"`
	// SkillID is set when the folder is already in the library.
	SkillID string `json:"skillId,omitempty"`
}

// SkillRepositoryView is a repository with the skill folders it holds now.
type SkillRepositoryView struct {
	Repository SkillRepository         `json:"repository"`
	Available  []RepositorySkillFolder `json:"available"`
}
