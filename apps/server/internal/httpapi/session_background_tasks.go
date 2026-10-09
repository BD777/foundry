package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// backgroundTaskID is the shape of Claude Code's task ids. The request names
// a task, never a path: the device reads the log it recorded for that task.
var backgroundTaskID = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

// handleReadBackgroundTaskOutput returns the end of one of a session's
// background tasks: its last 64 KB as plain text with secrets redacted, and
// the redacted command line. Members only (the route): output and commands
// can carry what the session worked on outside the workspace.
func (s *Server) handleReadBackgroundTaskOutput(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	sessionID := strings.TrimSpace(r.PathValue("id"))
	taskID := strings.TrimSpace(r.PathValue("taskId"))
	if sessionID == "" || !backgroundTaskID.MatchString(taskID) {
		writeError(w, http.StatusBadRequest, "a session id and a background task id are required")
		return
	}
	session, err := s.store.GetAgentSessionSummary(r.Context(), sessionID)
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	if !s.canReadSession(r.Context(), actorFromContext(r.Context()), session) {
		writeForbidden(w, "session token cannot read this session's background work")
		return
	}
	workspace, err := s.store.GetWorkspace(r.Context(), session.WorkspaceID)
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), deviceFileRequestTimeout)
	defer cancel()
	output, err := s.hub.ReadBackgroundTaskOutput(ctx, session, taskID)
	if writeDeviceRequestError(w, workspace, err) {
		return
	}
	var refusal backgroundTaskRefusal
	if errors.As(err, &refusal) {
		writeError(w, http.StatusNotFound, refusal.reason)
		return
	}
	writeResult(w, output, err)
}

// handleStopBackgroundTask asks the session's agent to stop one of its
// background tasks (Claude's own stopTask; the device never kills process
// ids). Like cancel: members control their own sessions, maintainers any.
func (s *Server) handleStopBackgroundTask(w http.ResponseWriter, r *http.Request) {
	sessionID := strings.TrimSpace(r.PathValue("id"))
	taskID := strings.TrimSpace(r.PathValue("taskId"))
	if sessionID == "" || !backgroundTaskID.MatchString(taskID) {
		writeError(w, http.StatusBadRequest, "a session id and a background task id are required")
		return
	}
	session, err := s.store.GetAgentSessionSummary(r.Context(), sessionID)
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	if !s.canControlSession(r.Context(), actorFromContext(r.Context()), session) {
		writeForbidden(w, "you cannot stop this session's background work")
		return
	}
	if session.Provider != "claude" {
		writeError(w, http.StatusConflict, "only Claude sessions run background work Foundry can stop")
		return
	}
	if !s.hub.HasConnection(session.DeviceID) {
		writeError(w, http.StatusConflict, ErrLocalDaemonNotConnected.Error())
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
	defer cancel()
	err = s.hub.StopBackgroundTask(ctx, session, taskID)
	var refusal backgroundTaskRefusal
	if errors.As(err, &refusal) {
		writeError(w, http.StatusConflict, refusal.reason)
		return
	}
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"sessionId": session.ID, "taskId": taskID, "stopping": true})
}

// backgroundTaskRefusal is a device's answer that the task is not one of
// the session's, or not running.
type backgroundTaskRefusal struct{ reason string }

func (r backgroundTaskRefusal) Error() string { return r.reason }

type wsBackgroundTaskRequestPayload struct {
	WorkspaceID string `json:"workspaceId"`
	SessionID   string `json:"sessionId"`
	TaskID      string `json:"taskId"`
}

type wsBackgroundTaskOutputReadPayload struct {
	store.AgentBackgroundTaskOutput
	Error string `json:"error,omitempty"`
}

type wsBackgroundTaskStoppedPayload struct {
	SessionID string `json:"sessionId"`
	TaskID    string `json:"taskId"`
	Error     string `json:"error,omitempty"`
}

func (h *DaemonHub) ReadBackgroundTaskOutput(ctx context.Context, session store.AgentSession, taskID string) (store.AgentBackgroundTaskOutput, error) {
	connection := h.connectionFor(session.DeviceID)
	if connection == nil {
		return store.AgentBackgroundTaskOutput{}, store.ErrNotFound
	}
	payload, err := json.Marshal(wsBackgroundTaskRequestPayload{WorkspaceID: session.WorkspaceID, SessionID: session.ID, TaskID: taskID})
	if err != nil {
		return store.AgentBackgroundTaskOutput{}, err
	}
	value, err := daemonRequest[wsBackgroundTaskOutputReadPayload](ctx, connection, wsReadBackgroundTaskOutputType, payload)
	if err != nil {
		return store.AgentBackgroundTaskOutput{}, err
	}
	if value.Error != "" {
		return store.AgentBackgroundTaskOutput{}, backgroundTaskRefusal{value.Error}
	}
	return value.AgentBackgroundTaskOutput, nil
}

func (h *DaemonHub) StopBackgroundTask(ctx context.Context, session store.AgentSession, taskID string) error {
	connection := h.connectionFor(session.DeviceID)
	if connection == nil {
		return ErrLocalDaemonNotConnected
	}
	payload, err := json.Marshal(wsBackgroundTaskRequestPayload{WorkspaceID: session.WorkspaceID, SessionID: session.ID, TaskID: taskID})
	if err != nil {
		return err
	}
	value, err := daemonRequest[wsBackgroundTaskStoppedPayload](ctx, connection, wsStopBackgroundTaskType, payload)
	if err != nil {
		return err
	}
	if value.Error != "" {
		return backgroundTaskRefusal{value.Error}
	}
	return nil
}
