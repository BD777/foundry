package personalagent

import (
	"context"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// Workspaces is the workspace lifecycle the assistant's flows
// (personalagent/assistant, knowledge) apply: the same service functions
// the REST routes call; httpapi implements it.
type Workspaces interface {
	CreateWorkspace(ctx context.Context, actor WorkspaceActor, request NewWorkspace) (store.WorkspaceProjection, error)
	UpdateWorkspaceDetails(ctx context.Context, actor WorkspaceActor, workspaceID string, details WorkspaceDetails) (store.WorkspaceProjection, error)
	ChangeWorkspaceSkills(ctx context.Context, actor WorkspaceActor, workspaceID string, add, remove []string) ([]store.WorkspaceSkillBinding, error)
	ChangeWorkspaceConnectors(ctx context.Context, actor WorkspaceActor, workspaceID string, add, remove []string) (store.WorkspaceExternalAccounts, error)
	ArchiveWorkspace(ctx context.Context, actor WorkspaceActor, workspaceID string) (store.WorkspaceProjection, error)
	RestoreWorkspace(ctx context.Context, actor WorkspaceActor, workspaceID string) (store.WorkspaceProjection, error)
	// NewFolderPath is where a new folder named folder goes on the device:
	// under its first managed root. connected is false while the device is
	// offline (its roots are then unknown).
	NewFolderPath(deviceID, folder string) (path string, connected bool, err error)
}

// WorkspaceActor is whom a workspace change is made for: the person and,
// when the assistant asked, its conversation.
type WorkspaceActor struct {
	UserID    string
	SessionID string
}

// NewWorkspace creates or registers a workspace on a device.
type NewWorkspace struct {
	DeviceID string
	// Path is the folder; with Create it may be empty (FolderName under
	// the device's first managed root). Without Create it names an
	// existing folder.
	Path       string
	Create     *WorkspaceSource
	FolderName string
	Name       string
	Purpose    string
	// Kind is store.WorkspaceKindProject (empty) or
	// store.WorkspaceKindPersonalAgent.
	Kind string
}

// WorkspaceSource is how a new folder starts: Kind WorkspaceCreateEmpty
// (GitInit to run git init, Files written into it) or WorkspaceCreateClone
// of URL.
type WorkspaceSource struct {
	Kind    string
	URL     string
	GitInit bool
	Files   []WorkspaceFile
}

// WorkspaceFile is a file a new folder starts with.
type WorkspaceFile struct {
	Path    string
	Content string
}

// How a new folder starts (WorkspaceSource.Kind).
const (
	WorkspaceCreateEmpty = "empty"
	WorkspaceCreateClone = "clone"
)

// WorkspaceDetails changes a workspace's name or purpose (nil keeps it).
type WorkspaceDetails struct {
	Name    *string
	Purpose *string
}
