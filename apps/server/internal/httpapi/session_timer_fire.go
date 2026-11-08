package httpapi

import (
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// handleDaemonTimerFire delivers a Claude timer of the session that came due
// while no agent process held it (its worker restarted or was down): its
// prompt becomes the session's next input, marked as the timer's fire, and
// a late one as a catch-up. One timer's due time is sent once, however often
// the device asks (timerFireInputID). A running session refuses it (409);
// the device asks again later.
func (s *Server) handleDaemonTimerFire(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	session, err := s.store.GetAgentSessionSummary(ctx, r.PathValue("id"))
	if err != nil || !actorFromContext(ctx).ActsAsDevice(session.DeviceID) {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	if session.ArchivedAt != "" {
		writeResult(w, nil, store.ErrSessionArchived)
		return
	}
	if session.Provider != "claude" {
		writeError(w, http.StatusConflict, "only Claude sessions hold timers")
		return
	}
	var body struct {
		TimerID string `json:"timerId"`
		Prompt  string `json:"prompt"`
		DueAt   string `json:"dueAt"`
		CatchUp bool   `json:"catchUp,omitempty"`
	}
	if !decodeJSONRequest(w, r, &body) {
		return
	}
	body.TimerID, body.Prompt = strings.TrimSpace(body.TimerID), strings.TrimSpace(body.Prompt)
	due, err := time.Parse(time.RFC3339Nano, body.DueAt)
	if body.TimerID == "" || body.Prompt == "" || err != nil {
		writeError(w, http.StatusBadRequest, "timerId, prompt and an RFC 3339 dueAt are required")
		return
	}
	inputID := timerFireInputID(session.ID, body.TimerID, due)
	fire := &store.AgentSessionTimerFire{
		ID: body.TimerID, Origin: "scheduled", Prompt: body.Prompt,
		StartedAt:    time.Now().UTC().Format(time.RFC3339Nano),
		ScheduledFor: due.UTC().Format(time.RFC3339Nano),
		CatchUp:      body.CatchUp,
	}
	_, err = s.sessionService.Send(ctx, session.ID, store.SendAgentSessionInput{Prompt: body.Prompt, RequireIdle: true, InputID: inputID, TimerFire: fire}, nil)
	switch {
	case errors.Is(err, store.ErrSessionInputExists):
		writeJSON(w, http.StatusOK, map[string]any{"inputId": inputID, "delivered": true})
	case errors.Is(err, store.ErrAgentSessionActive):
		writeError(w, http.StatusConflict, "session busy")
	case err != nil:
		writeResult(w, nil, err)
	default:
		writeJSON(w, http.StatusAccepted, map[string]any{"inputId": inputID, "delivered": true})
	}
}
