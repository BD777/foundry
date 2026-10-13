package httpapi

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// A session's timers (Claude's CronCreate, ScheduleWakeup) fire in the agent
// process that runs it. While no process runs the session (its worker
// restarted, or the process ended), its device keeps them and, when one is
// due, sends it here: the timer's prompt becomes the session's next input,
// which resumes the session. Claude Code then holds the timers again and
// fires them itself; a device sends a timer only while no process of its
// own holds it.

type daemonTimerFire struct {
	TimerID string `json:"timerId"`
	Prompt  string `json:"prompt"`
	// DueAt is the fire time it is sent for: one input per timer and time.
	DueAt string `json:"dueAt"`
	// NativeSessionID is the native session the timer lives in.
	NativeSessionID string `json:"nativeSessionId"`
}

type daemonTimerFireRefusal struct {
	Error string `json:"error"`
	Code  string `json:"code"`
}

func (s *Server) handleDaemonTimerFire(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	var fire daemonTimerFire
	if !decodeJSONRequest(w, r, &fire) {
		return
	}
	fire.TimerID = strings.TrimSpace(fire.TimerID)
	prompt := strings.TrimSpace(fire.Prompt)
	dueAt, err := time.Parse(time.RFC3339Nano, strings.TrimSpace(fire.DueAt))
	if fire.TimerID == "" || prompt == "" || err != nil {
		writeError(w, http.StatusBadRequest, "timerId, prompt and dueAt (RFC 3339) are required")
		return
	}
	session, err := s.store.GetAgentSessionSummary(ctx, r.PathValue("id"))
	// A deleted session, or another device's: nothing of this device's.
	if errors.Is(err, store.ErrNotFound) || (err == nil && !actorFromContext(ctx).ActsAsDevice(session.DeviceID)) {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	nativeSessionID := strings.TrimSpace(fire.NativeSessionID)
	if session.Provider != "claude" || session.Role != "" ||
		(nativeSessionID != "" && session.NativeSessionID != "" && session.NativeSessionID != nativeSessionID) {
		// The session runs elsewhere now; resuming it would not bring the
		// timers back. It holds none any more.
		s.clearSessionSchedule(ctx, session)
		writeJSON(w, http.StatusGone, daemonTimerFireRefusal{Error: "the session no longer runs these timers", Code: "timers_gone"})
		return
	}
	if !s.hub.HasConnection(session.DeviceID) {
		writeError(w, http.StatusServiceUnavailable, ErrLocalDaemonNotConnected.Error())
		return
	}
	inputID := timerFireInputID(session.ID, fire.TimerID, dueAt)
	_, err = s.sendSessionMessage(ctx, session.ID, store.SendAgentSessionInput{
		Prompt: prompt, RequireIdle: true, InputID: inputID,
		TimerFire: &store.AgentSessionTimerFire{
			ID: fire.TimerID, Origin: "scheduled", Prompt: prompt, StartedAt: time.Now().UTC().Format(time.RFC3339Nano),
		},
	})
	switch {
	case err == nil:
		writeJSON(w, http.StatusAccepted, map[string]string{"sessionId": session.ID, "inputId": inputID})
	case errors.Is(err, store.ErrSessionInputExists):
		// Sent already for this time.
		writeJSON(w, http.StatusOK, map[string]string{"sessionId": session.ID, "inputId": inputID})
	case errors.Is(err, store.ErrAgentSessionActive):
		writeJSON(w, http.StatusConflict, daemonTimerFireRefusal{Error: err.Error(), Code: "session_busy"})
	case errors.Is(err, store.ErrNotFound), errors.Is(err, store.ErrSessionControlledByIssue):
		writeError(w, http.StatusNotFound, "not found")
	case errors.Is(err, ErrLocalDaemonNotConnected):
		writeError(w, http.StatusServiceUnavailable, err.Error())
	case errorStatus(err) == http.StatusConflict:
		// Refused for good (its workspace is not served here, say).
		writeJSON(w, http.StatusConflict, daemonTimerFireRefusal{Error: err.Error(), Code: "session_refused"})
	default:
		writeError(w, http.StatusInternalServerError, err.Error())
	}
}

// handleDaemonSessionToken mints a token for a session its own device runs.
// Claude fires a timer itself while its process lives, with no dispatch to
// mint one; the device asks for a fresh token as the timer's turn starts, so
// a timer firing long after the session last used its tools still reaches
// them (a token idles out a day after its last use, session_tokens.go).
func (s *Server) handleDaemonSessionToken(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	session, err := s.store.GetAgentSessionSummary(ctx, r.PathValue("id"))
	if errors.Is(err, store.ErrNotFound) || (err == nil && !actorFromContext(ctx).ActsAsDevice(session.DeviceID)) {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	token, err := s.store.MintAgentSessionToken(ctx, session.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, map[string]string{"sessionToken": token})
}

// timerFireInputID names the input a timer's fire time becomes, the same
// for every attempt to send it.
func timerFireInputID(sessionID, timerID string, dueAt time.Time) string {
	sum := sha256.Sum256([]byte("timer-fire\x00" + sessionID + "\x00" + timerID + "\x00" + dueAt.UTC().Format(time.RFC3339)))
	id := hex.EncodeToString(sum[:16])
	return id[0:8] + "-" + id[8:12] + "-" + id[12:16] + "-" + id[16:20] + "-" + id[20:32]
}

// clearSessionSchedule records that the session holds no timers, as its
// device would: the empty snapshot ends its schedule for every reader.
func (s *Server) clearSessionSchedule(ctx context.Context, session store.AgentSession) {
	if session.Scheduled == nil {
		return
	}
	empty := []store.AgentScheduledTask{}
	event := store.AgentSessionEvent{
		ID: "evt_timers_gone_" + session.ID + "_" + time.Now().UTC().Format("20060102T150405.000000000"), SessionID: session.ID,
		At: time.Now().UTC().Format(time.RFC3339Nano), Label: "Scheduled tasks updated", Level: "info",
		Metadata: &store.AgentSessionEventMetadata{TimerSnapshot: &empty},
	}
	if err := s.store.AppendAgentSessionEvent(ctx, event); err != nil {
		return
	}
	s.sessions.recorded(ctx, session.WorkspaceID, event)
}
