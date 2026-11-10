package usagestats

import (
	"context"
	"errors"
	"fmt"
	"math"
	"sort"
	"strings"

	"github.com/foundry-dev/foundry/apps/server/internal/jsonempty"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

var ErrInvalidQuery = errors.New("invalid usage query")
var ErrHourRange = fmt.Errorf("%w: hour granularity is available only for the last 90 days", ErrInvalidQuery)

type QueryOptions struct {
	Granularity string
	GroupBy     []string
	Limit       int
	Offset      int
	Filter      store.UsageStatsFilter
}

type usageGroupKey struct {
	bucket      string
	userID      string
	entry       string
	deviceID    string
	workspaceID string
	provider    string
	model       string
	runtime     string
}

type requestMetrics struct {
	requests        int64
	outputTokens    int64
	generationMs    int64
	tokensPerSecond []float64
	firstTokenMs    []int64
}

// Query aggregates turn and request facts into a bounded, paginated result.
// Turn sums cover all retained turns; request percentiles cover the detail
// rows still retained (90 days).
func (r *Recorder) Query(ctx context.Context, options QueryOptions) (store.UsageStatsResult, error) {
	if options.Granularity != "hour" && options.Granularity != "day" {
		return store.UsageStatsResult{}, fmt.Errorf("%w: granularity must be hour or day", ErrInvalidQuery)
	}
	if options.Granularity == "hour" && options.Filter.From.Before(r.Now().Add(-RequestRetention)) {
		return store.UsageStatsResult{}, ErrHourRange
	}
	if !options.Filter.To.After(options.Filter.From) {
		return store.UsageStatsResult{}, fmt.Errorf("%w: to must be after from", ErrInvalidQuery)
	}
	groupBy, err := normalizeGroupBy(options.GroupBy)
	if err != nil {
		return store.UsageStatsResult{}, err
	}
	if options.Limit <= 0 {
		options.Limit = 100
	}
	if options.Limit > 500 {
		options.Limit = 500
	}
	if options.Offset < 0 {
		options.Offset = 0
	}
	turnRows, err := r.store.UsageTurnAggregates(ctx, store.UsageTurnAggregateQuery{
		UsageStatsFilter: options.Filter,
		Granularity:      options.Granularity,
		GroupBy:          groupBy,
	})
	if err != nil {
		return store.UsageStatsResult{}, err
	}
	requestRows, err := r.store.UsageRequestRows(ctx, store.UsageRequestRowQuery{
		UsageStatsFilter: options.Filter,
		Granularity:      options.Granularity,
		GroupBy:          groupBy,
	})
	if err != nil {
		return store.UsageStatsResult{}, err
	}

	points := map[usageGroupKey]*store.UsageStatsPoint{}
	metrics := map[usageGroupKey]*requestMetrics{}
	for _, row := range turnRows {
		key := usageKey(row.Bucket, row.UserID, row.Entry, row.DeviceID, row.WorkspaceID, row.Provider, row.Model, row.Runtime)
		point := points[key]
		if point == nil {
			point = &store.UsageStatsPoint{Bucket: row.Bucket}
			points[key] = point
		}
		point.UserID, point.Entry, point.DeviceID = row.UserID, row.Entry, row.DeviceID
		point.WorkspaceID, point.Provider, point.Model, point.Runtime = row.WorkspaceID, row.Provider, row.Model, row.Runtime
		point.Turns = row.Turns
		point.InputTokens = row.InputTokens
		point.CacheReadTokens = row.CacheReadTokens
		point.CacheWriteTokens = row.CacheWriteTokens
		point.OutputTokens = row.OutputTokens
		point.ReasoningTokens = row.ReasoningTokens
		point.CostUSD = row.CostUSD
		point.CostSources = costSources(row)
	}
	for _, row := range requestRows {
		key := usageKey(row.Bucket, row.UserID, row.Entry, row.DeviceID, row.WorkspaceID, row.Provider, row.Model, row.Runtime)
		point := points[key]
		if point == nil {
			point = &store.UsageStatsPoint{Bucket: row.Bucket}
			points[key] = point
		}
		point.UserID, point.Entry, point.DeviceID = row.UserID, row.Entry, row.DeviceID
		point.WorkspaceID, point.Provider, point.Model, point.Runtime = row.WorkspaceID, row.Provider, row.Model, row.Runtime
		metric := metrics[key]
		if metric == nil {
			metric = &requestMetrics{}
			metrics[key] = metric
		}
		metric.requests++
		point.Requests++
		if row.GenerationMs > 0 && row.OutputTokens > 0 {
			metric.outputTokens += row.OutputTokens
			metric.generationMs += row.GenerationMs
			metric.tokensPerSecond = append(metric.tokensPerSecond, float64(row.OutputTokens)*1000/float64(row.GenerationMs))
		}
		if row.FirstTokenMs > 0 {
			metric.firstTokenMs = append(metric.firstTokenMs, row.FirstTokenMs)
		}
	}
	for key, point := range points {
		metric := metrics[key]
		if metric == nil {
			continue
		}
		if metric.generationMs > 0 {
			average := float64(metric.outputTokens) * 1000 / float64(metric.generationMs)
			point.AverageTokensPerSecond = &average
		}
		if median, ok := percentileFloat(metric.tokensPerSecond, 50); ok {
			point.MedianTokensPerSecond = &median
		}
		if p50, ok := percentileInt(metric.firstTokenMs, 50); ok {
			point.TtftP50Ms = &p50
		}
		if p90, ok := percentileInt(metric.firstTokenMs, 90); ok {
			point.TtftP90Ms = &p90
		}
	}

	items := make([]store.UsageStatsPoint, 0, len(points))
	for _, point := range points {
		items = append(items, *point)
	}
	sort.Slice(items, func(i, j int) bool {
		return usagePointLess(items[i], items[j], groupBy)
	})
	total := int64(len(items))
	start := min(options.Offset, len(items))
	end := min(start+options.Limit, len(items))
	page := items[start:end]
	groupList := make(jsonempty.List[store.UsageStatsDimension], len(groupBy))
	for index, dimension := range groupBy {
		groupList[index] = dimension
	}
	return store.UsageStatsResult{
		From:        formatTime(options.Filter.From),
		To:          formatTime(options.Filter.To),
		Granularity: options.Granularity,
		GroupBy:     groupList,
		Items:       page,
		Total:       total,
		Limit:       int64(options.Limit),
		Offset:      int64(options.Offset),
	}, nil
}

func normalizeGroupBy(groupBy []string) ([]string, error) {
	valid := map[string]bool{
		"entry": true, "device": true, "workspace": true, "provider": true,
		"model": true, "runtime": true, "user": true,
	}
	result := make([]string, 0, len(groupBy))
	seen := map[string]bool{}
	for _, raw := range groupBy {
		dimension := strings.TrimSpace(raw)
		if dimension == "" || seen[dimension] {
			continue
		}
		if !valid[dimension] {
			return nil, fmt.Errorf("%w: unknown groupBy dimension %s", ErrInvalidQuery, dimension)
		}
		seen[dimension] = true
		result = append(result, dimension)
	}
	return result, nil
}

func usageKey(bucket, userID, entry, deviceID, workspaceID, provider, model, runtime string) usageGroupKey {
	return usageGroupKey{
		bucket: bucket, userID: userID, entry: entry, deviceID: deviceID,
		workspaceID: workspaceID, provider: provider, model: model, runtime: runtime,
	}
}

func costSources(row store.UsageTurnAggregate) jsonempty.List[store.UsageStatsCostSource] {
	result := jsonempty.List[store.UsageStatsCostSource]{}
	for _, item := range []store.UsageStatsCostSource{
		{Source: store.UsageCostReported, Turns: row.ReportedTurns, CostUSD: row.ReportedCostUSD},
		{Source: store.UsageCostEstimated, Turns: row.EstimatedTurns, CostUSD: row.EstimatedCostUSD},
		{Source: store.UsageCostCustom, Turns: row.CustomTurns, CostUSD: row.CustomCostUSD},
		{Source: store.UsageCostUnknown, Turns: row.UnknownTurns, CostUSD: row.UnknownCostUSD},
	} {
		if item.Turns != 0 {
			result = append(result, item)
		}
	}
	return result
}

func usagePointLess(left, right store.UsageStatsPoint, groupBy []string) bool {
	if left.Bucket != right.Bucket {
		return left.Bucket < right.Bucket
	}
	for _, dimension := range groupBy {
		leftValue, rightValue := pointDimension(left, dimension), pointDimension(right, dimension)
		if leftValue != rightValue {
			return leftValue < rightValue
		}
	}
	return false
}

func pointDimension(point store.UsageStatsPoint, dimension string) string {
	switch dimension {
	case "entry":
		return point.Entry
	case "device":
		return point.DeviceID
	case "workspace":
		return point.WorkspaceID
	case "provider":
		return point.Provider
	case "model":
		return point.Model
	case "runtime":
		return point.Runtime
	case "user":
		return point.UserID
	default:
		return ""
	}
}

func percentileFloat(values []float64, percentile float64) (float64, bool) {
	if len(values) == 0 {
		return 0, false
	}
	sorted := append([]float64(nil), values...)
	sort.Float64s(sorted)
	index := int(math.Ceil(percentile/100*float64(len(sorted)))) - 1
	index = max(0, min(index, len(sorted)-1))
	return sorted[index], true
}

func percentileInt(values []int64, percentile float64) (int64, bool) {
	if len(values) == 0 {
		return 0, false
	}
	sorted := append([]int64(nil), values...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i] < sorted[j] })
	index := int(math.Ceil(percentile/100*float64(len(sorted)))) - 1
	index = max(0, min(index, len(sorted)-1))
	return sorted[index], true
}
