package store

import (
	"context"
	"errors"
	"time"
)

var ErrWorkerGroupNotFound = errors.New("worker group not found")

// StoredWorkerGroup is a person's named group of models, each on its own
// provider, that workers are assigned from. Cursor is private allocation
// state for groups without TPM limits.
type StoredWorkerGroup struct {
	ID          string              `json:"id"`
	OwnerUserID string              `json:"-"`
	Label       string              `json:"label"`
	Members     []WorkerGroupMember `json:"members"`
	Cursor      int                 `json:"-"`
	CreatedAt   string              `json:"createdAt"`
	UpdatedAt   string              `json:"updatedAt"`
}

type WorkerGroupStore interface {
	ListWorkerGroups(ctx context.Context, ownerUserID string) ([]StoredWorkerGroup, error)
	GetWorkerGroup(ctx context.Context, id string) (StoredWorkerGroup, error)
	SaveWorkerGroup(ctx context.Context, group StoredWorkerGroup) (StoredWorkerGroup, error)
	DeleteWorkerGroup(ctx context.Context, id, ownerUserID string) error
	// AdvanceWorkerGroupCursor atomically reserves the next weighted slot and
	// returns its zero-based cursor.
	AdvanceWorkerGroupCursor(ctx context.Context, id string, memberCount int) (int, error)
	// RecentModelTokens sums model requests from since, using a turn's totals
	// only when that input has no request rows.
	RecentModelTokens(ctx context.Context, since time.Time, ownerUserID, profileID, runtime string, models []string) (map[string]int64, error)
}

const (
	SessionRetryPending     = "pending"
	SessionRetryDispatching = "dispatching"
	SessionRetryRunning     = "running"
	SessionRetryResolved    = "resolved"
	SessionRetryExhausted   = "exhausted"
	SessionRetryCanceled    = "canceled"
)

// SessionRetry is the durable state for one input's automatic model retry.
// Attempt is the number of retries already started (0 before the first one).
type SessionRetry struct {
	SessionID     string    `json:"sessionId"`
	InputID       string    `json:"inputId"`
	Attempt       int       `json:"attempt"`
	MaxAttempts   int       `json:"maxAttempts"`
	PreviousModel string    `json:"previousModel,omitempty"`
	NextModel     string    `json:"nextModel,omitempty"`
	Status        string    `json:"status"`
	NextAttemptAt time.Time `json:"nextAttemptAt"`
	LastError     string    `json:"lastError,omitempty"`
	CreatedAt     time.Time `json:"createdAt"`
	UpdatedAt     time.Time `json:"updatedAt"`
}

type SessionRetryStore interface {
	GetSessionRetry(ctx context.Context, sessionID, inputID string) (SessionRetry, bool, error)
	DueSessionRetries(ctx context.Context, now time.Time, limit int) ([]SessionRetry, error)
	// ScheduleAgentSessionRetry writes the retry and blocks the still-current
	// input in one transaction.
	ScheduleAgentSessionRetry(ctx context.Context, retry SessionRetry, blockedReason string) (AgentSession, error)
	// ClaimAgentSessionRetry moves a due retry to queued with its next model.
	ClaimAgentSessionRetry(ctx context.Context, retry SessionRetry, nextAttemptAt time.Time) (AgentSession, error)
	// UpdateSessionRetry changes only retry state; an unknown row is ignored.
	UpdateSessionRetry(ctx context.Context, sessionID, inputID, status, detail string, at time.Time) error
}
