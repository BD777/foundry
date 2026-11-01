package httpapi

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
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
	list, err := r.server.store.ListSessionWork(ctx, root, "")
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
	runs, err := s.store.ListWorkRuns(ctx, item.ID)
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
			id, err = s.store.WorkRunInputSession(ctx, expected)
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
	// A run whose end the observation already records is settled: what the
	// device observed since (a paused one-shot schedule reports "stopped")
	// stands. Settling it again flipped the observation back on every device
	// poll while the device kept reporting its own state (DEV-085).
	if run == runs[index] && run.EndedAt != "" && item.Observation.EndedAt == run.EndedAt && item.Spec.ManualRunAt == "" {
		return item, nil
	}
	// Every device poll settles every schedule naming a run; one already
	// recorded is not written again (DEV-085). An ended run still clears a
	// pending manual run of its slot.
	if run != runs[index] || (run.EndedAt != "" && item.Spec.ManualRunAt != "") {
		if err = s.store.FinishWorkRun(ctx, run); err != nil {
			return item, err
		}
	}
	observation := item.Observation
	observation.Status, observation.RunID, observation.ExecutionSessionID = run.Status, run.ID, run.ExecutionSessionID
	observation.StartedAt = run.StartedAt
	observation.EndedAt, observation.Error = run.EndedAt, run.Error
	if run.EndedAt != "" {
		observation.NextFireAt = ""
	}
	if observation == item.Observation {
		return item, nil
	}
	observation.At = time.Now().UTC().Format(time.RFC3339Nano)
	if err = s.store.ObserveSessionWork(ctx, item.ID, observation); err != nil {
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

// timerFireInputID names the input a timer's fire time becomes, the same
// for every attempt to send it.
func timerFireInputID(sessionID, timerID string, dueAt time.Time) string {
	sum := sha256.Sum256([]byte("timer-fire\x00" + sessionID + "\x00" + timerID + "\x00" + dueAt.UTC().Format(time.RFC3339)))
	id := hex.EncodeToString(sum[:16])
	return id[0:8] + "-" + id[8:12] + "-" + id[12:16] + "-" + id[16:20] + "-" + id[20:32]
}
