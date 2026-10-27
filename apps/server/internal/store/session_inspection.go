package store

import (
	"context"
	"errors"
)

// SessionInspectionStore answers what an agent asks when it inspects a
// session it was pointed at, beside what Store already reads.
type SessionInspectionStore interface {
	// AgentSessionCreatedAt is when the session was created.
	AgentSessionCreatedAt(ctx context.Context, sessionID string) (string, error)
	// NativeSessionOwner names the Foundry session that owns a native
	// session of a runtime ("" when none does).
	NativeSessionOwner(ctx context.Context, provider, nativeID string) (string, error)
	// ListSessionPage reads one page of a workspace's sessions, newest
	// activity first, each in a few fields. Deleted and naming sessions are
	// left out.
	ListSessionPage(ctx context.Context, query SessionListQuery) (SessionListPage, error)
}

// SessionListQuery selects the sessions one list call reads.
type SessionListQuery struct {
	Archived    string
	WorkspaceID string
	// ParentSessionID keeps only the sessions that session created.
	ParentSessionID string
	// IDs keeps only these sessions; the page then holds all of them.
	IDs []string
	// Cursor continues after the page that returned it as NextCursor.
	Cursor string
	Limit  int
}

// SessionListItem is a session as a list shows it. Title is the one the
// person sees (a rename or an AI title wins over the opening one).
type SessionListItem struct {
	ArchivedAt                              string
	ID, WorkspaceID, DeviceID, Provider     string
	ProfileID, ProfileLabel                 string
	Status, Title, ParentSessionID, IssueID string
	Role, Source, ActivityAt                string
}

type SessionListPage struct {
	Sessions []SessionListItem
	// NextCursor reads the next page; empty on the last one.
	NextCursor string
}

// ErrSessionListCursor is a cursor no list call returned.
var ErrSessionListCursor = errors.New("unknown session list cursor")
