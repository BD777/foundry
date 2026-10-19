package store

import "context"

type WorkspaceDraftSkill struct {
	SnapshotRoot    string           `json:"snapshotRoot,omitempty"`
	EntryPath       string           `json:"entryPath,omitempty"`
	SourceDigest    string           `json:"sourceDigest,omitempty"`
	PreviousDigest  string           `json:"previousDigest,omitempty"`
	LastTrial       *DraftSkillTrial `json:"lastTrial,omitempty"`
	ID              string           `json:"id"`
	WorkspaceID     string           `json:"workspaceId"`
	ExecutionRootID string           `json:"executionRootId"`
	Name            string           `json:"name"`
	RelativePath    string           `json:"relativePath"`
	Description     string           `json:"description"`
	Digest          string           `json:"digest,omitempty"`
	Status          string           `json:"status"`
	Error           string           `json:"error,omitempty"`
	SnapshotPath    string           `json:"snapshotPath,omitempty"`
	SnapshotDigest  string           `json:"snapshotDigest,omitempty"`
}
type WorkspaceDraftSkills struct {
	Enabled   bool                  `json:"enabled"`
	Supported bool                  `json:"supported"`
	ScannedAt string                `json:"scannedAt,omitempty"`
	Skills    []WorkspaceDraftSkill `json:"skills"`
}
type WorkspaceDraftStore interface {
	WorkspaceDraftRevision(context.Context, string, string, string, string) (WorkspaceDraftSkill, error)
	WorkspaceDrafts(context.Context, string, string) (WorkspaceDraftSkills, error)
	SetWorkspaceDraftsEnabled(context.Context, string, bool) error
	SaveWorkspaceDrafts(context.Context, string, string, WorkspaceDraftSkills) error
}

type DraftSelectionRef struct {
	ID     string `json:"id"`
	Digest string `json:"digest"`
}
type LibrarySelectionRef struct {
	SkillID  string `json:"skillId"`
	Revision int    `json:"revision"`
}
type SkillSelection struct {
	Mode    string                `json:"mode"`
	Drafts  []DraftSelectionRef   `json:"drafts,omitempty"`
	Names   []string              `json:"names,omitempty"`
	Library []LibrarySelectionRef `json:"library,omitempty"`
}
type ResolvedSkillSelection struct {
	Transfers     []DraftSkillTransfer  `json:"transfers,omitempty"`
	Mode          string                `json:"mode"`
	Drafts        []WorkspaceDraftSkill `json:"drafts"`
	LibraryRefs   []SessionSkillRef     `json:"libraryRefs"`
	ExcludedNames []string              `json:"excludedNames"`
}
type DraftSkillTransfer struct {
	ID            string `json:"id"`
	Digest        string `json:"digest"`
	ArchiveBase64 string `json:"archiveBase64"`
	Checksum      string `json:"checksum"`
}

type DraftSkillTrial struct {
	SessionID string `json:"sessionId"`
	Digest    string `json:"digest"`
	Status    string `json:"status"`
}
