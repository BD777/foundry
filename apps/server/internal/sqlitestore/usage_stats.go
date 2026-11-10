package sqlitestore

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

var _ store.UsageStatsStore = (*Store)(nil)

func (s *Store) setupUsageStats(ctx context.Context) error {
	statements := []string{
		`CREATE TABLE IF NOT EXISTS usage_turns (
			session_id TEXT NOT NULL,
			input_id TEXT NOT NULL,
			user_id TEXT NOT NULL DEFAULT '',
			workspace_id TEXT NOT NULL DEFAULT '',
			device_id TEXT NOT NULL DEFAULT '',
			parent_session_id TEXT NOT NULL DEFAULT '',
			entry TEXT NOT NULL CHECK (entry IN ('chat', 'chat_child', 'assistant', 'assistant_helper', 'issue', 'utility')),
			runtime TEXT NOT NULL DEFAULT '',
			profile_id TEXT NOT NULL DEFAULT '',
			provider_label TEXT NOT NULL DEFAULT '',
			requested_model TEXT NOT NULL DEFAULT '',
			model TEXT NOT NULL DEFAULT '',
			started_at TEXT NOT NULL,
			ended_at TEXT NOT NULL,
			duration_ms INTEGER NOT NULL DEFAULT 0,
			model_ms INTEGER NOT NULL DEFAULT 0,
			ttft_ms INTEGER NOT NULL DEFAULT 0,
			timing_estimated INTEGER NOT NULL DEFAULT 0,
			input_tokens INTEGER NOT NULL DEFAULT 0,
			cache_read_tokens INTEGER NOT NULL DEFAULT 0,
			cache_write_tokens INTEGER NOT NULL DEFAULT 0,
			output_tokens INTEGER NOT NULL DEFAULT 0,
			reasoning_tokens INTEGER NOT NULL DEFAULT 0,
			model_requests INTEGER NOT NULL DEFAULT 0,
			cost_usd REAL NOT NULL DEFAULT 0,
			cost_source TEXT NOT NULL CHECK (cost_source IN ('reported', 'estimated', 'custom', 'unknown')),
			outcome TEXT NOT NULL CHECK (outcome IN ('completed', 'failed', 'canceled')),
			error_class TEXT NOT NULL DEFAULT '',
			UNIQUE (session_id, input_id)
		)`,
		`CREATE TABLE IF NOT EXISTS usage_requests (
			request_id TEXT PRIMARY KEY,
			session_id TEXT NOT NULL,
			input_id TEXT NOT NULL,
			user_id TEXT NOT NULL DEFAULT '',
			workspace_id TEXT NOT NULL DEFAULT '',
			device_id TEXT NOT NULL DEFAULT '',
			parent_session_id TEXT NOT NULL DEFAULT '',
			entry TEXT NOT NULL CHECK (entry IN ('chat', 'chat_child', 'assistant', 'assistant_helper', 'issue', 'utility')),
			at TEXT NOT NULL,
			runtime TEXT NOT NULL DEFAULT '',
			profile_id TEXT NOT NULL DEFAULT '',
			provider_label TEXT NOT NULL DEFAULT '',
			requested_model TEXT NOT NULL DEFAULT '',
			model TEXT NOT NULL DEFAULT '',
			input_tokens INTEGER NOT NULL DEFAULT 0,
			cache_read_tokens INTEGER NOT NULL DEFAULT 0,
			cache_write_tokens INTEGER NOT NULL DEFAULT 0,
			output_tokens INTEGER NOT NULL DEFAULT 0,
			first_token_ms INTEGER NOT NULL DEFAULT 0,
			generation_ms INTEGER NOT NULL DEFAULT 0,
			request_ms INTEGER NOT NULL DEFAULT 0,
			timing_estimated INTEGER NOT NULL DEFAULT 0
		)`,
		`CREATE TABLE IF NOT EXISTS usage_daily (
			day TEXT NOT NULL,
			user_id TEXT NOT NULL DEFAULT '',
			entry TEXT NOT NULL CHECK (entry IN ('chat', 'chat_child', 'assistant', 'assistant_helper', 'issue', 'utility')),
			device_id TEXT NOT NULL DEFAULT '',
			workspace_id TEXT NOT NULL DEFAULT '',
			runtime TEXT NOT NULL DEFAULT '',
			profile_id TEXT NOT NULL DEFAULT '',
			model TEXT NOT NULL DEFAULT '',
			turn_count INTEGER NOT NULL DEFAULT 0,
			completed_count INTEGER NOT NULL DEFAULT 0,
			failed_count INTEGER NOT NULL DEFAULT 0,
			canceled_count INTEGER NOT NULL DEFAULT 0,
			duration_ms INTEGER NOT NULL DEFAULT 0,
			model_ms INTEGER NOT NULL DEFAULT 0,
			ttft_ms INTEGER NOT NULL DEFAULT 0,
			input_tokens INTEGER NOT NULL DEFAULT 0,
			cache_read_tokens INTEGER NOT NULL DEFAULT 0,
			cache_write_tokens INTEGER NOT NULL DEFAULT 0,
			output_tokens INTEGER NOT NULL DEFAULT 0,
			reasoning_tokens INTEGER NOT NULL DEFAULT 0,
			model_requests INTEGER NOT NULL DEFAULT 0,
			cost_usd REAL NOT NULL DEFAULT 0,
			PRIMARY KEY (day, user_id, entry, device_id, workspace_id, runtime, profile_id, model)
		)`,
		`CREATE TABLE IF NOT EXISTS usage_backfill (
			id INTEGER PRIMARY KEY CHECK (id = 1),
			cursor TEXT NOT NULL DEFAULT '',
			completed INTEGER NOT NULL DEFAULT 0,
			updated_at TEXT NOT NULL DEFAULT ''
		)`,
		`CREATE INDEX IF NOT EXISTS idx_usage_turns_user_started ON usage_turns(user_id, started_at)`,
		`CREATE INDEX IF NOT EXISTS idx_usage_turns_started ON usage_turns(started_at)`,
		`CREATE INDEX IF NOT EXISTS idx_usage_turns_dimensions ON usage_turns(started_at, user_id, entry, device_id, workspace_id, runtime, profile_id, model)`,
		`CREATE INDEX IF NOT EXISTS idx_usage_requests_at ON usage_requests(at)`,
		`CREATE INDEX IF NOT EXISTS idx_usage_daily_user_day ON usage_daily(user_id, day)`,
	}
	for _, statement := range statements {
		if _, err := s.conn().ExecContext(ctx, statement); err != nil {
			return fmt.Errorf("migrate sqlite usage stats: %w", err)
		}
	}
	return nil
}

const usageTurnColumns = `session_id, input_id, user_id, workspace_id, device_id, parent_session_id, entry,
	runtime, profile_id, provider_label, requested_model, model, started_at, ended_at, duration_ms, model_ms,
	ttft_ms, timing_estimated, input_tokens, cache_read_tokens, cache_write_tokens, output_tokens,
	reasoning_tokens, model_requests, cost_usd, cost_source, outcome, error_class`

func (s *Store) RecordUsage(ctx context.Context, record store.UsageRecord) error {
	return s.withTx(ctx, func(tx *Store) error {
		for _, request := range record.Requests {
			if request.RequestID == "" {
				continue
			}
			if err := tx.recordUsageRequest(ctx, request); err != nil {
				return err
			}
		}
		if record.Turn != nil {
			if err := tx.recordUsageTurn(ctx, *record.Turn); err != nil {
				return err
			}
		}
		return nil
	})
}

func (s *Store) recordUsageRequest(ctx context.Context, request store.UsageRequest) error {
	_, err := s.conn().ExecContext(ctx, `INSERT INTO usage_requests (
		request_id, session_id, input_id, user_id, workspace_id, device_id, parent_session_id, entry, at,
		runtime, profile_id, provider_label, requested_model, model, input_tokens, cache_read_tokens,
		cache_write_tokens, output_tokens, first_token_ms, generation_ms, request_ms, timing_estimated
	) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	ON CONFLICT(request_id) DO UPDATE SET
		session_id = excluded.session_id,
		input_id = excluded.input_id,
		user_id = excluded.user_id,
		workspace_id = excluded.workspace_id,
		device_id = excluded.device_id,
		parent_session_id = excluded.parent_session_id,
		entry = excluded.entry,
		at = excluded.at,
		runtime = excluded.runtime,
		profile_id = excluded.profile_id,
		provider_label = excluded.provider_label,
		requested_model = excluded.requested_model,
		model = CASE WHEN excluded.model = '' THEN usage_requests.model ELSE excluded.model END,
		input_tokens = excluded.input_tokens,
		cache_read_tokens = excluded.cache_read_tokens,
		cache_write_tokens = excluded.cache_write_tokens,
		output_tokens = excluded.output_tokens,
		first_token_ms = CASE WHEN excluded.first_token_ms = 0 THEN usage_requests.first_token_ms ELSE excluded.first_token_ms END,
		generation_ms = CASE WHEN excluded.generation_ms = 0 THEN usage_requests.generation_ms ELSE excluded.generation_ms END,
		request_ms = CASE WHEN excluded.request_ms = 0 THEN usage_requests.request_ms ELSE excluded.request_ms END,
		timing_estimated = CASE WHEN excluded.timing_estimated = 1 THEN 1 ELSE usage_requests.timing_estimated END`,
		request.RequestID, request.SessionID, request.InputID, request.UserID, request.WorkspaceID,
		request.DeviceID, request.ParentSessionID, request.Entry, request.At, request.Runtime, request.ProfileID,
		request.ProviderLabel, request.RequestedModel, request.Model, request.InputTokens,
		request.CacheReadTokens, request.CacheWriteTokens, request.OutputTokens, request.FirstTokenMs,
		request.GenerationMs, request.RequestMs, request.TimingEstimated)
	if err != nil {
		return fmt.Errorf("record usage request %s: %w", request.RequestID, err)
	}
	return nil
}

func (s *Store) recordUsageTurn(ctx context.Context, incoming store.UsageTurn) error {
	existing, found, err := s.readUsageTurn(ctx, incoming.SessionID, incoming.InputID)
	if err != nil {
		return err
	}
	next := incoming
	if found && !incoming.UsageReported {
		next = existing
		next.EndedAt = incoming.EndedAt
		next.DurationMs = incoming.DurationMs
		next.Outcome = incoming.Outcome
		next.ErrorClass = incoming.ErrorClass
	} else if found && incoming.Backfill {
		next = mergeUsageBackfill(existing, incoming)
	}
	if next.Outcome == "" {
		next.Outcome = store.UsageOutcomeCompleted
	}
	if next.CostSource == "" {
		next.CostSource = store.UsageCostUnknown
	}
	if _, err := s.conn().ExecContext(ctx, `INSERT INTO usage_turns (`+usageTurnColumns+`)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(session_id, input_id) DO UPDATE SET
			user_id = excluded.user_id,
			workspace_id = excluded.workspace_id,
			device_id = excluded.device_id,
			parent_session_id = excluded.parent_session_id,
			entry = excluded.entry,
			runtime = excluded.runtime,
			profile_id = excluded.profile_id,
			provider_label = excluded.provider_label,
			requested_model = excluded.requested_model,
			model = excluded.model,
			started_at = excluded.started_at,
			ended_at = excluded.ended_at,
			duration_ms = excluded.duration_ms,
			model_ms = excluded.model_ms,
			ttft_ms = excluded.ttft_ms,
			timing_estimated = excluded.timing_estimated,
			input_tokens = excluded.input_tokens,
			cache_read_tokens = excluded.cache_read_tokens,
			cache_write_tokens = excluded.cache_write_tokens,
			output_tokens = excluded.output_tokens,
			reasoning_tokens = excluded.reasoning_tokens,
			model_requests = excluded.model_requests,
			cost_usd = excluded.cost_usd,
			cost_source = excluded.cost_source,
			outcome = excluded.outcome,
			error_class = excluded.error_class`,
		next.SessionID, next.InputID, next.UserID, next.WorkspaceID, next.DeviceID, next.ParentSessionID,
		next.Entry, next.Runtime, next.ProfileID, next.ProviderLabel, next.RequestedModel, next.Model,
		next.StartedAt, next.EndedAt, next.DurationMs, next.ModelMs, next.TtftMs, next.TimingEstimated,
		next.InputTokens, next.CacheReadTokens, next.CacheWriteTokens, next.OutputTokens,
		next.ReasoningTokens, next.ModelRequests, next.CostUSD, next.CostSource, next.Outcome, next.ErrorClass); err != nil {
		return fmt.Errorf("record usage turn %s/%s: %w", next.SessionID, next.InputID, err)
	}
	if found {
		if err := s.adjustUsageDaily(ctx, existing, -1); err != nil {
			return err
		}
	}
	if err := s.adjustUsageDaily(ctx, next, 1); err != nil {
		return err
	}
	return s.deleteEmptyUsageDaily(ctx)
}

func mergeUsageBackfill(existing, incoming store.UsageTurn) store.UsageTurn {
	next := incoming
	if next.Model == "" {
		next.Model = existing.Model
	}
	if existing.Outcome != "" {
		next.Outcome = existing.Outcome
		next.ErrorClass = existing.ErrorClass
	}
	if next.CostSource == store.UsageCostUnknown && existing.CostSource != store.UsageCostUnknown {
		next.CostUSD = existing.CostUSD
		next.CostSource = existing.CostSource
	}
	for _, pair := range []struct {
		next     *int64
		existing int64
	}{
		{&next.DurationMs, existing.DurationMs},
		{&next.ModelMs, existing.ModelMs},
		{&next.TtftMs, existing.TtftMs},
		{&next.InputTokens, existing.InputTokens},
		{&next.CacheReadTokens, existing.CacheReadTokens},
		{&next.CacheWriteTokens, existing.CacheWriteTokens},
		{&next.OutputTokens, existing.OutputTokens},
		{&next.ReasoningTokens, existing.ReasoningTokens},
		{&next.ModelRequests, existing.ModelRequests},
	} {
		if *pair.next == 0 {
			*pair.next = pair.existing
		}
	}
	next.TimingEstimated = next.TimingEstimated || existing.TimingEstimated
	return next
}

func (s *Store) readUsageTurn(ctx context.Context, sessionID, inputID string) (store.UsageTurn, bool, error) {
	var turn store.UsageTurn
	err := s.conn().QueryRowContext(ctx, `SELECT `+usageTurnColumns+` FROM usage_turns
		WHERE session_id = ? AND input_id = ?`, sessionID, inputID).Scan(
		&turn.SessionID, &turn.InputID, &turn.UserID, &turn.WorkspaceID, &turn.DeviceID, &turn.ParentSessionID,
		&turn.Entry, &turn.Runtime, &turn.ProfileID, &turn.ProviderLabel, &turn.RequestedModel, &turn.Model,
		&turn.StartedAt, &turn.EndedAt, &turn.DurationMs, &turn.ModelMs, &turn.TtftMs, &turn.TimingEstimated,
		&turn.InputTokens, &turn.CacheReadTokens, &turn.CacheWriteTokens, &turn.OutputTokens,
		&turn.ReasoningTokens, &turn.ModelRequests, &turn.CostUSD, &turn.CostSource, &turn.Outcome,
		&turn.ErrorClass)
	if errors.Is(err, sql.ErrNoRows) {
		return store.UsageTurn{}, false, nil
	}
	if err != nil {
		return store.UsageTurn{}, false, fmt.Errorf("read usage turn: %w", err)
	}
	return turn, true, nil
}

func (s *Store) adjustUsageDaily(ctx context.Context, turn store.UsageTurn, sign int64) error {
	day, err := usageDay(turn.StartedAt)
	if err != nil {
		return err
	}
	completed, failed, canceled := int64(0), int64(0), int64(0)
	switch turn.Outcome {
	case store.UsageOutcomeCompleted:
		completed = sign
	case store.UsageOutcomeFailed:
		failed = sign
	case store.UsageOutcomeCanceled:
		canceled = sign
	default:
		return fmt.Errorf("unknown usage outcome %q", turn.Outcome)
	}
	_, err = s.conn().ExecContext(ctx, `INSERT INTO usage_daily (
		day, user_id, entry, device_id, workspace_id, runtime, profile_id, model,
		turn_count, completed_count, failed_count, canceled_count, duration_ms, model_ms, ttft_ms,
		input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, reasoning_tokens,
		model_requests, cost_usd
	) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	ON CONFLICT(day, user_id, entry, device_id, workspace_id, runtime, profile_id, model) DO UPDATE SET
		turn_count = usage_daily.turn_count + excluded.turn_count,
		completed_count = usage_daily.completed_count + excluded.completed_count,
		failed_count = usage_daily.failed_count + excluded.failed_count,
		canceled_count = usage_daily.canceled_count + excluded.canceled_count,
		duration_ms = usage_daily.duration_ms + excluded.duration_ms,
		model_ms = usage_daily.model_ms + excluded.model_ms,
		ttft_ms = usage_daily.ttft_ms + excluded.ttft_ms,
		input_tokens = usage_daily.input_tokens + excluded.input_tokens,
		cache_read_tokens = usage_daily.cache_read_tokens + excluded.cache_read_tokens,
		cache_write_tokens = usage_daily.cache_write_tokens + excluded.cache_write_tokens,
		output_tokens = usage_daily.output_tokens + excluded.output_tokens,
		reasoning_tokens = usage_daily.reasoning_tokens + excluded.reasoning_tokens,
		model_requests = usage_daily.model_requests + excluded.model_requests,
		cost_usd = usage_daily.cost_usd + excluded.cost_usd`,
		day, turn.UserID, turn.Entry, turn.DeviceID, turn.WorkspaceID, turn.Runtime, turn.ProfileID,
		turn.Model, sign, completed, failed, canceled, sign*turn.DurationMs, sign*turn.ModelMs,
		sign*turn.TtftMs, sign*turn.InputTokens, sign*turn.CacheReadTokens, sign*turn.CacheWriteTokens,
		sign*turn.OutputTokens, sign*turn.ReasoningTokens, sign*turn.ModelRequests, float64(sign)*turn.CostUSD)
	if err != nil {
		return fmt.Errorf("update usage daily: %w", err)
	}
	return nil
}

func (s *Store) deleteEmptyUsageDaily(ctx context.Context) error {
	_, err := s.conn().ExecContext(ctx, `DELETE FROM usage_daily WHERE
		turn_count = 0 AND completed_count = 0 AND failed_count = 0 AND canceled_count = 0 AND
		duration_ms = 0 AND model_ms = 0 AND ttft_ms = 0 AND input_tokens = 0 AND
		cache_read_tokens = 0 AND cache_write_tokens = 0 AND output_tokens = 0 AND
		reasoning_tokens = 0 AND model_requests = 0 AND cost_usd = 0`)
	if err != nil {
		return fmt.Errorf("delete empty usage daily: %w", err)
	}
	return nil
}

func (s *Store) UsageContextModel(ctx context.Context, sessionID, inputID string) (string, error) {
	if inputID == "" {
		return "", nil
	}
	var since string
	err := s.reader().QueryRowContext(ctx, `SELECT created_at FROM agent_session_events
		WHERE session_id = ? AND id = ?`, sessionID, store.SessionInputEventID(inputID)).Scan(&since)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("find usage turn input: %w", err)
	}
	var model string
	err = s.reader().QueryRowContext(ctx, `SELECT COALESCE(json_extract(payload_json, '$.metadata.contextUsage.model'), '')
		FROM agent_session_events
		WHERE session_id = ? AND created_at >= ?
			AND COALESCE(json_extract(payload_json, '$.metadata.contextUsage.model'), '') <> ''
		ORDER BY created_at DESC, rowid DESC LIMIT 1`, sessionID, since).Scan(&model)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("read usage context model: %w", err)
	}
	return model, nil
}

func (s *Store) DeleteUsageRequestsBefore(ctx context.Context, before time.Time) (int64, error) {
	result, err := s.conn().ExecContext(ctx, `DELETE FROM usage_requests WHERE at < ?`, formatTime(before))
	if err != nil {
		return 0, fmt.Errorf("delete expired usage requests: %w", err)
	}
	return result.RowsAffected()
}

func (s *Store) UsageBackfillState(ctx context.Context) (store.UsageBackfillState, error) {
	var state store.UsageBackfillState
	var completed int
	err := s.reader().QueryRowContext(ctx, `SELECT cursor, completed FROM usage_backfill WHERE id = 1`).
		Scan(&state.Cursor, &completed)
	if errors.Is(err, sql.ErrNoRows) {
		return state, nil
	}
	if err != nil {
		return state, fmt.Errorf("read usage backfill state: %w", err)
	}
	state.Completed = completed != 0
	return state, nil
}

func (s *Store) UsageBackfillSessionIDs(ctx context.Context, after string, limit int) ([]string, error) {
	if limit <= 0 {
		return nil, fmt.Errorf("usage backfill limit must be positive, got %d", limit)
	}
	rows, err := s.reader().QueryContext(ctx, `SELECT id FROM agent_sessions WHERE id > ? ORDER BY id LIMIT ?`, after, limit)
	if err != nil {
		return nil, fmt.Errorf("list usage backfill sessions: %w", err)
	}
	defer rows.Close()
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

func (s *Store) UsageSessionEvents(ctx context.Context, sessionID string) ([]store.AgentSessionEvent, error) {
	events, err := listSessionEvents(ctx, s.reader(), `SELECT `+sessionEventColumns+`
		FROM agent_session_events
		WHERE session_id = ?
			AND (
				json_extract(payload_json, '$.label') = ?
				OR json_type(payload_json, '$.metadata.turnUsage') = 'object'
				OR json_type(payload_json, '$.metadata.requestUsage') = 'object'
				OR json_type(payload_json, '$.metadata.contextUsage') = 'object'
			)
		ORDER BY created_at ASC, rowid ASC`, sessionID, store.EventLabelUserMessage)
	if err != nil {
		return nil, fmt.Errorf("read usage backfill events for %s: %w", sessionID, err)
	}
	return events, nil
}

func (s *Store) SaveUsageBackfillState(ctx context.Context, cursor string, completed bool) error {
	_, err := s.conn().ExecContext(ctx, `INSERT INTO usage_backfill (id, cursor, completed, updated_at)
		VALUES (1, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
			cursor = excluded.cursor,
			completed = excluded.completed,
			updated_at = excluded.updated_at`,
		cursor, boolInt(completed), formatTime(time.Now().UTC()))
	if err != nil {
		return fmt.Errorf("save usage backfill state: %w", err)
	}
	return nil
}

var usageDimensionColumns = map[string]string{
	"user":      "user_id",
	"entry":     "entry",
	"device":    "device_id",
	"workspace": "workspace_id",
	"provider":  "provider_label",
	"model":     "model",
	"runtime":   "runtime",
}

func (s *Store) UsageTurnAggregates(ctx context.Context, query store.UsageTurnAggregateQuery) ([]store.UsageTurnAggregate, error) {
	groupColumns, err := usageGroupColumns(query.GroupBy)
	if err != nil {
		return nil, err
	}
	bucket, err := usageBucketExpression("started_at", query.Granularity)
	if err != nil {
		return nil, err
	}
	where, args := usageFilterWhere("started_at", query.UsageStatsFilter)
	selects := []string{bucket + ` AS bucket`}
	for _, column := range groupColumns {
		selects = append(selects, column)
	}
	selects = append(selects,
		`COUNT(*)`,
		`COALESCE(SUM(duration_ms), 0)`,
		`COALESCE(SUM(input_tokens), 0)`,
		`COALESCE(SUM(cache_read_tokens), 0)`,
		`COALESCE(SUM(cache_write_tokens), 0)`,
		`COALESCE(SUM(output_tokens), 0)`,
		`COALESCE(SUM(reasoning_tokens), 0)`,
		`COALESCE(SUM(model_requests), 0)`,
		`COALESCE(SUM(cost_usd), 0)`,
		`COALESCE(SUM(CASE WHEN cost_source = 'reported' THEN 1 ELSE 0 END), 0)`,
		`COALESCE(SUM(CASE WHEN cost_source = 'estimated' THEN 1 ELSE 0 END), 0)`,
		`COALESCE(SUM(CASE WHEN cost_source = 'custom' THEN 1 ELSE 0 END), 0)`,
		`COALESCE(SUM(CASE WHEN cost_source = 'unknown' THEN 1 ELSE 0 END), 0)`,
		`COALESCE(SUM(CASE WHEN cost_source = 'reported' THEN cost_usd ELSE 0 END), 0)`,
		`COALESCE(SUM(CASE WHEN cost_source = 'estimated' THEN cost_usd ELSE 0 END), 0)`,
		`COALESCE(SUM(CASE WHEN cost_source = 'custom' THEN cost_usd ELSE 0 END), 0)`,
		`COALESCE(SUM(CASE WHEN cost_source = 'unknown' THEN cost_usd ELSE 0 END), 0)`,
	)
	groupBy := append([]string{"bucket"}, groupColumns...)
	sqlQuery := `SELECT ` + strings.Join(selects, ", ") + ` FROM usage_turns WHERE ` + where +
		` GROUP BY ` + strings.Join(groupBy, ", ") + ` ORDER BY ` + strings.Join(groupBy, ", ")
	rows, err := s.reader().QueryContext(ctx, sqlQuery, args...)
	if err != nil {
		return nil, fmt.Errorf("query usage turn aggregates: %w", err)
	}
	defer rows.Close()
	result := []store.UsageTurnAggregate{}
	for rows.Next() {
		var item store.UsageTurnAggregate
		dest := []any{&item.Bucket}
		for _, column := range groupColumns {
			dest = append(dest, usageDimensionDestination(&item, column))
		}
		dest = append(dest, &item.Turns, &item.DurationMs, &item.InputTokens,
			&item.CacheReadTokens, &item.CacheWriteTokens, &item.OutputTokens,
			&item.ReasoningTokens, &item.ModelRequests, &item.CostUSD,
			&item.ReportedTurns, &item.EstimatedTurns, &item.CustomTurns, &item.UnknownTurns,
			&item.ReportedCostUSD, &item.EstimatedCostUSD, &item.CustomCostUSD, &item.UnknownCostUSD)
		if err := rows.Scan(dest...); err != nil {
			return nil, err
		}
		result = append(result, item)
	}
	return result, rows.Err()
}

func (s *Store) UsageRequestRows(ctx context.Context, query store.UsageRequestRowQuery) ([]store.UsageRequestRow, error) {
	groupColumns, err := usageGroupColumns(query.GroupBy)
	if err != nil {
		return nil, err
	}
	bucket, err := usageBucketExpression("at", query.Granularity)
	if err != nil {
		return nil, err
	}
	where, args := usageFilterWhere("at", query.UsageStatsFilter)
	selects := []string{bucket + ` AS bucket`}
	selects = append(selects, groupColumns...)
	selects = append(selects, `output_tokens`, `generation_ms`, `first_token_ms`)
	orderBy := append([]string{"bucket"}, groupColumns...)
	sqlQuery := `SELECT ` + strings.Join(selects, ", ") + ` FROM usage_requests WHERE ` + where +
		` ORDER BY ` + strings.Join(orderBy, ", ")
	rows, err := s.reader().QueryContext(ctx, sqlQuery, args...)
	if err != nil {
		return nil, fmt.Errorf("query usage request rows: %w", err)
	}
	defer rows.Close()
	result := []store.UsageRequestRow{}
	for rows.Next() {
		var item store.UsageRequestRow
		dest := []any{&item.Bucket}
		for _, column := range groupColumns {
			dest = append(dest, usageDimensionDestination(&item, column))
		}
		dest = append(dest, &item.OutputTokens, &item.GenerationMs, &item.FirstTokenMs)
		if err := rows.Scan(dest...); err != nil {
			return nil, err
		}
		result = append(result, item)
	}
	return result, rows.Err()
}

func usageGroupColumns(groupBy []string) ([]string, error) {
	columns := make([]string, 0, len(groupBy))
	seen := map[string]bool{}
	for _, dimension := range groupBy {
		column, ok := usageDimensionColumns[dimension]
		if !ok {
			return nil, fmt.Errorf("unknown usage dimension %q", dimension)
		}
		if !seen[dimension] {
			seen[dimension] = true
			columns = append(columns, column)
		}
	}
	return columns, nil
}

func usageBucketExpression(column, granularity string) (string, error) {
	switch granularity {
	case "hour":
		return `substr(` + column + `, 1, 13) || ':00:00Z'`, nil
	case "day":
		return `substr(` + column + `, 1, 10)`, nil
	default:
		return "", fmt.Errorf("unknown usage granularity %q", granularity)
	}
}

func usageFilterWhere(timeColumn string, filter store.UsageStatsFilter) (string, []any) {
	where := timeColumn + ` >= ? AND ` + timeColumn + ` < ?`
	args := []any{formatTime(filter.From), formatTime(filter.To)}
	for _, pair := range []struct {
		column string
		value  string
	}{
		{"user_id", filter.UserID},
		{"entry", filter.Entry},
		{"device_id", filter.DeviceID},
		{"workspace_id", filter.WorkspaceID},
		{"provider_label", filter.Provider},
		{"model", filter.Model},
		{"runtime", filter.Runtime},
	} {
		if pair.value != "" {
			where += ` AND ` + pair.column + ` = ?`
			args = append(args, pair.value)
		}
	}
	return where, args
}

func usageDimensionDestination(item any, column string) any {
	switch row := item.(type) {
	case *store.UsageTurnAggregate:
		switch column {
		case "user_id":
			return &row.UserID
		case "entry":
			return &row.Entry
		case "device_id":
			return &row.DeviceID
		case "workspace_id":
			return &row.WorkspaceID
		case "provider_label":
			return &row.Provider
		case "model":
			return &row.Model
		case "runtime":
			return &row.Runtime
		}
	case *store.UsageRequestRow:
		switch column {
		case "user_id":
			return &row.UserID
		case "entry":
			return &row.Entry
		case "device_id":
			return &row.DeviceID
		case "workspace_id":
			return &row.WorkspaceID
		case "provider_label":
			return &row.Provider
		case "model":
			return &row.Model
		case "runtime":
			return &row.Runtime
		}
	}
	panic("unknown usage dimension destination")
}

func usageDay(at string) (string, error) {
	parsed, err := time.Parse(time.RFC3339Nano, at)
	if err != nil {
		return "", fmt.Errorf("parse usage turn start %q: %w", at, err)
	}
	return parsed.UTC().Format("2006-01-02"), nil
}
