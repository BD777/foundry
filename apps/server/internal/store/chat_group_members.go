package store

import "context"

// ChatGroupMemberStore reads a chat folder's members beyond the ones the
// sidebar lists at first.
type ChatGroupMemberStore interface {
	// ChatGroupMemberCounts counts each folder's chats the sidebar can list,
	// so a folder can say how many of its members it has not shown yet.
	ChatGroupMemberCounts(ctx context.Context, workspaceID string) (map[string]int, error)
	// ListChatGroupMemberSessions reads one page of a folder's listable
	// sessions, newest activity first, for the members a folder adds on demand.
	ListChatGroupMemberSessions(ctx context.Context, workspaceID string, groupID string, cursor string, limit int) ([]AgentSession, string, error)
}
