package store

import "context"

// Workspace terms (docs/personal-agent.md §3): which names a workspace's
// chats, sessions, files and connectors mention, and how often, so the
// person's assistant can tell where a host, service or code name belongs.
// They are names and counts, never what was said; one set per workspace,
// read only for workspaces the reader can read.

// WorkspaceTermSource is one thing a workspace's terms were counted from:
// a chat, a session, or the list of its file names, skills or connectors.
type WorkspaceTermSource struct {
	WorkspaceID string
	// SourceID is the chat's or session's id, or the kind of a list.
	SourceID string
	// Kind is WorkspaceTermChat, WorkspaceTermSession, WorkspaceTermFiles,
	// WorkspaceTermSkills or WorkspaceTermConnectors.
	Kind string
	// Rev tells when the source changed and its terms are counted again.
	Rev string
	// Title is a chat's or session's title, cleaned as a digest shows it.
	Title string
	// At is when the source was last active.
	At string
}

// The kinds of WorkspaceTermSource.
const (
	WorkspaceTermChat       = "chat"
	WorkspaceTermSession    = "session"
	WorkspaceTermFiles      = "files"
	WorkspaceTermSkills     = "skills"
	WorkspaceTermConnectors = "connectors"
)

// WorkspaceTermTotal is one term's count over a workspace's sources.
type WorkspaceTermTotal struct {
	WorkspaceID string
	Term        string
	Count       int
	// Sources is how many of the workspace's sources mention it.
	Sources int
}

// WorkspaceTermHit is one source mentioning a term.
type WorkspaceTermHit struct {
	Source WorkspaceTermSource
	Term   string
	Count  int
}

// WorkspaceTermStore keeps the terms (tables workspace_term_sources and
// workspace_terms), owned by their workspace.
type WorkspaceTermStore interface {
	// WorkspaceTermSources lists the workspace's counted sources.
	WorkspaceTermSources(ctx context.Context, workspaceID string) ([]WorkspaceTermSource, error)
	// SaveWorkspaceTermSource replaces one source and its terms.
	SaveWorkspaceTermSource(ctx context.Context, source WorkspaceTermSource, terms map[string]int) error
	// DeleteWorkspaceTermSources deletes the workspace's sources but keep,
	// with their terms.
	DeleteWorkspaceTermSources(ctx context.Context, workspaceID string, keep []string) error
	// WorkspaceTermTotals lists each workspace's terms with at least
	// minCount mentions.
	WorkspaceTermTotals(ctx context.Context, workspaceIDs []string, minCount int) ([]WorkspaceTermTotal, error)
	// FindWorkspaceTerms lists the sources of the workspaces mentioning a
	// term that starts with prefix, at most limit.
	FindWorkspaceTerms(ctx context.Context, workspaceIDs []string, prefix string, limit int) ([]WorkspaceTermHit, error)
	// ChatTermTexts is what a chat's terms are counted from: its title and
	// handoff context, and the text of its messages that are
	// not tool calls or reasoning. sessionID, instead of chatID, reads the
	// native chats a Foundry session ran in.
	ChatTermTexts(ctx context.Context, chatID, sessionID string) ([]string, error)
}
