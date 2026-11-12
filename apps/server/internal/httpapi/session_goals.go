package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/sessions"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// claudeGoalClear is Claude Code's own way to clear its /goal: the command,
// sent as the session's next message.
const claudeGoalClear = "/goal clear"

type wsSessionGoalControlPayload struct {
	WorkspaceID string `json:"workspaceId"`
	SessionID   string `json:"sessionId"`
	Action      string `json:"action"`
}

type wsSessionGoalControlledPayload struct {
	SessionID string `json:"sessionId"`
	Error     string `json:"error,omitempty"`
}

// sessionGoalRefusal is a device's answer that it could not apply the
// control (no open thread, Codex refused it).
type sessionGoalRefusal struct{ reason string }

func (r sessionGoalRefusal) Error() string { return r.reason }

// handleControlSessionGoal applies the person's control of the session's
// goal the way its runtime does: Codex's thread/goal/set (pause, resume)
// and thread/goal/clear on its device; Claude Code's "/goal clear" as the
// session's next message. Claude has no pause.
func (s *Server) handleControlSessionGoal(w http.ResponseWriter, r *http.Request) {
	actor := actorFromContext(r.Context())
	session := guardedSession(r)
	if session.ArchivedAt != "" {
		writeResult(w, nil, store.ErrSessionArchived)
		return
	}
	if !s.canControlSession(r.Context(), actor, session) {
		writeForbidden(w, "you cannot change this session's goal")
		return
	}
	var body struct {
		Action string `json:"action"`
	}
	if !decodeJSONRequest(w, r, &body) {
		return
	}
	action := strings.TrimSpace(body.Action)
	switch session.Provider {
	case "codex":
		if action != "pause" && action != "resume" && action != "clear" {
			writeError(w, http.StatusBadRequest, "action must be pause, resume or clear")
			return
		}
		if !s.hub.HasConnection(session.DeviceID) {
			if _, err := s.hub.waitForConnection(r.Context(), session.DeviceID); err != nil {
				writeError(w, http.StatusConflict, err.Error())
				return
			}
		}
		// Opening a closed thread starts Codex first.
		ctx, cancel := context.WithTimeout(r.Context(), 45*time.Second)
		defer cancel()
		err := s.hub.ControlSessionGoal(ctx, session, action)
		var refusal sessionGoalRefusal
		if errors.As(err, &refusal) {
			writeError(w, http.StatusConflict, refusal.reason)
			return
		}
		if err != nil {
			writeResult(w, nil, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"sessionId": session.ID, "action": action})
	case "claude":
		if action != "clear" {
			writeError(w, http.StatusBadRequest, "Claude Code's /goal can only be cleared")
			return
		}
		// A command between turns, never steered into a running one.
		sent, err := s.sessionService.Send(r.Context(), session.ID, store.SendAgentSessionInput{Prompt: claudeGoalClear, RequireIdle: true, SentBySessionID: messageSender(actor)}, nil)
		if errors.Is(err, store.ErrAgentSessionActive) {
			writeError(w, http.StatusConflict, "Claude clears its goal between turns: stop the running turn or wait for it, then try again")
			return
		}
		writeResult(w, s.presentSession(r.Context(), sessions.Slim(sent)), err)
	default:
		writeError(w, http.StatusConflict, "this session's runtime has no goal")
	}
}

// ControlSessionGoal asks the session's device to apply a goal control to
// its Codex thread.
func (h *DaemonHub) ControlSessionGoal(ctx context.Context, session store.AgentSession, action string) error {
	connection, err := h.waitForConnection(ctx, session.DeviceID)
	if err != nil {
		return err
	}
	payload, err := json.Marshal(wsSessionGoalControlPayload{WorkspaceID: session.WorkspaceID, SessionID: session.ID, Action: action})
	if err != nil {
		return err
	}
	value, err := daemonRequest[wsSessionGoalControlledPayload](ctx, connection, wsControlSessionGoalType, payload)
	if err != nil {
		return err
	}
	if value.Error != "" {
		return sessionGoalRefusal{value.Error}
	}
	return nil
}
