package store

import (
	"context"
	"errors"
)

var ErrSessionArchived = errors.New("session_archived: Unarchive to continue")
var ErrArchiveBlocked = errors.New("archive blocked; resolve the preflight blockers")
var ErrInvalidArchive = errors.New("name chatIds, groupId or batchId in one workspace")

type ChatArchive struct {
	ArchivedByLabel   string                `json:"archivedByLabel,omitempty"`
	ArchivedAt        string                `json:"archivedAt,omitempty"`
	ArchivedByUser    string                `json:"archivedByUser,omitempty"`
	ArchivedBySession string                `json:"archivedBySession,omitempty"`
	ArchiveBatchID    string                `json:"archiveBatchId,omitempty"`
	NativeArchive     []NativeArchiveTarget `json:"nativeArchive,omitempty"`
}

// NativeArchiveItem is the minimal device request; persistence/results also
// retain observations and errors in NativeArchiveTarget.
type NativeArchiveItem struct {
	Provider        string `json:"provider"`
	NativeSessionID string `json:"nativeSessionId"`
	DeviceID        string `json:"deviceId"`
	SessionID       string `json:"sessionId,omitempty"`
	ProfileID       string `json:"profileId,omitempty"`
	WorkspacePath   string `json:"workspacePath"`
	Desired         string `json:"desired"`
	Generation      int64  `json:"generation"`
}
type NativeArchiveTarget struct {
	DeviceLabel         string   `json:"deviceLabel,omitempty"`
	NativeDescendantIDs []string `json:"nativeDescendantIds,omitempty"`
	Provider            string   `json:"provider"`
	NativeSessionID     string   `json:"nativeSessionId"`
	DeviceID            string   `json:"deviceId"`
	SessionID           string   `json:"sessionId,omitempty"`
	ProfileID           string   `json:"profileId,omitempty"`
	WorkspacePath       string   `json:"workspacePath"`
	Desired             string   `json:"desired"`
	Generation          int64    `json:"generation"`
	State               string   `json:"state"`
	Error               string   `json:"error,omitempty"`
	AttemptedAt         string   `json:"attemptedAt,omitempty"`
	AppliedAt           string   `json:"appliedAt,omitempty"`
}
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
