package usagestats

import (
	"context"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

const (
	DefaultRepriceBatchSize = 100
	DefaultRepricePause     = 50 * time.Millisecond
)

// RepriceOptions bounds one historical price scan. Zero values use the
// production defaults; MaxBatches bounds a run that callers can resume later
// because each pass starts from the beginning.
type RepriceOptions struct {
	BatchSize  int
	Pause      time.Duration
	MaxBatches int
}

// Reprice recomputes non-reported historical turns with the active custom and
// LiteLLM prices. Agent-reported costs are never changed.
func (r *Recorder) Reprice(ctx context.Context, options RepriceOptions) error {
	if options.BatchSize <= 0 {
		options.BatchSize = DefaultRepriceBatchSize
	}
	if options.Pause <= 0 {
		options.Pause = DefaultRepricePause
	}
	cursor := store.UsageRepriceCursor{}
	batches := 0
	for {
		turns, next, err := r.store.UsageTurnsForReprice(ctx, cursor, options.BatchSize)
		if err != nil {
			return err
		}
		if len(turns) == 0 {
			return nil
		}
		for index := range turns {
			turn := turns[index]
			if turn.CostSource == store.UsageCostReported {
				continue
			}
			repriced := turn
			repriced.UsageReported = true
			r.applyCost(ctx, &repriced)
			if repriced.CostUSD == turn.CostUSD && repriced.CostSource == turn.CostSource {
				continue
			}
			if _, err := r.store.UpdateUsageCost(
				ctx, repriced.SessionID, repriced.InputID, repriced.CostUSD, repriced.CostSource,
			); err != nil {
				return err
			}
		}
		cursor = next
		batches++
		if len(turns) < options.BatchSize || (options.MaxBatches > 0 && batches >= options.MaxBatches) {
			return nil
		}
		timer := time.NewTimer(options.Pause)
		select {
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		case <-timer.C:
		}
	}
}
