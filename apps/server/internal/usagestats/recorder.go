package usagestats

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

const (
	// RequestRetention is the life of usage_requests detail rows.
	RequestRetention = 90 * 24 * time.Hour
	// RetentionSweepInterval is how often the server removes expired request
	// detail.
	RetentionSweepInterval = 24 * time.Hour
)

// Store is what the recorder needs from storage. The SQLite store implements
// it, including when the store is scoped to the event's transaction.
type Store interface {
	store.UsageStatsStore
	store.SessionEventWindowStore
	GetAgentSessionSummary(ctx context.Context, id string) (store.AgentSession, error)
	GetProfile(ctx context.Context, id string) (store.ProfileDefinition, error)
}

// Recorder extracts usage facts from persisted session events and writes them
// through the usage store. It owns no state, so retries are idempotent in the
// database rather than in memory.
type Recorder struct {
	store  Store
	roleOf RoleResolver
	prices *PriceCatalog
	Now    func() time.Time
}

// RoleResolver returns the session's effective role, including the assistant's
// implicit personal_agent role for conversations whose stored role is empty.
type RoleResolver func(context.Context, store.AgentSession) string

func New(st Store, roleOf RoleResolver) *Recorder {
	prices, _ := newEmbeddedPriceCatalog()
	return &Recorder{store: st, roleOf: roleOf, prices: prices, Now: time.Now}
}

// Record extracts turn and request usage from event. A failed or canceled
// session with no turn report writes a zero-token terminal row. All writes are
// idempotent, including a later terminal update of a turn already reported.
func (r *Recorder) Record(ctx context.Context, session store.AgentSession, event store.AgentSessionEvent) error {
	if session.ID == "" || session.Input.ID == "" {
		return nil
	}
	hasTurn := event.Metadata != nil && event.Metadata.TurnUsage != nil
	hasRequest := event.Metadata != nil && event.Metadata.RequestUsage != nil
	if !hasTurn && !hasRequest && !terminalWithoutUsage(session) {
		return nil
	}
	at := event.At
	if at == "" {
		at = session.CompletedAt
	}
	if at == "" {
		at = formatTime(r.Now())
	}
	event.At = at

	entry, err := ClassifyEntry(ctx, session, r.store, r.roleOf)
	if err != nil {
		return err
	}
	model, err := r.modelForTurn(ctx, session, event)
	if err != nil {
		return err
	}

	record := store.UsageRecord{}
	if hasTurn {
		record.Turn = turnFromEvent(session, event, entry, model)
	}
	if hasRequest {
		record.Requests = append(record.Requests, requestFromEvent(session, event, entry, model))
	}
	if record.Turn == nil && record.Requests == nil && terminalWithoutUsage(session) {
		record.Turn = terminalTurn(session, event, entry, model)
	}
	if record.Turn == nil && len(record.Requests) == 0 {
		return nil
	}
	r.applyCost(ctx, record.Turn)
	return r.store.RecordUsage(ctx, record)
}

// RefreshPrices tries to replace the LiteLLM snapshot. A failed fetch or an
// invalid document leaves the current catalog untouched.
func (r *Recorder) RefreshPrices(ctx context.Context, source string) error {
	if r == nil || r.prices == nil {
		return errors.New("price catalog is unavailable")
	}
	return r.prices.Refresh(ctx, source)
}

// applyCost implements the recorded cost priority: reported, custom,
// LiteLLM estimated, then unknown. Custom prices belong to the provider
// profile that served the turn, never to a model name shared by every
// provider.
func (r *Recorder) applyCost(ctx context.Context, turn *store.UsageTurn) {
	if r == nil || turn == nil || !turn.UsageReported || turn.CostSource == store.UsageCostReported {
		return
	}
	tokens := usageTokens{
		input:      turn.InputTokens,
		cacheRead:  turn.CacheReadTokens,
		cacheWrite: turn.CacheWriteTokens,
		output:     turn.OutputTokens,
	}
	if tokens.empty() || strings.TrimSpace(turn.Model) == "" {
		turn.CostUSD = 0
		turn.CostSource = store.UsageCostUnknown
		return
	}
	if turn.ProfileID != "" {
		profile, err := r.store.GetProfile(ctx, turn.ProfileID)
		if err == nil {
			if price, ok := customModelPrice(profile.ModelPrices, turn.Model); ok {
				if cost, ok := costForTokens(price, tokens); ok {
					turn.CostUSD = cost
					turn.CostSource = store.UsageCostCustom
					return
				}
			}
		}
	}
	if r.prices != nil {
		if price, ok := r.prices.lookup(turn.Model); ok {
			if cost, ok := costForTokens(price, tokens); ok {
				turn.CostUSD = cost
				turn.CostSource = store.UsageCostEstimated
				return
			}
		}
	}
	turn.CostUSD = 0
	turn.CostSource = store.UsageCostUnknown
}

// DeleteExpiredRequests applies the 90-day request detail retention.
func (r *Recorder) DeleteExpiredRequests(ctx context.Context) (int64, error) {
	return r.store.DeleteUsageRequestsBefore(ctx, r.Now().Add(-RequestRetention))
}

// SessionLookup is the parent reader entry classification needs.
type SessionLookup interface {
	GetAgentSessionSummary(ctx context.Context, id string) (store.AgentSession, error)
}

// ClassifyEntry assigns the fixed usage entry class for a session.
func ClassifyEntry(ctx context.Context, session store.AgentSession, sessions SessionLookup, roleOf RoleResolver) (string, error) {
	role := resolveRole(ctx, session, roleOf)
	switch {
	case role == store.AgentSessionRolePersonalAgent:
		return store.UsageEntryAssistant, nil
	case session.IssueID != "" ||
		role == store.AgentSessionRoleIssueExecution ||
		role == store.AgentSessionRoleIssueClarification ||
		session.Source == store.SessionSourceIssue:
		return store.UsageEntryIssue, nil
	}

	var parent store.AgentSession
	if session.ParentSessionID != "" {
		var err error
		parent, err = sessions.GetAgentSessionSummary(ctx, session.ParentSessionID)
		if err != nil && !errors.Is(err, store.ErrNotFound) {
			return "", err
		}
		parentRole := resolveRole(ctx, parent, roleOf)
		if parentRole == store.AgentSessionRolePersonalAgent {
			return store.UsageEntryAssistantHelper, nil
		}
		if parent.ID != "" && (parent.IssueID != "" ||
			parentRole == store.AgentSessionRoleIssueExecution ||
			parentRole == store.AgentSessionRoleIssueClarification ||
			parent.Source == store.SessionSourceIssue) {
			return store.UsageEntryIssue, nil
		}
	}

	if session.Source == store.SessionSourceVerification {
		// A standalone verifier is utility; one attached to an Issue was
		// classified above through its Issue fields or parent.
		return store.UsageEntryUtility, nil
	}
	if store.IsUtilitySessionSource(session.Source) {
		return store.UsageEntryUtility, nil
	}
	if session.ParentSessionID != "" {
		return store.UsageEntryChatChild, nil
	}
	switch session.Source {
	case "", store.SessionSourceChat:
		return store.UsageEntryChat, nil
	case store.SessionSourceAgent:
		return store.UsageEntryUtility, nil
	default:
		return store.UsageEntryUtility, nil
	}
}

func turnFromEvent(session store.AgentSession, event store.AgentSessionEvent, entry, model string) *store.UsageTurn {
	usage := event.Metadata.TurnUsage
	if usage.Model != "" {
		model = usage.Model
	}
	startedAt := session.StartedAt
	if startedAt == "" {
		startedAt = event.At
	}
	duration := usage.DurationMs
	if duration == 0 {
		duration = elapsedMs(startedAt, event.At)
	}
	turn := &store.UsageTurn{
		UsageReported:    true,
		SessionID:        session.ID,
		InputID:          session.Input.ID,
		UserID:           session.CreatedByUserID,
		WorkspaceID:      session.WorkspaceID,
		DeviceID:         session.DeviceID,
		ParentSessionID:  session.ParentSessionID,
		Entry:            entry,
		Runtime:          string(session.Provider),
		ProfileID:        session.ProfileID,
		ProviderLabel:    session.ProfileLabel,
		RequestedModel:   session.Model,
		Model:            model,
		StartedAt:        startedAt,
		EndedAt:          event.At,
		DurationMs:       duration,
		ModelMs:          usage.ModelMs,
		TtftMs:           usage.TtftMs,
		TimingEstimated:  usage.TimingEstimated,
		InputTokens:      usage.InputTokens,
		CacheReadTokens:  usage.CacheReadTokens,
		CacheWriteTokens: usage.CacheWriteTokens,
		OutputTokens:     usage.OutputTokens,
		ReasoningTokens:  int64Value(usage.ReasoningTokens),
		ModelRequests:    int64Value(usage.ModelRequests),
		Outcome:          store.UsageOutcomeCompleted,
	}
	if usage.CostUSD != nil {
		turn.CostUSD = *usage.CostUSD
		turn.CostSource = store.UsageCostReported
	} else {
		turn.CostSource = store.UsageCostUnknown
	}
	switch usage.Outcome {
	case store.UsageOutcomeCompleted, store.UsageOutcomeFailed, store.UsageOutcomeCanceled:
		turn.Outcome = usage.Outcome
		if turn.Outcome != store.UsageOutcomeCompleted {
			turn.ErrorClass = errorClass(session, event)
		}
	case "":
		if event.Level == "error" || session.Status == "failed" {
			turn.Outcome = store.UsageOutcomeFailed
			turn.ErrorClass = errorClass(session, event)
		} else if session.Status == "canceled" {
			turn.Outcome = store.UsageOutcomeCanceled
			turn.ErrorClass = errorClass(session, event)
		}
	default:
		turn.Outcome = store.UsageOutcomeFailed
		turn.ErrorClass = errorClass(session, event)
	}
	return turn
}

func requestFromEvent(session store.AgentSession, event store.AgentSessionEvent, entry, model string) store.UsageRequest {
	usage := event.Metadata.RequestUsage
	if usage.Model != "" {
		model = usage.Model
	}
	return store.UsageRequest{
		RequestID:        usage.RequestID,
		SessionID:        session.ID,
		InputID:          session.Input.ID,
		UserID:           session.CreatedByUserID,
		WorkspaceID:      session.WorkspaceID,
		DeviceID:         session.DeviceID,
		ParentSessionID:  session.ParentSessionID,
		Entry:            entry,
		At:               event.At,
		Runtime:          string(session.Provider),
		ProfileID:        session.ProfileID,
		ProviderLabel:    session.ProfileLabel,
		RequestedModel:   session.Model,
		Model:            model,
		InputTokens:      usage.InputTokens,
		CacheReadTokens:  usage.CacheReadTokens,
		CacheWriteTokens: usage.CacheWriteTokens,
		OutputTokens:     usage.OutputTokens,
		FirstTokenMs:     usage.FirstTokenMs,
		GenerationMs:     usage.GenerationMs,
		RequestMs:        usage.RequestMs,
		TimingEstimated:  usage.TimingEstimated,
	}
}

func terminalWithoutUsage(session store.AgentSession) bool {
	return session.Status == "failed" || session.Status == "canceled"
}

func terminalTurn(session store.AgentSession, event store.AgentSessionEvent, entry, model string) *store.UsageTurn {
	startedAt := session.StartedAt
	if startedAt == "" {
		startedAt = event.At
	}
	outcome := store.UsageOutcomeCompleted
	if session.Status == "failed" {
		outcome = store.UsageOutcomeFailed
	} else if session.Status == "canceled" {
		outcome = store.UsageOutcomeCanceled
	}
	return &store.UsageTurn{
		SessionID:       session.ID,
		InputID:         session.Input.ID,
		UserID:          session.CreatedByUserID,
		WorkspaceID:     session.WorkspaceID,
		DeviceID:        session.DeviceID,
		ParentSessionID: session.ParentSessionID,
		Entry:           entry,
		Runtime:         string(session.Provider),
		ProfileID:       session.ProfileID,
		ProviderLabel:   session.ProfileLabel,
		RequestedModel:  session.Model,
		Model:           model,
		StartedAt:       startedAt,
		EndedAt:         event.At,
		DurationMs:      elapsedMs(startedAt, event.At),
		CostSource:      store.UsageCostUnknown,
		Outcome:         outcome,
		ErrorClass:      errorClass(session, event),
	}
}

func (r *Recorder) modelForTurn(ctx context.Context, session store.AgentSession, event store.AgentSessionEvent) (string, error) {
	if event.Metadata != nil && event.Metadata.TurnUsage != nil && event.Metadata.TurnUsage.Model != "" {
		return event.Metadata.TurnUsage.Model, nil
	}
	if event.Metadata != nil && event.Metadata.RequestUsage != nil && event.Metadata.RequestUsage.Model != "" {
		return event.Metadata.RequestUsage.Model, nil
	}
	if event.Metadata != nil && event.Metadata.ContextUsage != nil && event.Metadata.ContextUsage.Model != "" {
		return event.Metadata.ContextUsage.Model, nil
	}
	model, err := r.store.UsageContextModel(ctx, session.ID, session.Input.ID)
	if err != nil {
		return "", err
	}
	if model != "" {
		return model, nil
	}
	return session.Model, nil
}

func resolveRole(ctx context.Context, session store.AgentSession, roleOf RoleResolver) string {
	if roleOf != nil {
		return roleOf(ctx, session)
	}
	return session.Role
}

func errorClass(session store.AgentSession, event store.AgentSessionEvent) string {
	if event.Metadata != nil && event.Metadata.WorkerFailure != nil && event.Metadata.WorkerFailure.Code != "" {
		return string(event.Metadata.WorkerFailure.Code)
	}
	errorText := strings.ToLower(strings.TrimSpace(session.Error))
	switch {
	case strings.Contains(errorText, "rate limit"):
		return "rate_limited"
	case strings.Contains(errorText, "permission"):
		return "permission_denied"
	case strings.Contains(errorText, "timeout") || strings.Contains(errorText, "timed out"):
		return "timeout"
	case strings.Contains(errorText, "cancel"):
		return "canceled"
	case session.Status == "failed":
		return "failed"
	case session.Status == "canceled":
		return "canceled"
	default:
		return ""
	}
}

func int64Value(value *int64) int64 {
	if value == nil {
		return 0
	}
	return *value
}

func elapsedMs(startedAt, endedAt string) int64 {
	start, err := time.Parse(time.RFC3339Nano, startedAt)
	if err != nil {
		return 0
	}
	end, err := time.Parse(time.RFC3339Nano, endedAt)
	if err != nil || end.Before(start) {
		return 0
	}
	return end.Sub(start).Milliseconds()
}

func formatTime(value time.Time) string {
	return value.UTC().Format(time.RFC3339Nano)
}
