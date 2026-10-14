package httpapi

import (
	"bytes"
	"cmp"
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"mime"
	"net/http"
	"path/filepath"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/feishu"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// The one way sessions start, take messages and stop, whoever asks: the
// REST handlers (sessions_http.go), MCP, the chat queue, timers and Feishu.
// Signatures carry no HTTP; a refusal is a statusError.

// sessionControlTimeout is how long a steer or a stop waits for the
// session's device to answer.
var sessionControlTimeout = 8 * time.Second

// startAgentSession creates a session on the agent its input names and hands it
// to that agent's device. A refusal is a statusError; a session its device
// could not take comes back failed, with StatusConflict.
func (s *Server) startAgentSession(ctx context.Context, input store.CreateAgentSessionInput) (store.AgentSession, error) {
	if err := s.resolveSessionDevice(ctx, &input); err != nil {
		return store.AgentSession{}, err
	}
	session, err := s.createAndDispatch(ctx, input, true)
	switch {
	case err == nil:
		return session, nil
	case errors.Is(err, ErrLocalDaemonNotConnected):
		return session, &statusError{http.StatusConflict, err}
	case errors.Is(err, store.ErrDeviceRemoved):
		return store.AgentSession{}, &statusError{http.StatusGone, errors.New("device_removed")}
	default:
		return store.AgentSession{}, err
	}
}

var ErrLocalDaemonNotConnected = errors.New("local daemon is not connected")

// createAndDispatch creates a session, tells its viewers and hands it to its
// device: the one way a new session starts, whoever starts it (a person,
// the chat queue, Feishu, an agent over MCP). reconcile first settles the
// workspace's sessions whose device stopped reporting (MCP creates without
// it). A session its device does not take comes back failed, with
// ErrLocalDaemonNotConnected; a refused creation, with the store's error.
func (s *Server) createAndDispatch(ctx context.Context, input store.CreateAgentSessionInput, reconcile bool) (store.AgentSession, error) {
	return s.createAndDispatchWith(ctx, input, reconcile, nil)
}

// createAndDispatchWith runs beforeDispatch, if any, once the store took the
// session and before its device hears of it; a failure fails the session
// with its error.
func (s *Server) createAndDispatchWith(ctx context.Context, input store.CreateAgentSessionInput, reconcile bool, beforeDispatch func(context.Context) error) (store.AgentSession, error) {
	if reconcile && input.WorkspaceID != "" {
		if sessions, err := s.store.ListAgentSessionSummaries(ctx, input.WorkspaceID); err == nil {
			s.reconcileAgentSessions(ctx, sessions)
		}
	}
	if refusal := archivedWorkspace(ctx, s.store, input.WorkspaceID); refusal != nil {
		return store.AgentSession{}, refusal
	}
	assistant, delegating, err := s.admitAssistantSession(ctx, input)
	if err != nil {
		return store.AgentSession{}, err
	}
	session, err := s.store.CreateAgentSession(ctx, input)
	if err != nil {
		return store.AgentSession{}, err
	}
	if delegating {
		s.recordAssistantTask(ctx, assistant, input.ParentSessionID, session)
	}
	s.sessions.changed(ctx, sessionCreated, session)
	s.chats.sessionCreated(session)
	if chatID := session.AdoptedChatID; chatID != "" {
		// The adopted native chat's queued messages are the session's now.
		s.chats.announceQueue(ctx, session.WorkspaceID, chatID)
		s.chats.announceQueue(ctx, session.WorkspaceID, session.ID)
	}
	if groupID := strings.TrimSpace(session.CreatedGroupID); groupID != "" {
		// Best-effort asynchronous AI naming; failures keep the deterministic
		// placeholder name and never block session dispatch.
		go s.titles.StartGroupName(context.Background(), session.WorkspaceID, groupID, session.ParentSessionID)
	}
	if beforeDispatch != nil {
		if err := beforeDispatch(ctx); err != nil {
			return s.failUndelivered(ctx, session, err.Error()), err
		}
	}
	if failed, err := s.dispatchOrFail(ctx, session, notConnected); err != nil {
		return failed, ErrLocalDaemonNotConnected
	}
	return session, nil
}

// dispatchOrFail hands a session its viewers know of to its device. One the
// device does not take fails with failure(err) as its error (see
// failUndelivered). It comes back failed, with the dispatch's error.
func (s *Server) dispatchOrFail(ctx context.Context, session store.AgentSession, failure func(error) string) (store.AgentSession, error) {
	if err := s.hub.DispatchAgentSession(session); err != nil {
		return s.failUndelivered(ctx, session, failure(err)), err
	}
	return session, nil
}

// failUndelivered fails a session its device did not take, and tells it
// like any other end, so what reacts to an ended session follows (the
// chat's queued messages, Feishu's card, naming).
func (s *Server) failUndelivered(ctx context.Context, session store.AgentSession, reason string) store.AgentSession {
	failed, err := s.store.FailAgentSession(ctx, session.ID, reason)
	if err != nil {
		log.Printf("fail session %s its device did not take: %v", session.ID, err)
		return failed
	}
	s.sessions.changed(ctx, sessionCompleted, failed)
	return failed
}

// notConnected records a failed dispatch as the device not taking it.
func notConnected(error) string { return ErrLocalDaemonNotConnected.Error() }

// dispatchNamingJob hands a naming job to its device; one it does not take
// fails with what failed.
func (s *Server) dispatchNamingJob(ctx context.Context, job store.AgentSession) (store.AgentSession, error) {
	return s.dispatchOrFail(ctx, job, func(err error) string { return err.Error() })
}

// pickSessionAgent chooses the agent a request names, most specific first:
// its agent id, else its profile (within the requested runtime), else the
// first agent of its runtime.
func pickSessionAgent(agents []store.AgentProjection, input store.CreateAgentSessionInput) (store.AgentProjection, bool) {
	match := func(ok func(store.AgentProjection) bool) (store.AgentProjection, bool) {
		for _, agent := range agents {
			if ok(agent) {
				return agent, true
			}
		}
		return store.AgentProjection{}, false
	}
	switch {
	case input.AgentID != "":
		return match(func(agent store.AgentProjection) bool { return agent.ID == input.AgentID })
	case input.ProfileID != "":
		return match(func(agent store.AgentProjection) bool {
			return agent.ProfileID == input.ProfileID && (input.Provider == "" || agent.Provider == input.Provider)
		})
	case input.Provider != "":
		return match(func(agent store.AgentProjection) bool { return agent.Provider == input.Provider })
	}
	return store.AgentProjection{}, false
}

// resolveSessionDevice finds the agent a new session runs on and checks its
// device is reachable by the caller and connected. It may pin input.AgentID.
// A refusal is a statusError; any other err is an ordinary failure.
// Callers authorize the workspace first; an agent picked here always belongs
// to it, so a session token reaches exactly the devices of workspaces its
// scope grants.
func (s *Server) resolveSessionDevice(ctx context.Context, input *store.CreateAgentSessionInput) error {
	return s.pickSessionDevice(ctx, input, false)
}

// CreateSessionAndDispatch starts a session for an integration (Feishu)
// whose messages name no agent: one its input does not resolve runs on the
// workspace's first connected agent, else its first.
func (s *Server) CreateSessionAndDispatch(ctx context.Context, input store.CreateAgentSessionInput) (store.AgentSession, error) {
	if err := s.pickSessionDevice(ctx, &input, true); err != nil {
		return store.AgentSession{}, err
	}
	return s.createAndDispatch(ctx, input, true)
}

// pickSessionDevice is resolveSessionDevice. With anyAgent, a request no
// agent answers (none named, none found, or its device removed) takes the
// workspace's first connected agent, else its first, pinning it; a
// workspace without agents is left to the dispatch to fail.
func (s *Server) pickSessionDevice(ctx context.Context, input *store.CreateAgentSessionInput, anyAgent bool) error {
	if refusal := unservedWorkspace(ctx, s.store, input.WorkspaceID); refusal != nil {
		return &statusError{http.StatusConflict, refusal}
	}
	agents, err := s.store.ListAgents(ctx, input.WorkspaceID, "")
	if err != nil {
		return err
	}
	deviceID := ""
	if agent, ok := pickSessionAgent(agents, *input); ok {
		deviceID = agent.DeviceID
		if input.AgentID == "" && input.ProfileID != "" {
			input.AgentID, input.Provider = agent.ID, agent.Provider
		}
	}
	// Server-owned profile agents are projected per snapshot, never persisted
	// as agents rows (see serverProfileProjections). Resolve that id from the
	// trusted workspace -> device -> enabled binding -> profile chain so a
	// picker selection can start a session; client fields never authorise it.
	if deviceID == "" && (input.AgentID != "" || input.ProfileID != "") {
		resolved, resolveErr := s.store.ResolveSessionAgent(ctx, *input)
		switch {
		case resolveErr == nil:
			deviceID = resolved.DeviceID
			if input.AgentID == "" {
				input.AgentID, input.Provider = resolved.ID, resolved.Provider
			}
		case errors.Is(resolveErr, store.ErrProfileRuntimeMismatch):
			return &statusError{http.StatusBadRequest, resolveErr}
		case errors.Is(resolveErr, store.ErrDeviceRemoved) && !anyAgent:
			return &statusError{http.StatusGone, errors.New("device_removed")}
		case !errors.Is(resolveErr, store.ErrNotFound) &&
			!errors.Is(resolveErr, store.ErrProfileNotFound) &&
			!errors.Is(resolveErr, store.ErrDeviceRemoved):
			return resolveErr
		}
	}
	if deviceID == "" && anyAgent {
		if len(agents) == 0 {
			return nil
		}
		agent := agents[0]
		for _, candidate := range agents {
			if s.hub.HasConnection(candidate.DeviceID) {
				agent = candidate
				break
			}
		}
		deviceID, input.AgentID, input.Provider = agent.DeviceID, agent.ID, agent.Provider
	}
	if deviceID == "" {
		return &statusError{http.StatusBadRequest, errors.New("no agent is available for the selected runtime and profile")}
	}
	if !s.hub.HasConnection(deviceID) {
		return &statusError{http.StatusConflict, ErrLocalDaemonNotConnected}
	}
	return nil
}

// SendSessionMessage delivers a follow-up to a session on behalf of an
// integration (Feishu) that acts with the workspace owner's authority.
func (s *Server) SendSessionMessage(ctx context.Context, sessionID, message string, attachments []store.ChatAttachment) error {
	_, err := s.sendSessionMessage(ctx, sessionID, store.SendAgentSessionInput{Prompt: message, Attachments: attachments})
	return err
}

// SaveAttachments stores the files an integration (Feishu) received with
// one message in the workspace's attachments on its device, as a person's
// upload is and within the same limit.
func (s *Server) SaveAttachments(ctx context.Context, workspaceID string, files []feishu.MessageFile) ([]store.ChatAttachment, error) {
	total := 0
	for _, file := range files {
		total += len(file.Data)
	}
	if total > maxAttachmentUploadBytes {
		return nil, fmt.Errorf("the files hold more than %d MB, the most one message may bring", maxAttachmentUploadBytes>>20)
	}
	workspace, err := s.store.GetWorkspace(ctx, workspaceID)
	if err != nil {
		return nil, err
	}
	now := time.Now().UTC()
	attachments := make([]store.ChatAttachment, 0, len(files))
	for index, file := range files {
		mimeType := file.MIMEType
		if mimeType == "" || mimeType == "application/octet-stream" {
			mimeType = cmp.Or(mime.TypeByExtension(strings.ToLower(filepath.Ext(sanitizeAttachmentName(file.Name)))), mimeType)
		}
		data := bytes.NewReader(file.Data)
		attachment, err := s.storeAttachment(ctx, workspace, now, index, file.Name, mimeType, int64(len(file.Data)), func(buffer []byte) (int, error) {
			return io.ReadFull(data, buffer)
		})
		if err != nil {
			return nil, err
		}
		attachments = append(attachments, attachment)
	}
	return attachments, nil
}

// sendSessionMessage is the one way to talk to an existing session: a
// running session is steered, an idle one takes the message as its next
// input and is dispatched again. A refusal is a statusError.
func (s *Server) sendSessionMessage(ctx context.Context, sessionID string, input store.SendAgentSessionInput) (store.AgentSession, error) {
	return s.sendSessionMessageWith(ctx, sessionID, input, nil)
}

// sendSessionMessageWith runs beforeDelivery, if any, once the message is
// accepted and before the session's device hears of it: a steer it fails
// is not sent, a queued input it fails fails the session with its error.
func (s *Server) sendSessionMessageWith(ctx context.Context, sessionID string, input store.SendAgentSessionInput, beforeDelivery func(context.Context) error) (store.AgentSession, error) {
	session, err := store.AgentSessionRecord(ctx, s.store, sessionID)
	if err != nil {
		return store.AgentSession{}, err
	}
	if session, _, err = s.reconcileAgentSession(ctx, session); err != nil {
		return store.AgentSession{}, err
	}
	if session.Role != "" {
		return store.AgentSession{}, &statusError{http.StatusConflict, store.ErrSessionControlledByIssue}
	}
	if err := s.admitAssistantTurn(ctx, session); err != nil {
		return store.AgentSession{}, err
	}
	message := strings.TrimSpace(input.Prompt)
	if activeOrBlocked(session.Status) {
		if input.RequireIdle {
			return store.AgentSession{}, &statusError{http.StatusConflict, store.ErrAgentSessionActive}
		}
		if input.AgentID != "" || input.Provider != "" || input.ProfileID != "" {
			return store.AgentSession{}, &statusError{http.StatusConflict, errors.New("a running session keeps its runtime; switch it once it settles")}
		}
		// Files steer in with the message, as they arrive with any message.
		attachments := store.NormalizeChatAttachments(input.Attachments)
		if message == "" && len(attachments) == 0 {
			return store.AgentSession{}, &statusError{http.StatusBadRequest, errors.New("message is required")}
		}
		if !s.hub.HasConnection(session.DeviceID) {
			return store.AgentSession{}, &statusError{http.StatusConflict, ErrLocalDaemonNotConnected}
		}
		if beforeDelivery != nil {
			if err := beforeDelivery(ctx); err != nil {
				return store.AgentSession{}, &statusError{http.StatusConflict, err}
			}
		}
		steerCtx, cancel := context.WithTimeout(ctx, sessionControlTimeout)
		defer cancel()
		if err := s.hub.SteerAgentSession(steerCtx, session, input.InputID, message, attachments); err != nil {
			return store.AgentSession{}, &statusError{cmp.Or(deviceErrorStatus(err), http.StatusConflict), err}
		}
		session, err = store.AgentSessionRecord(ctx, s.store, session.ID)
		return session, err
	}
	if refusal := unservedWorkspace(ctx, s.store, session.WorkspaceID); refusal != nil {
		return store.AgentSession{}, &statusError{http.StatusConflict, refusal}
	}
	session, err = s.store.SendAgentSessionInput(ctx, session.ID, input)
	if err != nil {
		if errors.Is(err, store.ErrAgentSessionActive) {
			return store.AgentSession{}, &statusError{http.StatusConflict, err}
		}
		return store.AgentSession{}, err
	}
	// A summary carries no events, so the input's own transcript events are
	// streamed too; otherwise viewers keep the previous turn as the latest.
	for _, event := range store.SessionInputEvents(session.ID, session.Input) {
		s.sessions.recorded(ctx, session.WorkspaceID, event)
	}
	s.sessions.changed(ctx, sessionQueued, session)
	if !s.hub.HasConnection(session.DeviceID) {
		return s.failUndelivered(ctx, session, notConnected(nil)), &statusError{http.StatusConflict, ErrLocalDaemonNotConnected}
	}
	if beforeDelivery != nil {
		if err := beforeDelivery(ctx); err != nil {
			return s.failUndelivered(ctx, session, err.Error()), &statusError{http.StatusConflict, err}
		}
	}
	if failed, err := s.dispatchOrFail(ctx, session, notConnected); err != nil {
		return failed, &statusError{http.StatusConflict, ErrLocalDaemonNotConnected}
	}
	return session, nil
}

// cancelSession stops the work a session is doing. It never cascades:
// sessions it created keep running. A refusal is a statusError.
func (s *Server) cancelSession(ctx context.Context, actor Actor, sessionID string) (store.AgentSession, error) {
	session, err := store.AgentSessionRecord(ctx, s.store, sessionID)
	if err != nil {
		return store.AgentSession{}, err
	}
	session, recovered, err := s.reconcileAgentSession(ctx, session)
	if err != nil {
		return store.AgentSession{}, err
	}
	if session.Role != "" {
		return store.AgentSession{}, &statusError{http.StatusConflict, store.ErrSessionControlledByIssue}
	}
	if recovered || !activeOrBlocked(session.Status) {
		return store.AgentSession{}, &statusError{http.StatusConflict, errors.New("agent session is not active")}
	}
	if !s.hub.HasConnection(session.DeviceID) {
		return store.AgentSession{}, &statusError{http.StatusConflict, ErrLocalDaemonNotConnected}
	}
	cancelCtx, cancel := context.WithTimeout(ctx, sessionControlTimeout)
	defer cancel()
	answered, err := s.hub.CancelAgentSession(cancelCtx, session)
	if err != nil {
		return store.AgentSession{}, &statusError{cmp.Or(deviceErrorStatus(err), http.StatusConflict), err}
	}
	if answered {
		// The turn had already answered; the stop ended only the background
		// work it waited for. The device reports it completed with that
		// answer, so it is not recorded as canceled.
		s.appendSessionControlAudit(ctx, session, "Stopped by orchestrator", actor)
		return session, nil
	}
	cancelMessage := "Canceled by user"
	if actor.Agent() {
		cancelMessage = "Canceled by orchestrator session"
	}
	session, err = s.store.CancelAgentSession(ctx, session.ID, cancelMessage)
	if err != nil {
		return store.AgentSession{}, err
	}
	s.appendSessionControlAudit(ctx, session, "Canceled by orchestrator", actor)
	s.sessions.changed(ctx, sessionCompleted, session)
	return session, nil
}

// appendSessionControlAudit records in the session's transcript that an
// orchestrating session controlled it, and streams the event like the
// transcript's others.
func (s *Server) appendSessionControlAudit(ctx context.Context, session store.AgentSession, label string, actor Actor) {
	if !actor.Agent() {
		return
	}
	now := time.Now().UTC()
	event := store.AgentSessionEvent{
		ID:        fmt.Sprintf("audit_%d", now.UnixNano()),
		SessionID: session.ID,
		At:        now.Format(time.RFC3339Nano),
		Label:     label,
		Detail:    actor.Identity.SessionID,
		Level:     "info",
		Metadata: &store.AgentSessionEventMetadata{
			TaskID: actor.Identity.SessionID,
		},
	}
	if err := s.store.AppendAgentSessionEvent(ctx, event); err != nil {
		log.Printf("record %q on session %s: %v", label, session.ID, err)
		return
	}
	s.sessions.recorded(ctx, session.WorkspaceID, event)
}
