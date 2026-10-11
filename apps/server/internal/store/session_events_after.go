package store

import (
	"context"
	"errors"
)

// ErrEventsCursorGone refuses a catch-up from a cursor that names no event
// of the session: the reader reads the newest window instead.
var ErrEventsCursorGone = errors.New("the cursor names no event of the session")

// SessionEventCatchUpStore lets a reader that missed stream events (a
// reconnect, a resync) read only the events it lacks, rather than reload
// its whole window. Cursors are those of SessionEventWindowStore, in the
// same order.
type SessionEventCatchUpStore interface {
	// AgentSessionEventWindowSpan is AgentSessionEventWindow that also
	// returns the cursor of the window's newest event ("" for an empty
	// window): a reader holding the newest window catches up from it.
	AgentSessionEventWindowSpan(ctx context.Context, sessionID string, before string, limit int) (events []AgentSessionEvent, older, newest string, err error)
	// AgentSessionEventsAfter returns the session's events stored after
	// the cursor, oldest first, and the cursor to catch up from next (the
	// newest returned; after itself when none follow). An event stored
	// again in place, such as a growing answer, sorts after the cursor and
	// is returned again. It is all or nothing: when more than limit events
	// follow it returns none and more, and the reader reads the newest
	// window instead. A cursor it cannot read is ErrInvalidEventsCursor;
	// one that names no event of the session is ErrEventsCursorGone.
	AgentSessionEventsAfter(ctx context.Context, sessionID string, after string, limit int) (events []AgentSessionEvent, newest string, more bool, err error)
}
