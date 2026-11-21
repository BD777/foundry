package store

import (
	"context"
	"time"
)

// Signals by item (DEV-324). A helper tied to an item sends its signals (the
// report of an ended turn, a question, an alert, a supervision fact) to
// whoever follows the item: its holder, the session that handed the helper
// its work, or the assistant's conversation. When none of them is reachable,
// the signal waits on the item (PersonalAgentItemSignal) until a session
// claims the item or the assistant's conversation is reachable again; it then
// enters that session's inbox like any other message.

// PersonalAgentItemSignal is a signal waiting on an item for a session that
// follows it.
type PersonalAgentItemSignal struct {
	// ID is the inbox input id the signal is admitted under once it goes out.
	ID          string
	AssistantID string
	ItemID      string
	// SenderSessionID is the helper the signal is from.
	SenderSessionID string
	Prompt          string
	// Delivery is the inbox delivery it asks for (DeliveryTurnEnd, ...).
	Delivery string
	Source   *AgentSessionInputSource
	// MergeKey, when set, makes a newer waiting signal with the same key
	// replace this one: an alert repeated while it waits is one signal.
	MergeKey  string
	CreatedAt time.Time
}

// PersonalAgentItemRef names an item: the assistant whose list holds it and
// its id.
type PersonalAgentItemRef struct {
	AssistantID string
	ItemID      string
}

// PersonalAgentItemSignalStore keeps the items the helpers of sessions other
// than the assistant work on, and the signals waiting on items.
type PersonalAgentItemSignalStore interface {
	// LinkPersonalAgentItemHelper ties a helper a session the person started
	// in a workspace created to an item (create_session or send_message
	// itemId), recording helper_started on the item it joins for actor. The
	// assistant's own helpers are tied through their task (pa_tasks.item_id)
	// instead, which also counts them as its work.
	LinkPersonalAgentItemHelper(ctx context.Context, actor, assistantID, itemID, sessionID string) error
	// PersonalAgentItemOfHelper is the item a helper is tied to by
	// LinkPersonalAgentItemHelper; ErrNotFound for none.
	PersonalAgentItemOfHelper(ctx context.Context, sessionID string) (PersonalAgentItemRef, error)
	// SetPersonalAgentItemHelperStatus follows a linked helper's session: its
	// status (PersonalAgentTaskStatusOf) and, once final, when it ended. Reaching
	// a final status records helper_ended on its item, as Foundry. A session
	// that is no linked helper changes nothing.
	SetPersonalAgentItemHelperStatus(ctx context.Context, sessionID, status, endedAt string) error
	// ListPersonalAgentItemHelpers lists the helpers of an item, oldest first:
	// the assistant's tasks on it (pa_tasks.item_id) and the helpers linked to
	// it (pa_item_helpers), a session once.
	ListPersonalAgentItemHelpers(ctx context.Context, assistantID, itemID string) ([]PersonalAgentTask, error)
	// QueuePersonalAgentItemSignal keeps a signal on its item. One with an id
	// already kept changes nothing; one with a merge key replaces the waiting
	// signals with that key. It reports whether it was kept anew.
	QueuePersonalAgentItemSignal(ctx context.Context, signal PersonalAgentItemSignal) (bool, error)
	// WaitingPersonalAgentItemSignals lists an item's waiting signals, oldest
	// first.
	WaitingPersonalAgentItemSignals(ctx context.Context, assistantID, itemID string) ([]PersonalAgentItemSignal, error)
	// ItemsWithWaitingSignals lists the items that have waiting signals.
	ItemsWithWaitingSignals(ctx context.Context, limit int) ([]PersonalAgentItemRef, error)
	// MarkPersonalAgentItemSignalSent records that a waiting signal went to
	// sessionID; it waits no more.
	MarkPersonalAgentItemSignalSent(ctx context.Context, id, sessionID string, at time.Time) error
}
