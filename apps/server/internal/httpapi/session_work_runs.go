package httpapi

import (
	"context"
	"errors"
	"log"
	"slices"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/sessionwork"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// Completion follows the exact input, before a later user turn can replace the
// session summary. Recovery uses the same identity; timestamps alone do not
// associate a human turn with a scheduled run.
type workRunReactions struct{ server *Server }

func (r workRunReactions) sessionChanged(ctx context.Context, change sessionChange, session store.AgentSession) {
	if change != sessionCompleted {
		return
	}
	if session.Input.TimerFire == nil && session.ParentSessionID == "" {
		return
	}
	root := sessionwork.Thread(session)
	if session.ParentSessionID != "" {
		if parent, err := r.server.store.GetAgentSessionSummary(ctx, session.ParentSessionID); err == nil {
			root = sessionwork.Thread(parent)
		}
	}
	backing, err := r.server.workStore()
	if err != nil {
		return
	}
	list, err := backing.ListSessionWork(ctx, root, "")
	if err != nil {
		log.Printf("scheduled work completion: %v", err)
		return
	}
	for _, item := range list.Items {
		if item.Kind != "schedule" || item.Observation.RunID == "" {
			continue
		}
		if _, err := r.server.settleScheduledWork(ctx, item, &session); err != nil {
			log.Printf("scheduled work %s completion: %v", item.ID, err)
		}
	}
}

func (s *Server) settleScheduledWork(ctx context.Context, item store.SessionWork, completed *store.AgentSession) (store.SessionWork, error) {
	if item.Kind != "schedule" || item.Observation.RunID == "" {
		return item, nil
	}
	backing, err := s.workStore()
	if err != nil {
		return item, err
	}
	runs, err := backing.ListWorkRuns(ctx, item.ID)
	if err != nil {
		return item, err
	}
	index := slices.IndexFunc(runs, func(run store.WorkRun) bool { return run.ID == item.Observation.RunID })
	if index < 0 {
		return item, nil
	}
	run := runs[index]
	expected := scheduledWorkInputID(item, run)
	var execution store.AgentSession
	if completed != nil {
		if completed.Input.ID != expected {
			return item, nil
		}
		execution = *completed
	} else {
		id := run.ExecutionSessionID
		if id == "" {
			id, err = backing.WorkRunInputSession(ctx, expected)
			if errors.Is(err, store.ErrNotFound) {
				run.Status, run.EndedAt = "failed", time.Now().UTC().Format(time.RFC3339Nano)
				run.Error = "Scheduled dispatch was interrupted before its input was recorded; no execution was delivered."
				id, err = item.SessionID, nil
			}
			if err != nil {
				return item, err
			}
		}
		execution, err = s.store.GetAgentSessionSummary(ctx, id)
		if err != nil {
			return item, err
		}
	}
	if execution.Input.ID == expected && (execution.DeviceID != item.DeviceID || execution.WorkspaceID != item.WorkspaceID ||
		(item.Spec.Target == "new_session" && execution.ParentSessionID != item.SessionID) ||
		(item.Spec.Target != "new_session" && execution.ID != item.SessionID)) {
		return item, errors.New("scheduled input does not belong to this work execution scope")
	}
	if run.EndedAt == "" && execution.Input.ID == expected {
		run.ExecutionSessionID = execution.ID
		if activeOrBlocked(execution.Status) {
			run.Status, run.Error = "running", ""
		} else {
			run.Status, run.EndedAt, run.Error = "completed", execution.CompletedAt, ""
			if execution.Status == "failed" {
				run.Status = "failed"
			}
			if execution.Status == "canceled" {
				run.Status = "stopped"
			}
		}
	} else if run.EndedAt == "" {
		// The server may have died between the durable claim and delivery.
		// Never replay an ambiguous claim or claim an unrelated turn completed it.
		run.Status = "unknown"
		run.Error = "Scheduled dispatch has no confirmed input identity; automatic replay is withheld. Inspect the execution before running again."
	}
	if err = backing.FinishWorkRun(ctx, run); err != nil {
		return item, err
	}
	observation := item.Observation
	observation.Status, observation.RunID, observation.ExecutionSessionID = run.Status, run.ID, run.ExecutionSessionID
	observation.At, observation.StartedAt = time.Now().UTC().Format(time.RFC3339Nano), run.StartedAt
	observation.EndedAt, observation.Error = run.EndedAt, run.Error
	if run.EndedAt != "" {
		observation.NextFireAt = ""
	}
	if err = backing.ObserveSessionWork(ctx, item.ID, observation); err != nil {
		return item, err
	}
	item.Observation = observation
	return item, nil
}

func scheduledWorkInputID(item store.SessionWork, run store.WorkRun) string {
	if run.InputID != "" {
		return run.InputID
	}
	return timerFireInputID(item.SessionID, item.ID, mustWorkTime(run.ScheduledAt))
}
