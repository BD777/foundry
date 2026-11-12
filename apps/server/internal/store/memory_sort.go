package store

import "context"

// MemorySort is one decision of memory upkeep's sorting between the
// person's layer and one assistant's (DEV-191): an automatic move, which
// the person can undo, or a suggestion to share, which they confirm or
// dismiss. It holds the entry's title and the reviewer's one-sentence
// reason, never the entry's body. Its id is per source entry
// (MemorySortID), so sorting the same entry again finds this record.
type MemorySort struct {
	ID     string `json:"id"`
	UserID string `json:"-"`
	// AssistantID is the assistant whose layer is the other side: the one
	// the entry moved to (person → assistant) or from (assistant → person).
	AssistantID    string   `json:"assistantId"`
	JobID          string   `json:"jobId,omitempty"`
	Kind           string   `json:"kind"`
	Status         string   `json:"status"`
	Reason         string   `json:"reason"`
	FromScope      string   `json:"fromScope"`
	ToScope        string   `json:"toScope"`
	SourceVaultID  string   `json:"sourceVaultId"`
	SourceEntryID  string   `json:"sourceEntryId"`
	SourceRevision int64    `json:"sourceRevision"`
	SourceHash     string   `json:"sourceHash"`
	TargetVaultID  string   `json:"targetVaultId,omitempty"`
	TargetEntryID  string   `json:"targetEntryId,omitempty"`
	Title          string   `json:"title"`
	Judgement      string   `json:"judgement"`
	Confidence     string   `json:"confidence"`
	Mentions       []string `json:"mentions"`
	// Failure is why the last move or undo did not go through (an error
	// code or refusal, never entry text).
	Failure   string `json:"failure,omitempty"`
	CreatedAt string `json:"createdAt"`
	UpdatedAt string `json:"updatedAt"`
}

// Kinds and states of a MemorySort.
const (
	MemorySortMove       = "move"
	MemorySortSuggestion = "suggestion"

	// A move is moving until both writes are captured, then moved; undone
	// once the person moved it back. failed keeps a move that could not be
	// captured; the next sort of the entry retries it.
	MemorySortMoving = "moving"
	MemorySortMoved  = "moved"
	MemorySortFailed = "failed"
	MemorySortUndone = "undone"
	// A suggestion is suggested until the person confirms (the entry moves)
	// or dismisses it.
	MemorySortSuggested = "suggested"
	MemorySortConfirmed = "confirmed"
	MemorySortDismissed = "dismissed"
)

type MemorySortStore interface {
	// RecordMemorySort inserts v unless its id is recorded; either way it
	// answers the stored record and whether it was inserted.
	RecordMemorySort(ctx context.Context, v MemorySort) (MemorySort, bool, error)
	GetMemorySort(ctx context.Context, user, id string) (MemorySort, error)
	// UpdateMemorySort saves v if its stored status is still fromStatus,
	// else ErrPersonalAgentRevision.
	UpdateMemorySort(ctx context.Context, v MemorySort, fromStatus string) (MemorySort, error)
	// ListMemorySorts is user's records, newest first, at most limit.
	ListMemorySorts(ctx context.Context, user string, limit int) ([]MemorySort, error)
	// MovingMemorySorts are moves of any person still in flight, oldest
	// first, at most limit.
	MovingMemorySorts(ctx context.Context, limit int) ([]MemorySort, error)
}
