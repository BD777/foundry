package store

import (
	"context"
	"time"
)

// Resources: what a device (later also a remote service) offers sessions,
// kept as one inventory. A resource type says what a resource does; an
// instance is one concrete thing of a type at one source. Workers report
// whole snapshots of what their detectors found (ResourcesReport); package
// resources reconciles them into instances with stable ids. A session holds
// an instance through a lease and operates it through the hosting device's
// worker (ResourceOperateRequest).
//
// packages/protocol/src/resources.ts declares the same types for clients;
// scripts/audit-contract.mjs keeps their JSON fields in step.

// DaemonCapabilityResources: the worker sends resources_report (its whole
// inventory) after hello and whenever it changes; a server announcing it in
// registered takes it. A worker without it lists device.resources only.
const DaemonCapabilityResources = "resources_v1"

// DaemonCapabilityResourceOperations: the worker runs resource_operate,
// resource_reset and install_resource_backend.
const DaemonCapabilityResourceOperations = "resources_ops_v1"

// DaemonCapabilityResourceCompute: the worker offers a compute instance and
// takes resource_settings, which it keeps and enforces itself.
const DaemonCapabilityResourceCompute = "resources_compute_v1"

// Resource states (ResourceInstance.State). Busy is derived from a live
// lease when listing; it is never stored.
const (
	ResourceAvailable = "available"
	ResourceBusy      = "busy"
	ResourceUnready   = "unready"
	ResourceOffline   = "offline"
	ResourceGone      = "gone"
)

// ResourceReadiness is how far a resource is set up. A detector reports
// the level it actually reached; "verified" is written only by a real
// successful use, never by detection.
type ResourceReadiness struct {
	Ready   bool     `json:"ready"`
	Level   string   `json:"level"`
	Reason  string   `json:"reason,omitempty"`
	Missing []string `json:"missing,omitempty"`
}

// ResourceBackend is one way to use an instance; several may drive the
// same instance, which stays the unit.
type ResourceBackend struct {
	ID        string            `json:"id"`
	Version   string            `json:"version,omitempty"`
	Mode      string            `json:"mode"`
	Readiness ResourceReadiness `json:"readiness"`
}

// DetectedResource is one instance as a detector found it on its device.
// Key is deterministic within the source.
type DetectedResource struct {
	Key       string            `json:"key"`
	Type      string            `json:"type"`
	Platform  string            `json:"platform"`
	Name      string            `json:"name"`
	Detector  string            `json:"detector"`
	Readiness ResourceReadiness `json:"readiness"`
	Backends  []ResourceBackend `json:"backends,omitempty"`
	Details   map[string]string `json:"details,omitempty"`
}

// ResourceDetectorError is a detector that failed during a scan.
type ResourceDetectorError struct {
	Detector string `json:"detector"`
	Type     string `json:"type"`
	Error    string `json:"error"`
}

// ResourcesReport is a worker's whole inventory (resources_report).
type ResourcesReport struct {
	ScannerVersion int                     `json:"scannerVersion"`
	ScannedAt      string                  `json:"scannedAt"`
	Instances      []DetectedResource      `json:"instances"`
	DetectorErrors []ResourceDetectorError `json:"detectorErrors"`
}

// ResourceSource is where an instance comes from.
type ResourceSource struct {
	Kind  string `json:"kind"`
	ID    string `json:"id"`
	Label string `json:"label"`
}

// ResourceInstance is one resource instance as the server keeps it.
type ResourceInstance struct {
	ID           string            `json:"id"`
	Key          string            `json:"key"`
	Type         string            `json:"type"`
	Platform     string            `json:"platform"`
	Name         string            `json:"name"`
	Source       ResourceSource    `json:"source"`
	State        string            `json:"state"`
	StateReason  string            `json:"stateReason,omitempty"`
	Stale        bool              `json:"stale,omitempty"`
	Readiness    ResourceReadiness `json:"readiness"`
	Backends     []ResourceBackend `json:"backends"`
	Details      map[string]string `json:"details,omitempty"`
	Detector     string            `json:"detector"`
	DiscoveredAt string            `json:"discoveredAt"`
	LastSeenAt   string            `json:"lastSeenAt"`
	GoneAt       string            `json:"goneAt,omitempty"`
	// Holder, Queue and Resetting come from the leases when listing.
	Holder    *ResourceHolder `json:"holder,omitempty"`
	Queue     int             `json:"queue,omitempty"`
	Resetting bool            `json:"resetting,omitempty"`
}

// ResourceSourceStatus is a source of instances and how its last report
// went.
type ResourceSourceStatus struct {
	Kind           string                  `json:"kind"`
	ID             string                  `json:"id"`
	Label          string                  `json:"label"`
	Online         bool                    `json:"online"`
	ScannerVersion int                     `json:"scannerVersion,omitempty"`
	LastReportAt   string                  `json:"lastReportAt,omitempty"`
	DetectorErrors []ResourceDetectorError `json:"detectorErrors"`
	// AllowRemoteCommands is the source's ResourceSourceSettings, read
	// with it; reports never write it.
	AllowRemoteCommands bool `json:"allowRemoteCommands"`
}

// ResourceSourceSettings is what a device's owner allows sessions to do
// with its resources. The server enforces it and sends it to the device's
// worker (resource_settings), which enforces it too.
type ResourceSourceSettings struct {
	// AllowRemoteCommands: sessions the owner started may lease the
	// device's compute instance and run commands with it. On by default:
	// a device whose owner never chose allows them; an explicit off stays.
	AllowRemoteCommands bool `json:"allowRemoteCommands"`
}

// ResourceList is GET /api/resources.
type ResourceList struct {
	Instances []ResourceInstance     `json:"instances"`
	Sources   []ResourceSourceStatus `json:"sources"`
}

// ResourceFilter narrows ListResourceInstances; empty fields match all.
type ResourceFilter struct {
	SourceID    string
	Type        string
	IncludeGone bool
}

// ResourceStore keeps the resource inventory: one row per source and one
// per instance (unique by source and key). It stores what package
// resources decided; it makes no decisions of its own. A source's
// instances are always written together with it, so a reader never sees
// half a snapshot.
type ResourceStore interface {
	// ListResourceInstances lists instances, gone ones only when the filter
	// asks, ordered by type, source and name.
	ListResourceInstances(ctx context.Context, filter ResourceFilter) ([]ResourceInstance, error)
	// ListResourceSources lists every source.
	ListResourceSources(ctx context.Context) ([]ResourceSourceStatus, error)
	// ReplaceSourceResources writes a source and the whole set of its
	// instances (gone ones included) in one transaction: instances of the
	// source not in instances are deleted.
	ReplaceSourceResources(ctx context.Context, source ResourceSourceStatus, instances []ResourceInstance) error
	// DeleteGoneResources deletes instances gone before the cutoff.
	DeleteGoneResources(ctx context.Context, before time.Time) (int64, error)
	// ResourceSourceSettings reads a source's settings; a source never
	// set has the zero settings.
	ResourceSourceSettings(ctx context.Context, sourceID string) (ResourceSourceSettings, error)
	// SetResourceSourceSettings keeps a source's settings, set by the
	// account byUserID.
	SetResourceSourceSettings(ctx context.Context, sourceID string, settings ResourceSourceSettings, byUserID string) error
}

// A removed device's source and instances go with its other reported
// state (sqlitestore purgeRemovedDeviceState), and with them the leases,
// waits and fences on them; the operation audit stays as history.

// Lease states (ResourceLease.State). Active and parked are live; the rest
// say how it ended.
const (
	LeaseActive    = "active"
	LeaseParked    = "parked"
	LeaseReleased  = "released"
	LeaseYielded   = "yielded"
	LeaseExpired   = "expired"
	LeasePreempted = "preempted"
	LeaseRevoked   = "revoked"
)

// LeaseLive reports a lease state that still holds its instance.
func LeaseLive(state string) bool { return state == LeaseActive || state == LeaseParked }

// ResourceHolder is who holds an instance, as the inventory lists it.
type ResourceHolder struct {
	LeaseID     string `json:"leaseId"`
	SessionID   string `json:"sessionId"`
	WorkspaceID string `json:"workspaceId,omitempty"`
	State       string `json:"state"`
	Since       string `json:"since"`
	ParkUntil   string `json:"parkUntil,omitempty"`
	HoldUntil   string `json:"holdUntil,omitempty"`
	PreemptAt   string `json:"preemptAt,omitempty"`
}

// ResourceLease is one session's exclusive use of one instance. Times are
// RFC 3339; an empty one is unset.
type ResourceLease struct {
	ID              string `json:"id"`
	ResourceID      string `json:"resourceId"`
	SourceID        string `json:"sourceId"`
	Generation      int64  `json:"generation"`
	HolderSessionID string `json:"holderSessionId"`
	HolderUserID    string `json:"holderUserId,omitempty"`
	HolderDeviceID  string `json:"holderDeviceId,omitempty"`
	Reason          string `json:"reason,omitempty"`
	State           string `json:"state"`
	AcquiredAt      string `json:"acquiredAt"`
	ParkUntil       string `json:"parkUntil,omitempty"`
	HoldUntil       string `json:"holdUntil,omitempty"`
	ContendedSince  string `json:"contendedSince,omitempty"`
	PreemptAt       string `json:"preemptAt,omitempty"`
	EndedAt         string `json:"endedAt,omitempty"`
	EndReason       string `json:"endReason,omitempty"`
	EndedBy         string `json:"endedBy,omitempty"`
	// Server-side bookkeeping, never sent.
	WarnedAt           string `json:"-"`
	Extended           bool   `json:"-"`
	HolderOfflineSince string `json:"-"`
	UpdatedAt          string `json:"-"`
}

// ResourceFence is an instance's fencing generation and reset state: the
// highest generation handed out, and whether the device must still confirm
// a reset before the instance goes to anyone else.
type ResourceFence struct {
	ResourceID  string
	SourceID    string
	Generation  int64
	Resetting   bool
	ResetSince  string
	ResetReason string
	// Unconfirmed: the device did not confirm the reset in time.
	Unconfirmed bool
}

// ResourceWait is a session waiting for a set of instances, all or none.
type ResourceWait struct {
	ID          string
	SessionID   string
	UserID      string
	DeviceID    string
	ResourceIDs []string
	Reason      string
	HoldUntil   string
	EnqueuedAt  string
	// RetainUntil: the wait keeps its place until then (the call's deadline
	// and a short retention after it).
	RetainUntil string
	// State: waiting, granted, canceled or expired.
	State string
}

// Wait states (ResourceWait.State).
const (
	WaitWaiting  = "waiting"
	WaitGranted  = "granted"
	WaitCanceled = "canceled"
	WaitExpired  = "expired"
)

// ResourceOperationRecord is one audited operation.
type ResourceOperationRecord struct {
	ID         string         `json:"id"`
	LeaseID    string         `json:"leaseId"`
	ResourceID string         `json:"resourceId"`
	SessionID  string         `json:"sessionId"`
	Op         string         `json:"op"`
	Args       map[string]any `json:"args,omitempty"`
	Status     string         `json:"status"`
	ErrorCode  string         `json:"errorCode,omitempty"`
	Outcome    map[string]any `json:"outcome,omitempty"`
	StartedAt  string         `json:"startedAt"`
	DurationMs int64          `json:"durationMs"`
	BytesOut   int64          `json:"bytesOut"`
	// SourceID and UserID are kept for filtering, not sent.
	SourceID string `json:"-"`
	UserID   string `json:"-"`
}

// ResourceOperationList is GET /api/resources/{id}/operations.
type ResourceOperationList struct {
	Operations []ResourceOperationRecord `json:"operations"`
}

// ResourceLeaseFilter narrows ListResourceLeases; empty fields match all.
type ResourceLeaseFilter struct {
	ID         string
	ResourceID string
	SessionID  string
	SourceID   string
	// Live: only active and parked leases.
	Live bool
}

// ResourceLeaseChanges is one decision of package resources, written in
// one transaction: leases, fences and waits upserted by id.
type ResourceLeaseChanges struct {
	Leases []ResourceLease
	Fences []ResourceFence
	Waits  []ResourceWait
}

// ResourceLeaseStore keeps leases, waits, fences and the operation audit.
// Like ResourceStore it keeps what package resources decided; a unique
// index still refuses a second live lease on one instance.
type ResourceLeaseStore interface {
	ListResourceLeases(ctx context.Context, filter ResourceLeaseFilter) ([]ResourceLease, error)
	ListResourceFences(ctx context.Context) ([]ResourceFence, error)
	// ListResourceWaits lists waits still waiting, in the order they came.
	ListResourceWaits(ctx context.Context) ([]ResourceWait, error)
	SaveResourceLeaseChanges(ctx context.Context, changes ResourceLeaseChanges) error
	// DeleteEndedResourceLeases deletes leases and waits that ended before
	// the cutoff.
	DeleteEndedResourceLeases(ctx context.Context, before time.Time) (int64, error)
	RecordResourceOperation(ctx context.Context, record ResourceOperationRecord) error
	// ListResourceOperations lists an instance's operations, newest first.
	ListResourceOperations(ctx context.Context, resourceID string, limit int) ([]ResourceOperationRecord, error)
	DeleteResourceOperations(ctx context.Context, before time.Time) (int64, error)
}

// ResourceOperateRequest is resource_operate.
type ResourceOperateRequest struct {
	ResourceID string           `json:"resourceId"`
	Key        string           `json:"key"`
	Type       string           `json:"type"`
	Backend    string           `json:"backend"`
	LeaseID    string           `json:"leaseId"`
	Generation int64            `json:"generation"`
	Actions    []ResourceAction `json:"actions"`
	DeadlineMs int64            `json:"deadlineMs"`
}

// ResourceAction is one typed operation and its arguments.
type ResourceAction struct {
	Op   string         `json:"op"`
	Args map[string]any `json:"args,omitempty"`
}

// ResourceImage is an image an operation returned, already scaled.
type ResourceImage struct {
	Data     string  `json:"data"`
	MimeType string  `json:"mimeType"`
	Width    int     `json:"width"`
	Height   int     `json:"height"`
	Scale    float64 `json:"scale"`
	FrameID  string  `json:"frameId"`
}

// ResourceActionResult is the outcome of one action.
type ResourceActionResult struct {
	Op        string          `json:"op"`
	OK        bool            `json:"ok"`
	Text      string          `json:"text,omitempty"`
	Error     string          `json:"error,omitempty"`
	ErrorCode string          `json:"errorCode,omitempty"`
	Images    []ResourceImage `json:"images,omitempty"`
	// Outcome: facts the audit keeps (exit code, sizes), never output.
	Outcome map[string]any `json:"outcome,omitempty"`
}

// ResourceOperateResult is resource_operated.
type ResourceOperateResult struct {
	Results   []ResourceActionResult `json:"results"`
	Opened    bool                   `json:"opened,omitempty"`
	Error     string                 `json:"error,omitempty"`
	ErrorCode string                 `json:"errorCode,omitempty"`
}

// ResourceResetRequest is resource_reset.
type ResourceResetRequest struct {
	ResourceID string `json:"resourceId"`
	Key        string `json:"key"`
	Type       string `json:"type"`
	Generation int64  `json:"generation"`
	Reason     string `json:"reason"`
	Notify     string `json:"notify,omitempty"`
}

// ResourceResetResult is resource_reset_done.
type ResourceResetResult struct {
	ResourceID string `json:"resourceId"`
	Generation int64  `json:"generation"`
	Error      string `json:"error,omitempty"`
}

// ResourceBackendInstallRequest is install_resource_backend.
type ResourceBackendInstallRequest struct {
	Backend string `json:"backend"`
}

// ResourceBackendInstallResult is resource_backend_installed.
type ResourceBackendInstallResult struct {
	Backend string   `json:"backend"`
	OK      bool     `json:"ok"`
	Output  string   `json:"output,omitempty"`
	Error   string   `json:"error,omitempty"`
	Missing []string `json:"missing,omitempty"`
}
