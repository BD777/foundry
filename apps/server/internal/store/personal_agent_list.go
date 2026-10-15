package store

import "context"

// The person's list (docs/personal-agent.md §6): what they told their
// assistant they plan to do, are doing or have done, in their own words,
// kept by the server beside the assistant's own tasks (pa_tasks, the work
// it handed off). The assistant writes it with update_list, grounded in
// what the person wrote; the person ticks, edits and deletes items on the
// assistant's home page. An open item with a time and Remind set is a
// reminder: at that time the server tells the assistant, which tells the
// person (personal_agent_list.go in httpapi). Same JSON names as
// packages/protocol/src/personal-agent-list.ts.

// List item statuses.
const (
	PersonalAgentItemOpen    = "open"
	PersonalAgentItemDone    = "done"
	PersonalAgentItemDropped = "dropped"
)

// PersonalAgentListItem is one thing on the person's list (table pa_items).
type PersonalAgentListItem struct {
	ID     string `json:"id"`
	UserID string `json:"-"`
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
	// Quote is the person's words the item rests on.
	Quote string `json:"quote,omitempty"`
	// TaskID is the assistant's task helping with it (pa_tasks).
	TaskID          string `json:"taskId,omitempty"`
	SourceSessionID string `json:"sourceSessionId,omitempty"`
	CreatedAt       string `json:"createdAt"`
	UpdatedAt       string `json:"updatedAt"`
	// ClosedAt is when it was done or dropped.
	ClosedAt string `json:"closedAt,omitempty"`
	// RemindedAt is when the reminder for At went out.
	RemindedAt string `json:"remindedAt,omitempty"`
}

// PersonalAgentListItemInput is the person's edit of an item on the web;
// absent fields stay as they are.
type PersonalAgentListItemInput struct {
	Text   *string `json:"text,omitempty"`
	When   *string `json:"when,omitempty"`
	Status *string `json:"status,omitempty"`
}

// PersonalAgentListStore keeps the person's list and the daily digest's
// mark. Every call is scoped to one person (userID) but the due scans.
type PersonalAgentListStore interface {
	// ListPersonalAgentItems lists the person's open items and those
	// closed since closedSince ("" for none), oldest first.
	ListPersonalAgentItems(ctx context.Context, userID, closedSince string) ([]PersonalAgentListItem, error)
	GetPersonalAgentItem(ctx context.Context, userID, id string) (PersonalAgentListItem, error)
	AddPersonalAgentItem(ctx context.Context, item PersonalAgentListItem) (PersonalAgentListItem, error)
	// SavePersonalAgentItem stores an item's fields as given; a new At
	// clears RemindedAt.
	SavePersonalAgentItem(ctx context.Context, item PersonalAgentListItem) (PersonalAgentListItem, error)
	DeletePersonalAgentItem(ctx context.Context, userID, id string) error
	// DuePersonalAgentReminders lists open items of anyone whose reminder
	// is due by now and has not gone out.
	DuePersonalAgentReminders(ctx context.Context, now string) ([]PersonalAgentListItem, error)
	// ClaimPersonalAgentReminder marks the reminder of the item's At gone
	// out; false when it already had.
	ClaimPersonalAgentReminder(ctx context.Context, userID, id, at string) (bool, error)
	// ListPersonalAgents lists every person's assistant.
	ListPersonalAgents(ctx context.Context) ([]PersonalAgent, error)
	// ClaimPersonalAgentDigest marks the person's daily digest of day
	// (YYYY-MM-DD) sent; false when it already was.
	ClaimPersonalAgentDigest(ctx context.Context, userID, day string) (bool, error)
}
