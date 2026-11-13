package httpapi

import (
	"context"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/sessions"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// onSessionStarted marks the session's input running on this device.
func (c *daemonConnection) onSessionStarted(ctx context.Context, envelope wsEnvelope) error {
	var payload wsSessionStartedPayload
	if err := decodeWebSocketPayload(envelope.Payload, &payload); err != nil {
		return err
	}
	existing, existingErr := c.hub.store.GetAgentSessionSummary(ctx, payload.SessionID)
	if existingErr == nil && staleSessionInput(existing, payload.InputID, payload.DispatchID) {
		c.reply(wsEnvelope{Type: wsAckType, ID: envelope.ID})
		return nil
	}
	if existingErr == nil && (existing.Status == "running" || !store.IsActiveSessionStatus(existing.Status)) {
		c.setActiveSession(payload.SessionID, existing.Status == "running")
		c.clearDispatchedSession(payload.SessionID)
		c.reply(wsEnvelope{Type: wsAckType, ID: envelope.ID})
		return nil
	}
	session, err := c.hub.store.StartAgentSession(ctx, payload.SessionID)
	if err == nil {
		c.setActiveSession(payload.SessionID, true)
		c.clearDispatchedSession(payload.SessionID)
		c.hub.sessions.Changed(ctx, sessions.Started, session)
		if c.hub.sessionRetryStarted != nil {
			c.hub.sessionRetryStarted(ctx, session)
		}
		c.reply(wsEnvelope{Type: wsAckType, ID: envelope.ID})
	}
	return err
}

// onSessionEvent records and streams one event of a running session; what
// reacts to it observes the sessions notifier (server.go). These stay here:
// before the store takes the event, a session message's read receipt is
// settled and not recorded (inboxConsumed), as is a question that stopped
// waiting (questionSettled), and a steered message is named
// with its sender (withSteerSender); a native account hold and the Issue
// run's copy of the event may fail the message, so the device sends it
// again; the subagent cache is updated before viewers hear of the event,
// since what it says goes to them (subagentChanged); and a Codex transport
// report is kept only from the device that ran the session, which only this
// connection knows.
func (c *daemonConnection) onSessionEvent(ctx context.Context, envelope wsEnvelope) error {
	var payload wsSessionEventPayload
	if err := decodeWebSocketPayload(envelope.Payload, &payload); err != nil {
		return err
	}
	// The server's clock, never the worker's: the store keeps this time,
	// so the streamed event and a later read of it agree.
	payload.Event.At = time.Now().UTC().Format(time.RFC3339Nano)
	if (c.hub.inboxConsumed != nil && c.hub.inboxConsumed(ctx, payload.Event)) ||
		(c.hub.questionSettled != nil && c.hub.questionSettled(ctx, payload.Event)) {
		c.reply(wsEnvelope{Type: wsAckType, ID: envelope.ID})
		return nil
	}
	payload.Event = c.hub.withSteerSender(ctx, payload.Event)
	// An event sent again (its acknowledgement was late) is acknowledged
	// again and nothing else: no new time, no stream, no cache change.
	stored, err := c.recordSessionEvent(ctx, payload.Event)
	if err == nil && payload.Event.Metadata != nil &&
		(payload.Event.Metadata.TurnUsage != nil || payload.Event.Metadata.RequestUsage != nil) {
		c.hub.recordUsageEvent(ctx, payload.Event)
	}
	if err == nil && payload.Event.Metadata != nil {
		err = c.observeNativeAccountHold(ctx, payload.Event.SessionID, payload.Event.Metadata.NativeAccountInputID, payload.Event.Metadata.NativeAccountError)
	}
	if err == nil && stored {
		workspaceID := c.sessionWorkspace(ctx, payload.Event.SessionID)
		subagents := c.hub.subagents.observe(payload.Event)
		c.hub.sessions.Recorded(ctx, workspaceID, payload.Event)
		c.hub.sessions.SubagentChanged(workspaceID, payload.Event, subagents)
		c.learnCodexTransport(ctx, payload.Event)
	}
	if err == nil {
		c.reply(wsEnvelope{Type: wsAckType, ID: envelope.ID})
	}
	return err
}

// onSessionBlocked marks the session blocked for the reason its device gives.
func (c *daemonConnection) onSessionBlocked(ctx context.Context, envelope wsEnvelope) error {
	var payload struct {
		SessionID string `json:"sessionId"`
		Reason    string `json:"reason"`
	}
	if err := decodeWebSocketPayload(envelope.Payload, &payload); err != nil {
		return err
	}
	session, err := c.hub.store.BlockAgentSession(ctx, payload.SessionID, payload.Reason)
	if err == nil {
		c.hub.sessions.Changed(ctx, sessions.Blocked, session)
		c.reply(wsEnvelope{Type: wsAckType, ID: envelope.ID})
	}
	return err
}

// onSessionResumed marks a blocked session running again.
func (c *daemonConnection) onSessionResumed(ctx context.Context, envelope wsEnvelope) error {
	var payload struct {
		SessionID string `json:"sessionId"`
	}
	if err := decodeWebSocketPayload(envelope.Payload, &payload); err != nil {
		return err
	}
	session, err := c.hub.store.ResumeAgentSession(ctx, payload.SessionID)
	if err == nil {
		c.hub.sessions.Changed(ctx, sessions.Resumed, session)
		c.reply(wsEnvelope{Type: wsAckType, ID: envelope.ID})
	}
	return err
}

// onSessionNativeID records the session's id in its native runtime.
func (c *daemonConnection) onSessionNativeID(ctx context.Context, envelope wsEnvelope) error {
	var payload wsSessionNativeSessionIDPayload
	if err := decodeWebSocketPayload(envelope.Payload, &payload); err != nil {
		return err
	}
	session, err := c.hub.store.SetAgentSessionNativeSessionID(ctx, payload.SessionID, payload.NativeSessionID)
	if err == nil {
		c.hub.sessions.Changed(ctx, sessions.NativeSessionID, session)
		c.reply(wsEnvelope{Type: wsAckType, ID: envelope.ID})
	}
	return err
}

// onSessionCompleted settles the session's input: its answer or its error.
// What reacts to the end observes the sessions notifier (changed, then
// endReported once the device was answered). These stay here: the
// assistant's record of a native end may fail the message; the Issue's
// result is the device's report, not the session's, and is handed over
// before the device is answered, also for a session the server had already
// settled, so a lost answer brings it again (settleIssueSession).
func (c *daemonConnection) onSessionCompleted(ctx context.Context, envelope wsEnvelope) error {
	var payload wsSessionCompletedPayload
	if err := decodeWebSocketPayload(envelope.Payload, &payload); err != nil {
		return err
	}
	existing, existingErr := c.hub.store.GetAgentSessionRecord(ctx, payload.SessionID)
	if existingErr == nil && staleSessionInput(existing, payload.InputID, payload.DispatchID) {
		c.reply(wsEnvelope{Type: wsAckType, ID: envelope.ID})
		return nil
	}
	if existingErr == nil && !store.IsActiveSessionStatus(existing.Status) {
		if payload.InputID != "" {
			status := "completed"
			if payload.Error != "" {
				status = "failed"
			}
			if err := c.hub.store.NotePersonalAgentNativeEnd(ctx, payload.SessionID, payload.InputID, status); err != nil {
				return err
			}
		}

		c.setActiveSession(payload.SessionID, false)
		c.clearDispatchedSession(payload.SessionID)
		c.hub.recordUsage(ctx, existing, store.AgentSessionEvent{
			SessionID: existing.ID,
			At:        existing.CompletedAt,
		})
		// A session the server already settled (a stale reconcile) still
		// hands over the Issue result the device recorded.
		c.hub.settleIssueSession(ctx, existing, payload.IssueResult, payload.ClarificationResult)
		c.reply(wsEnvelope{Type: wsAckType, ID: envelope.ID})
		c.hub.sessions.EndReported(ctx, existing)
		return nil
	}
	if payload.Error != "" && existingErr == nil && c.hub.retrySessionFailure != nil {
		scheduled, err := c.hub.retrySessionFailure(ctx, existing, payload.Error)
		if err != nil {
			return err
		}
		if scheduled {
			c.setActiveSession(payload.SessionID, false)
			c.clearDispatchedSession(payload.SessionID)
			c.reply(wsEnvelope{Type: wsAckType, ID: envelope.ID})
			return nil
		}
	}
	// A new input can be queued after the read above. Fence the actual write,
	// not just this handler's initial snapshot, before accepting a replay.
	session, applied, err := c.hub.store.SettleAgentSessionInput(ctx, payload.SessionID, payload.InputID, payload.Response, payload.NativeSessionID, payload.Error)
	if err == nil {
		c.hub.recordUsage(ctx, session, store.AgentSessionEvent{
			SessionID: session.ID,
			At:        session.CompletedAt,
		})
	}
	if err == nil && !applied {
		c.reply(wsEnvelope{Type: wsAckType, ID: envelope.ID})
		return nil
	}
	if err == nil {
		c.setActiveSession(payload.SessionID, false)
		c.clearDispatchedSession(payload.SessionID)
		c.hub.subagents.invalidate(payload.SessionID)
		for _, event := range session.Events {
			c.hub.sessions.Recorded(ctx, session.WorkspaceID, event)
		}
		c.hub.sessions.Changed(ctx, sessions.Completed, session)
		if c.hub.sessionRetryDone != nil {
			c.hub.sessionRetryDone(ctx, session, session.Status == "failed")
		}
		c.hub.settleIssueSession(ctx, session, payload.IssueResult, payload.ClarificationResult)
		c.reply(wsEnvelope{Type: wsAckType, ID: envelope.ID})
		c.hub.sessions.EndReported(ctx, session)
	}
	return err
}

// onSessionTurn follows a model turn the session's agent runs on its own:
// the session's status does not show it, its resource leases follow it.
func (c *daemonConnection) onSessionTurn(ctx context.Context, envelope wsEnvelope) error {
	var payload wsSessionTurnPayload
	if err := decodeWebSocketPayload(envelope.Payload, &payload); err != nil {
		return err
	}
	deviceID, _ := c.registrationSnapshot()
	if err := c.hub.leases.AgentTurn(ctx, payload.SessionID, deviceID, payload.Running); err != nil {
		return err
	}
	c.reply(wsEnvelope{Type: wsAckType, ID: envelope.ID})
	return nil
}

// staleSessionInput reports a lifecycle message about an input the session
// has already moved past.
func staleSessionInput(session store.AgentSession, inputID, dispatchID string) bool {
	return (inputID != "" && session.Input.ID != "" && inputID != session.Input.ID) ||
		(dispatchID != "" && session.DispatchID != "" && dispatchID != session.DispatchID)
}

// sessionWorkspace resolves (and remembers) the workspace of a session whose
// events stream over this connection.
func (c *daemonConnection) sessionWorkspace(ctx context.Context, sessionID string) string {
	c.sessionWorkspacesMu.Lock()
	defer c.sessionWorkspacesMu.Unlock()
	if workspaceID, ok := c.sessionWorkspaces[sessionID]; ok {
		return workspaceID
	}
	session, err := c.hub.store.GetAgentSessionSummary(ctx, sessionID)
	if err != nil {
		return ""
	}
	if c.sessionWorkspaces == nil {
		c.sessionWorkspaces = map[string]string{}
	}
	c.sessionWorkspaces[sessionID] = session.WorkspaceID
	return session.WorkspaceID
}
