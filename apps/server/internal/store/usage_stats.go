package store

import (
	"context"
	"time"
)

// Usage entry classes are fixed when a turn is written, from the session's
// source, role and parent.
const (
	UsageEntryChat            = "chat"
	UsageEntryChatChild       = "chat_child"
	UsageEntryAssistant       = "assistant"
	UsageEntryAssistantHelper = "assistant_helper"
	UsageEntryIssue           = "issue"
	UsageEntryUtility         = "utility"
)

// Usage outcomes and cost sources are fixed vocabularies in usage_turns.
const (
	UsageOutcomeCompleted = "completed"
	UsageOutcomeFailed    = "failed"
	UsageOutcomeCanceled  = "canceled"

	UsageCostReported  = "reported"
	UsageCostEstimated = "estimated"
	UsageCostCustom    = "custom"
	UsageCostUnknown   = "unknown"
)

// UsageTurn is one session input's recorded usage. UsageReported is not a
// database column: false means only terminal outcome information is being
// added, so an existing turn's usage fields stay unchanged.
type UsageTurn struct {
	UsageReported bool
	Backfill      bool

	SessionID       string
	InputID         string
	UserID          string
	WorkspaceID     string
	DeviceID        string
	ParentSessionID string
	Entry           string

	Runtime        string
	ProfileID      string
	ProviderLabel  string
	RequestedModel string
	Model          string

	StartedAt        string
	EndedAt          string
	DurationMs       int64
	ModelMs          int64
	TtftMs           int64
	TimingEstimated  bool
	InputTokens      int64
	CacheReadTokens  int64
	CacheWriteTokens int64
	OutputTokens     int64
	ReasoningTokens  int64
	ModelRequests    int64

	CostUSD    float64
	CostSource string

	Outcome    string
	ErrorClass string
}

// UsageRequest is one Claude model request, denormalised with its session's
// dimensions so a 90-day detail query need not join usage_turns.
type UsageRequest struct {
	Backfill bool

	RequestID string

	SessionID       string
	InputID         string
	UserID          string
	WorkspaceID     string
	DeviceID        string
	ParentSessionID string
	Entry           string
	At              string

	Runtime        string
	ProfileID      string
	ProviderLabel  string
	RequestedModel string
	Model          string

	InputTokens      int64
	CacheReadTokens  int64
	CacheWriteTokens int64
	OutputTokens     int64

	FirstTokenMs int64
	GenerationMs int64
	RequestMs    int64

	TimingEstimated bool
}

// UsageBackfillState is the one-time historical scan's durable cursor.
type UsageBackfillState struct {
	Cursor    string
	Completed bool
}

// UsageRepriceCursor continues a scan ordered by start time and turn identity.
type UsageRepriceCursor struct {
	StartedAt string
	SessionID string
	InputID   string
}

// UsageStatsFilter narrows both turn aggregates and request detail reads.
type UsageStatsFilter struct {
	From        time.Time
	To          time.Time
	UserID      string
	Entry       string
	DeviceID    string
	WorkspaceID string
	Provider    string
	Model       string
	Runtime     string
}

// UsageTurnAggregateQuery groups turn facts into hour/day buckets.
type UsageTurnAggregateQuery struct {
	UsageStatsFilter
	Granularity string
	GroupBy     []string
}

// UsageTurnAggregate is one SQL aggregate row.
type UsageTurnAggregate struct {
	Bucket      string
	UserID      string
	Entry       string
	DeviceID    string
	WorkspaceID string
	Provider    string
	Model       string
	Runtime     string

	Turns            int64
	DurationMs       int64
	InputTokens      int64
	CacheReadTokens  int64
	CacheWriteTokens int64
	OutputTokens     int64
	ReasoningTokens  int64
	ModelRequests    int64
	CostUSD          float64

	ReportedTurns    int64
	EstimatedTurns   int64
	CustomTurns      int64
	UnknownTurns     int64
	ReportedCostUSD  float64
	EstimatedCostUSD float64
	CustomCostUSD    float64
	UnknownCostUSD   float64
}

// UsageRequestRowQuery reads request detail needed for throughput and TTFT
// percentiles.
type UsageRequestRowQuery struct {
	UsageStatsFilter
	Granularity string
	GroupBy     []string
}

// UsageRequestRow is one request detail row with its bucket dimensions.
type UsageRequestRow struct {
	Bucket      string
	UserID      string
	Entry       string
	DeviceID    string
	WorkspaceID string
	Provider    string
	Model       string
	Runtime     string

	OutputTokens int64
	GenerationMs int64
	FirstTokenMs int64
}

// UsageRecord is the usage extracted from one event. The SQLite store writes
// it in one transaction; a turn changes usage_daily, requests do not.
type UsageRecord struct {
	Turn     *UsageTurn
	Requests []UsageRequest
}

// UsageStatsStore keeps usage facts and the permanent daily rollup.
type UsageStatsStore interface {
	// RecordUsage writes the record atomically and idempotently.
	RecordUsage(ctx context.Context, record UsageRecord) error
	// UsageContextModel returns the newest context model in the input's turn.
	UsageContextModel(ctx context.Context, sessionID, inputID string) (string, error)
	// DeleteUsageRequestsBefore removes request detail, never turns or daily
	// aggregates, older than before.
	DeleteUsageRequestsBefore(ctx context.Context, before time.Time) (int64, error)
	// UsageBackfillState reads the durable historical scan cursor.
	UsageBackfillState(ctx context.Context) (UsageBackfillState, error)
	// UsageBackfillSessionIDs returns the next session ids after the cursor.
	UsageBackfillSessionIDs(ctx context.Context, after string, limit int) ([]string, error)
	// UsageSessionEvents returns the input boundaries and usage/context events
	// needed to rebuild one session's turns and requests.
	UsageSessionEvents(ctx context.Context, sessionID string) ([]AgentSessionEvent, error)
	// SaveUsageBackfillState advances the historical scan.
	SaveUsageBackfillState(ctx context.Context, cursor string, completed bool) error
	// UsageTurnsForReprice returns the next turns in a stable order.
	UsageTurnsForReprice(ctx context.Context, after UsageRepriceCursor, limit int) ([]UsageTurn, UsageRepriceCursor, error)
	// UpdateUsageCost changes only a non-reported turn's cost and source.
	UpdateUsageCost(ctx context.Context, sessionID, inputID string, costUSD float64, source string) (bool, error)
	// UsageTurnAggregates reads turn aggregates for the query API.
	UsageTurnAggregates(ctx context.Context, query UsageTurnAggregateQuery) ([]UsageTurnAggregate, error)
	// UsageRequestRows reads request detail for throughput/TTFT percentiles.
	UsageRequestRows(ctx context.Context, query UsageRequestRowQuery) ([]UsageRequestRow, error)
}
