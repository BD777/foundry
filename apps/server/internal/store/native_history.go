package store

import "context"

// NativeHistory is how far back a session that continued a device's native
// chat holds that chat's history: the chat's log before byte Before is not
// imported yet (0 when all of it is). Provider and NativeSessionID name the
// log, DeviceID the device that has it.
type NativeHistory struct {
	Provider        string
	NativeSessionID string
	DeviceID        string
	Before          int64
}

// NativeHistoryStore imports a continued native chat's earlier history a
// page at a time, as someone scrolls back to it.
type NativeHistoryStore interface {
	// SessionNativeHistory is the session's native history not imported
	// yet; found is false when there is none.
	SessionNativeHistory(ctx context.Context, sessionID string) (history NativeHistory, found bool, err error)
	// ImportNativeHistory stores the page of the log that ends at
	// history.Before as the session's oldest events, and records that
	// the log before next is what remains. A page already imported (the
	// session's history no longer ends at history.Before) is ignored.
	ImportNativeHistory(ctx context.Context, sessionID string, history NativeHistory, page []TranscriptMessage, next int64) error
	// AgentSessionOldestEventCursor is the cursor of the session's oldest
	// event ("" when it has none), from which older events are read.
	AgentSessionOldestEventCursor(ctx context.Context, sessionID string) (string, error)
}
