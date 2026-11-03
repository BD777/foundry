package store

import (
	"context"
	"errors"
)

var ErrSessionArchived = errors.New("session_archived: Unarchive to continue")
var ErrArchiveBlocked = errors.New("archive blocked; resolve the preflight blockers")
var ErrInvalidArchive = errors.New("name chatIds, groupId or batchId in one workspace")

type ArchiveChatsInput struct {
	ExpectedChatIDs   []string `json:"expectedChatIds,omitempty"`
	WorkspaceID       string   `json:"workspaceId"`
	ChatIDs           []string `json:"chatIds,omitempty"`
	GroupID           string   `json:"groupId,omitempty"`
	BatchID           string   `json:"batchId,omitempty"`
	DryRun            bool     `json:"dryRun,omitempty"`
	ArchivedByUser    string   `json:"-"`
	ArchivedBySession string   `json:"-"`
}
type ArchiveBlocker struct {
	Action                string `json:"action,omitempty"`
	WorkID                string `json:"workId,omitempty"`
	WorkSessionID         string `json:"workSessionId,omitempty"`
	WorkRevision          int64  `json:"workRevision,omitempty"`
	WorkReferenceRevision int64  `json:"workReferenceRevision,omitempty"`
	Code                  string `json:"code,omitempty"`
	IssueID               string `json:"issueId,omitempty"`
	WorkTitle             string `json:"workTitle,omitempty"`
	ID                    string `json:"id"`
	Reason                string `json:"reason"`
}
type ArchivePausedWork struct {
	ID        string `json:"id"`
	Title     string `json:"title"`
	SessionID string `json:"sessionId"`
}
type ArchiveChatsResult struct {
	NativeAlsoHidden []ArchiveHiddenChat `json:"nativeAlsoHidden,omitempty"`
	BatchID          string              `json:"batchId"`
	Archived         []string            `json:"archived"`
	Blockers         []ArchiveBlocker    `json:"blockers"`
	PausedWork       []ArchivePausedWork `json:"pausedWork"`
}

// AgentSession and ChatThread carry ChatArchive's fields (allOf in
// contracts/models); these read and replace them as one value.

func (s AgentSession) Archive() ChatArchive {
	return ChatArchive{ArchivedByLabel: s.ArchivedByLabel, ArchivedAt: s.ArchivedAt, ArchivedByUser: s.ArchivedByUser, ArchivedBySession: s.ArchivedBySession, ArchiveBatchID: s.ArchiveBatchID, NativeArchive: s.NativeArchive}
}

func (s *AgentSession) SetArchive(a ChatArchive) {
	s.ArchivedByLabel, s.ArchivedAt, s.ArchivedByUser, s.ArchivedBySession, s.ArchiveBatchID, s.NativeArchive = a.ArchivedByLabel, a.ArchivedAt, a.ArchivedByUser, a.ArchivedBySession, a.ArchiveBatchID, a.NativeArchive
}

func (c ChatThread) Archive() ChatArchive {
	return ChatArchive{ArchivedByLabel: c.ArchivedByLabel, ArchivedAt: c.ArchivedAt, ArchivedByUser: c.ArchivedByUser, ArchivedBySession: c.ArchivedBySession, ArchiveBatchID: c.ArchiveBatchID, NativeArchive: c.NativeArchive}
}

func (c *ChatThread) SetArchive(a ChatArchive) {
	c.ArchivedByLabel, c.ArchivedAt, c.ArchivedByUser, c.ArchivedBySession, c.ArchiveBatchID, c.NativeArchive = a.ArchivedByLabel, a.ArchivedAt, a.ArchivedByUser, a.ArchivedBySession, a.ArchiveBatchID, a.NativeArchive
}

// Optional extension keeps archive available independently of legacy projections.
type ChatArchiveStore interface {
	ArchiveChats(context.Context, ArchiveChatsInput, bool) (ArchiveChatsResult, error)
	ArchiveChatIDs(context.Context, ArchiveChatsInput) ([]string, error)
	ListArchivedChats(context.Context, string, string) ([]ChatThread, error)
	ListArchivedSessions(context.Context, string, string) ([]AgentSession, error)
	NativeArchivePreview(context.Context, string, []string) ([]NativeArchiveTarget, error)
	NativeArchiveTargets(context.Context, string) ([]NativeArchiveTarget, error)
	RecordNativeArchiveResult(context.Context, NativeArchiveTarget) error
	RetryNativeArchive(context.Context, string, string) error
}

type ArchiveHiddenChat struct {
	ID    string `json:"id"`
	Title string `json:"title"`
}
