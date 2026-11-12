package store

import (
	"context"
	"time"
)

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
	// PendingSourceMessageChannel: a message channel needs the person
	// (DEV-203): messages held over its limit, or a gap in its feed.
	PendingSourceMessageChannel = "message_channel"
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
	// PendingHandedTimeout: the assistant neither acknowledged nor handled
	// the item before its deadline, so the person handles it now.
	PendingHandedTimeout = "assistant_timeout"
)

// PendingAssistantDeadline is how long an assistant item waits for its
// assistant to acknowledge or handle it before it goes to the person.
const PendingAssistantDeadline = 10 * time.Minute

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

// Why an item was resolved automatically. The detail says which condition
// made it moot; the reason is the stable value people and metrics use.
const (
	PendingResolutionAutoResolved = "auto_resolved"
	PendingResolutionMerged       = "merged"
)

// How an item ended. Outcome is the final result for the person; the
// escalation outcome is replaced if the person later answers or dismisses
// the item, while HandedReason keeps the escalation reason.
const (
	PendingOutcomeAssistantAnswered        = "assistant_answered"
	PendingOutcomeHandedOver               = "handed_over"
	PendingOutcomeEscalatedTimeout         = "escalated_timeout"
	PendingOutcomeAutoResolved             = "auto_resolved"
	PendingOutcomePersonAnswered           = "person_answered"
	PendingOutcomePersonDismissedNotNeeded = "person_dismissed_not_needed"
)

// PendingFailureCategory names the root cause a turn_failed item groups by.
const (
	PendingFailureQuotaExhausted      = "quota_exhausted"
	PendingFailureRateLimited         = "rate_limited"
	PendingFailureProviderUnavailable = "provider_unavailable"
	PendingFailureProviderMismatch    = "provider_mismatch"
	PendingFailureHostStopped         = "host_stopped"
	PendingFailureOther               = "other"
)

// PendingItem is one thing waiting for the person, with the words its
// source wrote: the question, the failure, the tool's output.
type PendingItem struct {
	ID     string `json:"id"`
	UserID string `json:"-"`
	// AssistantID is the assistant the record belongs to (DEV-191).
	AssistantID string `json:"assistantId,omitempty"`
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
	// again (the same question, another failure with the same root cause)
	// adds an occurrence to the open item instead of a second item.
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
	// FailureCategory, FailureProvider and FailureAccountID form a
	// turn_failed item's root-cause key. FailureSessions are every session
	// whose terminal failure contributed to it, and FailureResetAt is the
	// provider's own reset time when the failure named one.
	FailureCategory  string   `json:"failureCategory,omitempty"`
	FailureProvider  string   `json:"failureProvider,omitempty"`
	FailureAccountID string   `json:"failureAccountId,omitempty"`
	FailureResetAt   string   `json:"failureResetAt,omitempty"`
	FailureSessions  []string `json:"failureSessions,omitempty"`
	// Handler is who handles it while open: PendingHandlerPerson (also when
	// empty) or PendingHandlerAssistant.
	Handler string `json:"handler,omitempty"`
	// Note is what the assistant told the person when it handed the item
	// over; HandedReason why it went to the person (PendingHanded*), and
	// HandedAt when.
	Note         string `json:"note,omitempty"`
	HandedReason string `json:"handedReason,omitempty"`
	HandedAt     string `json:"handedAt,omitempty"`
	// DeadlineAt is when an assistant-handled item goes to the person
	// unless the assistant acknowledged or handled it. AcknowledgedAt records
	// that the assistant read it with needs_you; NotifiedAt records that the
	// arrival notice reached its conversation.
	DeadlineAt     string `json:"deadlineAt,omitempty"`
	AcknowledgedAt string `json:"acknowledgedAt,omitempty"`
	NotifiedAt     string `json:"-"`
	CreatedAt      string `json:"createdAt"`
	UpdatedAt      string `json:"updatedAt"`
	ResolvedAt     string `json:"resolvedAt,omitempty"`
	// ResolutionReason is auto_resolved for a condition that made the item
	// moot, merged when an older item was combined into a root-cause item;
	// ResolutionDetail names the concrete condition.
	ResolutionReason string `json:"resolutionReason,omitempty"`
	ResolutionDetail string `json:"resolutionDetail,omitempty"`
	Outcome          string `json:"outcome,omitempty"`
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
	Rule             string
	State            string
	ResolutionReason string
	ResolutionDetail string
	Outcome          string
	AcknowledgedAt   string
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
	// ListOpenPendingItemsBySource returns every person's open items of one
	// source, for maintenance that must not guess which person is active.
	ListOpenPendingItemsBySource(ctx context.Context, source string) ([]PendingItem, error)
	// MergePendingItems adds the open sources into the open item with the
	// target's key, or creates it, then resolves the sources as merged. It
	// keeps the sum of occurrences and the union of failure sessions, which
	// makes a repeated migration idempotent.
	MergePendingItems(ctx context.Context, target PendingItem, sourceIDs []string) (PendingItem, bool, error)
	// SetPendingItemState changes one of the person's items by hand: done,
	// dismissed, or open again.
	SetPendingItemState(ctx context.Context, userID, id, state string) (PendingItem, error)
	// ResolvePendingItem closes one of the person's items with the outcome
	// its handler gave it.
	ResolvePendingItem(ctx context.Context, userID, id, state, outcome string) (PendingItem, error)
	// AcknowledgePendingItems records that the assistant read these items
	// through needs_you, so their escalation deadline no longer applies.
	AcknowledgePendingItems(ctx context.Context, userID string, ids []string, at string) (int, error)
	// MarkPendingItemNotified records that the assistant heard about an
	// item's arrival.
	MarkPendingItemNotified(ctx context.Context, userID, id, at string) error
	// ListOpenAssistantPendingItems returns the open items whose handler is
	// an assistant, for the restart-safe notice and escalation sweep.
	ListOpenAssistantPendingItems(ctx context.Context) ([]PendingItem, error)
	// GetPendingItem is one of the person's items.
	GetPendingItem(ctx context.Context, userID, id string) (PendingItem, error)
	// HandPendingItem changes who handles one of the person's open items,
	// with the note that goes with it; an item no longer open is refused.
	HandPendingItem(ctx context.Context, userID, id, handler, note, reason, outcome string) (PendingItem, error)
}

// PendingHandledBy is who handles an item: the person unless it says the
// assistant.
func PendingHandledBy(item PendingItem) string {
	if item.Handler == PendingHandlerAssistant {
		return PendingHandlerAssistant
	}
	return PendingHandlerPerson
}
