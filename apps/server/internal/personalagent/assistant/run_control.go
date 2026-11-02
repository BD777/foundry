package assistant

import (
	"context"
	"errors"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/personalagent/flow"
	"github.com/foundry-dev/foundry/apps/server/internal/sessions"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

type runControlReactions struct{ s *Service }

func (r runControlReactions) SessionChanged(ctx context.Context, _ sessions.Change, session store.AgentSession) {
	if session.Input.ExecutionBudget == nil {
		return
	}
	_, _ = r.s.ensureRunControl(ctx, session)
}

// RunControlStore is what EnsureRunControl reads and keeps.
type RunControlStore interface {
	GetPersonalAgentRunSnapshot(ctx context.Context, userID, id string) (store.PersonalAgentRunSnapshot, error)
	EnsurePersonalAgentRunControl(ctx context.Context, control store.PersonalAgentRunControl) (store.PersonalAgentRunControl, error)
}

// EnsureRunControl is the control of the session's current input, kept
// once: its budget comes from the run snapshot the input carries.
func EnsureRunControl(ctx context.Context, backend RunControlStore, session store.AgentSession) (store.PersonalAgentRunControl, error) {
	c := store.PersonalAgentRunControl{ID: flow.Key("parctl", session.ID, session.Input.ID), UserID: session.CreatedByUserID, SessionID: session.ID, InputID: session.Input.ID, Role: "executor", DispatchAttempted: session.Input.ExecutionBudget == nil}
	if budget := session.Input.ExecutionBudget; budget != nil {
		snapshot, err := backend.GetPersonalAgentRunSnapshot(ctx, session.CreatedByUserID, budget.SnapshotID)
		if err != nil {
			return c, err
		}
		if snapshot.InputID != session.Input.ID || snapshot.WorkspaceID != session.WorkspaceID {
			return c, store.ErrIdempotencyConflict
		}
		c.SnapshotID, c.Role, c.TokenBudget, c.TimeoutMinutes = snapshot.ID, snapshot.Role, snapshot.TokenBudget, snapshot.TimeoutMinutes
	}
	return backend.EnsurePersonalAgentRunControl(ctx, c)
}

func (s *Service) ensureRunControl(ctx context.Context, session store.AgentSession) (store.PersonalAgentRunControl, error) {
	return EnsureRunControl(ctx, s.store, session)
}

// drainRunControls recovers the controls of runs with a budget and
// reconciles every active one.
func (s *Service) drainRunControls(ctx context.Context) {
	// Recover a creation/receipt crash from authoritative accepted inputs.
	if all, e := s.store.ListPersonalAgents(ctx); e == nil {
		for _, agent := range all {
			ids, e := s.store.PersonalAgentActiveSessions(ctx, agent)
			if e != nil {
				continue
			}
			for _, id := range ids {
				if session, e := s.store.GetAgentSessionSummary(ctx, id); e == nil && session.Input.ExecutionBudget != nil {
					_, _ = s.ensureRunControl(ctx, session)
				}
			}
		}
	}
	controls, err := s.store.ActivePersonalAgentRunControls(ctx)
	if err != nil {
		return
	}
	for _, c := range controls {
		if ctx.Err() != nil {
			return
		}
		runCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
		s.ReconcileRunControl(runCtx, c)
		cancel()
	}
}

// ReconcileRunControl enforces one run's time and token budget, and a
// requested stop, until its device confirms the run ended.
func (s *Service) ReconcileRunControl(ctx context.Context, c store.PersonalAgentRunControl) {
	ctx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	if c.State != "monitoring" && c.State != "stop_requested" {
		return
	}
	session, err := s.store.GetAgentSessionSummary(ctx, c.SessionID)
	if err != nil || session.CreatedByUserID != c.UserID {
		return
	}
	now := time.Now().UTC()
	save := func() { _, _ = s.store.SavePersonalAgentRunControl(ctx, c) }
	if session.Input.ID != c.InputID {
		c.State = "input_moved"
		c.ConfirmedAt = now.Format(time.RFC3339Nano)
		save()
		return
	}
	if !sessions.Unsettled(session.Status) {
		if !c.DispatchAttempted || c.NativeEndedAt != "" {
			c.State = "settled"
			if c.StopReason != "" || session.Status == "canceled" {
				c.State = "stopped"
			}
			c.ConfirmedAt = now.Format(time.RFC3339Nano)
			c.WaitingReason = ""
			save()
			return
		}
		// A server-side canceled/failed projection is not a native exit receipt.
		c.State = "stop_requested"
		if c.StopReason == "" {
			c.StopReason = "terminal_projection_needs_receipt"
		}
	}
	if c.State == "monitoring" {
		started, e := time.Parse(time.RFC3339Nano, session.StartedAt)
		if e == nil && c.TimeoutMinutes > 0 && now.Sub(started) >= time.Duration(c.TimeoutMinutes)*time.Minute {
			c.State = "stop_requested"
			c.StopReason = "timeout_budget"
		}
		last, _ := time.Parse(time.RFC3339Nano, c.LastUsageAt)
		if c.State == "monitoring" && c.TokenBudget > 0 && session.Status != "queued" && now.Sub(last) >= 30*time.Second {
			c.LastUsageAt = now.Format(time.RFC3339Nano)
			tokens, known, e := s.devices.InputTokens(ctx, session)
			c.UsageState = "unavailable"
			if e == nil && known {
				c.ObservedTokens = max(c.ObservedTokens, tokens)
				c.UsageState = "native_main_observed"
			}
			if known && c.ObservedTokens >= c.TokenBudget {
				c.State = "stop_requested"
				c.StopReason = "observed_token_budget"
			}
		}
	}
	updated, e := s.store.SavePersonalAgentRunControl(ctx, c)
	if e != nil {
		return
	}
	c = updated
	if c.State != "stop_requested" {
		return
	}
	if c.DispatchAttempted {
		connection := s.devices.Connection(session.DeviceID)
		if connection == nil {
			c.WaitingReason = "device_offline"
			save()
			return
		}
		if !connection.HasCapability("exact_input_cancel_v1") {
			c.WaitingReason = "worker_update_required"
			save()
			return
		}
		inputID, stopped, e := s.devices.CancelExactInput(ctx, session)
		if e != nil {
			return
		} // No native acknowledgement is never a success.
		if inputID != c.InputID || !stopped {
			c.WaitingReason = "native_end_pending"
			save()
			return
		}
	}
	stopped, changed, e := s.store.CancelPersonalAgentInput(ctx, session.ID, c.InputID, "Stopped: "+c.StopReason)
	if errors.Is(e, store.ErrPersonalAgentRevision) {
		c.State = "input_moved"
		c.ConfirmedAt = now.Format(time.RFC3339Nano)
		save()
		return
	}
	if e != nil {
		return
	}
	if changed {
		s.events.Changed(ctx, sessions.Completed, stopped)
	}
	if c.DispatchAttempted {
		_ = s.store.NotePersonalAgentNativeEnd(ctx, c.SessionID, c.InputID, "stopped")
		return
	}
	c.State = "stopped"
	c.WaitingReason = ""
	c.ConfirmedAt = time.Now().UTC().Format(time.RFC3339Nano)
	save()
}
