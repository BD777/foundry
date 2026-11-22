package store

import "context"

// Maintenance is a short, read-only run. Results are proposals, never source
// facts or execution-state authorities. EventKey coalesces the observed source
// version; the accepted native input remains stable across reconnects.
type PersonalAgentMaintenance struct {
	ID     string `json:"id"`
	UserID string `json:"-"`
	// AssistantID is the assistant whose home and account ran the last
	// attempt at a global review; for a memory review it is the assistant
	// the layer belongs to (DEV-191, DEV-256).
	AssistantID string `json:"-"`
	Role        string `json:"role"`
	WorkspaceID string `json:"workspaceId"`
	VaultID     string `json:"vaultId,omitempty"`
	EventKey    string `json:"eventKey"`
	Status      string `json:"status"`
	Reason      string `json:"reason,omitempty"`
	Revision    int64  `json:"revision"`
	Attempt     int    `json:"attempt"`
	SessionID   string `json:"sessionId,omitempty"`
	InputID     string `json:"inputId,omitempty"`
	SnapshotID  string `json:"snapshotId,omitempty"`
	DueAt       string `json:"dueAt"`
	// WaitingSince is when the job last entered waiting (empty otherwise),
	// so a repeatedly deferred job still shows how long it has waited.
	WaitingSince string             `json:"waitingSince,omitempty"`
	CreatedAt    string             `json:"createdAt"`
	UpdatedAt    string             `json:"updatedAt"`
	Result       *MaintenanceResult `json:"result,omitempty"`
}
type MaintenanceFinding struct {
	Kind       string   `json:"kind"`
	Summary    string   `json:"summary"`
	SourceRefs []string `json:"sourceRefs"`
}
type MaintenancePatch struct {
	Path     string `json:"path"`
	BaseHash string `json:"baseHash"`
	Content  string `json:"content"`
	Reason   string `json:"reason"`
}
type MaintenanceResult struct {
	Summary  string               `json:"summary"`
	Findings []MaintenanceFinding `json:"findings"`
	Patches  []MaintenancePatch   `json:"patches"`
}
type PersonalAgentMaintenanceStore interface {
	PersonalAgentMaintenanceInputs(context.Context, string) (map[string]bool, error)
	EnqueuePersonalAgentMaintenance(context.Context, PersonalAgentMaintenance) (PersonalAgentMaintenance, error)
	GetPersonalAgentMaintenance(context.Context, string, string) (PersonalAgentMaintenance, error)
	// ListAssistantMemoryMaintenance lists one assistant's own memory-layer
	// upkeep. Global project upkeep belongs to its workspace and is read
	// through the workspace instead (DEV-256).
	ListAssistantMemoryMaintenance(context.Context, string) ([]PersonalAgentMaintenance, error)
	// ListWorkspaceMaintenance lists a project's upkeep state: the
	// governance reviews of its instruction files the person owns, whoever
	// last ran them.
	ListWorkspaceMaintenance(context.Context, string, string) ([]PersonalAgentMaintenance, error)
	// GetWorkspaceMaintenance is one of a project's governance reviews.
	GetWorkspaceMaintenance(context.Context, string, string, string) (PersonalAgentMaintenance, error)
	// RebindPersonalAgentMaintenance gives a waiting governance review its
	// next executor without changing what it is or when it is due. It
	// reports ErrNotFound when the row, role or old executor differs.
	RebindPersonalAgentMaintenance(context.Context, string, string, string) error
	// ListPersonalAgentMaintenanceForUser lists the person's upkeep jobs
	// across assistants (their default is the executor of global upkeep).
	ListPersonalAgentMaintenanceForUser(context.Context, string) ([]PersonalAgentMaintenance, error)
	DuePersonalAgentMaintenance(context.Context, string) ([]PersonalAgentMaintenance, error)
	SavePersonalAgentMaintenance(context.Context, PersonalAgentMaintenance) (PersonalAgentMaintenance, error)
	// UpkeepNoticeSignature is the last upkeep state written into an
	// assistant's folder ("" when none).
	UpkeepNoticeSignature(context.Context, string) (string, error)
	SaveUpkeepNoticeSignature(context.Context, string, string, string) error
}

type ContextPatchCommand struct {
	WorkspaceID string `json:"workspaceId"`
	OperationID string `json:"operationId"`
	Action      string `json:"action"`
	Path        string `json:"path"`
	BaseHash    string `json:"baseHash"`
	Content     string `json:"content"`
}

type PersonalAgentContextPatch struct {
	ID     string `json:"id"`
	UserID string `json:"-"`
	// AssistantID is the assistant the record belongs to (DEV-191).
	AssistantID string `json:"-"`
	JobID       string `json:"jobId"`
	WorkspaceID string `json:"workspaceId"`
	DeviceID    string `json:"deviceId"`
	Index       int    `json:"index"`
	Path        string `json:"path"`
	BaseHash    string `json:"baseHash"`
	Hash        string `json:"hash"`
	Status      string `json:"status"`
	Reason      string `json:"reason,omitempty"`
	Revision    int64  `json:"revision"`
	CreatedAt   string `json:"createdAt"`
	UpdatedAt   string `json:"updatedAt"`
}

// WorkspaceUpkeep is what a project's upkeep holds for the person (DEV-256):
// the reviews of its instruction files and the changes they proposed.
type WorkspaceUpkeep struct {
	Jobs    []PersonalAgentMaintenance  `json:"jobs"`
	Patches []PersonalAgentContextPatch `json:"patches"`
}

type PersonalAgentContextPatchStore interface {
	BeginPersonalAgentContextPatch(context.Context, PersonalAgentContextPatch, int64) (PersonalAgentContextPatch, error)
	// ListPersonalAgentContextPatchesForWorkspace lists the file changes a
	// project's upkeep proposed for this person, whatever assistant ran the
	// review.
	ListPersonalAgentContextPatchesForWorkspace(context.Context, string, string) ([]PersonalAgentContextPatch, error)
	PendingPersonalAgentContextPatches(context.Context) ([]PersonalAgentContextPatch, error)
	SavePersonalAgentContextPatch(context.Context, PersonalAgentContextPatch) (PersonalAgentContextPatch, error)
}
