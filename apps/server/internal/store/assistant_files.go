package store

import "context"

// WorkspaceFileStore keeps the saved versions of the files the person edits
// in an assistant's workspaces (DEV-223), and which default instructions
// each assistant's AGENTS.md started from.
type WorkspaceFileStore interface {
	// ListWorkspaceFileRevisions lists a file's versions, newest first.
	ListWorkspaceFileRevisions(ctx context.Context, workspaceID, path string, limit int) ([]WorkspaceFileRevision, error)
	// GetWorkspaceFileRevision is one version and its content.
	GetWorkspaceFileRevision(ctx context.Context, workspaceID, path, id string) (WorkspaceFileRevision, string, error)
	// AddWorkspaceFileRevision saves a version and keeps the file's newest
	// MaxWorkspaceFileRevisions.
	AddWorkspaceFileRevision(ctx context.Context, workspaceID, path string, revision WorkspaceFileRevision, content string) error
	// AddWorkspaceFileRevisionUnlessLatest saves a version unless the file's
	// latest one already has the same content, so observing an unchanged
	// file again adds nothing.
	AddWorkspaceFileRevisionUnlessLatest(ctx context.Context, workspaceID, path string, revision WorkspaceFileRevision, content string) error
	// MoveWorkspaceFileRevisions gives a renamed file its versions.
	MoveWorkspaceFileRevisions(ctx context.Context, workspaceID, from, to string) error
	// AssistantInstructionsDefault is the sha256 of the default
	// instructions the assistant's AGENTS.md last started from or the
	// person last answered; ErrNotFound before any.
	AssistantInstructionsDefault(ctx context.Context, assistantID string) (string, error)
	SetAssistantInstructionsDefault(ctx context.Context, assistantID, sha256 string) error
}

// MaxWorkspaceFileRevisions is how many versions a file keeps.
const MaxWorkspaceFileRevisions = 50
