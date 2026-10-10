package store

import "context"

// SessionInspectionStore answers what an agent asks when it inspects a
// session it was pointed at, beside what Store already reads.
type SessionInspectionStore interface {
	// AgentSessionCreatedAt is when the session was created.
	AgentSessionCreatedAt(ctx context.Context, sessionID string) (string, error)
	// NativeSessionOwner names the Foundry session that owns a native
	// session of a runtime ("" when none does).
	NativeSessionOwner(ctx context.Context, provider, nativeID string) (string, error)
}
