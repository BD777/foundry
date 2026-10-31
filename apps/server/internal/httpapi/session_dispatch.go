package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"slices"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func (h *DaemonHub) DispatchAgentSession(session store.AgentSession) error {
	if recoveredSession, recovered, err := h.reconcileAgentSession(context.Background(), session); err != nil {
		return err
	} else if recovered || recoveredSession.Status != "queued" {
		return nil
	} else {
		session = recoveredSession
	}
	connection := h.connectionFor(session.DeviceID)
	if connection == nil {
		return store.ErrNotFound
	}
	return connection.dispatchAgentSession(session)
}

func (c *daemonConnection) dispatchAgentSession(session store.AgentSession) error {
	// Reserve the input before resolving anything: concurrent dispatchers
	// (a claim and the queued-session sweep on hello) send it once.
	c.dispatchedMu.Lock()
	if sent, ok := c.dispatchedSessions[session.ID]; ok && sent == session.Input.ID {
		c.dispatchedMu.Unlock()
		return nil
	}
	c.dispatchedSessions[session.ID] = session.Input.ID
	c.dispatchedMu.Unlock()
	if err := c.sendAgentSession(session); err != nil {
		c.clearDispatchedSession(session.ID)
		return err
	}
	return nil
}

func (c *daemonConnection) sendAgentSession(session store.AgentSession) error {
	if session.Input.ExecutionBudget != nil && (!c.hasCapability("role_run_budgets_v1") || !c.hasCapability("exact_input_cancel_v1")) {
		return fmt.Errorf("the active execution host needs an update to enforce role run deadlines")
	}
	if session.Input.ExecutionBudget != nil {
		if _, err := ensureAssistantRunControlRecord(context.Background(), c.hub.store, session); err != nil {
			return err
		}
	}
	if controls, ok := c.hub.store.(store.PersonalAgentRunControlStore); ok {
		allowed, err := controls.AuthorizePersonalAgentDispatch(context.Background(), session.ID, session.Input.ID)
		if err != nil {
			return err
		}
		if !allowed {
			return nil
		}
	}

	spec, err := c.sessionLaunchSpec(context.Background(), session)
	if err != nil {
		return err
	}
	payload, err := json.Marshal(spec)
	if err != nil {
		return err
	}
	if !c.queue(wsEnvelope{Type: wsRunSessionType, Payload: payload}) {
		return store.ErrNotFound
	}
	return nil
}

// sessionLaunchSpec is everything the device needs to run the session's
// input: the server profile and credential, skills, the Issue it works on,
// a session token and the external accounts it may act as.
func (c *daemonConnection) sessionLaunchSpec(ctx context.Context, session store.AgentSession) (wsRunSessionPayload, error) {
	if holds, ok := c.hub.store.(store.NativeAccountHoldStore); ok {
		if err := holds.BindNativeAccount(ctx, session); err != nil {
			return wsRunSessionPayload{}, err
		}
	}
	profile, err := c.hub.serverProfileForSession(ctx, session)
	if err != nil {
		return wsRunSessionPayload{}, fmt.Errorf("resolve server profile: %w", err)
	}
	var credential string
	if profile != nil {
		credential, err = c.hub.serverProfileCredential(ctx, profile.ID)
	} else {
		credential, err = c.hub.dispatchCredential(ctx, session)
	}
	if err != nil {
		return wsRunSessionPayload{}, fmt.Errorf("resolve server credential: %w", err)
	}
	// Resolve the workspace's skill selection to current latest revisions. An
	// empty slice is authoritative: the runtime exposes no skills at all.
	if refs, err := sessionSkillRefs(ctx, c.hub.store, session.WorkspaceID, session.Provider); err != nil {
		return wsRunSessionPayload{}, fmt.Errorf("resolve workspace skills: %w", err)
	} else {
		session.SkillRefs = refs
	}
	if backing, ok := c.hub.store.(store.WorkspaceDraftStore); ok && c.hasCapability(workspaceDraftCapability) && session.Source != verificationSource && session.Source != "naming" && session.Source != store.DigestSessionSource {
		drafts, err := backing.WorkspaceDrafts(ctx, session.WorkspaceID, session.WorkspaceID)
		if err != nil {
			return wsRunSessionPayload{}, err
		}
		session.WorkspaceDraftSkills = drafts.Enabled
	}
	var (
		issue         *store.Issue
		userFiles     string
		clarification *store.ClarificationTurn
	)
	if session.Role == store.AgentSessionRoleIssueClarification {
		if clarification, err = c.clarificationTurn(ctx, session); err != nil {
			return wsRunSessionPayload{}, err
		}
	}
	if session.Role == store.AgentSessionRoleIssueExecution {
		if !c.hasCapability(store.DaemonCapabilityIssueSessions) {
			return wsRunSessionPayload{}, errIssueSessionsUnsupported
		}
		loaded, err := c.hub.store.ExecutionIssue(ctx, session.IssueID)
		if err != nil {
			return wsRunSessionPayload{}, fmt.Errorf("load the issue to execute: %w", err)
		}
		issue = &loaded
		userFiles = issueUserFiles(loaded, c.actor)
	}
	// A digest summary reads its prompt only: without a token it has no
	// Foundry tools, and it acts as nobody elsewhere (workspace_digests.go).
	if session.Source == store.DigestSessionSource {
		return wsRunSessionPayload{Session: session, Profile: profile, Credential: credential}, nil
	}
	// Mint a session token per dispatch; earlier ones stay valid. Failure does
	// not block a run (the web UI needs no token); the agent-facing surface
	// simply stays unavailable for this process until the next one. A token
	// of a session in an Issue reaches only that Issue (agentScope).
	sessionToken, tokenErr := c.hub.store.MintAgentSessionToken(ctx, session.ID)
	if tokenErr != nil {
		log.Printf("mint session token for %s: %v", session.ID, tokenErr)
		sessionToken = ""
	}
	connectorUses := c.hub.sessionConnectors(ctx, session, c.actor, c.hasCapability)
	// The person's assistant runs as one, with its instructions and the
	// turn's context, every run.
	var assistantInstructions string
	if c.hub.assistantRun != nil {
		run, assistant, err := c.hub.assistantRun(ctx, session)
		if err != nil {
			return wsRunSessionPayload{}, fmt.Errorf("prepare the assistant's instructions: %w", err)
		}
		if assistant {
			session.Role, assistantInstructions = store.AgentSessionRolePersonalAgent, run.Instructions
			session.Input = withTurnContext(session.Input, run.TurnContext)
		}
	}
	return wsRunSessionPayload{
		Session: session, Profile: profile, Credential: credential, SessionToken: sessionToken, Issue: issue,
		UserFiles: userFiles, Clarification: clarification, ExternalAccounts: connectorUses.ExternalAccounts,
		DeviceConnectors: connectorUses.DeviceConnectors, PersonalAgentInstructions: assistantInstructions,
	}, nil
}

// sessionDispatched reports that this input of the session was already sent.
func (c *daemonConnection) sessionDispatched(sessionID string, inputID string) bool {
	c.dispatchedMu.Lock()
	defer c.dispatchedMu.Unlock()
	sent, ok := c.dispatchedSessions[sessionID]
	return ok && sent == inputID
}

func (c *daemonConnection) clearDispatchedSession(sessionID string) {
	c.dispatchedMu.Lock()
	delete(c.dispatchedSessions, sessionID)
	c.dispatchedMu.Unlock()
}

// issueUserFiles decides whether an Issue may use the device owner's own
// files and credentials: only when the device owner started it.
func issueUserFiles(issue store.Issue, device Actor) string {
	if owner := device.AccountID(); owner != "" && issue.CreatedByUserID == owner {
		return "readable"
	}
	return "hidden"
}

// unsettledSessions lists this device's queued, running and blocked sessions
// in one workspace, or in all of its workspaces when workspaceID is empty.
func (c *daemonConnection) unsettledSessions(workspaceID string) ([]store.AgentSession, error) {
	deviceID, _ := c.registrationSnapshot()
	sessions, err := c.hub.store.UnsettledAgentSessionsOnDevice(context.Background(), deviceID)
	if err != nil {
		return nil, err
	}
	unsettled := sessions[:0]
	for _, session := range sessions {
		if session.DeviceID == deviceID && isRecoverableAgentSessionStatus(session.Status) &&
			(workspaceID == "" || session.WorkspaceID == workspaceID) {
			unsettled = append(unsettled, session)
		}
	}
	return unsettled, nil
}

// dispatchQueuedAgentSessions sends the device its queued sessions in one
// workspace, or in all of them when workspaceID is empty, in the order
// their inputs were queued: work that waited for the device starts as it
// was sent, at most the device's maxConcurrentTasks at once (the worker's
// scheduler holds the rest).
func (c *daemonConnection) dispatchQueuedAgentSessions(workspaceID string) {
	sessions, err := c.unsettledSessions(workspaceID)
	if err != nil {
		c.reply(wsEnvelope{Type: wsErrorType, Error: err.Error()})
		return
	}
	slices.SortStableFunc(sessions, func(a, b store.AgentSession) int {
		queuedA, _ := sessionQueuedSince(a)
		queuedB, _ := sessionQueuedSince(b)
		return queuedA.Compare(queuedB)
	})
	for _, session := range sessions {
		if session.Status != "queued" {
			continue
		}
		reconciled, recovered, err := c.hub.reconcileAgentSession(context.Background(), session)
		if err != nil {
			c.reply(wsEnvelope{Type: wsErrorType, Error: err.Error()})
			return
		}
		if recovered || reconciled.Status != "queued" {
			continue
		}
		session = reconciled
		if c.sessionDispatched(session.ID, session.Input.ID) {
			continue
		}
		// The device would refuse it; fail it with the reason instead.
		if refusal := unservedWorkspace(context.Background(), c.hub.store, session.WorkspaceID); refusal != nil {
			if failed, err := c.hub.store.FailAgentSession(context.Background(), session.ID, refusal.Error()); err == nil {
				c.hub.sessions.changed(context.Background(), sessionCompleted, failed)
			}
			continue
		}
		if err := c.dispatchAgentSession(session); err != nil {
			c.reply(wsEnvelope{Type: wsErrorType, Error: err.Error()})
			return
		}
	}
}

// recoverOrphanedAgentSessions runs when a daemon (re)connects, over every
// workspace of the device. An input the
// server still counts as running, which the new connection does not claim,
// was left by an earlier daemon process; only the device knows whether it
// finished, so the device is asked. Daemons that report no execution claims
// predate the question and fall back to the stale-activity timeout.
func (c *daemonConnection) recoverOrphanedAgentSessions(claimsReported bool) {
	if !claimsReported {
		return
	}
	deviceID, _ := c.registrationSnapshot()
	sessions, err := c.unsettledSessions("")
	if err != nil {
		c.reply(wsEnvelope{Type: wsErrorType, Error: err.Error()})
		return
	}
	for _, session := range sessions {
		if session.Status != "running" && session.Status != "blocked" {
			continue
		}
		if c.hasActiveSession(session.ID) {
			continue
		}
		payload, err := json.Marshal(wsRecoverSessionPayload{
			SessionID: session.ID, InputID: session.Input.ID, WorkspaceID: session.WorkspaceID, IssueID: session.IssueID, Role: session.Role,
		})
		if err != nil {
			continue
		}
		log.Printf("asking %s about orphaned session %s input %s", deviceID, session.ID, session.Input.ID)
		c.queue(wsEnvelope{Type: wsRecoverSessionType, Payload: payload})
	}
}
