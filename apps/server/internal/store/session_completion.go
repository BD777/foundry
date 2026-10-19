package store

import "context"

// SessionInputCompletionStore fences a device's completion against the input
// being settled in the same transaction as the write. A replay can arrive after
// the person has already started another input on the same session.
// An applied result's Events holds only an answer event synthesized from the
// persisted completion, when one was needed; callers stream it to live readers.
type SessionInputCompletionStore interface {
	SettleAgentSessionInput(ctx context.Context, sessionID, inputID, response, nativeSessionID, failure string) (AgentSession, bool, error)
}
