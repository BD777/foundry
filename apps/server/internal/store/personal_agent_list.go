package store

import (
	"context"
	"errors"
	"time"
)

// The person's list (docs/personal-agent.md §6): what they told their
// assistant they plan to do, are doing or have done, in their own words,
// kept by the server beside the assistant's own tasks (pa_tasks, the work
// it handed off). The assistant writes it with update_list, grounded in
// what the person wrote; the person ticks, edits and deletes items on the
// assistant's home page. An open item with a time and Remind set is a
// reminder: at that time the server tells the assistant, which tells the
// person (personalagent/assistant's list.go). Same JSON names as
// packages/protocol/src/personal-agent-list.ts.
//
// 「事项」 (DEV-258) builds on the list: an item has an owner, a summary the
// assistant keeps, an origin, a timeline (pa_item_events) and helpers (the
// pa_tasks rows with item_id). The contract is PersonalAgentItem in
// contracts/models/personal_agent.yaml.

// List item statuses.
const (
	PersonalAgentItemOpen    = "open"
	PersonalAgentItemDone    = "done"
	PersonalAgentItemDropped = "dropped"
)

// Who an item is for: the person does it, or the assistant does it through
// its helpers (pa_items.owner).
const (
	PersonalAgentItemOwnerPerson    = "person"
	PersonalAgentItemOwnerAssistant = "assistant"
)

// Where an item started (origin.kind).
const (
	PersonalAgentItemOriginWeb      = "web"
	PersonalAgentItemOriginChannel  = "channel"
	PersonalAgentItemOriginSelfChat = "self_chat"
)

// Who caused a change that an item's timeline records. Every store call
// that records one takes it explicitly.
const (
	PersonalAgentActorPerson    = "person"
	PersonalAgentActorAssistant = "assistant"
	PersonalAgentActorFoundry   = "foundry"
)

// Kinds of an item's timeline events (pa_item_events.kind).
const (
	PersonalAgentItemEventCreated        = "created"
	PersonalAgentItemEventEdited         = "edited"
	PersonalAgentItemEventOwnerChanged   = "owner_changed"
	PersonalAgentItemEventStatusChanged  = "status_changed"
	PersonalAgentItemEventSummaryUpdated = "summary_updated"
	PersonalAgentItemEventHelperStarted  = "helper_started"
	PersonalAgentItemEventHelperEnded    = "helper_ended"
	PersonalAgentItemEventArchived       = "archived"
	PersonalAgentItemEventRestored       = "restored"
)

// Views of the items page: open, finished (done or dropped) and archived; all
// (any status, archived ones left out unless IncludeArchived) is read_list's.
const (
	PersonalAgentItemViewOpen     = "open"
	PersonalAgentItemViewFinished = "finished"
	PersonalAgentItemViewArchived = "archived"
	PersonalAgentItemViewAll      = "all"
)

const (
	// PersonalAgentItemSummaryMaxLength is the most characters an item's
	// summary holds.
	PersonalAgentItemSummaryMaxLength = 1500
	// PersonalAgentItemPageDefault and PersonalAgentItemPageMax bound the
	// limit of ListPersonalAgentItemPage.
	PersonalAgentItemPageDefault = 50
	PersonalAgentItemPageMax     = 200
)

var (
	// ErrPersonalAgentItemInvalid wraps each item field or query the store refuses.
	ErrPersonalAgentItemInvalid = errors.New("invalid personal agent item")
	// ErrPersonalAgentItemNotArchivable is refused archiving an item that is
	// still open or has a helper running.
	ErrPersonalAgentItemNotArchivable = errors.New("an item is archived only when it is done or dropped and no helper of it is running")
)

// PersonalAgentListItem is one thing on the person's list (table pa_items).
type PersonalAgentListItem struct {
	ID     string `json:"id"`
	UserID string `json:"-"`
	// AssistantID is the assistant the record belongs to (DEV-191).
	AssistantID    string                 `json:"-"`
	IntentRevision int64                  `json:"intentRevision,omitempty"`
	Revision       int64                  `json:"revision,omitempty"`
	SourceInputID  string                 `json:"sourceInputId,omitempty"`
	SourceInboxID  string                 `json:"sourceInboxId,omitempty"`
	CaptureKey     string                 `json:"-"`
	CaptureHash    string                 `json:"-"`
	Plan           *PersonalAgentItemPlan `json:"plan,omitempty"`
	// Owner is PersonalAgentItemOwnerPerson or PersonalAgentItemOwnerAssistant.
	Owner string `json:"owner"`
	// Text is the thing, short, in the person's language.
	Text string `json:"text"`
	// When is when the person said it happens, in their words ("after
	// work", "下午"); empty when they did not say.
	When string `json:"when,omitempty"`
	// At is When as a time (RFC 3339), set only when it is known.
	At string `json:"at,omitempty"`
	// Remind: the server reminds the assistant at At while it is open.
	Remind bool   `json:"remind"`
	Status string `json:"status"`
	// Summary is the assistant's running context in Markdown; Foundry never writes it.
	Summary string `json:"summary,omitempty"`
	// Quote is the person's words the item rests on.
	Quote string `json:"quote,omitempty"`
	// Origin is where the item started and the message it rests on (origin_json).
	Origin          *PersonalAgentItemOrigin `json:"origin,omitempty"`
	SourceSessionID string                   `json:"sourceSessionId,omitempty"`
	CreatedAt       string                   `json:"createdAt"`
	UpdatedAt       string                   `json:"updatedAt"`
	// ClosedAt is when it was done or dropped.
	ClosedAt string `json:"closedAt,omitempty"`
	// ArchivedAt is when it was archived; empty while it is not.
	ArchivedAt string `json:"archivedAt,omitempty"`
	// RemindedAt is when the reminder for At went out.
	RemindedAt string `json:"remindedAt,omitempty"`
}

// PersonalAgentListItemInput is the person's edit of an item on the web;
// absent fields stay as they are.
type PersonalAgentListItemInput struct {
	Revision *int64                 `json:"revision,omitempty"`
	Plan     *PersonalAgentItemPlan `json:"plan,omitempty"`
	Text     *string                `json:"text,omitempty"`
	When     *string                `json:"when,omitempty"`
	Status   *string                `json:"status,omitempty"`
	Owner    *string                `json:"owner,omitempty"`
	// PlanChoice is the person's choice of route, project and dependencies
	// (PUT plan), merged over the plan by the assistant's EditItem.
	PlanChoice *PersonalAgentItemPlanChoice `json:"-"`
}

// PersonalAgentItemPlan supplements the person's short task without
// duplicating execution state or changing what their original words meant.
type PersonalAgentItemPlan struct {
	Route        *PersonalAgentRouteDecision       `json:"route,omitempty"`
	Mode         string                            `json:"mode"`
	Progress     string                            `json:"progress"`
	NextAction   string                            `json:"nextAction,omitempty"`
	WaitingFor   string                            `json:"waitingFor,omitempty"`
	WorkspaceID  string                            `json:"workspaceId,omitempty"`
	Dependencies []string                          `json:"dependencies,omitempty"`
	WorkRefs     []PersonalAgentWorkReference      `json:"workRefs,omitempty"`
	Evidence     []PersonalAgentCompletionEvidence `json:"evidence,omitempty"`
}

type PersonalAgentWorkReference struct {
	Kind        string `json:"kind"`
	ID          string `json:"id"`
	WorkspaceID string `json:"workspaceId"`
	Relation    string `json:"relation"`
}

type PersonalAgentCompletionEvidence struct {
	Kind       string `json:"kind"`
	Ref        string `json:"ref"`
	Summary    string `json:"summary"`
	ObservedAt string `json:"observedAt"`
}

// PersonalAgentItemFilter selects one page of the items page.
type PersonalAgentItemFilter struct {
	// View is PersonalAgentItemViewOpen (the default), ...Finished or ...Archived.
	View string
	// Owner is PersonalAgentItemOwnerPerson or ...Assistant; empty for both.
	Owner string
	// Status is PersonalAgentItemOpen, ...Done or ...Dropped; empty for any.
	Status string
	// From and To bound updatedAt as RFC 3339 instants, the range [From, To);
	// an empty bound is open.
	From string
	To   string
	// Query matches text and summary, case-insensitively.
	Query string
	// IncludeArchived keeps archived items in every view but the archived one.
	IncludeArchived bool
	Limit           int
	Offset          int
	// ClosedSince, when set, replaces View: the open items and those closed at
	// or after it, the list the older /list route answered (closed_at, not
	// updatedAt). Status and Owner still narrow it; archived items are left out
	// unless IncludeArchived.
	ClosedSince string
}

// PersonalAgentItemPage is one page of items, newest-updated first, with the
// helpers of those items.
type PersonalAgentItemPage struct {
	Items []PersonalAgentListItem
	// Helpers are the helpers (pa_tasks with item_id) of the items in Items, by item.
	Helpers map[string][]PersonalAgentTask
	Total   int
	Offset  int
	// NextOffset is the offset of the next page; 0 on the last one.
	NextOffset int
}

// PersonalAgentItemRangeReport is the deterministic review of [From, To),
// built only from items and their times.
type PersonalAgentItemRangeReport struct {
	From   string
	To     string
	Counts PersonalAgentItemReportCounts
	Groups []PersonalAgentItemStatusGroup
	// Helpers are the helpers of the items in Groups, by item.
	Helpers map[string][]PersonalAgentTask
}

// PersonalAgentItemStatusGroup holds the items of one status in a report's range.
type PersonalAgentItemStatusGroup struct {
	Status string
	Items  []PersonalAgentListItem
}

// PersonalAgentArchivedItem is an item the time rule archived, with the
// sessions of its helpers.
type PersonalAgentArchivedItem struct {
	AssistantID string
	ItemID      string
	SessionIDs  []string
}

// PersonalAgentListStore keeps the person's list and the daily digest's
// mark. Every call is scoped to one assistant (assistantID) but the due scans.
type PersonalAgentListStore interface {
	// ListPersonalAgentItems lists the person's open items and those
	// closed since closedSince ("" for none), oldest first.
	ListPersonalAgentItems(ctx context.Context, assistantID, closedSince string) ([]PersonalAgentListItem, error)
	GetPersonalAgentItem(ctx context.Context, assistantID, id string) (PersonalAgentListItem, error)
	// AddPersonalAgentItem adds an item and records its created event for actor.
	AddPersonalAgentItem(ctx context.Context, actor string, item PersonalAgentListItem) (PersonalAgentListItem, error)
	// SavePersonalAgentItem stores an item's fields as given and records
	// the changes for actor; a new At clears RemindedAt.
	SavePersonalAgentItem(ctx context.Context, actor string, item PersonalAgentListItem) (PersonalAgentListItem, error)
	DeletePersonalAgentItem(ctx context.Context, assistantID, id string) error
	// SetPersonalAgentItemArchived archives a closed item no helper of which
	// runs, or restores it, recording it for actor. It returns the sessions
	// of the item's helpers, which archive and restore with it.
	SetPersonalAgentItemArchived(ctx context.Context, actor, assistantID, id string, archived bool) ([]string, error)
	// SavePersonalAgentItemArchive saves an item as SavePersonalAgentItem
	// does and archives or restores it as SetPersonalAgentItemArchived does,
	// in one transaction: a refusal of either writes nothing. It returns the
	// saved item and the sessions of its helpers.
	SavePersonalAgentItemArchive(ctx context.Context, actor string, item PersonalAgentListItem, archived bool) (PersonalAgentListItem, []string, error)
	// RecordPersonalAgentItemSessionEvent records that the archive or restore
	// of an item took one of its helper sessions: kind archived or restored,
	// with the session.
	RecordPersonalAgentItemSessionEvent(ctx context.Context, actor, assistantID, itemID, kind, sessionID string) error
	ListPersonalAgentItemPage(ctx context.Context, assistantID string, filter PersonalAgentItemFilter) (PersonalAgentItemPage, error)
	// ReportPersonalAgentItems reviews [from, to), both RFC 3339 instants.
	ReportPersonalAgentItems(ctx context.Context, assistantID, from, to string) (PersonalAgentItemRangeReport, error)
	// ListPersonalAgentItemEvents lists an item's timeline, oldest first.
	ListPersonalAgentItemEvents(ctx context.Context, assistantID, itemID string) ([]PersonalAgentItemEvent, error)
	// SweepArchiveFinishedItems archives, as Foundry, the items closed at
	// least after ago with no helper running.
	SweepArchiveFinishedItems(ctx context.Context, now time.Time, after time.Duration) ([]PersonalAgentArchivedItem, error)
	// DuePersonalAgentReminders lists open items of anyone whose reminder
	// is due by now and has not gone out.
	DuePersonalAgentReminders(ctx context.Context, now string) ([]PersonalAgentListItem, error)
	// ClaimPersonalAgentReminder marks the reminder of the item's At gone
	// out; false when it already had.
	ClaimPersonalAgentReminder(ctx context.Context, assistantID, id, at string) (bool, error)
	// ListPersonalAgents lists every person's assistant.
	ListPersonalAgents(ctx context.Context) ([]PersonalAgent, error)
	// ClaimPersonalAgentDigest marks the person's daily digest of day
	// (YYYY-MM-DD) sent; false when it already was.
	ClaimPersonalAgentDigest(ctx context.Context, assistantID, day string) (bool, error)
}

// Routing is an explainable decision for this intent, not an access grant.
type PersonalAgentRouteDecision struct {
	Kind               string   `json:"kind"`
	Reason             string   `json:"reason"`
	Alternatives       []string `json:"alternatives,omitempty"`
	NeedsClarification bool     `json:"needsClarification"`
}
