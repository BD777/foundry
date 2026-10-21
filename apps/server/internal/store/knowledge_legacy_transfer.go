package store

import "context"

// Explicit, reviewed authority transfer. The legacy body is frozen until its
// file receipt commits; completion erases the old body and leaves only a pointer.
type KnowledgeLegacyTransferStore interface {
	TransferPersonalAgentMemory(context.Context, string, string, string, string, string) (KnowledgeMutation, error)
}
