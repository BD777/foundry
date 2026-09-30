package httpapi

import (
	"context"
	"errors"
	"log"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// An Issue is implemented by an AgentSession with the issue_execution role.
// The session's lifecycle drives the Issue's Run, which is kept as the
// Issue-side projection: its id is the session id, its events mirror the
// session's, and completion carries the candidate the session left.

var errIssueSessionsUnsupported = errors.New("the worker does not run Issue executions as sessions; update it")

// startIssueExecution records that the Issue's execution session started.
func (h *DaemonHub) startIssueExecution(ctx context.Context, session store.AgentSession) {
	if session.Role != store.AgentSessionRoleIssueExecution {
		return
	}
	issue, err := h.store.StartIssueRun(ctx, session.IssueID, store.Run{
		ID:           session.ID,
		Runtime:      session.Provider,
		StartedLabel: "just now",
		StartedAt:    time.Now().UTC().Format(time.RFC3339),
	})
	if err != nil {
		log.Printf("start issue %s run for session %s: %v", session.IssueID, session.ID, err)
		return
	}
	h.events.Publish("issue_updated", issue)
}

// appendIssueExecutionEvent mirrors an execution session's event onto its
// Issue's Run.
func (h *DaemonHub) appendIssueExecutionEvent(ctx context.Context, workspaceID string, event store.AgentSessionEvent) error {
	runEvent := store.RunEvent{
		ID:     event.ID,
		RunID:  event.SessionID,
		At:     event.At,
		Label:  event.Label,
		Detail: event.Detail,
		Level:  event.Level,
	}
	if err := h.store.AppendRunEvent(ctx, runEvent); err != nil {
		return err
	}
	h.events.PublishIn(workspaceID, "issue_run_event", runEvent)
	return nil
}

// settleIssueExecution completes the Issue once its execution session ends.
// A session that ended without a result (the device lost it, or the server
// marked it stale) blocks the Issue with the session's error; candidate files
// stay on the device for a retry.
func (h *DaemonHub) settleIssueExecution(ctx context.Context, session store.AgentSession, result *store.CompleteIssueInput) {
	if session.Role != store.AgentSessionRoleIssueExecution {
		return
	}
	input := store.CompleteIssueInput{
		Error: session.Error,
		Artifact: store.AcceptanceArtifact{
			ID:      "art_" + session.ID,
			IssueID: session.IssueID,
			Kind:    "text",
			Title:   "Interrupted execution",
			Summary: session.Error,
		},
	}
	if input.Error == "" {
		input.Error = "The execution ended without a result."
		input.Artifact.Summary = input.Error
	}
	input.Checks = []string{input.Error}
	if result != nil {
		input = *result
	}
	input.RunID = session.ID
	issue, err := h.store.CompleteIssue(ctx, session.IssueID, input)
	if err != nil {
		log.Printf("complete issue %s from session %s: %v", session.IssueID, session.ID, err)
		return
	}
	h.events.Publish("issue_updated", issue)
	h.DispatchReady()
}
