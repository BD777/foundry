package httpapi

import (
	"context"
	"errors"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/sessions"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func (s *Server) handleListAgentSessions(w http.ResponseWriter, r *http.Request) {
	workspaceID := requestedWorkspace(actorFromContext(r.Context()), r.URL.Query().Get("workspaceId"))
	items, err := s.store.ListAgentSessionSummaries(r.Context(), workspaceID)
	if mode := r.URL.Query().Get("archived"); mode != "" {
		if mode != "exclude" && mode != "only" && mode != "include" {
			writeError(w, 400, "archived must be exclude, only or include")
			return
		}
		items, err = s.store.ListArchivedSessions(r.Context(), workspaceID, mode)
	}
	// issueId narrows the list to the sessions that worked for one Issue.
	if issueID := strings.TrimSpace(r.URL.Query().Get("issueId")); err == nil && issueID != "" {
		items = slices.DeleteFunc(items, func(session store.AgentSession) bool { return session.IssueID != issueID })
	}
	if err == nil {
		items = s.presentSessions(r.Context(), summarizeAgentSessionsForList(s.sessionService.ReconcileAll(r.Context(), items)))
	}
	writeResult(w, items, err)
}

func summarizeAgentSessionsForList(sessions []store.AgentSession) []store.AgentSession {
	for index := range sessions {
		sessions[index] = summarizeAgentSessionForList(sessions[index])
	}
	return sessions
}

func summarizeAgentSessionForList(session store.AgentSession) store.AgentSession {
	session.Input.ImportedContext = ""
	session.Input.ProfileTransitionNote = ""
	session.Response = ""
	session.Error = ""
	session.Events = nil
	return session
}

func (s *Server) handleGetAgentSession(w http.ResponseWriter, r *http.Request) {
	// A reader that missed stream events reads only those (session_events_after.go).
	if r.URL.Query().Has("eventsAfter") {
		s.handleGetAgentSessionEventsAfter(w, r)
		return
	}
	window, windowed, err := requestedEventWindow(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	// The route authorized the side-effect-free summary; only a permitted
	// caller may then trigger stale-session reconciliation.
	item, err := s.store.GetAgentSessionRecord(r.Context(), guardedSession(r).ID)
	if err != nil {
		writeResult(w, item, err)
		return
	}
	item, _, err = s.reconcileAgentSession(r.Context(), item)
	item = s.presentSession(r.Context(), item)
	if err == nil && sessionEventsRequested(r) {
		if windowed {
			page, pageErr := s.sessionEventWindow(r.Context(), item, window)
			if pageErr != nil {
				writeEventWindowError(w, pageErr)
				return
			}
			writeResult(w, page, nil)
			return
		}
		item, err = s.store.GetAgentSession(r.Context(), item.ID)
		item = s.presentSession(r.Context(), item)
	}
	writeResult(w, item, err)
}

func (s *Server) handleGetAgentSessionThread(w http.ResponseWriter, r *http.Request) {
	window, windowed, err := requestedEventWindow(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if window.before != "" {
		writeError(w, http.StatusBadRequest, "eventsBefore pages one session: read GET /api/agent-sessions/{id}")
		return
	}
	workspaceID := requestedWorkspace(actorFromContext(r.Context()), r.URL.Query().Get("workspaceId"))
	var items []store.AgentSession
	if windowed {
		items, err = s.store.ListAgentSessionThreadRecords(r.Context(), workspaceID, r.PathValue("id"))
	} else {
		items, err = s.store.ListAgentSessionThread(r.Context(), workspaceID, r.PathValue("id"))
	}
	if err != nil {
		writeResult(w, items, err)
		return
	}
	items = s.sessionService.ReconcileAll(r.Context(), items)
	items = s.presentSessions(r.Context(), s.backfillSessionUsage(r.Context(), items))
	if !windowed {
		writeResult(w, items, nil)
		return
	}
	// Each session's newest events: older ones are paged per session.
	pages := make([]windowedAgentSession, 0, len(items))
	for _, item := range items {
		page, err := s.sessionEventWindow(r.Context(), item, window)
		if err != nil {
			writeEventWindowError(w, err)
			return
		}
		pages = append(pages, page)
	}
	writeResult(w, pages, nil)
}

func (s *Server) handleGetAgentSubagentTranscript(w http.ResponseWriter, r *http.Request) {
	taskID := strings.TrimSpace(r.PathValue("taskId"))
	if taskID == "" {
		writeError(w, http.StatusBadRequest, "session id and task id are required")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	transcript, err := s.hub.ReadAgentSubagentTranscript(ctx, guardedSession(r), taskID)
	writeResult(w, transcript, err)
}

func (s *Server) handleListAgentSubagents(w http.ResponseWriter, r *http.Request) {
	session := guardedSession(r)
	// Readers read this list once per session view and then follow
	// agent_subagent_updated; it is served from the cache until a subagent
	// event arrives, and concurrent readers share one device round trip.
	// Chats read digests (?view=digest); agents, the whole list.
	ctx, cancel := context.WithTimeout(r.Context(), subagentReadWait)
	defer cancel()
	view := subagentListViewOf(r)
	body, err := s.hub.subagents.load(ctx, session.ID, view, sessions.Unsettled(session.Status), s.hub.subagentListFetch(session, view))
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	writeCacheableJSON(w, r, body)
}

// handleCreateAgentSession starts a session (resolveNewSession). A request
// with an Idempotency-Key or an inputId already taken answers with the
// session it started.
func (s *Server) handleCreateAgentSession(w http.ResponseWriter, r *http.Request) {
	var input store.CreateAgentSessionInput
	if !decodeJSONRequest(w, r, &input) || !validRequestedInputID(w, input.InputID) {
		return
	}
	if err := s.resolveNewSession(r.Context(), actorFromContext(r.Context()), &input, false); err != nil {
		writeResult(w, nil, err)
		return
	}
	idempotent, handled := s.beginIdempotentRequest(w, r, "agent-sessions/create", input, http.StatusCreated)
	if handled {
		return
	}
	defer idempotent.release()
	sent := sentInput{id: input.InputID, workspaceID: input.WorkspaceID, status: http.StatusCreated}
	if s.replaySentInput(w, r, sent, idempotent) {
		return
	}
	session, err := s.sessionService.DispatchNew(r.Context(), input, true, nil)
	if err != nil {
		switch {
		case errors.Is(err, store.ErrSessionInputExists) && s.replaySentInput(w, r, sent, idempotent):
		case session.ID != "":
			// Created, but its device could not take it: the failed session.
			writeJSON(w, errorStatus(err), s.presentSession(r.Context(), sessions.Slim(session)))
		default:
			writeResult(w, nil, err)
		}
		return
	}
	session = s.presentSession(r.Context(), sessions.Slim(session))
	idempotent.record(r.Context(), session)
	writeJSON(w, http.StatusCreated, session)
}

func (s *Server) handleSendAgentSessionMessage(w http.ResponseWriter, r *http.Request) {
	actor := actorFromContext(r.Context())
	anchor := guardedSession(r)
	if anchor.ArchivedAt != "" {
		writeResult(w, nil, store.ErrSessionArchived)
		return
	}
	if !s.canControlSession(r.Context(), actor, anchor) {
		writeForbidden(w, "you cannot send messages to this session")
		return
	}
	// As over MCP (send_message): an assistant hands work on by dispatch_item.
	if _, err := s.paScope(r.Context(), actor); err == nil {
		writeResult(w, nil, errAssistantStartsByDispatch)
		return
	}
	var input store.SendAgentSessionInput
	if !decodeJSONRequest(w, r, &input) || !validRequestedInputID(w, input.InputID) {
		return
	}
	input.SentBySessionID = messageSender(actor)
	idempotent, handled := s.beginIdempotentRequest(w, r, "agent-sessions/messages:"+anchor.ID, input, http.StatusOK)
	if handled {
		return
	}
	defer idempotent.release()
	// A message this session already took is answered with the session,
	// before a now-running turn could refuse (requireIdle) or be steered.
	sent := sentInput{id: input.InputID, sessionID: anchor.ID, workspaceID: anchor.WorkspaceID, status: http.StatusOK}
	if s.replaySentInput(w, r, sent, idempotent) {
		return
	}
	wasActive := sessions.Unsettled(anchor.Status)
	session, err := s.sessionService.Send(r.Context(), anchor.ID, input, nil)
	if err != nil {
		if errors.Is(err, store.ErrSessionInputExists) && s.replaySentInput(w, r, sent, idempotent) {
			return
		}
		writeResult(w, nil, err)
		return
	}
	if wasActive {
		s.sessionService.AuditControl(r.Context(), session, "Steered by orchestrator", messageSender(actor))
	}
	session = s.presentSession(r.Context(), sessions.Slim(session))
	idempotent.record(r.Context(), session)
	writeResult(w, session, nil)
}

func (s *Server) handleCancelAgentSession(w http.ResponseWriter, r *http.Request) {
	actor := actorFromContext(r.Context())
	anchor := guardedSession(r)
	if !s.canControlSession(r.Context(), actor, anchor) {
		writeForbidden(w, "you cannot cancel this session")
		return
	}
	session, err := s.sessionService.Cancel(r.Context(), anchor.ID, messageSender(actor))
	writeResult(w, s.presentSession(r.Context(), sessions.Slim(session)), err)
}
