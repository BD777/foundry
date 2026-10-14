package store

import (
	"context"
	"time"
)

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
	// Kind is WorkspaceKindProject (sent as absent) or
	// WorkspaceKindPersonalAgent.
	Kind string `json:"kind,omitempty"`
	// ArchivedAt is set while the workspace is archived: hidden in an
	// "Archived" group, starting no sessions, everything kept.
	ArchivedAt string `json:"archivedAt,omitempty"`
}

// WorkspaceLifecycleStore keeps what the server, not the device, decides
// about a workspace: its kind, whether it is archived, and its purpose.
// Device registrations never change these.
type WorkspaceLifecycleStore interface {
	// SetWorkspaceKind sets WorkspaceProjection.Kind.
	SetWorkspaceKind(ctx context.Context, workspaceID string, kind string) error
	// SetWorkspaceArchived archives the workspace at at, or with a zero at
	// restores it. Archiving an archived workspace keeps its first time.
	SetWorkspaceArchived(ctx context.Context, workspaceID string, at time.Time) (WorkspaceProjection, error)
	// SetWorkspacePurpose stores one sentence on what the workspace is for.
	SetWorkspacePurpose(ctx context.Context, workspaceID string, purpose string) error
	WorkspacePurpose(ctx context.Context, workspaceID string) (string, error)
}

// WorkspaceUnavailability says why a workspace cannot run on its device.
type WorkspaceUnavailability struct {
	// Reason is WorkspaceNotServed or WorkspaceFolderMissing.
	Reason string `json:"reason"`
	Since  string `json:"since"`
}

// WorkspaceNotServed: the device's worker, at its last report, did not list
// the folder among those it serves.
const WorkspaceNotServed = "not_served"

// WorkspaceFolderMissing: the device's worker still has the workspace, but
// its folder (LocalPath, the last known path) is gone from the device.
const WorkspaceFolderMissing = "folder_missing"

// WorkspaceNativeSessionsMoved is what relinking did to make the
// workspace's native sessions resumable in its new folder.
type WorkspaceNativeSessionsMoved struct {
	Copied       int `json:"copied"`
	AlreadyThere int `json:"alreadyThere"`
	NotFound     int `json:"notFound"`
}

// WorkspaceRelinkResult answers locating a workspace's folder.
type WorkspaceRelinkResult struct {
	Workspace      WorkspaceProjection          `json:"workspace"`
	NativeSessions WorkspaceNativeSessionsMoved `json:"nativeSessions"`
}

// WorkspaceRelinkSuggestion is a folder that looks like a missing
// workspace's, moved: "same_workspace" or "same_git_remote".
type WorkspaceRelinkSuggestion struct {
	Path   string `json:"path"`
	Reason string `json:"reason"`
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

type AssetProjection struct {
	ID          string `json:"id"`
	WorkspaceID string `json:"workspaceId,omitempty"`
	Name        string `json:"name"`
	Kind        string `json:"kind"`
	Status      string `json:"status"`
	Detail      string `json:"detail"`
}

type CreateWorkspaceInput struct {
	DeviceID string `json:"deviceId"`
	Path     string `json:"path"`
}
