package store

import "context"

// Explicit, reviewed authority transfer. The legacy body is frozen until its
// file receipt commits; completion erases the old body and leaves only a pointer.
//
// The automatic copy (DEV-191 P2) ends the second memory: each confirmed
// legacy fact is copied once into the person's memory layer and the
// pa_memory row stays as it was, read-only, for rollback.
type KnowledgeLegacyTransferStore interface {
	TransferPersonalAgentMemory(context.Context, string, string, string, string, string) (KnowledgeMutation, error)
	// LegacyMemoryToCopy lists confirmed legacy facts (any person) not yet
	// copied or transferred, oldest first, at most limit.
	LegacyMemoryToCopy(ctx context.Context, limit int) ([]PersonalAgentMemoryItem, error)
	// CopyLegacyMemory queues item's copy into the memory vault vaultID once;
	// a replay answers the first copy's job.
	CopyLegacyMemory(ctx context.Context, item PersonalAgentMemoryItem, vaultID string) (KnowledgeMutation, error)
	// LegacyMemoryCopies is the copy or transfer status of each of user's
	// legacy facts that has one (copying, copied, pending, complete,
	// forgetting).
	LegacyMemoryCopies(ctx context.Context, user string) (map[string]string, error)
}
