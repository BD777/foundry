package usagestats

import (
	"context"
	"errors"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

const (
	DefaultBackfillBatchSize = 25
	DefaultBackfillPause     = 100 * time.Millisecond
)

// BackfillOptions tunes tests and small installations. Zero values use the
// production defaults; MaxBatches bounds one run without marking it complete.
type BackfillOptions struct {
	BatchSize  int
	Pause      time.Duration
	MaxBatches int
}

// Backfill rebuilds usage facts from persisted session events. It checkpoints
// after every completed batch, so a restart resumes after the last session it
// finished. Replaying a batch is safe because RecordUsage is idempotent.
func (r *Recorder) Backfill(ctx context.Context, options BackfillOptions) error {
	if options.BatchSize <= 0 {
		options.BatchSize = DefaultBackfillBatchSize
	}
	if options.Pause <= 0 {
		options.Pause = DefaultBackfillPause
	}
	state, err := r.store.UsageBackfillState(ctx)
	if err != nil || state.Completed {
		return err
	}
	cursor := state.Cursor
	batches := 0
	for {
		ids, err := r.store.UsageBackfillSessionIDs(ctx, cursor, options.BatchSize)
		if err != nil {
			return err
		}
		if len(ids) == 0 {
			return r.store.SaveUsageBackfillState(ctx, cursor, true)
		}
		for _, sessionID := range ids {
			session, err := r.store.GetAgentSessionSummary(ctx, sessionID)
			if errors.Is(err, store.ErrNotFound) {
				cursor = sessionID
				continue
			}
			if err != nil {
				return err
			}
			events, err := r.store.UsageSessionEvents(ctx, sessionID)
			if err != nil {
				return err
			}
			if err := r.backfillSession(ctx, session, events); err != nil {
				return err
			}
			cursor = sessionID
		}
		batches++
		completed := len(ids) < options.BatchSize
		if err := r.store.SaveUsageBackfillState(ctx, cursor, completed); err != nil {
			return err
		}
		if completed || (options.MaxBatches > 0 && batches >= options.MaxBatches) {
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

type backfillInput struct {
	id           string
	startedAt    string
	contextModel string
	turns        []store.AgentSessionEvent
	requests     []store.AgentSessionEvent
}

func (r *Recorder) backfillSession(ctx context.Context, session store.AgentSession, events []store.AgentSessionEvent) error {
	entry, err := ClassifyEntry(ctx, session, r.store, r.roleOf)
	if err != nil {
		return err
	}
	inputs := []*backfillInput{}
	byID := map[string]*backfillInput{}
	ensureInput := func(id, startedAt string) *backfillInput {
		if id == "" {
			id = session.Input.ID
		}
		if startedAt == "" {
			startedAt = session.StartedAt
		}
		if input := byID[id]; input != nil {
			if input.startedAt == "" {
				input.startedAt = startedAt
			}
			return input
		}
		input := &backfillInput{id: id, startedAt: startedAt}
		byID[id] = input
		inputs = append(inputs, input)
		return input
	}
	var current *backfillInput
	for _, event := range events {
		if inputID, named := store.SessionInputIDOfEvent(event.ID); named &&
			event.ID == store.SessionInputEventID(inputID) &&
			event.Label == store.EventLabelUserMessage {
			current = ensureInput(inputID, event.At)
		}
		metadata := event.Metadata
		if metadata == nil {
			continue
		}
		if current == nil {
			current = ensureInput(session.Input.ID, session.StartedAt)
		}
		if metadata.ContextUsage != nil && metadata.ContextUsage.Model != "" {
			current.contextModel = metadata.ContextUsage.Model
		}
		if metadata.TurnUsage != nil {
			current.turns = append(current.turns, event)
		}
		if metadata.RequestUsage != nil {
			current.requests = append(current.requests, event)
		}
	}
	if len(inputs) == 0 {
		ensureInput(session.Input.ID, session.StartedAt)
	}

	requestCutoff := r.Now().Add(-RequestRetention)
	lastInput := len(inputs) - 1
	for index, input := range inputs {
		turnSession := session
		turnSession.Input.ID = input.id
		turnSession.Input.At = input.startedAt
		turnSession.StartedAt = input.startedAt
		if index == lastInput && session.Status == "failed" {
			turnSession.Status = "failed"
		} else if index == lastInput && session.Status == "canceled" {
			turnSession.Status = "canceled"
		} else {
			turnSession.Status = "completed"
		}
		var turn *store.UsageTurn
		if len(input.turns) > 0 {
			event := input.turns[len(input.turns)-1]
			if event.Metadata.TurnUsage.Model == "" {
				usage := *event.Metadata.TurnUsage
				usage.Model = input.contextModel
				event.Metadata = &store.AgentSessionEventMetadata{TurnUsage: &usage}
			}
			turn = turnFromEvent(turnSession, event, entry, "")
			turn.Backfill = true
		} else if index == lastInput && (session.Status == "failed" || session.Status == "canceled") {
			turn = terminalTurn(turnSession, store.AgentSessionEvent{
				SessionID: session.ID,
				At:        session.CompletedAt,
			}, entry, input.contextModel)
			turn.Backfill = true
		}
		var requests []store.UsageRequest
		for _, event := range input.requests {
			at, err := time.Parse(time.RFC3339Nano, event.At)
			if err != nil || at.Before(requestCutoff) {
				continue
			}
			if event.Metadata.RequestUsage.Model == "" {
				usage := *event.Metadata.RequestUsage
				usage.Model = input.contextModel
				event.Metadata = &store.AgentSessionEventMetadata{RequestUsage: &usage}
			}
			request := requestFromEvent(turnSession, event, entry, "")
			request.Backfill = true
			requests = append(requests, request)
		}
		if turn == nil && len(requests) == 0 {
			continue
		}
		r.applyCost(ctx, turn)
		if err := r.store.RecordUsage(ctx, store.UsageRecord{Turn: turn, Requests: requests}); err != nil {
			return err
		}
	}
	return nil
}
