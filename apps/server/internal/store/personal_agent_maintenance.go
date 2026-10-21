package store

import "context"

// Maintenance is a short, read-only run. Results are proposals, never source
// facts or execution-state authorities. EventKey coalesces the observed source
// version; the accepted native input remains stable across reconnects.
type PersonalAgentMaintenance struct {
	ID          string             `json:"id"`
	UserID      string             `json:"-"`
	Role        string             `json:"role"`
	WorkspaceID string             `json:"workspaceId"`
	VaultID     string             `json:"vaultId,omitempty"`
	EventKey    string             `json:"eventKey"`
	Status      string             `json:"status"`
	Reason      string             `json:"reason,omitempty"`
	Revision    int64              `json:"revision"`
	Attempt     int                `json:"attempt"`
	SessionID   string             `json:"sessionId,omitempty"`
	InputID     string             `json:"inputId,omitempty"`
	SnapshotID  string             `json:"snapshotId,omitempty"`
	DueAt       string             `json:"dueAt"`
	CreatedAt   string             `json:"createdAt"`
	UpdatedAt   string             `json:"updatedAt"`
	Result      *MaintenanceResult `json:"result,omitempty"`
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
	ListPersonalAgentMaintenance(context.Context, string) ([]PersonalAgentMaintenance, error)
	DuePersonalAgentMaintenance(context.Context, string) ([]PersonalAgentMaintenance, error)
	SavePersonalAgentMaintenance(context.Context, PersonalAgentMaintenance) (PersonalAgentMaintenance, error)
}

type ContextPatchCommand struct {
	WorkspaceID string `json:"workspaceId"`
	OperationID string `json:"operationId"`
	Action      string `json:"action"`
	Path        string `json:"path"`
	BaseHash    string `json:"baseHash"`
	Content     string `json:"content"`
}
type ContextPatchReply struct {
	OperationID string `json:"operationId"`
	Path        string `json:"path"`
	Hash        string `json:"hash"`
	Content     string `json:"content,omitempty"`
	State       string `json:"state"`
	Error       string `json:"error,omitempty"`
	Code        string `json:"code,omitempty"`
}
type PersonalAgentContextPatch struct {
	ID          string `json:"id"`
	UserID      string `json:"-"`
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
type PersonalAgentContextPatchStore interface {
	BeginPersonalAgentContextPatch(context.Context, PersonalAgentContextPatch, int64) (PersonalAgentContextPatch, error)
	ListPersonalAgentContextPatches(context.Context, string) ([]PersonalAgentContextPatch, error)
	PendingPersonalAgentContextPatches(context.Context) ([]PersonalAgentContextPatch, error)
	SavePersonalAgentContextPatch(context.Context, PersonalAgentContextPatch) (PersonalAgentContextPatch, error)
}
