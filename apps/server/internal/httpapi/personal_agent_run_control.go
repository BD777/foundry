package httpapi

import (
	"context"
	"errors"
	"fmt"
	"github.com/foundry-dev/foundry/apps/server/internal/personalagent/flow"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"net/http"
	"time"
)

type assistantRunControlReactions struct{ s *Server }

func (r assistantRunControlReactions) sessionChanged(ctx context.Context, _ sessionChange, session store.AgentSession) {
	if session.Input.ExecutionBudget == nil {
		return
	}
	_, _ = r.s.ensureAssistantRunControl(ctx, session)
}
func ensureAssistantRunControlRecord(ctx context.Context, backend Backend, session store.AgentSession) (store.PersonalAgentRunControl, error) {
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
func (s *Server) ensureAssistantRunControl(ctx context.Context, session store.AgentSession) (store.PersonalAgentRunControl, error) {
	return ensureAssistantRunControlRecord(ctx, s.store, session)
}

func (s *Server) handleAssistantRunControls(w http.ResponseWriter, r *http.Request) {
	rows, err := s.store.ListPersonalAgentRunControls(r.Context(), s.personFrom(r).ID)
	writeResult(w, rows, err)
}
func (s *Server) handleStopAssistantRun(w http.ResponseWriter, r *http.Request) {
	row, err := s.store.RequestPersonalAgentRunStop(r.Context(), s.personFrom(r).ID, r.PathValue("control"), "person_requested")
	writeResultWithStatus(w, http.StatusAccepted, row, err)
}
func (s *Server) drainAssistantRunControls(ctx context.Context) {
	// Recover a creation/receipt crash from authoritative accepted inputs.
	if all, e := s.store.ListPersonalAgents(ctx); e == nil {
		for _, agent := range all {
			ids, e := s.store.PersonalAgentActiveSessions(ctx, agent)
			if e != nil {
				continue
			}
			for _, id := range ids {
				if session, e := s.store.GetAgentSessionSummary(ctx, id); e == nil && session.Input.ExecutionBudget != nil {
					_, _ = s.ensureAssistantRunControl(ctx, session)
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
		s.reconcileAssistantRunControl(runCtx, c)
		cancel()
	}
}
func (s *Server) reconcileAssistantRunControl(ctx context.Context, c store.PersonalAgentRunControl) {
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
	if !activeOrBlocked(session.Status) {
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
			tokens, known, e := s.observeAssistantInputTokens(ctx, session)
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
		connection := s.hub.connectionFor(session.DeviceID)
		if connection == nil {
			c.WaitingReason = "device_offline"
			save()
			return
		}
		if !connection.hasCapability("exact_input_cancel_v1") {
			c.WaitingReason = "worker_update_required"
			save()
			return
		}
		receipt, e := s.hub.cancelExactAssistantInput(ctx, session)
		if e != nil {
			return
		} // No native acknowledgement is never a success.
		if receipt.InputID != c.InputID || !receipt.Stopped {
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
		s.sessions.changed(ctx, sessionCompleted, stopped)
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

// Native logs include cache tokens in InputTokens. This is an observed main
// runtime budget, not a provider billing cap: reporting and in-flight requests
// may overshoot it. The device-local time ceiling remains effective offline.
func (s *Server) observeAssistantInputTokens(ctx context.Context, session store.AgentSession) (int64, bool, error) {
	connection := s.hub.connectionFor(session.DeviceID)
	if connection == nil || !connection.hasCapability(sessionUsageCapability) || session.NativeSessionID == "" {
		return 0, false, nil
	}
	usage, err := connection.readSessionUsage(ctx, session.Provider, []string{session.NativeSessionID})
	if err != nil {
		return 0, false, err
	}
	start, err := time.Parse(time.RFC3339Nano, session.Input.At)
	if err != nil {
		return 0, false, err
	}
	var latest *nativeTurnUsage
	for _, turn := range usage.Turns {
		at := parseEventTime(turn.StartedAt)
		ended := parseEventTime(turn.EndedAt)
		if at.Before(start.Add(-usageTolerance)) || ended.Before(start) {
			continue
		}
		if latest == nil || at.After(parseEventTime(latest.StartedAt)) {
			copy := turn
			latest = &copy
		}
	}
	if latest == nil {
		return 0, false, nil
	}
	if latest.InputTokens < 0 || latest.OutputTokens < 0 {
		return 0, false, fmt.Errorf("native usage was invalid")
	}
	return latest.InputTokens + latest.OutputTokens, true, nil
}
