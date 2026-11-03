package store

type DeviceProjection struct {
	ID              string                `json:"id"`
	Label           string                `json:"label"`
	Status          string                `json:"status"`
	LastSeenLabel   string                `json:"lastSeenLabel"`
	RuntimeSettings *AgentRuntimeSettings `json:"runtimeSettings,omitempty"`
	// Owned reports whether the caller owns (and may manage) the device.
	Owned bool `json:"owned,omitempty"`
	// ManagedRoots are the folders, resolved, the Personal Agent may create
	// projects in, reported by its worker.
	ManagedRoots []string `json:"managedRoots,omitempty"`
	// OutsideFilesOff: its owner turned off opening its files outside
	// workspaces from chats; set for the owner only (device_files.go).
	OutsideFilesOff bool `json:"outsideFilesOff,omitempty"`
	// Capabilities are the protocol features its worker declared at its
	// last registration.
	Capabilities []string `json:"capabilities,omitempty"`
	// Connectors are what extensions installed on the device provide, as its
	// worker reports them (docs/connector-extensions.md); shown to its owner
	// only.
	Connectors []ConnectorDescriptor `json:"connectors,omitempty"`
	// Worker is the build the device's worker runs and the command that
	// updates it there, reported at registration (0.5.7 and later).
	Worker *DeviceWorker `json:"worker,omitempty"`
	// System describes the machine, reported at registration (0.5.7 and later).
	System *DeviceSystem `json:"system,omitempty"`
	// WorkerUpdate is set while an update requested from Foundry runs; the
	// server adds it to projections, the worker never reports it.
	WorkerUpdate *DeviceWorkerUpdate `json:"workerUpdate,omitempty"`
	// Runner is the worker's session runner as its connection service last
	// reported it while connected; the server adds it to projections.
	Runner *DeviceRunner `json:"runner,omitempty"`
	// LastDisconnect is the last time the device dropped; the server adds it
	// to projections.
	LastDisconnect *DeviceDisconnect `json:"lastDisconnect,omitempty"`
	// LastSeenAt is when the server last recorded the device; for an offline
	// one, when it went offline. ListDevices adds it from the row.
	LastSeenAt string `json:"lastSeenAt,omitempty"`
	// SkillsVersion changes when the device's scanned skills or the catalog
	// they are compared with change. Workspace data leaves the skill lists
	// out (hundreds of skills per device); clients load one device's list
	// from /api/device-skills and reload it when this changes. The server
	// adds it to projections.
	SkillsVersion string `json:"skillsVersion,omitempty"`
	// SharesSystemAccountWith are other people's devices under the same
	// system account of this computer; the server adds it for the device's
	// owner only (device_sharing.go).
	SharesSystemAccountWith []DeviceAccountShare `json:"sharesSystemAccountWith,omitempty"`
}

// DeviceRunner is a worker's session runner (execution host): its version
// and whether it waits to switch to the connection service's newer one.
// State is current, pending, switching or failed (protocol DeviceRunner).
type DeviceRunner struct {
	Version            string `json:"version,omitempty"`
	TargetVersion      string `json:"targetVersion,omitempty"`
	State              string `json:"state"`
	PendingSince       string `json:"pendingSince,omitempty"`
	Deadline           string `json:"deadline,omitempty"`
	RunningTurns       int    `json:"runningTurns"`
	HeldTurns          int    `json:"heldTurns"`
	BackgroundSessions int    `json:"backgroundSessions"`
	WaitingFor         string `json:"waitingFor,omitempty"`
	Reclaiming         bool   `json:"reclaiming,omitempty"`
	Error              string `json:"error,omitempty"`
}

// DeviceRunnerTurn is a turn a "switch now" stops, as its owner reviews it.
type DeviceRunnerTurn struct {
	SessionID   string `json:"sessionId"`
	InputID     string `json:"inputId,omitempty"`
	Title       string `json:"title,omitempty"`
	WorkspaceID string `json:"workspaceId,omitempty"`
	Background  bool   `json:"background,omitempty"`
}

// DeviceRunnerDetail is the runner with the turns it runs now.
type DeviceRunnerDetail struct {
	Runner *DeviceRunner      `json:"runner,omitempty"`
	Turns  []DeviceRunnerTurn `json:"turns"`
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
	SwapBytes   int64  `json:"swapBytes,omitempty"`
	// Service is how the worker is kept running there (DEV-088).
	Service *DeviceServiceState `json:"service,omitempty"`
}

// DeviceServiceState is the login service that keeps a worker running, as
// the worker reads it without administrator rights.
type DeviceServiceState struct {
	Manager   string          `json:"manager"`
	Unit      string          `json:"unit,omitempty"`
	Installed bool            `json:"installed"`
	Linger    *bool           `json:"linger,omitempty"`
	LogDir    string          `json:"logDir,omitempty"`
	OOMKills  *DeviceOOMKills `json:"oomKills,omitempty"`
}

// DeviceOOMKills counts the worker's processes stopped for lack of memory.
type DeviceOOMKills struct {
	Count  int    `json:"count"`
	LastAt string `json:"lastAt,omitempty"`
}

type DeviceWorker struct {
	Version string `json:"version"`
	Command string `json:"command,omitempty"`
}

type AgentRuntimeSettings struct {
	ActiveRuntimeTtlMs int `json:"activeRuntimeTtlMs"`
	// MaxConcurrentTasks is the turns the device runs at once. An owner
	// saving 0 withdraws their choice: the worker uses its hardware default.
	MaxConcurrentTasks int `json:"maxConcurrentTasks"`
	// MaxConcurrentTasksSource is "owner" or "hardware"; workers before
	// DEV-084 leave it out.
	MaxConcurrentTasksSource   string          `json:"maxConcurrentTasksSource,omitempty"`
	HardwareMaxConcurrentTasks int             `json:"hardwareMaxConcurrentTasks,omitempty"`
	Hardware                   *DeviceHardware `json:"hardware,omitempty"`
}

// DeviceHardware is what a worker's default turn limit is computed from.
type DeviceHardware struct {
	MemoryGiB float64 `json:"memoryGiB"`
	CPUs      int     `json:"cpus"`
}

// DaemonCapabilityVerificationSessions: the worker runs a verification
// session in a sandbox that keeps the workspace read-only while it runs
// commands. A worker declares it only while that sandbox (bubblewrap on
// Linux) is ready.
const DaemonCapabilityVerificationSessions = "verification_sessions"

type UpsertAgentRuntimeSettingsInput struct {
	DeviceID string               `json:"deviceId,omitempty"`
	Settings AgentRuntimeSettings `json:"settings"`
}

type DaemonRegistration struct {
	// Capabilities name the protocol features this worker implements. Most
	// are always declared; the server checks only those a worker withholds
	// while it cannot run them (verification_sessions without its sandbox,
	// and those an older execution host still running lacks).
	Capabilities []string `json:"capabilities,omitempty"`
	// ActiveSessionIDs are execution claims owned by this daemon process; an
	// empty list means it owns no sessions.
	ActiveSessionIDs []string `json:"activeSessionIds"`
	// ServedWorkspaceIDs, sent with hello, is every workspace the worker
	// serves; its other workspaces on the server are marked unavailable on
	// the device.
	ServedWorkspaceIDs []string `json:"servedWorkspaceIds,omitempty"`
	// MissingWorkspaceIDs, sent with hello, are the workspaces the worker
	// still has whose folder is gone; they are marked
	// WorkspaceFolderMissing.
	MissingWorkspaceIDs []string                 `json:"missingWorkspaceIds,omitempty"`
	Device              DeviceProjection         `json:"device"`
	Workspace           WorkspaceProjection      `json:"workspace"`
	ProviderHealth      []ProviderHealth         `json:"providerHealth"`
	AgentProfiles       []AgentProfileProjection `json:"agentProfiles,omitempty"`
	Chats               []ChatThread             `json:"chats,omitempty"`
	Assets              []AssetProjection        `json:"assets"`
	Agents              []AgentProjection        `json:"agents"`
	WorkspaceFiles      []WorkspaceFileEntry     `json:"workspaceFiles"`
	// Stalls are stretches the worker's event loop was blocked since its
	// previous registration; the server logs them.
	Stalls []WorkerStall `json:"stalls,omitempty"`
	// Connections are the worker's own accounts of its previous connections;
	// the server logs them and keeps the latest for the device page.
	Connections []WorkerConnectionReport `json:"connections,omitempty"`
	// Sections are the digests of the registration's sections, by name
	// ("device": its agent profiles and provider health; "workspace": the
	// workspace's assets, agents, files, chats and skills), and
	// OmittedSections the ones left out because the server keeps them (see
	// httpapi registration_sections.go).
	Sections        map[string]string `json:"sections,omitempty"`
	OmittedSections []string          `json:"omittedSections,omitempty"`
	// Identity is the system account and machine the worker runs on, as
	// hashes (device_sharing.go); workers before it report none.
	Identity *DeviceAccountIdentity `json:"identity,omitempty"`
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
	// SentAfterOpen is what the worker sent in the first minutes after the
	// connection opened, by message type, largest first.
	SentAfterOpen *WorkerSentAfterOpen `json:"sentAfterOpen,omitempty"`
	// Replayed are session outbox messages carried over from an earlier
	// connection.
	Replayed *WorkerSentCount `json:"replayed,omitempty"`
	// OutboxPeak is the most the session outbox and the socket held.
	OutboxPeak *WorkerOutboxPeak `json:"outboxPeak,omitempty"`
	// LongestSendStallMs is the longest the socket held bytes the network
	// took none of.
	LongestSendStallMs int64 `json:"longestSendStallMs,omitempty"`
	// Compressed: the connection used permessage-deflate.
	Compressed bool `json:"compressed,omitempty"`
}

// WorkerSentAfterOpen counts a connection's first messages by type.
type WorkerSentAfterOpen struct {
	WindowMs int64             `json:"windowMs"`
	Types    []WorkerSentCount `json:"types"`
}

// WorkerSentCount is how many messages (of Type) went and their bytes.
type WorkerSentCount struct {
	Type  string `json:"type,omitempty"`
	Count int64  `json:"count"`
	Bytes int64  `json:"bytes"`
}

// WorkerOutboxPeak is the fullest a worker's outbox and socket got.
type WorkerOutboxPeak struct {
	Queued        int64 `json:"queued"`
	BufferedBytes int64 `json:"bufferedBytes"`
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
