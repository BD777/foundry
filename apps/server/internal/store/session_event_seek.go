package store

import "context"

// SessionEventSeekStore finds how far back a transcript reaches a message,
// so a reader opened at one of its messages (a link to it) pages back to
// it in one read instead of a page at a time.
type SessionEventSeekStore interface {
	// AgentSessionEventsThrough counts at least the events a window before
	// the cursor (the newest without one) holds to include the oldest
	// event of message id (an event's message id, or its own id). found is
	// false when no event before the cursor is that message's. A cursor it
	// cannot read is ErrInvalidEventsCursor.
	AgentSessionEventsThrough(ctx context.Context, sessionID string, before string, id string) (count int, found bool, err error)
}
