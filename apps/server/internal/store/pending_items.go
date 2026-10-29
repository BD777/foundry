package store

import "context"

// A pending item is something in a session that waits for the person (DEV-079):
// a question an Agent asked, an Issue's question, a turn that failed, or a
// tool error only the person can clear. Foundry finds them in what sessions
// already record; it never asks an Agent for them.
const (
	PendingSourceQuestion      = "question"
	PendingSourceIssueQuestion = "issue_question"
	PendingSourceTurnFailed    = "turn_failed"
	PendingSourceNeedsHands    = "needs_hands"
)

// The states of a pending item. Open waits for the person; the others are
// resolved, and any of them may be opened again.
const (
	PendingOpen       = "open"
	PendingReplied    = "replied"
	PendingSuperseded = "superseded"
	PendingDone       = "done"
	PendingDismissed  = "dismissed"
)

// PendingItem is one thing waiting for the person, with the words its
// source wrote: the question, the failure, the tool's output.
type PendingItem struct {
	ID          string `json:"id"`
	UserID      string `json:"-"`
	WorkspaceID string `json:"workspaceId"`
	SessionID   string `json:"sessionId,omitempty"`
	IssueID     string `json:"issueId,omitempty"`
	// EventID and MessageID name where it was found in the session's
	// transcript; MessageID is the transcript message a link opens at.
	EventID   string `json:"eventId,omitempty"`
	MessageID string `json:"messageId,omitempty"`
	Source    string `json:"source"`
	// Rule names what a needs_hands item matched (sudo, permission, ...).
	Rule string `json:"rule,omitempty"`
	// Key is the source's identity: a source that reports the same thing
	// again (the same question, another failure of the same session) adds an
	// occurrence to the open item instead of a second item.
	Key   string `json:"-"`
	State string `json:"state"`
	Title string `json:"title"`
	// Excerpt is the source's own words; Context, when set, is the text
	// around it (the answer that asked, the command that failed).
	Excerpt        string   `json:"excerpt"`
	Context        string   `json:"context,omitempty"`
	Options        []string `json:"options,omitempty"`
	Recommendation string   `json:"recommendation,omitempty"`
	Occurrences    int      `json:"occurrences"`
	CreatedAt      string   `json:"createdAt"`
	UpdatedAt      string   `json:"updatedAt"`
	ResolvedAt     string   `json:"resolvedAt,omitempty"`
}

// PendingResolution resolves the open items a filter selects: a session's
// items found before a time, or an Issue's.
type PendingResolution struct {
	SessionID string
	IssueID   string
	// Sources limits it to items of these sources; empty means all.
	Sources []string
	// Before, an RFC 3339 time, limits it to items found before it.
	Before string
	// ExceptKey keeps the open item with this key (an Issue's current question).
	ExceptKey string
	State     string
}

// PendingItemStore keeps pending items.
type PendingItemStore interface {
	// RecordPendingItem adds an item, or adds an occurrence to the open item
	// with its key; it reports whether anything changed.
	RecordPendingItem(ctx context.Context, item PendingItem) (PendingItem, bool, error)
	// ResolvePendingItems resolves the open items the resolution selects and
	// returns how many.
	ResolvePendingItems(ctx context.Context, resolution PendingResolution) (int, error)
	// ListPendingItems returns the person's items in the given states,
	// those resolved only if resolved since resolvedSince, newest first.
	ListPendingItems(ctx context.Context, userID string, states []string, resolvedSince string, limit int) ([]PendingItem, error)
	// SetPendingItemState changes one of the person's items by hand: done,
	// dismissed, or open again.
	SetPendingItemState(ctx context.Context, userID, id, state string) (PendingItem, error)
}
