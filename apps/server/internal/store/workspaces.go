package store

import (
	"context"
	"time"
)

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

// WorkspaceNotServed: the device's worker, at its last report, did not list
// the folder among those it serves.
const WorkspaceNotServed = "not_served"

// WorkspaceFolderMissing: the device's worker still has the workspace, but
// its folder (LocalPath, the last known path) is gone from the device.
const WorkspaceFolderMissing = "folder_missing"

// WorkspaceRelinkResult answers locating a workspace's folder.
type WorkspaceRelinkResult struct {
	Workspace      WorkspaceProjection          `json:"workspace"`
	NativeSessions WorkspaceNativeSessionsMoved `json:"nativeSessions"`
}

type WorkspaceFileRead struct {
	WorkspaceID string `json:"workspaceId"`
	Path        string `json:"path"`
	Content     string `json:"content"`
	Truncated   bool   `json:"truncated"`
}

type CreateWorkspaceInput struct {
	DeviceID string `json:"deviceId"`
	Path     string `json:"path"`
}
