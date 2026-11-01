package httpapi

import (
	"context"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/sessionwork"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func (s *Server) importWorkChildren(ctx context.Context, parent store.AgentSession) error {
	children, err := s.store.ListAgentSessionChildren(ctx, parent.WorkspaceID, parent.ID)
	if err != nil {
		return err
	}
	// A schedule execution is already controlled by its schedule item. Do not
	// import it a second time as an automatic agent and accidentally apply the
	// conversation barrier to an explicitly resumed schedule's current run.
	scheduledInputs := map[string]bool{}
	list, err := s.store.ListSessionWork(ctx, sessionwork.Thread(parent), "")
	if err != nil {
		return err
	}
	for _, work := range list.Items {
		if work.SessionID != parent.ID || work.Kind != "schedule" || work.Spec.Target != "new_session" {
			continue
		}
		runs, readErr := s.store.ListWorkRuns(ctx, work.ID)
		if readErr != nil {
			return readErr
		}
		for _, run := range runs {
			scheduledInputs[scheduledWorkInputID(work, run)] = true
		}
	}
	for _, child := range children {
		if scheduledInputs[child.Input.ID] {
			continue
		}
		if !s.canReadSession(ctx, actorFromContext(ctx), child) {
			continue
		}
		item := sessionwork.Base(parent, "agent", "foundry", child.ID, child.Title)
		item.Observation.Status = "running"
		if !activeOrBlocked(child.Status) {
			item.Observation.Status = "completed"
			if child.Status == "failed" {
				item.Observation.Status = "failed"
			}
			if child.Status == "canceled" {
				item.Observation.Status = "stopped"
			}
			item.Observation.EndedAt = child.CompletedAt
		}
		saved, err := s.store.SaveSessionWork(ctx, item)
		if err != nil {
			return err
		}
		item.Observation.ConfirmedRevision = saved.Revision
		if saved.DesiredState == "stopped" && activeOrBlocked(child.Status) {
			item.Observation.ConfirmedRevision = saved.Observation.ConfirmedRevision
		}
		if err = s.store.ObserveSessionWork(ctx, item.ID, item.Observation); err != nil {
			return err
		}
	}
	return nil
}

func (s *Server) settleWorkChild(ctx context.Context, item store.SessionWork) store.SessionWork {
	child, err := s.store.GetAgentSessionSummary(ctx, item.SourceID)
	if err != nil {
		return item
	}
	if (item.DesiredState == "stopped" || item.DesiredState == "removed") && activeOrBlocked(child.Status) && s.canControlSession(ctx, actorFromContext(ctx), child) {
		if ended, cancelErr := s.cancelSession(ctx, actorFromContext(ctx), child.ID); cancelErr == nil {
			child = ended
		}
	}
	settled := item.Observation
	item.Observation.At = time.Now().UTC().Format(time.RFC3339Nano)
	if !activeOrBlocked(child.Status) {
		item.Observation.Status = "completed"
		if child.Status == "failed" {
			item.Observation.Status = "failed"
		}
		if child.Status == "canceled" {
			item.Observation.Status = "stopped"
		}
		item.Observation.EndedAt = child.CompletedAt
		item.Observation.ConfirmedRevision = item.Revision
	}
	// A child's state was recorded on an earlier poll; observing it again
	// would only rewrite the timestamp, once per poll per child.
	recorded := item.Observation
	recorded.At = settled.At
	if recorded == settled {
		item.Observation = settled
		return item
	}
	_ = s.store.ObserveSessionWork(ctx, item.ID, item.Observation)
	return item
}
