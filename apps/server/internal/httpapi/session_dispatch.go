package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"slices"

	"github.com/foundry-dev/foundry/apps/server/internal/personalagent/assistant"
	"github.com/foundry-dev/foundry/apps/server/internal/sessions"
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
	if session.Input.ExecutionBudget != nil {
		if _, err := assistant.EnsureRunControl(context.Background(), c.hub.store, session); err != nil {
			return err
		}
	}
	allowed, err := c.hub.store.AuthorizePersonalAgentDispatch(context.Background(), session.ID, session.Input.ID)
	if err != nil {
		return err
	}
	if !allowed {
		return nil
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
	if err := c.hub.store.BindNativeAccount(ctx, session); err != nil {
		return wsRunSessionPayload{}, err
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
	connectorUses := c.hub.sessionConnectors(ctx, session, c.actor)
	// Resolve the workspace's skill selection to current latest revisions. An
	// empty slice is authoritative: the runtime exposes no skills at all.
	// A bundle that ships a CLI gives the skills of the version the device's
	// CLI is (docs/skills.md, Bundle 版本), and the session runs that CLI.
	var toolPins []store.SessionToolPin
	if sources, err := resolveWorkspaceSkills(ctx, c.hub.store, session.WorkspaceID); err != nil {
		return wsRunSessionPayload{}, fmt.Errorf("resolve workspace skills: %w", err)
	} else if refs, packagePins, err := workspacePackageSkills(
		ctx, c.hub.store, c.actor.AccountID(), session.WorkspaceID, session.DeviceID,
		connectorKinds(connectorUses.ExternalAccounts, connectorUses.DeviceConnectors),
		withBuiltinSkills(sources.Refs, session.Provider),
	); err != nil {
		return wsRunSessionPayload{}, err
	} else if refs, toolPins, err = deviceSkillRefs(ctx, c.hub.store, refs, session.DeviceID); err != nil {
		return wsRunSessionPayload{}, fmt.Errorf("resolve the device's bundle versions: %w", err)
	} else {
		toolPins = mergeToolPins(toolPins, packagePins)
		session.SkillRefs = refs
	}
	session.QuestionsTo, _ = questionsTo(ctx, c.hub.store, session, 0)
	if session.Source != store.SessionSourceVerification && !store.IsPromptOnlySessionSource(session.Source) {
		drafts, err := c.hub.store.WorkspaceDrafts(ctx, session.WorkspaceID, session.WorkspaceID)
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
		turn, err := c.hub.store.ClarificationTurn(ctx, session.IssueID)
		if err != nil {
			return wsRunSessionPayload{}, err
		}
		clarification = &turn
	}
	if session.Role == store.AgentSessionRoleIssueExecution {
		loaded, err := c.hub.store.ExecutionIssue(ctx, session.IssueID)
		if err != nil {
			return wsRunSessionPayload{}, fmt.Errorf("load the issue to execute: %w", err)
		}
		issue = &loaded
		userFiles = issueUserFiles(loaded, c.actor)
	}
	// A digest summary reads its prompt only: without a token it has no
	// Foundry tools, and it acts as nobody elsewhere (workspace_digests.go).
	if session.Source == store.SessionSourceDigest {
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
	// The person's assistant runs as one, with its folder's files and the
	// turn's context, every run.
	var assistantFiles []wsSetupWorkspaceFile
	if c.hub.assistantRun != nil {
		run, isAssistant, err := c.hub.assistantRun(ctx, session)
		if err != nil {
			return wsRunSessionPayload{}, fmt.Errorf("prepare the assistant's instructions: %w", err)
		}
		if isAssistant {
			session.Role = store.AgentSessionRolePersonalAgent
			for _, file := range run.Files {
				assistantFiles = append(assistantFiles, wsSetupWorkspaceFile{Path: file.Path, Content: file.Content})
			}
			session.Input = assistant.WithTurnContext(session.Input, run.TurnContext)
		}
	}
	return wsRunSessionPayload{
		Session: session, Profile: profile, Credential: credential, SessionToken: sessionToken, Issue: issue,
		UserFiles: userFiles, Clarification: clarification, ExternalAccounts: connectorUses.ExternalAccounts,
		DeviceConnectors: connectorUses.DeviceConnectors, PersonalAgentFiles: assistantFiles, ToolPins: toolPins,
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
	onDevice, err := c.hub.store.UnsettledAgentSessionsOnDevice(context.Background(), deviceID)
	if err != nil {
		return nil, err
	}
	unsettled := onDevice[:0]
	for _, session := range onDevice {
		if session.DeviceID == deviceID && store.IsActiveSessionStatus(session.Status) &&
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
	unsettled, err := c.unsettledSessions(workspaceID)
	if err != nil {
		c.reply(wsEnvelope{Type: wsErrorType, Error: err.Error()})
		return
	}
	slices.SortStableFunc(unsettled, func(a, b store.AgentSession) int {
		queuedA, _ := sessions.QueuedSince(a)
		queuedB, _ := sessions.QueuedSince(b)
		return queuedA.Compare(queuedB)
	})
	for _, session := range unsettled {
		if session.Status != "queued" {
			continue
		}
		// One still being started is sent by its starter, after what must
		// come before its device hears of it (a digest summary's claim).
		if c.hub.awaitSessionStart != nil && c.hub.awaitSessionStart(session.ID) {
			current, err := c.hub.store.GetAgentSessionSummary(context.Background(), session.ID)
			if err != nil || current.Status != "queued" || current.Input.ID != session.Input.ID {
				continue
			}
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
		// A workspace moving to another device keeps it queued until it
		// arrives there.
		if movingWorkspace(context.Background(), c.hub.store, session.WorkspaceID) != nil {
			continue
		}
		// The device would refuse it; fail it with the reason instead.
		if refusal := unservedWorkspace(context.Background(), c.hub.store, session.WorkspaceID); refusal != nil {
			if failed, err := c.hub.store.FailAgentSession(context.Background(), session.ID, refusal.Error()); err == nil {
				c.hub.sessions.Changed(context.Background(), sessions.Completed, failed)
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
// workspace of the device. An input the server still counts as running,
// which the new connection does not claim, was left by an earlier daemon
// process; only the device knows whether it finished, so the device is
// asked.
func (c *daemonConnection) recoverOrphanedAgentSessions() {
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
			SessionID: session.ID, InputID: session.Input.ID, WorkspaceID: session.WorkspaceID, IssueID: session.IssueID, Role: session.Role, Source: session.Source,
		})
		if err != nil {
			continue
		}
		log.Printf("asking %s about orphaned session %s input %s", deviceID, session.ID, session.Input.ID)
		c.queue(wsEnvelope{Type: wsRecoverSessionType, Payload: payload})
	}
}
