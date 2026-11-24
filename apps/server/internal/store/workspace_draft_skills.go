package store

import "context"

type WorkspaceDraftSkill struct {
	Dependencies         []SkillDependency     `json:"dependencies,omitempty"`
	DependenciesAnalyzed bool                  `json:"dependenciesAnalyzed,omitempty"`
	LibraryRelation      *SkillLibraryRelation `json:"libraryRelation,omitempty"`
	SnapshotRoot         string                `json:"snapshotRoot,omitempty"`
	EntryPath            string                `json:"entryPath,omitempty"`
	SourceDigest         string                `json:"sourceDigest,omitempty"`
	PreviousDigest       string                `json:"previousDigest,omitempty"`
	ID                   string                `json:"id"`
	WorkspaceID          string                `json:"workspaceId"`
	ExecutionRootID      string                `json:"executionRootId"`
	Name                 string                `json:"name"`
	RelativePath         string                `json:"relativePath"`
	Description          string                `json:"description"`
	Digest               string                `json:"digest,omitempty"`
	Status               string                `json:"status"`
	Error                string                `json:"error,omitempty"`
	SnapshotPath         string                `json:"snapshotPath,omitempty"`
	SnapshotDigest       string                `json:"snapshotDigest,omitempty"`
}
type SkillCheckoutOrigin struct {
	SkillCheckoutBaseline
	DirectoryID string `json:"directoryId"`
}
type WorkspaceDraftSkills struct {
	// CheckoutOrigins is transport-only. Only a new Worker sends a complete map.
	CheckoutOrigins map[string]SkillCheckoutOrigin `json:"-"`
	Enabled         bool                           `json:"enabled"`
	Supported       bool                           `json:"supported"`
	ScannedAt       string                         `json:"scannedAt,omitempty"`
	Skills          []WorkspaceDraftSkill          `json:"skills"`
}
type SkillCheckoutBaseline struct {
	CheckoutDirectoryID string `json:"-"`
	SkillID             string `json:"skillId"`
	Revision            int    `json:"revision"`
}

type WorkspaceDraftStore interface {
	WorkspaceSkillCheckouts(context.Context, string) (map[string]SkillCheckoutBaseline, error)
	SaveWorkspaceSkillCheckout(context.Context, string, string, SkillCheckoutBaseline) error
	WorkspaceDraftRevision(context.Context, string, string, string, string) (WorkspaceDraftSkill, error)
	WorkspaceDrafts(context.Context, string, string) (WorkspaceDraftSkills, error)
	SetWorkspaceDraftsEnabled(context.Context, string, bool) error
	SaveWorkspaceDrafts(context.Context, string, string, WorkspaceDraftSkills) error
}
