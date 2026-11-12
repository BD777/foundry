package store

import "context"

// A pending item is something that waits for the person (DEV-079): in a
// session, a question an Agent asked, an Issue's question, a turn that
// failed, or a tool error only the person can clear; outside any session
// (DEV-125), a connected account to authorize again or a device's sign-in
// that expired. Foundry finds them in what it already records; it never
// asks an Agent for them.
const (
	PendingSourceQuestion      = "question"
	PendingSourceIssueQuestion = "issue_question"
	PendingSourceTurnFailed    = "turn_failed"
	PendingSourceNeedsHands    = "needs_hands"
	// PendingSourceAccount: a connected account that needs authorizing again.
	PendingSourceAccount = "account"
	// PendingSourceConnector: a device-held connector whose sign-in expired.
	PendingSourceConnector = "connector"
	// PendingSourceHelperStuck: a helper the assistant handed work to that
	// cannot reach its model service or ran past the person's stuck limit.
	PendingSourceHelperStuck = "helper_stuck"
	// PendingSourceBundleUpdate: a bundle update that stopped (DEV-154),
	// for whoever follows the repository: its rule is the rollout's state,
	// rolled_back (the canary's check failed) or failed (its install did).
	PendingSourceBundleUpdate = "bundle_update"
)

// Who handles an open item (docs/assistant-orchestration.md §h): the
// person, or their assistant, which answers or retries its own helpers'
// items and hands the rest to the person with a note.
const (
	PendingHandlerPerson    = "person"
	PendingHandlerAssistant = "assistant"
)

// Why an item the assistant handled went to the person: it handed it over,
// it was stopped, or its computer was offline when the person looked.
const (
	PendingHandedByAssistant = "assistant"
	PendingHandedStopped     = "assistant_stopped"
	PendingHandedOffline     = "assistant_offline"
)

// PendingRuleHandedOver marks an item the assistant made for a helper
// session that asked without a question card.
const PendingRuleHandedOver = "handed_over"

// PendingRuleHeld marks a question that held its turn while it waited (no
// TranscriptMessage.delivery): once the turn ends it no longer waits.
const PendingRuleHeld = "held"

// PendingPersonal reports whether a source's items belong to the person
// rather than a workspace: they have no workspace, session or Issue.
func PendingPersonal(source string) bool {
	return source == PendingSourceAccount || source == PendingSourceConnector || source == PendingSourceBundleUpdate
}

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
	ID     string `json:"id"`
	UserID string `json:"-"`
	// AssistantID is the assistant the record belongs to (DEV-191).
	AssistantID string `json:"-"`
	WorkspaceID string `json:"workspaceId"`
	SessionID   string `json:"sessionId,omitempty"`
	IssueID     string `json:"issueId,omitempty"`
	// EventID and MessageID name where it was found in the session's
	// transcript; MessageID is the transcript message a link opens at.
	EventID   string `json:"eventId,omitempty"`
	MessageID string `json:"messageId,omitempty"`
	Source    string `json:"source"`
	// Rule names what a needs_hands item matched (sudo, permission, ...);
	// on a question, PendingRuleHeld when it held the turn.
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
	// Handler is who handles it while open: PendingHandlerPerson (also when
	// empty) or PendingHandlerAssistant.
	Handler string `json:"handler,omitempty"`
	// Note is what the assistant told the person when it handed the item
	// over; HandedReason why it went to the person (PendingHanded*), and
	// HandedAt when.
	Note         string `json:"note,omitempty"`
	HandedReason string `json:"handedReason,omitempty"`
	HandedAt     string `json:"handedAt,omitempty"`
	CreatedAt    string `json:"createdAt"`
	UpdatedAt    string `json:"updatedAt"`
	ResolvedAt   string `json:"resolvedAt,omitempty"`
}

// PendingResolution resolves the open items a filter selects: a session's
// items found before a time, an Issue's, or the item with a key.
type PendingResolution struct {
	SessionID string
	IssueID   string
	Key       string
	// Sources limits it to items of these sources; empty means all.
	Sources []string
	// Before, an RFC 3339 time, limits it to items found before it.
	Before string
	// ExceptKey keeps the open item with this key (an Issue's current question).
	ExceptKey string
	// MessageID limits it to items found in this transcript message, named
	// with or without a turn prefix ("<input>/").
	MessageID string
	// Rule limits it to items with this rule.
	Rule  string
	State string
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
	// GetPendingItem is one of the person's items.
	GetPendingItem(ctx context.Context, userID, id string) (PendingItem, error)
	// HandPendingItem changes who handles one of the person's open items,
	// with the note that goes with it; an item no longer open is refused.
	HandPendingItem(ctx context.Context, userID, id, handler, note, reason string) (PendingItem, error)
}

// PendingHandledBy is who handles an item: the person unless it says the
// assistant.
func PendingHandledBy(item PendingItem) string {
	if item.Handler == PendingHandlerAssistant {
		return PendingHandlerAssistant
	}
	return PendingHandlerPerson
}
