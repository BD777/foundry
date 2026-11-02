package store

import (
	"context"
	"time"
)

// SessionEventCompactionStore removes what idle sessions' transcripts
// store more than once, keeping what every reader shows (see
// docs/refactor/storage-compression.md).
type SessionEventCompactionStore interface {
	// CompactSessionEvents compacts the events idle sessions wrote since
	// their last compaction, up to maxSessions sessions (0: all).
	CompactSessionEvents(ctx context.Context, now time.Time, maxSessions int) (SessionEventCompaction, error)
}

// SessionEventCompaction is what one compaction run did.
type SessionEventCompaction struct {
	Sessions  int `json:"sessions"`  // sessions compacted
	Remaining int `json:"remaining"` // idle sessions left when the run stopped early
	Rewritten int `json:"rewritten"` // events stored slim or given a step's usage
	Removed   int `json:"removed"`   // events removed
	Conflicts int `json:"conflicts"` // sessions that changed meanwhile, left for later
}
