package httpapi

import (
	"context"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// onSessionStarted marks the session's input running on this device.
func (c *daemonConnection) onSessionStarted(ctx context.Context, envelope wsEnvelope) error {
	var payload wsSessionStartedPayload
	if err := decodeWebSocketPayload(envelope.Payload, &payload); err != nil {
		return err
	}
	existing, existingErr := c.hub.store.GetAgentSessionSummary(ctx, payload.SessionID)
	if existingErr == nil && staleSessionInput(existing, payload.InputID) {
		c.reply(wsEnvelope{Type: wsAckType, ID: envelope.ID})
		return nil
	}
	if existingErr == nil && (existing.Status == "running" || !isRecoverableAgentSessionStatus(existing.Status)) {
		c.setActiveSession(payload.SessionID, existing.Status == "running")
		c.clearDispatchedSession(payload.SessionID)
		c.reply(wsEnvelope{Type: wsAckType, ID: envelope.ID})
		return nil
	}
	session, err := c.hub.store.StartAgentSession(ctx, payload.SessionID)
	if err == nil {
		c.setActiveSession(payload.SessionID, true)
		c.clearDispatchedSession(payload.SessionID)
		c.hub.sessions.changed(ctx, sessionStarted, session)
		c.hub.startIssueExecution(ctx, session)
		c.reply(wsEnvelope{Type: wsAckType, ID: envelope.ID})
	}
	return err
}

// onSessionEvent records and streams one event of a running session.
func (c *daemonConnection) onSessionEvent(ctx context.Context, envelope wsEnvelope) error {
	var payload wsSessionEventPayload
	if err := decodeWebSocketPayload(envelope.Payload, &payload); err != nil {
		return err
	}
	// The server's clock, never the worker's: the store keeps this time,
	// so the streamed event and a later read of it agree.
	payload.Event.At = time.Now().UTC().Format(time.RFC3339Nano)
	if c.hub.inboxConsumed != nil && c.hub.inboxConsumed(ctx, payload.Event) {
		c.reply(wsEnvelope{Type: wsAckType, ID: envelope.ID})
		return nil
	}
	payload.Event = c.hub.withSteerSender(ctx, payload.Event)
	// An event sent again (its acknowledgement was late) is acknowledged
	// again and nothing else: no new time, no stream, no cache change.
	stored, err := c.recordSessionEvent(ctx, payload.Event)
	if err == nil && payload.Event.Metadata != nil {
		err = c.observeNativeAccountHold(ctx, payload.Event.SessionID, payload.Event.Metadata.NativeAccountInputID, payload.Event.Metadata.NativeAccountError)
	}
	if err == nil {
		target := c.sessionTarget(ctx, payload.Event.SessionID)
		if stored {
			subagents := c.hub.subagents.observe(payload.Event)
			c.hub.sessions.recorded(ctx, target.workspaceID, payload.Event)
			c.hub.sessions.subagentChanged(target.workspaceID, payload.Event, subagents)
			c.learnCodexTransport(ctx, payload.Event)
		}
		// Also for one sent again: the attempt that stored it in the
		// session may have failed to add it to the Issue's run.
		if target.executionIssue != "" {
			err = c.hub.appendIssueExecutionEvent(ctx, target.workspaceID, payload.Event, stored)
		}
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
		c.hub.sessions.changed(ctx, sessionBlocked, session)
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
		c.hub.sessions.changed(ctx, sessionResumed, session)
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
		c.hub.sessions.changed(ctx, sessionNativeSessionID, session)
		c.reply(wsEnvelope{Type: wsAckType, ID: envelope.ID})
	}
	return err
}

// onSessionCompleted settles the session's input: its answer or its error.
func (c *daemonConnection) onSessionCompleted(ctx context.Context, envelope wsEnvelope) error {
	var payload wsSessionCompletedPayload
	if err := decodeWebSocketPayload(envelope.Payload, &payload); err != nil {
		return err
	}
	existing, existingErr := store.AgentSessionRecord(ctx, c.hub.store, payload.SessionID)
	if existingErr == nil && staleSessionInput(existing, payload.InputID) {
		c.reply(wsEnvelope{Type: wsAckType, ID: envelope.ID})
		return nil
	}
	if existingErr == nil && !isRecoverableAgentSessionStatus(existing.Status) {
		if controls, ok := c.hub.store.(store.PersonalAgentRunControlStore); ok && payload.InputID != "" {
			status := "completed"
			if payload.Error != "" {
				status = "failed"
			}
			if err := controls.NotePersonalAgentNativeEnd(ctx, payload.SessionID, payload.InputID, status); err != nil {
				return err
			}
		}

		c.setActiveSession(payload.SessionID, false)
		c.clearDispatchedSession(payload.SessionID)
		// A session the server already settled (a stale reconcile) still
		// hands over the Issue result the device recorded.
		c.hub.settleIssueSession(ctx, existing, payload.IssueResult, payload.ClarificationResult)
		c.reply(wsEnvelope{Type: wsAckType, ID: envelope.ID})
		c.hub.sessions.endReported(ctx, existing)
		return nil
	}
	// A new input can be queued after the read above. Fence the actual write,
	// not just this handler's initial snapshot, before accepting a replay.
	session, applied, err := c.hub.store.SettleAgentSessionInput(ctx, payload.SessionID, payload.InputID, payload.Response, payload.NativeSessionID, payload.Error)
	if err == nil && !applied {
		c.reply(wsEnvelope{Type: wsAckType, ID: envelope.ID})
		return nil
	}
	if err == nil {
		c.setActiveSession(payload.SessionID, false)
		c.clearDispatchedSession(payload.SessionID)
		c.hub.subagents.invalidate(payload.SessionID)
		for _, event := range session.Events {
			c.hub.sessions.recorded(ctx, session.WorkspaceID, event)
		}
		c.hub.sessions.changed(ctx, sessionCompleted, session)
		c.hub.settleIssueSession(ctx, session, payload.IssueResult, payload.ClarificationResult)
		c.reply(wsEnvelope{Type: wsAckType, ID: envelope.ID})
		c.hub.sessions.endReported(ctx, session)
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
func staleSessionInput(session store.AgentSession, inputID string) bool {
	return inputID != "" && session.Input.ID != "" && inputID != session.Input.ID
}

// sessionWorkspace resolves (and remembers) the workspace of a session whose
// events stream over this connection.
func (c *daemonConnection) sessionWorkspace(ctx context.Context, sessionID string) string {
	return c.sessionTarget(ctx, sessionID).workspaceID
}

// sessionTarget is where a session's events belong: its workspace, and the
// Issue it executes (empty for any other session).
type sessionTarget struct {
	workspaceID    string
	executionIssue string
}

func (c *daemonConnection) sessionTarget(ctx context.Context, sessionID string) sessionTarget {
	c.sessionWorkspacesMu.Lock()
	defer c.sessionWorkspacesMu.Unlock()
	if target, ok := c.sessionWorkspaces[sessionID]; ok {
		return target
	}
	session, err := c.hub.store.GetAgentSessionSummary(ctx, sessionID)
	if err != nil {
		return sessionTarget{}
	}
	if c.sessionWorkspaces == nil {
		c.sessionWorkspaces = map[string]sessionTarget{}
	}
	target := sessionTarget{workspaceID: session.WorkspaceID}
	if session.Role == store.AgentSessionRoleIssueExecution {
		target.executionIssue = session.IssueID
	}
	c.sessionWorkspaces[sessionID] = target
	return target
}
